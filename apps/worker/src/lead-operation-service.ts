import {
  MAX_R2_ACTORS_PER_RUN,
  MAX_R2_BUNDLES_PER_RUN,
  MAX_R2_RUN_LOGICAL_BYTES,
  MAX_R3_ACTIVE_ACTORS,
  MAX_R3_ACTOR_RECORDS,
  MAX_R3_BUNDLE_BATCH,
  MAX_R3_DELTA_PAGE,
  MAX_R3_REGISTER_BATCH,
  actorSchema,
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  completeWorkItemRequestSchema,
  createWorkItemRequestSchema,
  elasticAccountSchema,
  elasticRunPlaneSchema,
  eventBundleSchema,
  getRunContextRequestSchema,
  leadOperationOverviewSchema,
  leadOperationScopeSchema,
  listProjectExceptionsReceiptSchema,
  listProjectExceptionsRequestSchema,
  projectExceptionSchema,
  projectPolicySchema,
  registerActorRequestSchema,
  runBudgetSchema,
  runContextSchema,
  runSchema,
  startRunRequestSchema,
  submitBundleRequestSchema,
  workPacketSchema,
  type Actor,
  type EventBundle,
  type LeadOperationOverview,
  type PolicyBinding,
  type PolicyDecision,
  type ProjectException,
  type ProjectPolicy,
  type Run,
  type RunContext,
  type WorkPacket,
} from "@owd/contracts";
import {
  CollaborationProblem,
  authorizeCollaboration,
  type CollaborationAuthorizationContext,
} from "./collaboration-service";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";
import {
  insertRecordStatement,
  insertStateStatement,
  prepareCollaborationRecord,
  readCollaborationRecord,
  type AuthorizedCollaborationGrant,
} from "./collaboration-store";
import { readProjectLeadLease } from "./continuity-store";
import {
  insertElasticOperationRecordStatement,
  prepareElasticOperationRecord,
} from "./elastic-operation-store";
import {
  insertLeadOperationRecordStatement,
  prepareLeadOperationRecord,
  readLeadOperationRecord,
  type PreparedLeadOperationRecord,
} from "./lead-operation-store";
import { readPolicyOperationalRecord } from "./policy-operation-store";
import { sha256Hex } from "./security";

const MIN_HANDS_OFF_ACTORS = 3;
const DEFAULT_R3_LOGICAL_UNIT_LIMIT = 1_000_000;
const DEFAULT_R3_COST_MICROUNIT_LIMIT = 100_000_000;
const R3_HOT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const R3_WARM_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type LeadOperationProblemCode =
  | "actor_invalid"
  | "actor_recovery_invalid"
  | "backpressure"
  | "budget_exhausted"
  | "bundle_invalid"
  | "checkpoint_required"
  | "cursor_invalid"
  | "evidence_conflict"
  | "exception_blocking"
  | "grant_invalid"
  | "idempotency_conflict"
  | "integrity_mismatch"
  | "lease_invalid"
  | "policy_required"
  | "project_invalid"
  | "review_independence"
  | "review_required"
  | "run_invalid"
  | "scope_required"
  | "submission_invalid"
  | "work_item_invalid";

const PROBLEM_CODES = new Set<LeadOperationProblemCode>([
  "actor_invalid",
  "actor_recovery_invalid",
  "backpressure",
  "budget_exhausted",
  "bundle_invalid",
  "checkpoint_required",
  "cursor_invalid",
  "evidence_conflict",
  "exception_blocking",
  "grant_invalid",
  "idempotency_conflict",
  "integrity_mismatch",
  "lease_invalid",
  "policy_required",
  "project_invalid",
  "review_independence",
  "review_required",
  "run_invalid",
  "scope_required",
  "submission_invalid",
  "work_item_invalid",
]);

export class LeadOperationProblem extends Error {
  constructor(
    readonly code: LeadOperationProblemCode,
    readonly retry?: {
      reason: "batch-limit" | "capacity" | "database-overloaded";
      reduceBatchTo: number;
      retryAfterMs: number;
      retryable: boolean;
    },
  ) {
    super(code);
    this.name = "LeadOperationProblem";
  }
}

type AuthInput = {
  authorization: CollaborationAuthorizationContext;
  now: number;
  request: unknown;
};

export type Fence = {
  fencingToken: number;
  leaseId: string;
};

export type RunRow = {
  actor_count: number;
  bundle_count: number;
  completed_at: number | null;
  completion_outcome: string | null;
  created_at: number;
  logical_bytes: number;
  policy_id: string;
  project_id: string;
  purpose: Run["purpose"];
  run_id: string;
  status: Run["status"];
  work_item_id: string;
  work_packet_id: string;
};

export type ActorRow = {
  actor_id: string;
  expires_at: number;
  revoked_at: number | null;
  run_id: string;
  scopes_json: string;
  status: "active" | "expired" | "revoked";
};

async function isElasticRun(
  db: D1Database,
  projectId: string,
  runId: string,
): Promise<boolean> {
  return (
    (await db
      .prepare(
        `SELECT 1 FROM project_elastic_planes
         WHERE project_id = ? AND run_id = ?`,
      )
      .bind(projectId, runId)
      .first()) !== null
  );
}

export type ReceiptReplay = {
  idempotencyKeySha256: string;
  result: Record<string, unknown>;
};

export const LIVE_FENCE_SQL = `CASE WHEN EXISTS (
  SELECT 1
  FROM project_lead_leases lease
  JOIN collaboration_grants grant_row
    ON grant_row.id = lease.holder_grant_id
  JOIN agent_grants source_grant
    ON source_grant.id = grant_row.source_agent_grant_id
  JOIN vaults source_vault ON source_vault.id = source_grant.vault_id
  JOIN collaboration_projects project
    ON project.project_id = lease.project_id
  WHERE lease.project_id = ?
    AND lease.lease_id = ?
    AND lease.fencing_token = ?
    AND lease.holder_grant_id = ?
    AND lease.holder_client_id = ?
    AND lease.status = 'active'
    AND lease.expires_at > ?
    AND grant_row.status = 'active'
    AND grant_row.expires_at > ?
    AND grant_row.oauth_client_id = ?
    AND source_grant.status = 'active'
    AND source_vault.status = 'active'
    AND project.status = 'active'
    AND project.agent_visibility = 'discoverable'
    AND project.active_knowledge_space_version_id =
      grant_row.knowledge_space_version_id
) THEN 1 ELSE 0 END`;

export function fenceBindings(
  projectId: string,
  fence: Fence,
  grant: AuthorizedCollaborationGrant,
  now: number,
): Array<number | string> {
  return [
    projectId,
    fence.leaseId,
    fence.fencingToken,
    grant.grantId,
    grant.oauthClientId,
    now,
    now,
    grant.oauthClientId,
  ];
}

function authorityKey(grantId: string): string {
  return `grant:${grantId}`;
}

export async function requestSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeCollaborationJson(value));
}

async function withIntegrity<T extends { integrity: { digest: string } }>(
  value: T,
): Promise<T> {
  const copy = structuredClone(value);
  copy.integrity.digest = await sha256Hex(
    canonicalizeIntegrityPayload(copy as T & Record<string, unknown>),
  );
  return copy;
}

async function verifyPacketIntegrity(packet: WorkPacket): Promise<void> {
  const expected = await sha256Hex(
    canonicalizeIntegrityPayload(
      packet as WorkPacket & Record<string, unknown>,
    ),
  );
  if (expected !== packet.integrity.digest) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
}

export async function authorizeLead(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
  projectId: string,
  fence: Fence,
): Promise<AuthorizedCollaborationGrant> {
  let grant: AuthorizedCollaborationGrant;
  try {
    grant = await authorizeCollaboration(db, storage, input.authorization, {
      now: input.now,
      projectId,
      requiredScope: "project.lead",
    });
  } catch (error) {
    if (error instanceof CollaborationProblem) {
      throw new LeadOperationProblem("grant_invalid");
    }
    throw error;
  }
  const lease = await readProjectLeadLease(db, projectId, input.now);
  if (
    lease === null ||
    lease.lease.status !== "active" ||
    lease.lease.leaseId !== fence.leaseId ||
    lease.lease.fencingToken !== fence.fencingToken ||
    lease.holderGrantId !== grant.grantId ||
    lease.holderClientId !== grant.oauthClientId
  ) {
    throw new LeadOperationProblem("lease_invalid");
  }
  return grant;
}

export async function authorizeLeadRead(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
  },
  projectId: string,
): Promise<AuthorizedCollaborationGrant> {
  try {
    return await authorizeCollaboration(db, storage, input.authorization, {
      now: input.now,
      projectId,
      requiredScope: "project.lead",
    });
  } catch (error) {
    if (error instanceof CollaborationProblem) {
      throw new LeadOperationProblem("grant_invalid");
    }
    throw error;
  }
}

export async function readReceipt(
  db: D1Database,
  input: {
    grantId: string;
    idempotencyKey: string;
    operation: string;
    requestSha256: string;
  },
): Promise<ReceiptReplay | null> {
  const idempotencyKeySha256 = await sha256Hex(input.idempotencyKey);
  const row = await db
    .prepare(
      `SELECT request_sha256, result_json
       FROM project_operation_receipts
       WHERE authority_key = ? AND operation = ?
         AND idempotency_key_sha256 = ?`,
    )
    .bind(authorityKey(input.grantId), input.operation, idempotencyKeySha256)
    .first<{ request_sha256: string; result_json: string }>();
  if (row === null) return null;
  if (row.request_sha256 !== input.requestSha256) {
    throw new LeadOperationProblem("idempotency_conflict");
  }
  let value: unknown;
  try {
    value = JSON.parse(row.result_json) as unknown;
  } catch {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  return {
    idempotencyKeySha256,
    result: value as Record<string, unknown>,
  };
}

export function replayResult(replay: ReceiptReplay): Record<string, unknown> {
  const failure = replay.result.__owdR2Failure;
  if (
    typeof failure === "string" &&
    PROBLEM_CODES.has(failure as LeadOperationProblemCode)
  ) {
    throw new LeadOperationProblem(failure as LeadOperationProblemCode);
  }
  return replay.result;
}

export function receiptStatement(
  db: D1Database,
  input: {
    extraFence?: { bindings: Array<number | string>; sql: string };
    fence: Fence;
    grant: AuthorizedCollaborationGrant;
    idempotencyKeySha256: string;
    now: number;
    operation: string;
    projectId: string;
    requestSha256: string;
    result: Record<string, unknown>;
  },
): D1PreparedStatement {
  const liveFenceSql =
    input.extraFence === undefined
      ? LIVE_FENCE_SQL
      : `CASE WHEN (${LIVE_FENCE_SQL}) = 1 AND (${input.extraFence.sql})
          THEN 1 ELSE 0 END`;
  return db
    .prepare(
      `INSERT INTO project_operation_receipts (
        authority_key, operation, idempotency_key_sha256, request_sha256,
        project_id, result_json, source_lease_id, source_fencing_token,
        live_fence_valid, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${liveFenceSql}, ?)`,
    )
    .bind(
      authorityKey(input.grant.grantId),
      input.operation,
      input.idempotencyKeySha256,
      input.requestSha256,
      input.projectId,
      canonicalizeCollaborationJson(input.result),
      input.fence.leaseId,
      input.fence.fencingToken,
      ...fenceBindings(input.projectId, input.fence, input.grant, input.now),
      ...(input.extraFence?.bindings ?? []),
      input.now,
    );
}

export function auditStatement(
  db: D1Database,
  eventType: string,
  requestId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (id, event_type, request_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), eventType, requestId, now);
}

function dependencyStatement(
  db: D1Database,
  recordId: string,
  dependencyId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collaboration_dependencies (
        record_id, dependency_id, dependency_kind
      ) VALUES (?, ?, 'record')`,
    )
    .bind(recordId, dependencyId);
}

function defaultPolicy(
  projectId: string,
  projectVersionId: string,
  now: number,
): ProjectPolicy {
  return projectPolicySchema.parse({
    createdAt: now,
    exceptionOnlyActions: [
      "authority-expansion",
      "destructive-action",
      "protected-path-access",
    ],
    format: "owd-project-policy-v1",
    independentReviewRequired: true,
    liveAuthorityIncluded: false,
    maxActorsPerRun: MAX_R2_ACTORS_PER_RUN,
    maxBundleBytes: 262_144,
    maxBundlesPerRun: MAX_R2_BUNDLES_PER_RUN,
    maxEventsPerBundle: 16,
    maxRunLogicalBytes: MAX_R2_RUN_LOGICAL_BYTES,
    policyId: crypto.randomUUID(),
    projectId,
    projectVersionId,
    protectedPaths: [".git", ".owdignore", ".obsidian"],
    restoredAuthorityAllowed: false,
    schemaVersion: 1,
    source: "project-version-bound-default",
  });
}

function policyProjectionStatement(
  db: D1Database,
  policy: ProjectPolicy,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_operation_policies (
        policy_id, operation_record_id, project_id, project_version_id,
        max_actors_per_run, max_bundles_per_run, max_events_per_bundle,
        max_bundle_bytes, max_run_logical_bytes, independent_review_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      policy.policyId,
      policy.policyId,
      policy.projectId,
      policy.projectVersionId,
      policy.maxActorsPerRun,
      policy.maxBundlesPerRun,
      policy.maxEventsPerBundle,
      policy.maxBundleBytes,
      policy.maxRunLogicalBytes,
    );
}

async function resolveStandingPolicy(
  db: D1Database,
  storage: R2Bucket,
  input: { now: number; projectId: string; projectVersionId: string },
): Promise<{
  policy: ProjectPolicy;
  prepared: PreparedLeadOperationRecord | null;
}> {
  const row = await db
    .prepare(
      `SELECT policy.policy_id
       FROM project_operation_policies policy
       JOIN project_operation_records record
         ON record.operation_record_id = policy.operation_record_id
       WHERE policy.project_id = ? AND policy.project_version_id = ?
         AND record.restore_state = 'live'
       LIMIT 1`,
    )
    .bind(input.projectId, input.projectVersionId)
    .first<{ policy_id: string }>();
  if (row !== null) {
    const existing = await readLeadOperationRecord(db, storage, row.policy_id);
    if (
      existing?.format !== "owd-project-policy-v1" ||
      existing.projectId !== input.projectId ||
      existing.projectVersionId !== input.projectVersionId
    ) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    return { policy: existing, prepared: null };
  }
  const policy = defaultPolicy(
    input.projectId,
    input.projectVersionId,
    input.now,
  );
  return {
    policy,
    prepared: await prepareLeadOperationRecord(storage, {
      now: input.now,
      record: policy,
    }),
  };
}

export function makeException(input: {
  actorId?: string | null;
  evidenceRefs?: string[];
  kind: ProjectException["kind"];
  normalizedRelativePath?: string | null;
  now: number;
  projectId: string;
  requestedAction?: ProjectException["requestedAction"];
  runId?: string | null;
  summary: string;
  workItemId?: string | null;
}): ProjectException {
  return projectExceptionSchema.parse({
    actorId: input.actorId ?? null,
    createdAt: input.now,
    evidenceRefs: input.evidenceRefs ?? [],
    exceptionId: crypto.randomUUID(),
    format: "owd-project-exception-v1",
    kind: input.kind,
    normalizedRelativePath: input.normalizedRelativePath ?? null,
    projectId: input.projectId,
    requestedAction: input.requestedAction ?? null,
    resolvedAt: null,
    runId: input.runId ?? null,
    schemaVersion: 1,
    status: "blocking",
    summary: input.summary,
    workItemId: input.workItemId ?? null,
  });
}

export function exceptionProjectionStatement(
  db: D1Database,
  input: {
    exception: ProjectException;
    fence: Fence;
    grant: AuthorizedCollaborationGrant;
    now: number;
  },
): D1PreparedStatement {
  const exception = input.exception;
  return db
    .prepare(
      `INSERT INTO project_exceptions (
        exception_id, operation_record_id, project_id, run_id, work_item_id,
        actor_id, kind, status, requested_action, normalized_relative_path,
        evidence_refs_json, created_at, resolved_at, source_lease_id,
        source_fencing_token, live_fence_valid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ${LIVE_FENCE_SQL})`,
    )
    .bind(
      exception.exceptionId,
      exception.exceptionId,
      exception.projectId,
      exception.runId,
      exception.workItemId,
      exception.actorId,
      exception.kind,
      exception.status,
      exception.requestedAction,
      exception.normalizedRelativePath,
      JSON.stringify(exception.evidenceRefs),
      exception.createdAt,
      exception.resolvedAt,
      input.fence.leaseId,
      input.fence.fencingToken,
      ...fenceBindings(
        exception.projectId,
        input.fence,
        input.grant,
        input.now,
      ),
    );
}

export async function persistDeniedException(
  db: D1Database,
  storage: R2Bucket,
  input: {
    exception: ProjectException;
    fence: Fence;
    grant: AuthorizedCollaborationGrant;
    idempotencyKeySha256: string;
    now: number;
    operation: string;
    requestSha256: string;
  },
): Promise<void> {
  const prepared = await prepareLeadOperationRecord(storage, {
    now: input.now,
    record: input.exception,
  });
  const result = {
    __owdR2Failure:
      input.exception.kind === "budget-exhausted"
        ? "budget_exhausted"
        : input.exception.kind === "review-independence"
          ? "review_independence"
          : "scope_required",
  };
  try {
    await db.batch([
      insertLeadOperationRecordStatement(db, prepared),
      exceptionProjectionStatement(db, input),
      receiptStatement(db, {
        extraFence: {
          bindings: [input.exception.exceptionId],
          sql: `EXISTS (
            SELECT 1 FROM project_exceptions WHERE exception_id = ?
          )`,
        },
        fence: input.fence,
        grant: input.grant,
        idempotencyKeySha256: input.idempotencyKeySha256,
        now: input.now,
        operation: input.operation,
        projectId: input.exception.projectId,
        requestSha256: input.requestSha256,
        result,
      }),
      auditStatement(
        db,
        `lead_operation.${input.exception.kind}`,
        input.idempotencyKeySha256,
        input.now,
      ),
    ]);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [prepared.bodyObjectKey],
      input.now,
    );
    throw error;
  }
}

export async function readRunRow(
  db: D1Database,
  projectId: string,
  runId: string,
): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT run_id, project_id, work_item_id, work_packet_id, policy_id,
        purpose, status, created_at, completed_at, completion_outcome,
        actor_count, bundle_count, logical_bytes
       FROM project_runs WHERE run_id = ? AND project_id = ?`,
    )
    .bind(runId, projectId)
    .first<RunRow>();
}

function currentRun(row: RunRow): Run {
  return runSchema.parse({
    completedAt: row.completed_at,
    createdAt: row.created_at,
    format: "owd-run-v1",
    logicalBytes: row.logical_bytes,
    policyId: row.policy_id,
    projectId: row.project_id,
    purpose: row.purpose,
    runId: row.run_id,
    schemaVersion: 1,
    status: row.status,
    workItemId: row.work_item_id,
  });
}

export async function readActorRow(
  db: D1Database,
  input: { actorId: string; projectId: string; runId: string },
): Promise<ActorRow | null> {
  return db
    .prepare(
      `SELECT actor_id, run_id, scopes_json, status, expires_at, revoked_at
       FROM project_actors
       WHERE actor_id = ? AND project_id = ? AND run_id = ?`,
    )
    .bind(input.actorId, input.projectId, input.runId)
    .first<ActorRow>();
}

export function actorScopes(row: ActorRow): Actor["scopes"] {
  let value: unknown;
  try {
    value = JSON.parse(row.scopes_json) as unknown;
  } catch {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  const parsed = leadOperationScopeSchema
    .array()
    .min(1)
    .max(3)
    .safeParse(value);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  return parsed.data;
}

async function readPinnedPacket(
  db: D1Database,
  storage: R2Bucket,
  input: {
    packetId: string;
    projectId: string;
    workItemId: string;
  },
): Promise<WorkPacket> {
  const usable = await db
    .prepare(
      `SELECT 1 AS found
       FROM collaboration_records record
       JOIN collaboration_record_states state ON state.record_id = record.id
       WHERE record.id = ? AND record.record_type = 'work-packet'
         AND record.project_id = ? AND record.work_item_id = ?
         AND record.restored_at IS NULL AND state.disposition = 'accepted'`,
    )
    .bind(input.packetId, input.projectId, input.workItemId)
    .first();
  if (usable === null) throw new LeadOperationProblem("integrity_mismatch");
  const stored = await readCollaborationRecord(db, storage, input.packetId);
  if (
    stored?.record.recordType !== "work-packet" ||
    stored.record.packetId !== input.packetId ||
    stored.record.projectId !== input.projectId ||
    stored.record.workItemId !== input.workItemId
  ) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  await verifyPacketIntegrity(stored.record);
  return stored.record;
}

async function readNewestUsablePacket(
  db: D1Database,
  storage: R2Bucket,
  input: {
    knowledgeSpaceVersionId: string;
    now: number;
    projectId: string;
    projectVersionId: string;
    workItemId: string;
    workItemVersionId: string;
  },
): Promise<WorkPacket> {
  const rows = await db
    .prepare(
      `SELECT record.id
       FROM collaboration_records record
       JOIN collaboration_record_states state ON state.record_id = record.id
       WHERE record.record_type = 'work-packet' AND record.project_id = ?
         AND record.work_item_id = ? AND record.restored_at IS NULL
         AND state.disposition = 'accepted'
       ORDER BY record.received_at DESC, record.id DESC LIMIT 16`,
    )
    .bind(input.projectId, input.workItemId)
    .all<{ id: string }>();
  for (const row of rows.results) {
    const stored = await readCollaborationRecord(db, storage, row.id);
    if (stored?.record.recordType !== "work-packet") continue;
    const packet = stored.record;
    if (
      packet.projectVersionId !== input.projectVersionId ||
      packet.knowledgeSpaceVersionId !== input.knowledgeSpaceVersionId ||
      packet.workItemVersionId !== input.workItemVersionId ||
      packet.expiresAt <= input.now
    ) {
      continue;
    }
    await verifyPacketIntegrity(packet);
    return packet;
  }
  throw new LeadOperationProblem("work_item_invalid");
}

export async function createLeadWorkItem(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
): Promise<Record<string, unknown>> {
  const parsed = createWorkItemRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const fence = {
    fencingToken: request.fencingToken,
    leaseId: request.leaseId,
  };
  const grant = await authorizeLead(
    db,
    storage,
    input,
    request.projectId,
    fence,
  );
  const requestDigest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "create_work_item",
    requestSha256: requestDigest,
  });
  if (replay !== null) return replayResult(replay);
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const project = await db
    .prepare(
      `SELECT active_project_version_id, active_knowledge_space_version_id,
        status
       FROM collaboration_projects WHERE project_id = ?`,
    )
    .bind(request.projectId)
    .first<{
      active_knowledge_space_version_id: string;
      active_project_version_id: string;
      status: string;
    }>();
  if (project === null || project.status !== "active") {
    throw new LeadOperationProblem("project_invalid");
  }

  const workItemId = crypto.randomUUID();
  const workItemVersionId = crypto.randomUUID();
  const packetId = crypto.randomUUID();
  const workItem = {
    createdAt: input.now,
    projectId: request.projectId,
    recordType: "work-item" as const,
    schemaVersion: 1 as const,
    workItemId,
  };
  const workItemVersion = {
    brief: request.workItemBrief,
    createdAt: input.now,
    previousVersionId: null,
    projectId: request.projectId,
    recordType: "work-item-version" as const,
    schemaVersion: 1 as const,
    version: 1,
    workItemId,
    workItemVersionId,
  };
  const packet = workPacketSchema.parse(
    await withIntegrity({
      brief: request.workItemBrief,
      createdAt: input.now,
      evidenceObjects: [],
      excluded: [],
      expiresAt: input.now + request.packetExpiresInSeconds,
      format: "owd-work-packet-v1" as const,
      includedRecords: [],
      integrity: {
        algorithm: "sha-256-jcs-rfc8785" as const,
        digest: "0".repeat(64),
        scope: "object-with-integrity-digest-omitted" as const,
      },
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      outputContract: {
        acceptedMediaTypes: ["text/markdown", "application/json"] as const,
        acceptedRecordTypes: [
          "attempt",
          "artifact",
          "handoff",
          "review",
        ] as const,
        maxSubmissionBytes: 1024 * 1024,
        submissionFormat: "owd-collaboration-submission-v1" as const,
      },
      packetId,
      projectId: request.projectId,
      projectVersionId: project.active_project_version_id,
      recordType: "work-packet" as const,
      requestedRole: request.requestedRole,
      schemaVersion: 1 as const,
      sourceCitations: [],
      truncationNotices: [],
      workItemId,
      workItemVersionId,
    }),
  );
  const prepared = await Promise.all(
    [workItem, workItemVersion, packet].map((record) =>
      prepareCollaborationRecord(storage, {
        historicalGrantId: grant.grantId,
        now: input.now,
        producerClientId: grant.oauthClientId,
        record,
      }),
    ),
  );
  const result = {
    idempotencyKey: request.idempotencyKey,
    operation: "create_work_item",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: requestDigest,
    workItemId,
  };
  const statements: D1PreparedStatement[] = [];
  for (const record of prepared) {
    statements.push(
      insertRecordStatement(db, record),
      insertStateStatement(db, {
        changedAt: input.now,
        disposition: "accepted",
        recordId: record.metadata.id,
        visibility: "owner-only",
      }),
    );
  }
  statements.push(
    dependencyStatement(db, workItemId, request.projectId),
    dependencyStatement(db, workItemVersionId, request.projectId),
    dependencyStatement(db, workItemVersionId, workItemId),
    dependencyStatement(db, packetId, request.projectId),
    dependencyStatement(db, packetId, project.active_project_version_id),
    dependencyStatement(
      db,
      packetId,
      project.active_knowledge_space_version_id,
    ),
    dependencyStatement(db, packetId, workItemId),
    dependencyStatement(db, packetId, workItemVersionId),
    db
      .prepare(
        `INSERT INTO collaboration_work_items (
          work_item_id, project_id, active_work_item_version_id,
          status, created_at
        ) VALUES (?, ?, ?, 'open', ?)`,
      )
      .bind(workItemId, request.projectId, workItemVersionId, input.now),
    receiptStatement(db, {
      extraFence: {
        bindings: [workItemId, request.projectId],
        sql: `EXISTS (
          SELECT 1 FROM collaboration_work_items
          WHERE work_item_id = ? AND project_id = ? AND status = 'open'
        )`,
      },
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "create_work_item",
      projectId: request.projectId,
      requestSha256: requestDigest,
      result,
    }),
    auditStatement(
      db,
      "lead_operation.work_item_created",
      idempotencyKeySha256,
      input.now,
    ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      prepared.map((record) => record.metadata.bodyObjectKey),
      input.now,
    );
    throw error;
  }
  return result;
}

export async function startLeadRun(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
): Promise<Record<string, unknown>> {
  const parsed = startRunRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const fence = {
    fencingToken: request.fencingToken,
    leaseId: request.leaseId,
  };
  const grant = await authorizeLead(
    db,
    storage,
    input,
    request.projectId,
    fence,
  );
  const requestDigest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "start_run",
    requestSha256: requestDigest,
  });
  if (replay !== null) return replayResult(replay);
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const current = await db
    .prepare(
      `SELECT item.status, item.active_work_item_version_id,
        project.active_project_version_id,
        project.active_knowledge_space_version_id
       FROM collaboration_work_items item
       JOIN collaboration_projects project
         ON project.project_id = item.project_id
       WHERE item.work_item_id = ? AND item.project_id = ?
         AND project.status = 'active'`,
    )
    .bind(request.workItemId, request.projectId)
    .first<{
      active_knowledge_space_version_id: string;
      active_project_version_id: string;
      active_work_item_version_id: string;
      status: string;
    }>();
  if (current === null || current.status !== "open") {
    throw new LeadOperationProblem("work_item_invalid");
  }
  const packet = await readNewestUsablePacket(db, storage, {
    knowledgeSpaceVersionId: current.active_knowledge_space_version_id,
    now: input.now,
    projectId: request.projectId,
    projectVersionId: current.active_project_version_id,
    workItemId: request.workItemId,
    workItemVersionId: current.active_work_item_version_id,
  });
  const standing = await resolveStandingPolicy(db, storage, {
    now: input.now,
    projectId: request.projectId,
    projectVersionId: current.active_project_version_id,
  });
  const run = runSchema.parse({
    completedAt: null,
    createdAt: input.now,
    format: "owd-run-v1",
    logicalBytes: 0,
    policyId: standing.policy.policyId,
    projectId: request.projectId,
    purpose: request.purpose,
    runId: crypto.randomUUID(),
    schemaVersion: 1,
    status: "active",
    workItemId: request.workItemId,
  });
  const preparedRun = await prepareLeadOperationRecord(storage, {
    now: input.now,
    record: run,
  });
  const elastic =
    request.elastic === undefined
      ? null
      : {
          account: elasticAccountSchema.parse({
            acceptedBundleCount: 0,
            accountId: crypto.randomUUID(),
            activeActorCount: 0,
            actorRecordCount: 0,
            authority: {
              liveAuthorityIncluded: false,
              restoredAuthorityAllowed: false,
            },
            format: "owd-elastic-account-v1",
            metadata: {
              retentionTier: "hot",
              retainUntil: input.now + R3_HOT_RETENTION_SECONDS,
            },
            projectId: request.projectId,
            runId: run.runId,
            schemaVersion: 1,
            updatedAt: input.now,
          }),
          budget: runBudgetSchema.parse({
            authority: {
              liveAuthorityIncluded: false,
              restoredAuthorityAllowed: false,
            },
            budgetId: crypto.randomUUID(),
            costMicrounitLimit: DEFAULT_R3_COST_MICROUNIT_LIMIT,
            costMicrounitsUsed: 0,
            format: "owd-run-budget-v1",
            logicalUnitLimit: DEFAULT_R3_LOGICAL_UNIT_LIMIT,
            logicalUnitsUsed: 0,
            metadata: {
              retentionTier: "warm",
              retainUntil: input.now + R3_WARM_RETENTION_SECONDS,
            },
            projectId: request.projectId,
            runId: run.runId,
            schemaVersion: 1,
            updatedAt: input.now,
          }),
          plane: elasticRunPlaneSchema.parse({
            authority: {
              liveAuthorityIncluded: false,
              restoredAuthorityAllowed: false,
            },
            createdAt: input.now,
            format: "owd-elastic-run-plane-v1",
            profile: {
              authority: {
                liveAuthorityIncluded: false,
                restoredAuthorityAllowed: false,
              },
              maxActiveActors: MAX_R3_ACTIVE_ACTORS,
              maxActorRecords: MAX_R3_ACTOR_RECORDS,
              maxBundleBatch: MAX_R3_BUNDLE_BATCH,
              maxDeltaPage: MAX_R3_DELTA_PAGE,
              maxRegisterBatch: MAX_R3_REGISTER_BATCH,
              profile: "owd-elastic-run-plane-v1",
            },
            projectId: request.projectId,
            retention: {
              retentionTier: "hot",
              retainUntil: input.now + R3_HOT_RETENTION_SECONDS,
            },
            runId: run.runId,
            schemaVersion: 1,
          }),
        };
  const preparedElastic =
    elastic === null
      ? []
      : await Promise.all(
          [elastic.plane, elastic.account, elastic.budget].map((record) =>
            prepareElasticOperationRecord(storage, {
              now: input.now,
              record,
            }),
          ),
        );
  const result = {
    idempotencyKey: request.idempotencyKey,
    operation: "start_run",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: requestDigest,
    run,
    ...(elastic === null
      ? {}
      : {
          elastic: {
            budget: elastic.budget,
            plane: elastic.plane,
          },
        }),
  };
  const statements: D1PreparedStatement[] = [];
  if (standing.prepared !== null) {
    statements.push(
      insertLeadOperationRecordStatement(db, standing.prepared),
      policyProjectionStatement(db, standing.policy),
    );
  }
  statements.push(
    insertLeadOperationRecordStatement(db, preparedRun),
    db
      .prepare(
        `INSERT INTO project_runs (
          run_id, operation_record_id, project_id, work_item_id,
          work_packet_id, policy_id, source_lease_id, source_fencing_token,
          live_fence_valid, purpose, status, created_at,
          max_actors_per_run, max_bundles_per_run, max_events_per_bundle,
          max_bundle_bytes, max_run_logical_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${LIVE_FENCE_SQL},
          ?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.runId,
        preparedRun.operationRecordId,
        request.projectId,
        request.workItemId,
        packet.packetId,
        standing.policy.policyId,
        fence.leaseId,
        fence.fencingToken,
        ...fenceBindings(request.projectId, fence, grant, input.now),
        request.purpose,
        input.now,
        standing.policy.maxActorsPerRun,
        standing.policy.maxBundlesPerRun,
        standing.policy.maxEventsPerBundle,
        standing.policy.maxBundleBytes,
        standing.policy.maxRunLogicalBytes,
      ),
    ...preparedElastic.map((prepared) =>
      insertElasticOperationRecordStatement(db, prepared),
    ),
    ...(elastic === null
      ? []
      : [
          db
            .prepare(
              `INSERT INTO project_elastic_planes (
                run_id, elastic_record_id, project_id, profile,
                max_active_actors, max_actor_records, max_register_batch,
                max_bundle_batch, max_delta_page, active_actor_count,
                actor_record_count, created_at, updated_at, retention_tier,
                retain_until
              ) VALUES (?, ?, ?, 'owd-elastic-run-plane-v1', ?, ?, ?, ?, ?,
                0, 0, ?, ?, ?, ?)`,
            )
            .bind(
              run.runId,
              preparedElastic[0]?.elasticRecordId,
              request.projectId,
              MAX_R3_ACTIVE_ACTORS,
              MAX_R3_ACTOR_RECORDS,
              MAX_R3_REGISTER_BATCH,
              MAX_R3_BUNDLE_BATCH,
              MAX_R3_DELTA_PAGE,
              input.now,
              input.now,
              elastic.plane.retention.retentionTier,
              elastic.plane.retention.retainUntil,
            ),
          db
            .prepare(
              `INSERT INTO project_elastic_accounts (
                account_id, elastic_record_id, project_id, run_id,
                active_actor_count, actor_record_count, accepted_bundle_count,
                updated_at, retention_tier, retain_until
              ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
            )
            .bind(
              elastic.account.accountId,
              preparedElastic[1]?.elasticRecordId,
              request.projectId,
              run.runId,
              input.now,
              elastic.account.metadata.retentionTier,
              elastic.account.metadata.retainUntil,
            ),
          db
            .prepare(
              `INSERT INTO project_run_budgets (
                budget_id, elastic_record_id, project_id, run_id,
                logical_unit_limit, cost_microunit_limit, logical_units_used,
                cost_microunits_used, updated_at, retention_tier, retain_until
              ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
            )
            .bind(
              elastic.budget.budgetId,
              preparedElastic[2]?.elasticRecordId,
              request.projectId,
              run.runId,
              elastic.budget.logicalUnitLimit,
              elastic.budget.costMicrounitLimit,
              input.now,
              elastic.budget.metadata.retentionTier,
              elastic.budget.metadata.retainUntil,
            ),
          db
            .prepare(
              `INSERT INTO project_run_budget_versions (
                budget_id, budget_version, logical_units_used,
                cost_microunits_used, recorded_at
              ) VALUES (?, 0, 0, 0, ?)`,
            )
            .bind(elastic.budget.budgetId, input.now),
        ]),
    receiptStatement(db, {
      extraFence: {
        bindings: [run.runId, request.projectId, packet.packetId],
        sql: `EXISTS (
          SELECT 1 FROM project_runs
          WHERE run_id = ? AND project_id = ? AND work_packet_id = ?
            AND status = 'active'
        )`,
      },
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "start_run",
      projectId: request.projectId,
      requestSha256: requestDigest,
      result,
    }),
    auditStatement(
      db,
      "lead_operation.run_started",
      idempotencyKeySha256,
      input.now,
    ),
  );
  const objectKeys = [
    preparedRun.bodyObjectKey,
    ...(standing.prepared === null ? [] : [standing.prepared.bodyObjectKey]),
    ...preparedElastic.map((prepared) => prepared.bodyObjectKey),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(db, objectKeys, input.now);
    const concurrentReplay = await readReceipt(db, {
      grantId: grant.grantId,
      idempotencyKey: request.idempotencyKey,
      operation: "start_run",
      requestSha256: requestDigest,
    });
    if (concurrentReplay !== null) return replayResult(concurrentReplay);
    throw error;
  }
  return result;
}

export async function registerRunActor(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
): Promise<Record<string, unknown>> {
  const parsed = registerActorRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const fence = {
    fencingToken: request.fencingToken,
    leaseId: request.leaseId,
  };
  const grant = await authorizeLead(
    db,
    storage,
    input,
    request.projectId,
    fence,
  );
  const requestDigest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "register_actor",
    requestSha256: requestDigest,
  });
  if (replay !== null) return replayResult(replay);
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const run = await readRunRow(db, request.projectId, request.runId);
  if (
    run === null ||
    run.status !== "active" ||
    run.work_item_id !== request.workItemId
  ) {
    throw new LeadOperationProblem("run_invalid");
  }
  if (await isElasticRun(db, request.projectId, request.runId)) {
    throw new LeadOperationProblem("submission_invalid");
  }
  if (run.actor_count >= MAX_R2_ACTORS_PER_RUN) {
    const exception = makeException({
      kind: "budget-exhausted",
      now: input.now,
      projectId: request.projectId,
      runId: request.runId,
      summary: `The Run actor budget is exhausted; actor ${request.actorId} was not registered.`,
      workItemId: request.workItemId,
    });
    await persistDeniedException(db, storage, {
      exception,
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "register_actor",
      requestSha256: requestDigest,
    });
    throw new LeadOperationProblem("budget_exhausted");
  }
  if (
    (await db
      .prepare(`SELECT 1 AS found FROM project_actors WHERE actor_id = ?`)
      .bind(request.actorId)
      .first()) !== null
  ) {
    throw new LeadOperationProblem("actor_invalid");
  }
  const lease = await readProjectLeadLease(db, request.projectId, input.now);
  const expiresAt = Math.min(
    input.now + request.lifetimeSeconds,
    lease?.lease.expiresAt ?? input.now,
  );
  if (expiresAt <= input.now) {
    throw new LeadOperationProblem("lease_invalid");
  }
  const actor = actorSchema.parse({
    actorId: request.actorId,
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    claimedIdentity: request.claimedIdentity,
    expiresAt,
    format: "owd-actor-v1",
    issuedAt: input.now,
    projectId: request.projectId,
    revokedAt: null,
    runId: request.runId,
    schemaVersion: 1,
    scopes: request.scopes,
    workItemId: request.workItemId,
  });
  const prepared = await prepareLeadOperationRecord(storage, {
    now: input.now,
    record: actor,
  });
  const result = {
    actor,
    idempotencyKey: request.idempotencyKey,
    operation: "register_actor",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: requestDigest,
  };
  try {
    await db.batch([
      insertLeadOperationRecordStatement(db, prepared),
      db
        .prepare(
          `INSERT INTO project_actors (
            actor_id, operation_record_id, project_id, run_id, work_item_id,
            claimed_identity, scopes_json, status, issued_at, expires_at,
            revoked_at, source_lease_id, source_fencing_token, live_fence_valid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?,
            ${LIVE_FENCE_SQL})`,
        )
        .bind(
          actor.actorId,
          prepared.operationRecordId,
          actor.projectId,
          actor.runId,
          actor.workItemId,
          actor.claimedIdentity,
          JSON.stringify(actor.scopes),
          actor.issuedAt,
          actor.expiresAt,
          fence.leaseId,
          fence.fencingToken,
          ...fenceBindings(request.projectId, fence, grant, input.now),
        ),
      db
        .prepare(
          `UPDATE project_runs SET actor_count = actor_count + 1
           WHERE run_id = ? AND project_id = ? AND status = 'active'`,
        )
        .bind(request.runId, request.projectId),
      receiptStatement(db, {
        extraFence: {
          bindings: [actor.actorId, actor.runId],
          sql: `EXISTS (
            SELECT 1 FROM project_actors
            WHERE actor_id = ? AND run_id = ? AND status = 'active'
          )`,
        },
        fence,
        grant,
        idempotencyKeySha256,
        now: input.now,
        operation: "register_actor",
        projectId: request.projectId,
        requestSha256: requestDigest,
        result,
      }),
      auditStatement(
        db,
        "lead_operation.actor_registered",
        idempotencyKeySha256,
        input.now,
      ),
    ]);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [prepared.bodyObjectKey],
      input.now,
    );
    throw error;
  }
  return result;
}

async function persistScopeOrReviewDenial(
  db: D1Database,
  storage: R2Bucket,
  input: {
    actorId: string;
    code: "review_independence" | "scope_required";
    fence: Fence;
    grant: AuthorizedCollaborationGrant;
    idempotencyKeySha256: string;
    now: number;
    projectId: string;
    requestSha256: string;
    run: RunRow;
    summary: string;
  },
): Promise<never> {
  const exception = makeException({
    actorId: input.actorId,
    kind:
      input.code === "review_independence"
        ? "review-independence"
        : "actor-scope",
    now: input.now,
    projectId: input.projectId,
    runId: input.run.run_id,
    summary: input.summary,
    workItemId: input.run.work_item_id,
  });
  await persistDeniedException(db, storage, {
    exception,
    fence: input.fence,
    grant: input.grant,
    idempotencyKeySha256: input.idempotencyKeySha256,
    now: input.now,
    operation: "submit_bundle",
    requestSha256: input.requestSha256,
  });
  throw new LeadOperationProblem(input.code);
}

export async function submitRunBundle(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
): Promise<Record<string, unknown>> {
  const parsed = submitBundleRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const bundle = eventBundleSchema.parse(request.bundle);
  const fence = {
    fencingToken: request.fencingToken,
    leaseId: request.leaseId,
  };
  const grant = await authorizeLead(
    db,
    storage,
    input,
    request.projectId,
    fence,
  );
  const requestDigest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "submit_bundle",
    requestSha256: requestDigest,
  });
  if (replay !== null) return replayResult(replay);
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const run = await readRunRow(db, request.projectId, request.runId);
  if (run === null || run.status !== "active") {
    throw new LeadOperationProblem("run_invalid");
  }
  if (await isElasticRun(db, request.projectId, request.runId)) {
    throw new LeadOperationProblem("submission_invalid");
  }
  const actor = await readActorRow(db, {
    actorId: bundle.actorId,
    projectId: request.projectId,
    runId: request.runId,
  });
  if (
    actor === null ||
    actor.status !== "active" ||
    actor.expires_at <= input.now
  ) {
    throw new LeadOperationProblem("actor_invalid");
  }
  const scopes = actorScopes(actor);
  const reviewRequests = bundle.events.filter(
    (event) => event.eventType === "review.requested",
  );
  const reviewResults = bundle.events.filter(
    (event) => event.eventType === "review.completed",
  );
  if (reviewRequests.length > 1 || reviewResults.length > 1) {
    throw new LeadOperationProblem("bundle_invalid");
  }
  const requiresBundleScope = bundle.events.some(
    (event) => event.eventType !== "review.completed",
  );
  const requiresReviewScope = reviewResults.length === 1;
  if (
    (requiresBundleScope && !scopes.includes("run.bundle.submit")) ||
    (requiresReviewScope && !scopes.includes("run.review.submit"))
  ) {
    return persistScopeOrReviewDenial(db, storage, {
      actorId: bundle.actorId,
      code: "scope_required",
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      projectId: request.projectId,
      requestSha256: requestDigest,
      run,
      summary:
        "The claimed actor requested an operation outside its Run scopes.",
    });
  }

  const reviewRequest = reviewRequests[0];
  if (reviewRequest !== undefined) {
    const target = await db
      .prepare(
        `SELECT actor_id FROM project_event_bundles
         WHERE bundle_id = ? AND run_id = ? AND project_id = ?
           AND has_provisional_result = 1`,
      )
      .bind(reviewRequest.targetBundleId, request.runId, request.projectId)
      .first<{ actor_id: string }>();
    const reviewer = await readActorRow(db, {
      actorId: reviewRequest.reviewerActorId,
      projectId: request.projectId,
      runId: request.runId,
    });
    if (
      target === null ||
      reviewer === null ||
      reviewer.status !== "active" ||
      reviewer.expires_at <= input.now ||
      target.actor_id === reviewRequest.reviewerActorId ||
      !actorScopes(reviewer).includes("run.review.submit")
    ) {
      return persistScopeOrReviewDenial(db, storage, {
        actorId: bundle.actorId,
        code: "review_independence",
        fence,
        grant,
        idempotencyKeySha256,
        now: input.now,
        projectId: request.projectId,
        requestSha256: requestDigest,
        run,
        summary:
          "The review request did not target an independent, active reviewer in this Run.",
      });
    }
  }

  const reviewResult = reviewResults[0];
  if (reviewResult !== undefined) {
    const routing = await db
      .prepare(
        `SELECT target.actor_id AS target_actor_id
         FROM project_event_bundles target
         JOIN project_event_bundles request_bundle
           ON request_bundle.run_id = target.run_id
          AND request_bundle.review_request_target_bundle_id = target.bundle_id
          AND request_bundle.requested_reviewer_actor_id = ?
         WHERE target.bundle_id = ? AND target.run_id = ?
           AND target.project_id = ? AND target.has_provisional_result = 1
         LIMIT 1`,
      )
      .bind(
        bundle.actorId,
        reviewResult.targetBundleId,
        request.runId,
        request.projectId,
      )
      .first<{ target_actor_id: string }>();
    if (routing === null || routing.target_actor_id === bundle.actorId) {
      return persistScopeOrReviewDenial(db, storage, {
        actorId: bundle.actorId,
        code: "review_independence",
        fence,
        grant,
        idempotencyKeySha256,
        now: input.now,
        projectId: request.projectId,
        requestSha256: requestDigest,
        run,
        summary:
          "The review result was not submitted by the independently routed reviewer.",
      });
    }
  }

  if (
    (await db
      .prepare(
        `SELECT 1 AS found FROM project_event_bundles WHERE bundle_id = ?`,
      )
      .bind(bundle.bundleId)
      .first()) !== null
  ) {
    throw new LeadOperationProblem("idempotency_conflict");
  }
  const preparedBundle = await prepareLeadOperationRecord(storage, {
    now: input.now,
    record: bundle,
  });
  if (
    run.bundle_count >= MAX_R2_BUNDLES_PER_RUN ||
    run.logical_bytes + preparedBundle.byteLength > MAX_R2_RUN_LOGICAL_BYTES
  ) {
    await queueCollaborationObjectCleanup(
      db,
      [preparedBundle.bodyObjectKey],
      input.now,
    );
    const exception = makeException({
      actorId: bundle.actorId,
      kind: "budget-exhausted",
      now: input.now,
      projectId: request.projectId,
      runId: request.runId,
      summary: "The Run bundle or logical-byte budget is exhausted.",
      workItemId: run.work_item_id,
    });
    await persistDeniedException(db, storage, {
      exception,
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "submit_bundle",
      requestSha256: requestDigest,
    });
    throw new LeadOperationProblem("budget_exhausted");
  }

  const claims = bundle.events.flatMap((event) =>
    event.eventType === "result.provisional" ? event.claims : [],
  );
  const uniqueClaims = [
    ...new Map(
      claims.map((claim) => [`${claim.key}\u0000${claim.valueSha256}`, claim]),
    ).values(),
  ];
  const claimKeys = [...new Set(uniqueClaims.map((claim) => claim.key))];
  const existingClaims =
    claimKeys.length === 0
      ? { results: [] as Array<{ claim_key: string; value_sha256: string }> }
      : await db
          .prepare(
            `SELECT claim_key, value_sha256 FROM project_run_claims
             WHERE run_id = ? AND claim_key IN (
               SELECT value FROM json_each(?) WHERE type = 'text'
             )`,
          )
          .bind(request.runId, JSON.stringify(claimKeys))
          .all<{ claim_key: string; value_sha256: string }>();
  const valuesByKey = new Map<string, Set<string>>();
  for (const claim of [
    ...existingClaims.results.map((row) => ({
      key: row.claim_key,
      valueSha256: row.value_sha256,
    })),
    ...uniqueClaims,
  ]) {
    const values = valuesByKey.get(claim.key) ?? new Set<string>();
    values.add(claim.valueSha256);
    valuesByKey.set(claim.key, values);
  }
  const conflictingKeys = [...valuesByKey]
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key)
    .sort();
  const exceptions: ProjectException[] = bundle.requestedActions.map((action) =>
    makeException({
      actorId: bundle.actorId,
      kind: action,
      normalizedRelativePath:
        action === "protected-path-access"
          ? bundle.normalizedRelativePath
          : null,
      now: input.now,
      projectId: request.projectId,
      requestedAction: action,
      runId: request.runId,
      summary: `The Run requested ${action}; MDevolved recorded an exception and did not execute it.`,
      workItemId: run.work_item_id,
    }),
  );
  if (conflictingKeys.length > 0) {
    exceptions.push(
      makeException({
        actorId: bundle.actorId,
        evidenceRefs: uniqueClaims
          .filter((claim) => conflictingKeys.includes(claim.key))
          .flatMap((claim) => [
            claim.valueSha256,
            ...(claim.evidenceSha256 === null ? [] : [claim.evidenceSha256]),
          ])
          .slice(0, 64),
        kind: "evidence-conflict",
        now: input.now,
        projectId: request.projectId,
        runId: request.runId,
        summary: `Conflicting evidence was reported for ${conflictingKeys.length} claim key${conflictingKeys.length === 1 ? "" : "s"}: ${conflictingKeys.slice(0, 32).join(", ")}${conflictingKeys.length > 32 ? ", …" : ""}.`,
        workItemId: run.work_item_id,
      }),
    );
  }
  const preparedExceptions = await Promise.all(
    exceptions.map((exception) =>
      prepareLeadOperationRecord(storage, {
        now: input.now,
        record: exception,
      }),
    ),
  );
  const result = {
    accepted: true,
    bundleId: bundle.bundleId,
    idempotencyKey: request.idempotencyKey,
    operation: "submit_bundle",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: requestDigest,
  };
  const statements: D1PreparedStatement[] = [
    insertLeadOperationRecordStatement(db, preparedBundle),
    db
      .prepare(
        `INSERT INTO project_event_bundles (
          bundle_id, operation_record_id, project_id, run_id, actor_id,
          visibility, event_count, byte_length, has_provisional_result,
          review_request_target_bundle_id, requested_reviewer_actor_id,
          review_result_target_bundle_id, review_verdict, source_lease_id,
          source_fencing_token, live_fence_valid, received_at
        ) VALUES (?, ?, ?, ?, ?, 'run-shared-unvetted', ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ${LIVE_FENCE_SQL}, ?)`,
      )
      .bind(
        bundle.bundleId,
        preparedBundle.operationRecordId,
        request.projectId,
        request.runId,
        bundle.actorId,
        bundle.events.length,
        preparedBundle.byteLength,
        bundle.events.some((event) => event.eventType === "result.provisional")
          ? 1
          : 0,
        reviewRequest?.targetBundleId ?? null,
        reviewRequest?.reviewerActorId ?? null,
        reviewResult?.targetBundleId ?? null,
        reviewResult?.verdict ?? null,
        fence.leaseId,
        fence.fencingToken,
        ...fenceBindings(request.projectId, fence, grant, input.now),
        input.now,
      ),
  ];
  for (const claim of uniqueClaims) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO project_run_claims (
            run_id, bundle_id, claim_key, value_sha256, evidence_sha256
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          request.runId,
          bundle.bundleId,
          claim.key,
          claim.valueSha256,
          claim.evidenceSha256,
        ),
    );
  }
  for (let index = 0; index < exceptions.length; index += 1) {
    const exception = exceptions[index];
    const prepared = preparedExceptions[index];
    if (exception === undefined || prepared === undefined) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    statements.push(
      insertLeadOperationRecordStatement(db, prepared),
      exceptionProjectionStatement(db, {
        exception,
        fence,
        grant,
        now: input.now,
      }),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE project_runs
         SET bundle_count = bundle_count + 1,
           logical_bytes = logical_bytes + ?
         WHERE run_id = ? AND project_id = ? AND status = 'active'`,
      )
      .bind(preparedBundle.byteLength, request.runId, request.projectId),
    receiptStatement(db, {
      extraFence: {
        bindings: [bundle.bundleId, request.runId],
        sql: `EXISTS (
          SELECT 1 FROM project_event_bundles
          WHERE bundle_id = ? AND run_id = ?
        )`,
      },
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "submit_bundle",
      projectId: request.projectId,
      requestSha256: requestDigest,
      result,
    }),
    auditStatement(
      db,
      "lead_operation.bundle_submitted",
      idempotencyKeySha256,
      input.now,
    ),
  );
  const objectKeys = [
    preparedBundle.bodyObjectKey,
    ...preparedExceptions.map((prepared) => prepared.bodyObjectKey),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(db, objectKeys, input.now);
    throw error;
  }
  return result;
}

async function materializeRunContext(
  db: D1Database,
  storage: R2Bucket,
  input: { projectId: string; runId: string },
): Promise<RunContext> {
  const row = await readRunRow(db, input.projectId, input.runId);
  if (row === null) throw new LeadOperationProblem("run_invalid");
  const storedRun = await readLeadOperationRecord(db, storage, row.run_id);
  const storedPolicy = await readLeadOperationRecord(
    db,
    storage,
    row.policy_id,
  );
  if (
    storedRun?.format !== "owd-run-v1" ||
    storedRun.runId !== row.run_id ||
    storedRun.projectId !== input.projectId ||
    storedPolicy?.format !== "owd-project-policy-v1" ||
    storedPolicy.policyId !== row.policy_id ||
    storedPolicy.projectId !== input.projectId
  ) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  const packet = await readPinnedPacket(db, storage, {
    packetId: row.work_packet_id,
    projectId: input.projectId,
    workItemId: row.work_item_id,
  });
  if (packet.projectVersionId !== storedPolicy.projectVersionId) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  const actorRows = await db
    .prepare(
      `SELECT actor_id, run_id, scopes_json, status, expires_at, revoked_at
       FROM project_actors WHERE run_id = ? AND project_id = ?
       ORDER BY issued_at, actor_id LIMIT ?`,
    )
    .bind(input.runId, input.projectId, MAX_R2_ACTORS_PER_RUN)
    .all<ActorRow>();
  const actors: Actor[] = [];
  for (const actorRow of actorRows.results) {
    const stored = await readLeadOperationRecord(
      db,
      storage,
      actorRow.actor_id,
    );
    if (
      stored?.format !== "owd-actor-v1" ||
      stored.actorId !== actorRow.actor_id ||
      stored.runId !== input.runId ||
      stored.projectId !== input.projectId
    ) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    actors.push(
      actorSchema.parse({
        ...stored,
        revokedAt:
          actorRow.status === "revoked"
            ? actorRow.revoked_at
            : stored.revokedAt,
      }),
    );
  }
  const bundleRows = await db
    .prepare(
      `SELECT bundle_id FROM project_event_bundles
       WHERE run_id = ? AND project_id = ?
       ORDER BY received_at, bundle_id LIMIT ?`,
    )
    .bind(input.runId, input.projectId, MAX_R2_BUNDLES_PER_RUN)
    .all<{ bundle_id: string }>();
  const acceptedBundles: EventBundle[] = [];
  for (const bundleRow of bundleRows.results) {
    const stored = await readLeadOperationRecord(
      db,
      storage,
      bundleRow.bundle_id,
    );
    if (
      stored?.format !== "owd-event-bundle-v1" ||
      stored.bundleId !== bundleRow.bundle_id ||
      stored.runId !== input.runId ||
      stored.projectId !== input.projectId
    ) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    acceptedBundles.push(stored);
  }
  const exceptionRows = await db
    .prepare(
      `SELECT exception_id, run_id, status, resolved_at
       FROM project_exceptions
       WHERE project_id = ? AND (run_id = ? OR run_id IS NULL)
       ORDER BY created_at, exception_id LIMIT 64`,
    )
    .bind(input.projectId, input.runId)
    .all<{
      exception_id: string;
      resolved_at: number | null;
      run_id: string | null;
      status: ProjectException["status"];
    }>();
  const exceptions: ProjectException[] = [];
  for (const exceptionRow of exceptionRows.results) {
    const stored = await readLeadOperationRecord(
      db,
      storage,
      exceptionRow.exception_id,
    );
    if (
      stored?.format !== "owd-project-exception-v1" ||
      stored.exceptionId !== exceptionRow.exception_id ||
      stored.runId !== exceptionRow.run_id ||
      stored.projectId !== input.projectId
    ) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    exceptions.push(
      projectExceptionSchema.parse({
        ...stored,
        resolvedAt: exceptionRow.resolved_at,
        status: exceptionRow.status,
      }),
    );
  }
  return runContextSchema.parse({
    acceptedBundles,
    actors,
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    exceptions,
    format: "owd-run-context-v1",
    policy: storedPolicy,
    projectId: input.projectId,
    run: currentRun(row),
    schemaVersion: 1,
    workPacket: packet,
  });
}

export async function getLeadRunContext(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<RunContext> {
  const parsed = getRunContextRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  await authorizeLeadRead(db, storage, input, request.projectId);
  if (request.actorId !== undefined) {
    const actor = await readActorRow(db, {
      actorId: request.actorId,
      projectId: request.projectId,
      runId: request.runId,
    });
    if (
      actor === null ||
      actor.status !== "active" ||
      actor.expires_at <= input.now
    ) {
      throw new LeadOperationProblem("actor_invalid");
    }
    if (!actorScopes(actor).includes("run.context.read")) {
      throw new LeadOperationProblem("scope_required");
    }
  }
  return materializeRunContext(db, storage, request);
}

type CompletionPolicyFence = {
  bindingId: string;
  decisionId: string;
  continuityPointId: string;
};

async function readCompletionPolicyFence(
  db: D1Database,
  storage: R2Bucket,
  input: {
    projectId: string;
    run: RunRow;
    runId: string;
    workItemId: string;
  },
): Promise<CompletionPolicyFence | null> {
  const bindingRow = await db
    .prepare(
      `SELECT binding.binding_id, binding.operational_record_id,
        binding.policy_id, binding.project_version_id,
        project.active_project_version_id, project.status AS project_status
       FROM project_policy_bindings binding
       JOIN collaboration_projects project
         ON project.project_id = binding.project_id
       WHERE binding.project_id = ? AND binding.status = 'active' LIMIT 1`,
    )
    .bind(input.projectId)
    .first<{
      active_project_version_id: string;
      binding_id: string;
      operational_record_id: string;
      policy_id: string;
      project_status: "active" | "archived";
      project_version_id: string;
    }>();
  if (bindingRow === null) return null;
  if (
    bindingRow.project_status !== "active" ||
    bindingRow.project_version_id !== bindingRow.active_project_version_id ||
    bindingRow.policy_id !== input.run.policy_id
  ) {
    throw new LeadOperationProblem("policy_required");
  }
  let storedBinding: PolicyBinding | null = null;
  try {
    const stored = await readPolicyOperationalRecord(
      db,
      storage,
      bindingRow.operational_record_id,
    );
    storedBinding = stored?.format === "owd-policy-binding-v1" ? stored : null;
  } catch {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  if (
    storedBinding === null ||
    storedBinding.bindingId !== bindingRow.binding_id ||
    storedBinding.policyId !== bindingRow.policy_id ||
    storedBinding.projectId !== input.projectId ||
    storedBinding.projectVersionId !== bindingRow.project_version_id ||
    !storedBinding.ownerAuthored
  ) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  const decisionRow = await db
    .prepare(
      `SELECT decision.decision_id, decision.operational_record_id,
        decision.continuity_point_id, decision.accepted_bundle_count,
        (SELECT COUNT(*) FROM project_event_bundles bundle
          WHERE bundle.project_id = decision.project_id
            AND bundle.run_id = decision.run_id) AS current_bundle_count
       FROM project_policy_decisions decision
       JOIN project_continuity_points point
         ON point.continuity_point_id = decision.continuity_point_id
        AND point.project_id = decision.project_id
        AND point.work_item_id = decision.work_item_id
        AND point.work_packet_id = decision.work_packet_id
        AND point.acknowledged_at >= ?
        AND point.restored_at IS NULL
        AND point.live_fence_valid = 1
        AND point.live_context_valid = 1
       WHERE decision.project_id = ? AND decision.run_id = ?
         AND decision.work_item_id = ? AND decision.work_packet_id = ?
         AND decision.policy_binding_id = ? AND decision.policy_id = ?
         AND decision.project_version_id = ? AND decision.outcome = 'allow'
         AND decision.live_fence_valid = 1
       ORDER BY decision.evaluated_at DESC, decision.decision_id DESC LIMIT 1`,
    )
    .bind(
      input.run.created_at,
      input.projectId,
      input.runId,
      input.workItemId,
      input.run.work_packet_id,
      bindingRow.binding_id,
      bindingRow.policy_id,
      bindingRow.project_version_id,
    )
    .first<{
      accepted_bundle_count: number;
      continuity_point_id: string;
      current_bundle_count: number;
      decision_id: string;
      operational_record_id: string;
    }>();
  if (
    decisionRow === null ||
    decisionRow.accepted_bundle_count !== decisionRow.current_bundle_count
  ) {
    throw new LeadOperationProblem("policy_required");
  }
  let storedDecision: PolicyDecision | null = null;
  try {
    const stored = await readPolicyOperationalRecord(
      db,
      storage,
      decisionRow.operational_record_id,
    );
    storedDecision =
      stored?.format === "owd-policy-decision-v1" ? stored : null;
  } catch {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  if (
    storedDecision === null ||
    storedDecision.decisionId !== decisionRow.decision_id ||
    storedDecision.outcome !== "allow" ||
    storedDecision.policyBindingId !== bindingRow.binding_id ||
    storedDecision.projectVersionId !== bindingRow.project_version_id ||
    storedDecision.runId !== input.runId ||
    storedDecision.workItemId !== input.workItemId ||
    storedDecision.workPacketId !== input.run.work_packet_id ||
    storedDecision.continuityPointId !== decisionRow.continuity_point_id ||
    storedDecision.acceptedBundleCount !== decisionRow.current_bundle_count ||
    !storedDecision.checks.every((check) => check.passed)
  ) {
    throw new LeadOperationProblem("integrity_mismatch");
  }
  return {
    bindingId: bindingRow.binding_id,
    continuityPointId: decisionRow.continuity_point_id,
    decisionId: decisionRow.decision_id,
  };
}

export async function completeLeadWorkItem(
  db: D1Database,
  storage: R2Bucket,
  input: AuthInput,
): Promise<Record<string, unknown>> {
  const parsed = completeWorkItemRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const fence = {
    fencingToken: request.fencingToken,
    leaseId: request.leaseId,
  };
  const grant = await authorizeLead(
    db,
    storage,
    input,
    request.projectId,
    fence,
  );
  const requestDigest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "complete_work_item",
    requestSha256: requestDigest,
  });
  if (replay !== null) return replayResult(replay);
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const run = await readRunRow(db, request.projectId, request.runId);
  if (
    run === null ||
    run.status !== "active" ||
    run.work_item_id !== request.workItemId
  ) {
    throw new LeadOperationProblem("run_invalid");
  }
  if (run.actor_count < MIN_HANDS_OFF_ACTORS) {
    throw new LeadOperationProblem("review_required");
  }
  const blocker = await db
    .prepare(
      `SELECT 1 AS found FROM project_exceptions
       WHERE project_id = ? AND status IN ('open', 'blocking')
         AND (run_id = ? OR run_id IS NULL)
       LIMIT 1`,
    )
    .bind(request.projectId, request.runId)
    .first();
  if (blocker !== null) {
    throw new LeadOperationProblem("exception_blocking");
  }
  const review = await db
    .prepare(
      `SELECT completed.bundle_id
       FROM project_event_bundles completed
       JOIN project_event_bundles target
         ON target.bundle_id = completed.review_result_target_bundle_id
        AND target.run_id = completed.run_id
        AND target.has_provisional_result = 1
       JOIN project_event_bundles requested
         ON requested.run_id = completed.run_id
        AND requested.review_request_target_bundle_id = target.bundle_id
        AND requested.requested_reviewer_actor_id = completed.actor_id
       WHERE completed.run_id = ? AND completed.project_id = ?
         AND completed.review_verdict IN ('pass', 'pass-with-findings')
         AND completed.actor_id <> target.actor_id
       LIMIT 1`,
    )
    .bind(request.runId, request.projectId)
    .first<{ bundle_id: string }>();
  if (review === null) throw new LeadOperationProblem("review_required");
  const checkpoint = await db
    .prepare(
      `SELECT 1 AS found FROM project_continuity_points
       WHERE project_id = ? AND work_item_id = ?
         AND work_packet_id = ?
         AND acknowledged_at >= ? AND restored_at IS NULL
         AND live_fence_valid = 1 AND live_context_valid = 1
       LIMIT 1`,
    )
    .bind(
      request.projectId,
      request.workItemId,
      run.work_packet_id,
      run.created_at,
    )
    .first();
  if (checkpoint === null) {
    throw new LeadOperationProblem("checkpoint_required");
  }
  const completionPolicy = await readCompletionPolicyFence(db, storage, {
    projectId: request.projectId,
    run,
    runId: request.runId,
    workItemId: request.workItemId,
  });
  const result = {
    completed: true,
    idempotencyKey: request.idempotencyKey,
    operation: "complete_work_item",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: requestDigest,
    workItemId: request.workItemId,
  };
  await db.batch([
    db
      .prepare(
        `UPDATE project_runs
         SET status = 'completed', completed_at = ?, completion_outcome = ?
         WHERE run_id = ? AND project_id = ? AND work_item_id = ?
           AND status = 'active'`,
      )
      .bind(
        input.now,
        request.outcome,
        request.runId,
        request.projectId,
        request.workItemId,
      ),
    db
      .prepare(
        `UPDATE project_actors SET status = 'revoked', revoked_at = ?
         WHERE run_id = ? AND project_id = ? AND status = 'active'`,
      )
      .bind(input.now, request.runId, request.projectId),
    db
      .prepare(
        `UPDATE project_elastic_actor_slots SET active_slot = NULL
         WHERE run_id = ?`,
      )
      .bind(request.runId),
    db
      .prepare(
        `UPDATE project_elastic_planes
         SET active_actor_count = 0, updated_at = ?
         WHERE run_id = ? AND project_id = ?`,
      )
      .bind(input.now, request.runId, request.projectId),
    db
      .prepare(
        `UPDATE project_elastic_accounts
         SET active_actor_count = 0, updated_at = ?
         WHERE run_id = ? AND project_id = ?`,
      )
      .bind(input.now, request.runId, request.projectId),
    db
      .prepare(
        `UPDATE collaboration_work_items SET status = 'closed'
         WHERE work_item_id = ? AND project_id = ? AND status = 'open'`,
      )
      .bind(request.workItemId, request.projectId),
    receiptStatement(db, {
      extraFence: {
        bindings: [
          request.runId,
          request.projectId,
          input.now,
          request.outcome,
          request.workItemId,
          request.projectId,
          ...(completionPolicy === null
            ? []
            : [
                completionPolicy.decisionId,
                completionPolicy.bindingId,
                completionPolicy.continuityPointId,
                request.runId,
                request.projectId,
              ]),
        ],
        sql: `EXISTS (
          SELECT 1 FROM project_runs
          WHERE run_id = ? AND project_id = ? AND status = 'completed'
            AND completed_at = ? AND completion_outcome = ?
        ) AND EXISTS (
          SELECT 1 FROM collaboration_work_items
          WHERE work_item_id = ? AND project_id = ? AND status = 'closed'
        )${
          completionPolicy === null
            ? ""
            : ` AND EXISTS (
          SELECT 1 FROM project_policy_decisions decision
          JOIN project_policy_bindings binding
            ON binding.binding_id = decision.policy_binding_id
           AND binding.status = 'active'
          JOIN collaboration_projects project
            ON project.project_id = decision.project_id
           AND project.status = 'active'
           AND project.active_project_version_id = decision.project_version_id
          JOIN project_continuity_points point
            ON point.continuity_point_id = decision.continuity_point_id
           AND point.restored_at IS NULL
           AND point.live_fence_valid = 1
           AND point.live_context_valid = 1
          WHERE decision.decision_id = ?
            AND decision.policy_binding_id = ?
            AND decision.continuity_point_id = ?
            AND decision.run_id = ? AND decision.project_id = ?
            AND decision.outcome = 'allow'
            AND decision.accepted_bundle_count = (
              SELECT COUNT(*) FROM project_event_bundles bundle
              WHERE bundle.run_id = decision.run_id
                AND bundle.project_id = decision.project_id
            )
        )`
        }`,
      },
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "complete_work_item",
      projectId: request.projectId,
      requestSha256: requestDigest,
      result,
    }),
    auditStatement(
      db,
      "lead_operation.work_item_completed",
      idempotencyKeySha256,
      input.now,
    ),
  ]);
  return result;
}

export async function listLeadProjectExceptions(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<Record<string, unknown>> {
  const parsed = listProjectExceptionsRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  await authorizeLeadRead(db, storage, input, request.projectId);
  const rows = await db
    .prepare(
      `SELECT exception_id, run_id, status, resolved_at FROM project_exceptions
       WHERE project_id = ? ${request.status === undefined ? "" : "AND status = ?"}
       ORDER BY created_at, exception_id LIMIT 256`,
    )
    .bind(
      ...(request.status === undefined
        ? [request.projectId]
        : [request.projectId, request.status]),
    )
    .all<{
      exception_id: string;
      resolved_at: number | null;
      run_id: string | null;
      status: ProjectException["status"];
    }>();
  const exceptions: ProjectException[] = [];
  for (const row of rows.results) {
    const stored = await readLeadOperationRecord(db, storage, row.exception_id);
    if (
      stored?.format !== "owd-project-exception-v1" ||
      stored.exceptionId !== row.exception_id ||
      stored.runId !== row.run_id ||
      stored.projectId !== request.projectId
    ) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    exceptions.push(
      projectExceptionSchema.parse({
        ...stored,
        resolvedAt: row.resolved_at,
        status: row.status,
      }),
    );
  }
  return listProjectExceptionsReceiptSchema.parse({
    exceptions,
    operation: "list_project_exceptions",
    projectId: request.projectId,
  });
}

export async function buildPortableLeadRunContext(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<RunContext> {
  return getLeadRunContext(db, storage, input);
}

export async function getLeadOperationOverview(
  db: D1Database,
  storage: R2Bucket,
  now = Math.floor(Date.now() / 1_000),
): Promise<LeadOperationOverview> {
  const projectRows = await db
    .prepare(
      `SELECT project.project_id,
        (SELECT COUNT(*) FROM project_runs run
         WHERE run.project_id = project.project_id AND run.status = 'active')
          AS active_run_count,
        (SELECT COUNT(*) FROM project_actors actor
         WHERE actor.project_id = project.project_id AND actor.status = 'active'
           AND actor.expires_at > ?)
          AS active_actor_count,
        (SELECT COUNT(*) FROM project_exceptions exception
         WHERE exception.project_id = project.project_id
           AND exception.status IN ('open', 'blocking'))
          AS blocking_exception_count,
        (SELECT MAX(record.received_at) FROM project_operation_records record
         WHERE record.project_id = project.project_id
           AND record.restore_state = 'live') AS last_run_activity_at
       FROM collaboration_projects project
       WHERE project.status = 'active' AND EXISTS (
         SELECT 1 FROM project_operation_records record
         WHERE record.project_id = project.project_id
           AND record.restore_state = 'live'
       )
       ORDER BY last_run_activity_at DESC, project.project_id
       LIMIT 256`,
    )
    .bind(now)
    .all<{
      active_actor_count: number;
      active_run_count: number;
      blocking_exception_count: number;
      last_run_activity_at: number | null;
      project_id: string;
    }>();
  const exceptionRows = await db
    .prepare(
      `SELECT exception_id, project_id, status, resolved_at
       FROM project_exceptions
       WHERE status IN ('open', 'blocking')
         AND project_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         )
       ORDER BY created_at DESC, exception_id DESC LIMIT 256`,
    )
    .bind(JSON.stringify(projectRows.results.map((row) => row.project_id)))
    .all<{
      exception_id: string;
      project_id: string;
      resolved_at: number | null;
      status: ProjectException["status"];
    }>();
  const recentByProject = new Map<string, ProjectException[]>();
  for (let offset = 0; offset < exceptionRows.results.length; offset += 8) {
    const batch = exceptionRows.results.slice(offset, offset + 8);
    const stored = await Promise.all(
      batch.map((row) =>
        readLeadOperationRecord(db, storage, row.exception_id),
      ),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      const record = stored[index];
      if (
        row === undefined ||
        record?.format !== "owd-project-exception-v1" ||
        record.projectId !== row.project_id
      ) {
        throw new LeadOperationProblem("integrity_mismatch");
      }
      const values = recentByProject.get(row.project_id) ?? [];
      if (values.length < 5) {
        values.push(
          projectExceptionSchema.parse({
            ...record,
            resolvedAt: row.resolved_at,
            status: row.status,
          }),
        );
        recentByProject.set(row.project_id, values);
      }
    }
  }
  return leadOperationOverviewSchema.parse({
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    format: "owd-lead-operation-overview-v1",
    projects: projectRows.results.map((row) => ({
      activeActorCount: row.active_actor_count,
      activeRunCount: row.active_run_count,
      blockingExceptionCount: row.blocking_exception_count,
      lastRunActivityAt: row.last_run_activity_at,
      projectId: row.project_id,
      recentExceptions: recentByProject.get(row.project_id) ?? [],
    })),
    schemaVersion: 1,
  });
}
