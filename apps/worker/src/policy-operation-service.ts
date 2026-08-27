import {
  OWD_CODING_COMPLETION_GATE,
  OWD_RESEARCH_COMPLETION_GATE,
  MAX_OPERATIONAL_EXPORT_BYTES,
  MAX_OPERATIONAL_EXPORT_RECORDS,
  MAX_OPERATIONAL_EXPORT_REFERENCES,
  activatePolicyBindingRequestSchema,
  canonicalizeCollaborationJson,
  completeContinuityDrillReceiptSchema,
  completeContinuityDrillRequestSchema,
  completionPolicySchema,
  evaluateRunPolicyReceiptSchema,
  evaluateRunPolicyRequestSchema,
  getPolicyOperationsReceiptSchema,
  getPolicyOperationsRequestSchema,
  operationalEvidenceSchema,
  operationalOverviewSchema,
  operationalPortableExportSchema,
  operationalScheduleSchema,
  policyBindingSchema,
  policyDecisionSchema,
  type ContinuityReceipt,
  type CompletionMode,
  type OperationalEvidence,
  type OperationalOverview,
  type OperationalPortableExport,
  type OperationalSchedule,
  type PolicyBinding,
  type PolicyDecision,
  type PolicyEvidenceRef,
  type PolicyExceptionAction,
} from "@mdevolved/contracts";
import type { CollaborationAuthorizationContext } from "./collaboration-service";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";
import { readCollaborationRecord } from "./collaboration-store";
import {
  readContinuityPoint,
  readLatestContinuityPoint,
} from "./continuity-store";
import { readElasticOperationRecord } from "./elastic-operation-store";
import {
  LIVE_FENCE_SQL,
  auditStatement,
  authorizeLead,
  authorizeLeadRead,
  exceptionProjectionStatement,
  fenceBindings,
  makeException,
  readReceipt,
  readRunRow,
  receiptStatement,
  replayResult,
  requestSha256,
  type Fence,
} from "./lead-operation-service";
import {
  insertLeadOperationRecordStatement,
  prepareLeadOperationRecord,
  readLeadOperationRecord,
} from "./lead-operation-store";
import {
  insertOperationalDependencyStatement,
  insertPolicyOperationalRecordStatement,
  preparePolicyOperationalRecord,
  readPolicyOperationalRecord,
} from "./policy-operation-store";
import { encodeBase64Url, sha256Hex, sha256HexBytes } from "./security";

const AUTHORITY = {
  liveAuthorityIncluded: false,
  restoredAuthorityAllowed: false,
} as const;
const SCHEDULER_AUTHORITY = {
  ...AUTHORITY,
  schedulerAuthorityIncluded: false,
} as const;
const COLD_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;
const REQUEST_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const SCHEDULE_PAGE_SIZE = 8;
const INTEGRITY_BODY_LIMIT = 64;

export type PolicyOperationProblemCode =
  | "evidence_invalid"
  | "integrity_mismatch"
  | "policy_edit_forbidden"
  | "policy_not_ready"
  | "policy_required"
  | "project_invalid"
  | "run_invalid"
  | "submission_invalid";

export class PolicyOperationProblem extends Error {
  constructor(readonly code: PolicyOperationProblemCode) {
    super(code);
    this.name = "PolicyOperationProblem";
  }
}

type BindingProjectionRow = {
  activated_at: number;
  binding_id: string;
  checkpoint_interval_seconds: number;
  drill_interval_seconds: number;
  operational_record_id: string;
  policy_id: string;
  policy_sha256: string;
  project_id: string;
  project_version_id: string;
};

type ScheduleProjectionRow = {
  checkpoint_interval_seconds: number;
  created_at: number;
  drill_interval_seconds: number;
  next_checkpoint_at: number;
  next_drill_at: number;
  operational_record_id: string;
  policy_binding_id: string;
  project_id: string;
  revision: number;
  schedule_id: string;
  status: "active" | "paused";
};

async function readActiveBindingRow(
  db: D1Database,
  projectId: string,
): Promise<BindingProjectionRow | null> {
  return db
    .prepare(
      `SELECT binding_id, operational_record_id, project_id,
        project_version_id, policy_id, policy_sha256,
        checkpoint_interval_seconds, drill_interval_seconds, activated_at
       FROM project_policy_bindings
       WHERE project_id = ? AND status = 'active' LIMIT 1`,
    )
    .bind(projectId)
    .first<BindingProjectionRow>();
}

async function readActiveBinding(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
): Promise<PolicyBinding | null> {
  const row = await readActiveBindingRow(db, projectId);
  if (row === null) return null;
  const record = await readPolicyOperationalRecord(
    db,
    storage,
    row.operational_record_id,
  );
  if (
    record?.format !== "owd-policy-binding-v1" ||
    record.bindingId !== row.binding_id ||
    record.projectId !== row.project_id ||
    record.projectVersionId !== row.project_version_id ||
    record.policyId !== row.policy_id ||
    record.policySha256 !== row.policy_sha256
  ) {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  return record;
}

async function verifyBindingPolicyInputs(
  db: D1Database,
  storage: R2Bucket,
  binding: PolicyBinding,
): Promise<void> {
  let policy: Awaited<ReturnType<typeof readLeadOperationRecord>>;
  let projectVersion: Awaited<ReturnType<typeof readCollaborationRecord>>;
  try {
    [policy, projectVersion] = await Promise.all([
      readLeadOperationRecord(db, storage, binding.policyId),
      readCollaborationRecord(db, storage, binding.ownerPolicyInput.recordId),
    ]);
  } catch {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  if (
    policy?.format !== "owd-project-policy-v1" ||
    policy.policyId !== binding.policyId ||
    policy.projectId !== binding.projectId ||
    policy.projectVersionId !== binding.projectVersionId ||
    (await sha256Hex(canonicalizeCollaborationJson(policy))) !==
      binding.policySha256 ||
    projectVersion?.record.recordType !== "project-version" ||
    projectVersion.record.projectId !== binding.projectId ||
    projectVersion.record.projectVersionId !== binding.projectVersionId ||
    projectVersion.metadata.contentSha256 !==
      binding.ownerPolicyInput.contentSha256
  ) {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
}

function bindingProjectionStatement(
  db: D1Database,
  binding: PolicyBinding,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_policy_bindings (
        binding_id, operational_record_id, project_id, project_version_id,
        policy_id, policy_sha256, owner_policy_input_record_id,
        owner_policy_input_sha256, owner_authored, gate_research, gate_coding,
        checkpoint_interval_seconds, drill_interval_seconds,
        solo_verified_allowed, status,
        activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(
      binding.bindingId,
      binding.bindingId,
      binding.projectId,
      binding.projectVersionId,
      binding.policyId,
      binding.policySha256,
      binding.ownerPolicyInput.recordId,
      binding.ownerPolicyInput.contentSha256,
      binding.gateProfiles.research,
      binding.gateProfiles.coding,
      binding.checkpointIntervalSeconds,
      binding.drillIntervalSeconds,
      binding.completionPolicy?.soloVerifiedOwnerConsent === true ? 1 : 0,
      binding.activatedAt,
    );
}

function scheduleProjectionStatement(
  db: D1Database,
  schedule: OperationalSchedule,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_operational_schedules (
        schedule_id, operational_record_id, project_id, policy_binding_id,
        status, checkpoint_interval_seconds, drill_interval_seconds,
        next_checkpoint_at, next_drill_at, created_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .bind(
      schedule.scheduleId,
      schedule.scheduleId,
      schedule.projectId,
      schedule.policyBindingId,
      schedule.checkpointIntervalSeconds,
      schedule.drillIntervalSeconds,
      schedule.nextCheckpointAt,
      schedule.nextDrillAt,
      schedule.createdAt,
    );
}

function operationalEvidenceProjectionStatements(
  db: D1Database,
  evidence: OperationalEvidence,
): D1PreparedStatement[] {
  if (evidence.detail.kind === "integrity-scan") {
    return [
      db
        .prepare(
          `INSERT INTO project_operational_integrity_reports (
            evidence_id, operational_record_id, project_id, coverage,
            inspected_record_count, inspected_body_count, missing_count,
            mismatched_count, status, measured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          evidence.evidenceId,
          evidence.evidenceId,
          evidence.projectId,
          evidence.detail.coverage,
          evidence.detail.inspectedRecordCount,
          evidence.detail.inspectedBodyCount,
          evidence.detail.missingCount,
          evidence.detail.mismatchedCount,
          evidence.status === "ok" ? "ok" : "degraded",
          evidence.occurredAt,
        ),
    ];
  }
  if (
    evidence.detail.kind !== "continuity-point-request" &&
    evidence.detail.kind !== "continuity-drill-request"
  ) {
    return [];
  }
  if (evidence.scheduleId === null) {
    throw new PolicyOperationProblem("submission_invalid");
  }
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO project_operational_requests (
          request_id, operational_record_id, project_id, schedule_id,
          request_kind, schedule_window, due_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        evidence.evidenceId,
        evidence.evidenceId,
        evidence.projectId,
        evidence.scheduleId,
        evidence.detail.kind === "continuity-point-request"
          ? "continuity-point"
          : "continuity-drill",
        evidence.detail.scheduleWindow,
        evidence.detail.dueAt,
        evidence.occurredAt,
      ),
  ];
}

function fixedOperationalEvidence(
  projectId: string,
  now: number,
  detail:
    | {
        forwardOnly: true;
        fromMigration: "0032";
        kind: "upgrade-readiness";
        toMigration: "0033";
        triggerFree: true;
      }
    | {
        automaticRollback: false;
        destructiveDownMigration: false;
        kind: "rollback-readiness";
        mode: "application-only";
        priorWorkerCompatible: true;
      }
    | {
        communityIndependent: true;
        controlPlaneRequired: false;
        deploymentMode: "community";
        executionEngineExternal: true;
        kind: "managed-cell-health";
      },
  summary: string,
): OperationalEvidence {
  return operationalEvidenceSchema.parse({
    authority: AUTHORITY,
    detail,
    evidenceId: crypto.randomUUID(),
    format: "owd-operational-evidence-v1",
    occurredAt: now,
    projectId,
    retainUntil: now + COLD_RETENTION_SECONDS,
    retentionTier: "cold",
    runId: null,
    scheduleId: null,
    schemaVersion: 1,
    status: "ok",
    summary,
  });
}

export async function activateProjectPolicyBinding(
  db: D1Database,
  storage: R2Bucket,
  rawRequest: unknown,
  now: number,
): Promise<PolicyBinding> {
  const parsed = activatePolicyBindingRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new PolicyOperationProblem("submission_invalid");
  }
  const request = parsed.data;
  const existing = await readActiveBinding(db, storage, request.projectId);
  const row = await db
    .prepare(
      `SELECT project.active_project_version_id, project.status,
        version.content_sha256 AS project_version_sha256,
        policy.policy_id, policy_record.content_sha256 AS policy_sha256
       FROM collaboration_projects project
       JOIN collaboration_records version
         ON version.id = project.active_project_version_id
        AND version.record_type = 'project-version'
        AND version.restored_at IS NULL
       JOIN project_operation_policies policy
         ON policy.project_id = project.project_id
        AND policy.project_version_id = project.active_project_version_id
       JOIN project_operation_records policy_record
         ON policy_record.operation_record_id = policy.policy_id
        AND policy_record.restore_state = 'live'
       WHERE project.project_id = ? LIMIT 1`,
    )
    .bind(request.projectId)
    .first<{
      active_project_version_id: string;
      policy_id: string;
      policy_sha256: string;
      project_version_sha256: string;
      status: string;
    }>();
  if (row === null || row.status !== "active") {
    throw new PolicyOperationProblem("policy_not_ready");
  }
  const policy = await readLeadOperationRecord(db, storage, row.policy_id);
  if (
    policy?.format !== "owd-project-policy-v1" ||
    policy.projectId !== request.projectId ||
    policy.projectVersionId !== row.active_project_version_id ||
    (await sha256Hex(canonicalizeCollaborationJson(policy))) !==
      row.policy_sha256
  ) {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  const requestedSoloCompletion = request.completionMode === "solo-verified";
  if (existing !== null) {
    const existingSoloCompletion =
      existing.completionPolicy?.soloVerifiedOwnerConsent === true;
    if (
      existing.checkpointIntervalSeconds !==
        request.checkpointIntervalSeconds ||
      existing.drillIntervalSeconds !== request.drillIntervalSeconds
    ) {
      throw new PolicyOperationProblem("policy_edit_forbidden");
    }
    if (existing.projectVersionId === row.active_project_version_id) {
      if (
        existing.policyId !== row.policy_id ||
        existing.policySha256 !== row.policy_sha256 ||
        existing.ownerPolicyInput.recordId !== row.active_project_version_id ||
        existing.ownerPolicyInput.contentSha256 !== row.project_version_sha256
      ) {
        throw new PolicyOperationProblem("integrity_mismatch");
      }
      await verifyBindingPolicyInputs(db, storage, existing);
      if (existingSoloCompletion === requestedSoloCompletion) return existing;
    }
  }
  const binding = policyBindingSchema.parse({
    activatedAt: now,
    authority: AUTHORITY,
    bindingId: crypto.randomUUID(),
    checkpointIntervalSeconds: request.checkpointIntervalSeconds,
    ...(requestedSoloCompletion
      ? {
          completionPolicy: completionPolicySchema.parse({
            allowedModes: ["orchestrated-reviewed", "solo-verified"],
            defaultMode: "orchestrated-reviewed",
            format: "owd-completion-policy-v1",
            schemaVersion: 1,
            soloVerifiedOwnerConsent: true,
          }),
        }
      : {}),
    drillIntervalSeconds: request.drillIntervalSeconds,
    exceptionOnlyActions: [
      "authority-expansion",
      "policy-editing",
      "self-approval",
      "destructive-action",
      "protected-path-access",
      "conflicting-evidence",
      "budget-exhaustion",
      "integrity-failure",
      "unsupported-upgrade",
      "unsupported-rollback",
    ],
    format: "owd-policy-binding-v1",
    gateProfiles: {
      coding: OWD_CODING_COMPLETION_GATE,
      research: OWD_RESEARCH_COMPLETION_GATE,
    },
    ownerAuthored: true,
    ownerAuthorization: "owner-session",
    ownerPolicyInput: {
      contentSha256: row.project_version_sha256,
      recordId: row.active_project_version_id,
      recordType: "project-version",
    },
    policyId: row.policy_id,
    policySha256: row.policy_sha256,
    projectId: request.projectId,
    projectVersionId: row.active_project_version_id,
    schemaVersion: 1,
  });
  const schedule = operationalScheduleSchema.parse({
    authority: SCHEDULER_AUTHORITY,
    checkpointIntervalSeconds: request.checkpointIntervalSeconds,
    createdAt: now,
    drillIntervalSeconds: request.drillIntervalSeconds,
    format: "owd-operational-schedule-v1",
    nextCheckpointAt: now + request.checkpointIntervalSeconds,
    nextDrillAt: now + request.drillIntervalSeconds,
    policyBindingId: binding.bindingId,
    projectId: request.projectId,
    scheduleId: crypto.randomUUID(),
    schemaVersion: 1,
    status: "active",
  });
  const evidence = [
    fixedOperationalEvidence(
      request.projectId,
      now,
      {
        forwardOnly: true,
        fromMigration: "0032",
        kind: "upgrade-readiness",
        toMigration: "0033",
        triggerFree: true,
      },
      "Migration 0033 is forward-only and trigger-free.",
    ),
    fixedOperationalEvidence(
      request.projectId,
      now,
      {
        automaticRollback: false,
        destructiveDownMigration: false,
        kind: "rollback-readiness",
        mode: "application-only",
        priorWorkerCompatible: true,
      },
      "Rollback is application-only; no destructive down-migration runs.",
    ),
    fixedOperationalEvidence(
      request.projectId,
      now,
      {
        communityIndependent: true,
        controlPlaneRequired: false,
        deploymentMode: "community",
        executionEngineExternal: true,
        kind: "managed-cell-health",
      },
      "The Community data path is independent and execution remains external.",
    ),
  ];
  const records: Array<
    PolicyBinding | OperationalSchedule | OperationalEvidence
  > = [binding, schedule, ...evidence];
  const prepared = await Promise.all(
    records.map((record) =>
      preparePolicyOperationalRecord(storage, { now, record }),
    ),
  );
  const statements = prepared.map((record) =>
    insertPolicyOperationalRecordStatement(db, record),
  );
  if (existing !== null) {
    statements.unshift(
      db
        .prepare(
          `UPDATE project_operational_schedules SET status = 'paused'
           WHERE project_id = ? AND policy_binding_id = ?
             AND status = 'active'`,
        )
        .bind(request.projectId, existing.bindingId),
      db
        .prepare(
          `UPDATE project_policy_bindings
           SET status = 'superseded', superseded_at = ?
           WHERE project_id = ? AND binding_id = ? AND status = 'active'`,
        )
        .bind(now, request.projectId, existing.bindingId),
    );
  }
  statements.push(
    bindingProjectionStatement(db, binding),
    scheduleProjectionStatement(db, schedule),
    insertOperationalDependencyStatement(db, {
      contentSha256: row.project_version_sha256,
      dependencyId: row.active_project_version_id,
      dependencyKind: "record",
      operationalRecordId: binding.bindingId,
    }),
    insertOperationalDependencyStatement(db, {
      contentSha256: row.policy_sha256,
      dependencyId: row.policy_id,
      dependencyKind: "record",
      operationalRecordId: binding.bindingId,
    }),
    insertOperationalDependencyStatement(db, {
      dependencyId: binding.bindingId,
      dependencyKind: "operational",
      operationalRecordId: schedule.scheduleId,
    }),
    auditStatement(
      db,
      "policy_operation.binding_activated",
      binding.bindingId,
      now,
    ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      prepared.map((record) => record.bodyObjectKey),
      now,
    );
    throw error;
  }
  return binding;
}

type GateInputs = {
  acceptedBundleCount: number;
  binding: PolicyBinding;
  budgetRef: PolicyEvidenceRef | null;
  budgetWithin: boolean;
  bundleRefs: PolicyEvidenceRef[];
  checkpointRef: PolicyEvidenceRef | null;
  conflicts: boolean;
  evidenceRefs: PolicyEvidenceRef[];
  integrityValid: boolean;
  latestIntegrityDegraded: boolean;
  noBlockingException: boolean;
  purposeEvidence: boolean;
  reviewRefs: PolicyEvidenceRef[];
  reviewValid: boolean;
};

async function verifyStoredBody(
  storage: R2Bucket,
  row: { body_object_key: string; byte_length: number; content_sha256: string },
): Promise<boolean> {
  const object = await storage.get(row.body_object_key);
  if (
    object === null ||
    object.size !== row.byte_length ||
    object.customMetadata?.sha256 !== row.content_sha256
  ) {
    return false;
  }
  return (
    (await sha256HexBytes(new Uint8Array(await object.arrayBuffer()))) ===
    row.content_sha256
  );
}

async function collectGateInputs(
  db: D1Database,
  storage: R2Bucket,
  input: {
    binding: PolicyBinding;
    projectId: string;
    purpose: "coding" | "research";
    runId: string;
    runCreatedAt: number;
    workItemId: string;
    workPacketId: string;
  },
): Promise<GateInputs> {
  const requiredKeys =
    input.purpose === "research"
      ? ["research.finding", "research.source"]
      : ["coding.change", "coding.validation"];
  const claimRows = await db
    .prepare(
      `SELECT claim.claim_key, claim.value_sha256, claim.evidence_sha256,
        bundle.bundle_id, bundle_record.content_sha256 AS bundle_sha256,
        content.id AS evidence_id, content.content_sha256,
        content.object_key AS body_object_key, content.byte_length
       FROM project_run_claims claim
       JOIN project_event_bundles bundle ON bundle.bundle_id = claim.bundle_id
       JOIN project_operation_records bundle_record
         ON bundle_record.operation_record_id = bundle.bundle_id
        AND bundle_record.restore_state = 'live'
       LEFT JOIN collaboration_content_objects content
         ON content.content_sha256 = claim.evidence_sha256
       LEFT JOIN collaboration_dependencies packet_dependency
         ON packet_dependency.record_id = ?
        AND packet_dependency.dependency_id = content.id
        AND packet_dependency.dependency_kind = 'evidence'
       WHERE claim.run_id = ? AND bundle.project_id = ?
         AND claim.claim_key IN (?, ?)
         AND (content.id IS NULL OR packet_dependency.dependency_id IS NOT NULL)
       ORDER BY claim.claim_key, bundle.received_at, bundle.bundle_id`,
    )
    .bind(
      input.workPacketId,
      input.runId,
      input.projectId,
      requiredKeys[0],
      requiredKeys[1],
    )
    .all<{
      body_object_key: string | null;
      bundle_id: string;
      bundle_sha256: string;
      byte_length: number | null;
      claim_key: string;
      content_sha256: string | null;
      evidence_id: string | null;
      evidence_sha256: string | null;
      value_sha256: string;
    }>();
  const selectedClaims = requiredKeys.map((key) =>
    claimRows.results.find(
      (row) =>
        row.claim_key === key &&
        row.evidence_sha256 !== null &&
        row.evidence_id !== null &&
        row.content_sha256 === row.evidence_sha256,
    ),
  );
  let integrityValid = selectedClaims.every((row) => row !== undefined);
  const storedPacket = await readCollaborationRecord(
    db,
    storage,
    input.workPacketId,
  );
  if (
    storedPacket?.record.recordType !== "work-packet" ||
    storedPacket.record.projectId !== input.projectId ||
    storedPacket.record.workItemId !== input.workItemId
  ) {
    integrityValid = false;
  }
  for (const row of selectedClaims) {
    if (
      row === undefined ||
      row.body_object_key === null ||
      row.byte_length === null ||
      row.content_sha256 === null ||
      !(await verifyStoredBody(storage, {
        body_object_key: row.body_object_key,
        byte_length: row.byte_length,
        content_sha256: row.content_sha256,
      }))
    ) {
      integrityValid = false;
      continue;
    }
    if (
      storedPacket?.record.recordType !== "work-packet" ||
      !storedPacket.record.evidenceObjects.some(
        (evidence) =>
          evidence.evidenceObjectId === row.evidence_id &&
          evidence.contentSha256 === row.content_sha256 &&
          evidence.byteLength === row.byte_length,
      )
    ) {
      integrityValid = false;
    }
  }
  const evidenceRefs = selectedClaims.flatMap((row) =>
    row === undefined || row.evidence_id === null || row.content_sha256 === null
      ? []
      : [
          {
            contentSha256: row.content_sha256,
            id: row.evidence_id,
            kind: "accepted-content" as const,
          },
        ],
  );
  const bundleRefs = [
    ...new Map(
      selectedClaims.flatMap((row) =>
        row === undefined
          ? []
          : [
              [
                row.bundle_id,
                {
                  contentSha256: row.bundle_sha256,
                  id: row.bundle_id,
                  kind: "event-bundle" as const,
                },
              ] as const,
            ],
      ),
    ).values(),
  ];
  for (const reference of bundleRefs) {
    try {
      if ((await readLeadOperationRecord(db, storage, reference.id)) === null) {
        integrityValid = false;
      }
    } catch {
      integrityValid = false;
    }
  }
  const review = await db
    .prepare(
      `SELECT completed.bundle_id AS completed_id,
        completed_record.content_sha256 AS completed_sha256,
        requested.bundle_id AS requested_id,
        requested_record.content_sha256 AS requested_sha256,
        target.bundle_id AS target_id,
        target_record.content_sha256 AS target_sha256
       FROM project_event_bundles completed
       JOIN project_event_bundles target
         ON target.bundle_id = completed.review_result_target_bundle_id
        AND target.run_id = completed.run_id
        AND target.has_provisional_result = 1
       JOIN project_event_bundles requested
         ON requested.run_id = completed.run_id
        AND requested.review_request_target_bundle_id = target.bundle_id
        AND requested.requested_reviewer_actor_id = completed.actor_id
       JOIN project_operation_records completed_record
         ON completed_record.operation_record_id = completed.bundle_id
       JOIN project_operation_records requested_record
         ON requested_record.operation_record_id = requested.bundle_id
       JOIN project_operation_records target_record
         ON target_record.operation_record_id = target.bundle_id
       WHERE completed.run_id = ? AND completed.project_id = ?
         AND completed.review_verdict IN ('pass', 'pass-with-findings')
         AND completed.actor_id <> target.actor_id
       ORDER BY completed.received_at DESC, completed.bundle_id DESC LIMIT 1`,
    )
    .bind(input.runId, input.projectId)
    .first<{
      completed_id: string;
      completed_sha256: string;
      requested_id: string;
      requested_sha256: string;
      target_id: string;
      target_sha256: string;
    }>();
  const reviewRefs: PolicyEvidenceRef[] =
    review === null
      ? []
      : [
          {
            contentSha256: review.target_sha256,
            id: review.target_id,
            kind: "event-bundle",
          },
          {
            contentSha256: review.requested_sha256,
            id: review.requested_id,
            kind: "independent-review",
          },
          {
            contentSha256: review.completed_sha256,
            id: review.completed_id,
            kind: "independent-review",
          },
        ];
  for (const reference of reviewRefs) {
    try {
      if ((await readLeadOperationRecord(db, storage, reference.id)) === null) {
        integrityValid = false;
      }
    } catch {
      integrityValid = false;
    }
  }
  const checkpointRow = await db
    .prepare(
      `SELECT continuity_point_id, content_sha256
       FROM project_continuity_points
       WHERE project_id = ? AND work_item_id = ? AND work_packet_id = ?
         AND acknowledged_at >= ? AND restored_at IS NULL
         AND live_fence_valid = 1 AND live_context_valid = 1
       ORDER BY acknowledged_at DESC, continuity_point_id DESC LIMIT 1`,
    )
    .bind(
      input.projectId,
      input.workItemId,
      input.workPacketId,
      input.runCreatedAt,
    )
    .first<{ continuity_point_id: string; content_sha256: string }>();
  const checkpointRef: PolicyEvidenceRef | null =
    checkpointRow === null
      ? null
      : {
          contentSha256: checkpointRow.content_sha256,
          id: checkpointRow.continuity_point_id,
          kind: "continuity-point",
        };
  if (checkpointRow !== null) {
    try {
      if (
        (await readContinuityPoint(
          db,
          storage,
          checkpointRow.continuity_point_id,
        )) === null
      ) {
        integrityValid = false;
      }
    } catch {
      integrityValid = false;
    }
  }
  const conflict = await db
    .prepare(
      `SELECT claim_key FROM project_run_claims WHERE run_id = ?
       GROUP BY claim_key HAVING COUNT(DISTINCT value_sha256) > 1 LIMIT 1`,
    )
    .bind(input.runId)
    .first();
  const blocker = await db
    .prepare(
      `SELECT 1 FROM project_exceptions
       WHERE project_id = ? AND status IN ('open', 'blocking')
         AND (run_id = ? OR run_id IS NULL) LIMIT 1`,
    )
    .bind(input.projectId, input.runId)
    .first();
  const budget = await db
    .prepare(
      `SELECT budget.budget_id, budget.elastic_record_id,
        record.content_sha256, budget.logical_units_used,
        budget.logical_unit_limit, budget.cost_microunits_used,
        budget.cost_microunit_limit
       FROM project_run_budgets budget
       JOIN project_elastic_records record
         ON record.elastic_record_id = budget.elastic_record_id
        AND record.restore_state = 'live'
       WHERE budget.project_id = ? AND budget.run_id = ? LIMIT 1`,
    )
    .bind(input.projectId, input.runId)
    .first<{
      budget_id: string;
      content_sha256: string;
      cost_microunit_limit: number;
      cost_microunits_used: number;
      elastic_record_id: string;
      logical_unit_limit: number;
      logical_units_used: number;
    }>();
  const budgetWithin =
    budget === null ||
    (budget.logical_units_used < budget.logical_unit_limit &&
      budget.cost_microunits_used < budget.cost_microunit_limit);
  const budgetRef: PolicyEvidenceRef | null =
    budget === null
      ? null
      : {
          contentSha256: budget.content_sha256,
          id: budget.elastic_record_id,
          kind: "budget-version",
        };
  if (budgetRef !== null) {
    try {
      if (
        (await readElasticOperationRecord(db, storage, budgetRef.id)) === null
      ) {
        integrityValid = false;
      }
    } catch {
      integrityValid = false;
    }
  }
  const latestIntegrity = await db
    .prepare(
      `SELECT coverage, status FROM project_operational_integrity_reports
       WHERE project_id = ? ORDER BY measured_at DESC, evidence_id DESC LIMIT 1`,
    )
    .bind(input.projectId)
    .first<{ coverage: "complete" | "partial"; status: "degraded" | "ok" }>();
  const bundleCount = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM project_event_bundles
       WHERE project_id = ? AND run_id = ?`,
    )
    .bind(input.projectId, input.runId)
    .first<{ count: number }>();
  return {
    acceptedBundleCount: bundleCount?.count ?? 0,
    binding: input.binding,
    budgetRef,
    budgetWithin,
    bundleRefs,
    checkpointRef,
    conflicts: conflict !== null,
    evidenceRefs,
    integrityValid,
    latestIntegrityDegraded:
      latestIntegrity !== null &&
      (latestIntegrity.status === "degraded" ||
        latestIntegrity.coverage !== "complete"),
    noBlockingException: blocker === null,
    purposeEvidence:
      selectedClaims.every((row) => row !== undefined) &&
      evidenceRefs.length === 2,
    reviewRefs,
    reviewValid: review !== null,
  };
}

function gateChecks(
  inputs: GateInputs,
  requestedOwnerActions: PolicyExceptionAction[],
  completionMode: CompletionMode,
  actorCount: number,
) {
  const policyRef = [inputs.binding.bindingId];
  const purposeRefs = [
    ...inputs.evidenceRefs.map((reference) => reference.id),
    ...inputs.bundleRefs.map((reference) => reference.id),
  ];
  return [
    {
      evidenceRefs: policyRef,
      key: "owner-authored-policy" as const,
      passed: inputs.binding.ownerAuthored,
    },
    {
      evidenceRefs: [],
      key: "run-identity" as const,
      passed:
        completionMode === "solo-verified" ? actorCount === 1 : actorCount >= 3,
    },
    {
      evidenceRefs: purposeRefs,
      key: "purpose-evidence" as const,
      passed: inputs.purposeEvidence,
    },
    {
      evidenceRefs: inputs.reviewRefs.map((reference) => reference.id),
      key: "independent-review" as const,
      passed: completionMode === "solo-verified" ? true : inputs.reviewValid,
    },
    {
      evidenceRefs:
        inputs.checkpointRef === null ? [] : [inputs.checkpointRef.id],
      key: "continuity-point" as const,
      passed: inputs.checkpointRef !== null,
    },
    {
      evidenceRefs: [],
      key: "no-blocking-exception" as const,
      passed: inputs.noBlockingException,
    },
    {
      evidenceRefs: [],
      key: "no-evidence-conflict" as const,
      passed: !inputs.conflicts,
    },
    {
      evidenceRefs: inputs.budgetRef === null ? [] : [inputs.budgetRef.id],
      key: "budget-within-policy" as const,
      passed: inputs.budgetWithin,
    },
    {
      evidenceRefs: [
        ...purposeRefs,
        ...inputs.reviewRefs.map((reference) => reference.id),
        ...(inputs.checkpointRef === null ? [] : [inputs.checkpointRef.id]),
      ],
      key: "integrity-valid" as const,
      passed: inputs.integrityValid && !inputs.latestIntegrityDegraded,
    },
    {
      evidenceRefs: [],
      key: "no-owner-only-action" as const,
      passed: requestedOwnerActions.length === 0,
    },
  ];
}

function exceptionReason(
  checks: ReturnType<typeof gateChecks>,
  requestedOwnerActions: PolicyExceptionAction[],
): PolicyExceptionAction | null {
  if (requestedOwnerActions[0] !== undefined) return requestedOwnerActions[0];
  const failed = new Set(
    checks.filter((check) => !check.passed).map((check) => check.key),
  );
  if (failed.has("integrity-valid")) return "integrity-failure";
  if (failed.has("no-evidence-conflict")) return "conflicting-evidence";
  if (failed.has("budget-within-policy")) return "budget-exhaustion";
  return failed.size === 0 ? null : "conflicting-evidence";
}

function mappedProjectExceptionKind(
  reason: PolicyExceptionAction,
):
  | "authority-expansion"
  | "budget-exhausted"
  | "destructive-action"
  | "evidence-conflict"
  | "protected-path-access" {
  switch (reason) {
    case "destructive-action":
      return "destructive-action";
    case "protected-path-access":
      return "protected-path-access";
    case "budget-exhaustion":
      return "budget-exhausted";
    case "conflicting-evidence":
    case "integrity-failure":
      return "evidence-conflict";
    default:
      return "authority-expansion";
  }
}

function policyDecisionProjectionStatement(
  db: D1Database,
  input: {
    decision: PolicyDecision;
    fence: Fence;
    grant: Awaited<ReturnType<typeof authorizeLead>>;
    now: number;
  },
): D1PreparedStatement {
  const decision = input.decision;
  return db
    .prepare(
      `INSERT INTO project_policy_decisions (
        decision_id, operational_record_id, project_id, project_version_id,
        work_item_id, work_packet_id, run_id, policy_id, policy_binding_id,
        continuity_point_id, purpose, gate_profile, outcome, exception_reason,
        checks_json, requested_owner_actions_json, evidence_fingerprint,
        accepted_bundle_count, evaluated_at, source_lease_id,
        source_fencing_token, live_fence_valid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ${LIVE_FENCE_SQL})`,
    )
    .bind(
      decision.decisionId,
      decision.decisionId,
      decision.projectId,
      decision.projectVersionId,
      decision.workItemId,
      decision.workPacketId,
      decision.runId,
      decision.policyId,
      decision.policyBindingId,
      decision.continuityPointId,
      decision.purpose,
      decision.gateProfile,
      decision.outcome,
      decision.exceptionReason,
      canonicalizeCollaborationJson(decision.checks),
      canonicalizeCollaborationJson(decision.requestedOwnerActions),
      decision.evidenceFingerprint,
      decision.acceptedBundleCount,
      decision.evaluatedAt,
      input.fence.leaseId,
      input.fence.fencingToken,
      ...fenceBindings(decision.projectId, input.fence, input.grant, input.now),
    );
}

export async function evaluateRunPolicy(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<Record<string, unknown>> {
  const parsed = evaluateRunPolicyRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    throw new PolicyOperationProblem("submission_invalid");
  }
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
  const digest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "evaluate_run_policy",
    requestSha256: digest,
  });
  if (replay !== null) return replayResult(replay);
  const binding = await readActiveBinding(db, storage, request.projectId);
  if (binding === null) throw new PolicyOperationProblem("policy_required");
  await verifyBindingPolicyInputs(db, storage, binding);
  const run = await readRunRow(db, request.projectId, request.runId);
  if (
    run === null ||
    run.status !== "active" ||
    run.work_item_id !== request.workItemId ||
    run.policy_id !== binding.policyId
  ) {
    throw new PolicyOperationProblem("run_invalid");
  }
  const completionMode = run.completion_mode;
  let storedRun: Awaited<ReturnType<typeof readLeadOperationRecord>>;
  try {
    storedRun = await readLeadOperationRecord(db, storage, request.runId);
  } catch {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  if (
    storedRun?.format !== "owd-run-v1" ||
    storedRun.projectId !== request.projectId ||
    storedRun.workItemId !== request.workItemId ||
    storedRun.policyId !== binding.policyId ||
    (storedRun.completionMode ?? "orchestrated-reviewed") !== completionMode
  ) {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  if (
    completionMode === "solo-verified" &&
    (binding.completionPolicy === undefined ||
      !binding.completionPolicy.allowedModes.includes(completionMode) ||
      !binding.completionPolicy.soloVerifiedOwnerConsent)
  ) {
    throw new PolicyOperationProblem("policy_required");
  }
  const gateInputs = await collectGateInputs(db, storage, {
    binding,
    projectId: request.projectId,
    purpose: run.purpose,
    runId: request.runId,
    runCreatedAt: run.created_at,
    workItemId: request.workItemId,
    workPacketId: run.work_packet_id,
  });
  const checks = gateChecks(
    gateInputs,
    request.requestedOwnerActions,
    completionMode,
    run.actor_count,
  );
  const reason = exceptionReason(checks, request.requestedOwnerActions);
  const outcome = reason === null ? "allow" : "exception";
  const evidenceRefs: PolicyEvidenceRef[] = [
    {
      contentSha256: await sha256Hex(canonicalizeCollaborationJson(binding)),
      id: binding.bindingId,
      kind: "policy-binding",
    },
    ...gateInputs.evidenceRefs,
    ...gateInputs.bundleRefs,
    ...gateInputs.reviewRefs,
    ...(gateInputs.checkpointRef === null ? [] : [gateInputs.checkpointRef]),
    ...(gateInputs.budgetRef === null ? [] : [gateInputs.budgetRef]),
  ];
  const uniqueEvidence = [
    ...new Map(
      evidenceRefs.map((reference) => [
        `${reference.kind}:${reference.id}`,
        reference,
      ]),
    ).values(),
  ];
  const evidenceFingerprint = await sha256Hex(
    canonicalizeCollaborationJson({
      acceptedBundleCount: gateInputs.acceptedBundleCount,
      checks,
      completionMode,
      evidenceRefs: uniqueEvidence,
      requestedOwnerActions: request.requestedOwnerActions,
    }),
  );
  const decision = policyDecisionSchema.parse({
    acceptedBundleCount: gateInputs.acceptedBundleCount,
    authority: AUTHORITY,
    checks,
    ...(completionMode === "solo-verified" ? { completionMode } : {}),
    continuityPointId: gateInputs.checkpointRef?.id ?? null,
    decisionId: crypto.randomUUID(),
    evaluatedAt: input.now,
    evaluator: "authorization-bound-lead",
    evidenceFingerprint,
    evidenceRefs: uniqueEvidence,
    exceptionReason: reason,
    format: "owd-policy-decision-v1",
    gateProfile:
      run.purpose === "research"
        ? OWD_RESEARCH_COMPLETION_GATE
        : OWD_CODING_COMPLETION_GATE,
    outcome,
    policyBindingId: binding.bindingId,
    policyId: binding.policyId,
    projectId: request.projectId,
    projectVersionId: binding.projectVersionId,
    purpose: run.purpose,
    requestedOwnerActions: request.requestedOwnerActions,
    runId: request.runId,
    schemaVersion: 1,
    workItemId: request.workItemId,
    workPacketId: run.work_packet_id,
  });
  const preparedDecision = await preparePolicyOperationalRecord(storage, {
    now: input.now,
    record: decision,
  });
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  const result = evaluateRunPolicyReceiptSchema.parse({
    decision,
    idempotencyKey: request.idempotencyKey,
    operation: "evaluate_run_policy",
    projectId: request.projectId,
    receivedAt: input.now,
    requestSha256: digest,
  });
  const statements: D1PreparedStatement[] = [
    insertPolicyOperationalRecordStatement(db, preparedDecision),
    policyDecisionProjectionStatement(db, {
      decision,
      fence,
      grant,
      now: input.now,
    }),
  ];
  for (const reference of uniqueEvidence) {
    statements.push(
      insertOperationalDependencyStatement(db, {
        contentSha256: reference.contentSha256,
        dependencyId: reference.id,
        dependencyKind:
          reference.kind === "accepted-content"
            ? "evidence"
            : reference.kind === "policy-binding"
              ? "operational"
              : "record",
        operationalRecordId: decision.decisionId,
      }),
    );
  }
  statements.push(
    receiptStatement(db, {
      extraFence: {
        bindings: [
          decision.decisionId,
          decision.runId,
          decision.projectId,
          decision.acceptedBundleCount,
          decision.runId,
          decision.projectId,
        ],
        sql: `EXISTS (
          SELECT 1 FROM project_policy_decisions
          WHERE decision_id = ? AND run_id = ? AND project_id = ?
        ) AND ? = (
          SELECT COUNT(*) FROM project_event_bundles
          WHERE run_id = ? AND project_id = ?
        )`,
      },
      fence,
      grant,
      idempotencyKeySha256,
      now: input.now,
      operation: "evaluate_run_policy",
      projectId: request.projectId,
      requestSha256: digest,
      result,
    }),
    auditStatement(
      db,
      `policy_operation.decision_${outcome}`,
      idempotencyKeySha256,
      input.now,
    ),
  );
  let preparedException: Awaited<
    ReturnType<typeof prepareLeadOperationRecord>
  > | null = null;
  if (reason !== null) {
    const kind = mappedProjectExceptionKind(reason);
    const requestedAction =
      kind === "authority-expansion" ||
      kind === "destructive-action" ||
      (kind === "protected-path-access" &&
        request.normalizedRelativePath !== null &&
        [".git", ".mdevolvedignore", ".owdignore", ".obsidian"].includes(
          request.normalizedRelativePath.split("/")[0] ?? "",
        ))
        ? kind
        : null;
    const exception = makeException({
      evidenceRefs: uniqueEvidence.map((reference) => reference.contentSha256),
      kind,
      normalizedRelativePath:
        requestedAction === "protected-path-access"
          ? request.normalizedRelativePath
          : null,
      now: input.now,
      projectId: request.projectId,
      requestedAction,
      runId: request.runId,
      summary: `Deterministic R4 policy denied completion: ${reason}.`,
      workItemId: request.workItemId,
    });
    preparedException = await prepareLeadOperationRecord(storage, {
      now: input.now,
      record: exception,
    });
    statements.splice(
      2,
      0,
      insertLeadOperationRecordStatement(db, preparedException),
      exceptionProjectionStatement(db, {
        exception,
        fence,
        grant,
        now: input.now,
      }),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [
        preparedDecision.bodyObjectKey,
        ...(preparedException === null
          ? []
          : [preparedException.bodyObjectKey]),
      ],
      input.now,
    );
    throw error;
  }
  return result;
}

async function readSchedule(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
): Promise<OperationalSchedule | null> {
  const row = await db
    .prepare(
      `SELECT operational_record_id FROM project_operational_schedules
       WHERE project_id = ? AND status = 'active' LIMIT 1`,
    )
    .bind(projectId)
    .first<{ operational_record_id: string }>();
  if (row === null) return null;
  const record = await readPolicyOperationalRecord(
    db,
    storage,
    row.operational_record_id,
  );
  if (record?.format !== "owd-operational-schedule-v1") {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  return record;
}

export async function getPolicyOperations(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<Record<string, unknown>> {
  const parsed = getPolicyOperationsRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    throw new PolicyOperationProblem("submission_invalid");
  }
  const request = parsed.data;
  await authorizeLeadRead(db, storage, input, request.projectId);
  const binding = await readActiveBinding(db, storage, request.projectId);
  const schedule = await readSchedule(db, storage, request.projectId);
  const decisionRows = await db
    .prepare(
      `SELECT operational_record_id FROM project_policy_decisions
       WHERE project_id = ? ORDER BY evaluated_at DESC, decision_id DESC
       LIMIT 64`,
    )
    .bind(request.projectId)
    .all<{ operational_record_id: string }>();
  const requestRows = await db
    .prepare(
      `SELECT operational_record_id FROM project_operational_requests
       WHERE project_id = ? AND status IN ('pending', 'acknowledged')
       ORDER BY created_at, request_id LIMIT 64`,
    )
    .bind(request.projectId)
    .all<{ operational_record_id: string }>();
  const decisions: PolicyDecision[] = [];
  for (const row of decisionRows.results) {
    const record = await readPolicyOperationalRecord(
      db,
      storage,
      row.operational_record_id,
    );
    if (record?.format !== "owd-policy-decision-v1") {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    decisions.push(record);
  }
  const pendingRequests: OperationalEvidence[] = [];
  for (const row of requestRows.results) {
    const record = await readPolicyOperationalRecord(
      db,
      storage,
      row.operational_record_id,
    );
    if (
      record?.format !== "owd-operational-evidence-v1" ||
      (record.detail.kind !== "continuity-point-request" &&
        record.detail.kind !== "continuity-drill-request")
    ) {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    pendingRequests.push(record);
  }
  return getPolicyOperationsReceiptSchema.parse({
    binding,
    decisions,
    operation: "get_policy_operations",
    pendingRequests,
    projectId: request.projectId,
    schedule,
  });
}

async function deterministicUuid(seed: string): Promise<string> {
  const hash = await sha256Hex(seed);
  const bytes = hash.slice(0, 32).split("");
  bytes[12] = "4";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function createScheduledRequest(
  db: D1Database,
  storage: R2Bucket,
  input: {
    dueAt: number;
    kind: "continuity-drill" | "continuity-point";
    now: number;
    schedule: ScheduleProjectionRow;
    scheduleWindow: number;
  },
): Promise<boolean> {
  const sourcePoint =
    input.kind === "continuity-drill"
      ? await readLatestContinuityPoint(db, storage, input.schedule.project_id)
      : null;
  if (
    input.kind === "continuity-drill" &&
    (sourcePoint === null ||
      sourcePoint.restoredAt !== null ||
      sourcePoint.sourceLeaseId === null)
  ) {
    return false;
  }
  if (sourcePoint !== null) {
    const contextValid = await db
      .prepare(
        `SELECT 1 AS valid
         FROM collaboration_projects project
         JOIN collaboration_work_items work
           ON work.work_item_id = ? AND work.project_id = project.project_id
         JOIN collaboration_records packet
           ON packet.id = ? AND packet.record_type = 'work-packet'
          AND packet.project_id = project.project_id
          AND packet.work_item_id = work.work_item_id
          AND packet.restored_at IS NULL
         JOIN collaboration_record_states packet_state
           ON packet_state.record_id = packet.id
          AND packet_state.disposition IN ('pending', 'accepted')
         WHERE project.project_id = ? AND project.status = 'active'
           AND project.active_project_version_id = ?
           AND work.active_work_item_version_id = ?
           AND work.status IN ('open', 'closed')
         LIMIT 1`,
      )
      .bind(
        sourcePoint.point.workItem.workItemId,
        sourcePoint.point.context.workPacketId,
        input.schedule.project_id,
        sourcePoint.point.project.projectVersionId,
        sourcePoint.point.workItem.workItemVersionId,
      )
      .first();
    if (contextValid === null) return false;
  }
  const evidenceId = await deterministicUuid(
    `${input.schedule.schedule_id}:${input.kind}:${input.scheduleWindow}`,
  );
  const evidence = operationalEvidenceSchema.parse({
    authority: AUTHORITY,
    detail:
      input.kind === "continuity-point"
        ? {
            dueAt: input.dueAt,
            kind: "continuity-point-request",
            scheduleWindow: input.scheduleWindow,
          }
        : {
            dueAt: input.dueAt,
            freshCommunityRequired: true,
            kind: "continuity-drill-request",
            leadReplacementRequired: true,
            scheduleWindow: input.scheduleWindow,
            sourceContinuityPointId: sourcePoint!.point.continuityPointId,
            sourceWorkItemId: sourcePoint!.point.workItem.workItemId,
            sourceWorkPacketId: sourcePoint!.point.context.workPacketId,
          },
    evidenceId,
    format: "owd-operational-evidence-v1",
    occurredAt: input.now,
    projectId: input.schedule.project_id,
    retainUntil: input.now + REQUEST_RETENTION_SECONDS,
    retentionTier: "warm",
    runId: null,
    scheduleId: input.schedule.schedule_id,
    schemaVersion: 1,
    status: "requested",
    summary:
      input.kind === "continuity-point"
        ? "A scheduled Continuity Point is due; an external lead may checkpoint."
        : "A disposable external continuity drill is due.",
  });
  const alreadyExists = await db
    .prepare(
      `SELECT 1 FROM project_operational_requests
       WHERE schedule_id = ? AND request_kind = ? AND schedule_window = ?`,
    )
    .bind(input.schedule.schedule_id, input.kind, input.scheduleWindow)
    .first();
  if (alreadyExists !== null) return true;
  const overlapping = await db
    .prepare(
      `SELECT 1 FROM project_operational_requests
       WHERE schedule_id = ? AND request_kind = ?
         AND status IN ('pending', 'acknowledged') LIMIT 1`,
    )
    .bind(
      input.schedule.schedule_id,
      input.kind === "continuity-point"
        ? "continuity-point"
        : "continuity-drill",
    )
    .first();
  if (overlapping !== null) return false;
  const prepared = await preparePolicyOperationalRecord(storage, {
    now: input.now,
    record: evidence,
  });
  try {
    await db.batch([
      insertPolicyOperationalRecordStatement(db, prepared),
      ...operationalEvidenceProjectionStatements(db, evidence),
      insertOperationalDependencyStatement(db, {
        dependencyId: input.schedule.schedule_id,
        dependencyKind: "operational",
        operationalRecordId: evidence.evidenceId,
      }),
      ...(sourcePoint === null
        ? []
        : [
            insertOperationalDependencyStatement(db, {
              contentSha256: sourcePoint.contentSha256,
              dependencyId: sourcePoint.point.continuityPointId,
              dependencyKind: "record",
              operationalRecordId: evidence.evidenceId,
            }),
          ]),
    ]);
  } catch (error) {
    const raced = await db
      .prepare(
        `SELECT 1 FROM project_operational_requests
         WHERE schedule_id = ? AND request_kind = ? AND schedule_window = ?`,
      )
      .bind(input.schedule.schedule_id, input.kind, input.scheduleWindow)
      .first();
    if (raced === null) throw error;
  }
  return true;
}

function nextDueAfter(
  currentDueAt: number,
  intervalSeconds: number,
  scheduledTime: number,
): number {
  const elapsed = Math.max(0, scheduledTime - currentDueAt);
  return (
    currentDueAt + (Math.floor(elapsed / intervalSeconds) + 1) * intervalSeconds
  );
}

type IntegrityCandidate = {
  body_object_key: string;
  byte_length: number;
  content_sha256: string;
  dependency_kind: "evidence" | "record";
  id: string;
};

async function scanProjectIntegrity(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
  now: number,
): Promise<void> {
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
        SELECT continuity_point_id AS id FROM project_continuity_points
          WHERE project_id = ?
        UNION ALL SELECT operation_record_id FROM project_operation_records
          WHERE project_id = ?
        UNION ALL SELECT elastic_record_id FROM project_elastic_records
          WHERE project_id = ?
        UNION ALL SELECT operational_record_id FROM project_operational_records
          WHERE project_id = ?
        UNION ALL SELECT content.id FROM collaboration_content_objects content
          WHERE EXISTS (
            SELECT 1 FROM collaboration_dependencies dependency
            JOIN collaboration_records record ON record.id = dependency.record_id
            WHERE dependency.dependency_id = content.id
              AND record.project_id = ?
            UNION ALL
            SELECT 1 FROM continuity_point_dependencies dependency
            JOIN project_continuity_points point
              ON point.continuity_point_id = dependency.continuity_point_id
            WHERE dependency.dependency_id = content.id
              AND point.project_id = ?
            UNION ALL
            SELECT 1 FROM project_operational_dependencies dependency
            JOIN project_operational_records operation
              ON operation.operational_record_id = dependency.operational_record_id
            WHERE dependency.dependency_id = content.id
              AND operation.project_id = ?
          )
      )`,
    )
    .bind(
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
    )
    .first<{ count: number }>();
  const rows = await db
    .prepare(
      `SELECT * FROM (
        SELECT continuity_point_id AS id, body_object_key, byte_length,
          content_sha256, 'record' AS dependency_kind
        FROM project_continuity_points WHERE project_id = ?
        UNION ALL
        SELECT operation_record_id, body_object_key, byte_length,
          content_sha256, 'record'
        FROM project_operation_records WHERE project_id = ?
        UNION ALL
        SELECT elastic_record_id, body_object_key, byte_length,
          content_sha256, 'record'
        FROM project_elastic_records WHERE project_id = ?
        UNION ALL
        SELECT operational_record_id, body_object_key, byte_length,
          content_sha256, 'record'
        FROM project_operational_records WHERE project_id = ?
        UNION ALL
        SELECT content.id, content.object_key, content.byte_length,
          content.content_sha256, 'evidence'
        FROM collaboration_content_objects content
        WHERE EXISTS (
          SELECT 1 FROM collaboration_dependencies dependency
          JOIN collaboration_records record ON record.id = dependency.record_id
          WHERE dependency.dependency_id = content.id AND record.project_id = ?
          UNION ALL
          SELECT 1 FROM continuity_point_dependencies dependency
          JOIN project_continuity_points point
            ON point.continuity_point_id = dependency.continuity_point_id
          WHERE dependency.dependency_id = content.id AND point.project_id = ?
          UNION ALL
          SELECT 1 FROM project_operational_dependencies dependency
          JOIN project_operational_records operation
            ON operation.operational_record_id = dependency.operational_record_id
          WHERE dependency.dependency_id = content.id AND operation.project_id = ?
        )
      ) ORDER BY dependency_kind, id LIMIT ?`,
    )
    .bind(
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
      projectId,
      INTEGRITY_BODY_LIMIT,
    )
    .all<IntegrityCandidate>();
  const completeCoverage = rows.results.length >= (count?.count ?? 0);
  let missingCount = 0;
  let mismatchedCount = 0;
  for (const row of rows.results) {
    const object = await storage.get(row.body_object_key);
    if (object === null) {
      missingCount += 1;
      continue;
    }
    if (
      object.size !== row.byte_length ||
      object.customMetadata?.sha256 !== row.content_sha256 ||
      (await sha256HexBytes(new Uint8Array(await object.arrayBuffer()))) !==
        row.content_sha256
    ) {
      mismatchedCount += 1;
    }
  }
  const evidenceId = await deterministicUuid(
    `${projectId}:integrity:${Math.floor(now / 3_600)}`,
  );
  const evidence = operationalEvidenceSchema.parse({
    authority: AUTHORITY,
    detail: {
      coverage: completeCoverage ? "complete" : "partial",
      inspectedBodyCount: rows.results.length,
      inspectedRecordCount: rows.results.length,
      kind: "integrity-scan",
      mismatchedCount,
      missingCount,
    },
    evidenceId,
    format: "owd-operational-evidence-v1",
    occurredAt: now,
    projectId,
    retainUntil: now + COLD_RETENTION_SECONDS,
    retentionTier: "cold",
    runId: null,
    scheduleId: null,
    schemaVersion: 1,
    status:
      completeCoverage && missingCount + mismatchedCount === 0
        ? "ok"
        : "degraded",
    summary:
      completeCoverage && missingCount + mismatchedCount === 0
        ? "The bounded R1-R4 integrity scan passed."
        : completeCoverage
          ? "The bounded R1-R4 integrity scan found missing or mismatched bodies."
          : "The bounded R1-R4 integrity scan was partial and failed closed.",
  });
  const existing = await db
    .prepare(
      `SELECT 1 FROM project_operational_records
       WHERE operational_record_id = ?`,
    )
    .bind(evidenceId)
    .first();
  if (existing !== null) return;
  const prepared = await preparePolicyOperationalRecord(storage, {
    now,
    record: evidence,
  });
  const statements: D1PreparedStatement[] = [
    insertPolicyOperationalRecordStatement(db, prepared),
    ...operationalEvidenceProjectionStatements(db, evidence),
  ];
  for (const row of rows.results) {
    statements.push(
      insertOperationalDependencyStatement(db, {
        contentSha256: row.content_sha256,
        dependencyId: row.id,
        dependencyKind: row.dependency_kind,
        operationalRecordId: evidence.evidenceId,
      }),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await db
      .prepare(
        `SELECT 1 FROM project_operational_records
         WHERE operational_record_id = ?`,
      )
      .bind(evidenceId)
      .first();
    if (raced === null) throw error;
  }
}

export async function runScheduledPolicyOperations(
  db: D1Database,
  storage: R2Bucket,
  scheduledTime: number,
  now = scheduledTime,
): Promise<void> {
  const schedules = await db
    .prepare(
      `SELECT schedule_id, operational_record_id, project_id,
        policy_binding_id, status, checkpoint_interval_seconds,
        drill_interval_seconds, next_checkpoint_at, next_drill_at, revision,
        created_at
       FROM project_operational_schedules
       WHERE status = 'active'
         AND (next_checkpoint_at <= ? OR next_drill_at <= ?)
       ORDER BY MIN(next_checkpoint_at, next_drill_at), schedule_id LIMIT ?`,
    )
    .bind(scheduledTime, scheduledTime, SCHEDULE_PAGE_SIZE)
    .all<ScheduleProjectionRow>();
  for (const schedule of schedules.results) {
    const statements: D1PreparedStatement[] = [];
    if (schedule.next_checkpoint_at <= scheduledTime) {
      const created = await createScheduledRequest(db, storage, {
        dueAt: schedule.next_checkpoint_at,
        kind: "continuity-point",
        now,
        schedule,
        scheduleWindow: schedule.next_checkpoint_at,
      });
      if (created)
        statements.push(
          db
            .prepare(
              `UPDATE project_operational_schedules
             SET next_checkpoint_at = ?, revision = revision + 1
             WHERE schedule_id = ? AND next_checkpoint_at = ?`,
            )
            .bind(
              nextDueAfter(
                schedule.next_checkpoint_at,
                schedule.checkpoint_interval_seconds,
                scheduledTime,
              ),
              schedule.schedule_id,
              schedule.next_checkpoint_at,
            ),
        );
    }
    if (schedule.next_drill_at <= scheduledTime) {
      const created = await createScheduledRequest(db, storage, {
        dueAt: schedule.next_drill_at,
        kind: "continuity-drill",
        now,
        schedule,
        scheduleWindow: schedule.next_drill_at,
      });
      if (created)
        statements.push(
          db
            .prepare(
              `UPDATE project_operational_schedules
             SET next_drill_at = ?, revision = revision + 1
             WHERE schedule_id = ? AND next_drill_at = ?`,
            )
            .bind(
              nextDueAfter(
                schedule.next_drill_at,
                schedule.drill_interval_seconds,
                scheduledTime,
              ),
              schedule.schedule_id,
              schedule.next_drill_at,
            ),
        );
    }
    if (statements.length > 0) await db.batch(statements);
    await scanProjectIntegrity(db, storage, schedule.project_id, now);
  }
  await db
    .prepare(
      `UPDATE project_operational_job_clock
       SET last_scheduled_time = MAX(last_scheduled_time, ?),
         last_completed_at = MAX(last_completed_at, ?)
       WHERE singleton_id = 1`,
    )
    .bind(scheduledTime, now)
    .run();
}

function continuityReceiptProjectionStatement(
  db: D1Database,
  receipt: ContinuityReceipt,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_continuity_drill_receipts (
        receipt_id, operational_record_id, project_id, drill_id,
        restored_continuity_point_id, outcome, rpo_seconds, rto_seconds,
        continuity_age_seconds, recovery_quality_bps, recovery_checks_passed,
        recovery_checks_total, runtime_independent, redacted,
        remaining_authority_count, emitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    )
    .bind(
      receipt.receiptId,
      receipt.receiptId,
      receipt.projectId,
      receipt.drillId,
      receipt.restoredContinuityPointId,
      receipt.outcome,
      receipt.metrics.rpoSeconds,
      receipt.metrics.rtoSeconds,
      receipt.metrics.continuityAgeSeconds,
      receipt.metrics.recoveryQualityBps,
      receipt.metrics.recoveryChecksPassed,
      receipt.metrics.recoveryChecksTotal,
      receipt.metrics.runtimeIndependent ? 1 : 0,
      receipt.emittedAt,
    );
}

export async function completeContinuityDrill(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<Record<string, unknown>> {
  const parsed = completeContinuityDrillRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    throw new PolicyOperationProblem("submission_invalid");
  }
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
  const digest = await requestSha256(request);
  const replay = await readReceipt(db, {
    grantId: grant.grantId,
    idempotencyKey: request.idempotencyKey,
    operation: "complete_continuity_drill",
    requestSha256: digest,
  });
  if (replay !== null) return replayResult(replay);
  const scheduled = await db
    .prepare(
      `SELECT request.operational_record_id, request.schedule_id,
        request.due_at, request.created_at, request.status
       FROM project_operational_requests request
       JOIN project_operational_schedules schedule
         ON schedule.schedule_id = request.schedule_id
       WHERE request.request_id = ? AND request.project_id = ?
         AND request.request_kind = 'continuity-drill'
         AND request.status IN ('pending', 'acknowledged')
         AND schedule.project_id = ? LIMIT 1`,
    )
    .bind(request.requestId, request.projectId, request.projectId)
    .first<{
      created_at: number;
      due_at: number;
      operational_record_id: string;
      schedule_id: string;
      status: "acknowledged" | "pending";
    }>();
  if (scheduled === null) {
    throw new PolicyOperationProblem("evidence_invalid");
  }
  let scheduledRecord: Awaited<ReturnType<typeof readPolicyOperationalRecord>>;
  let continuityPoint: Awaited<ReturnType<typeof readContinuityPoint>>;
  try {
    [scheduledRecord, continuityPoint] = await Promise.all([
      readPolicyOperationalRecord(db, storage, scheduled.operational_record_id),
      readContinuityPoint(
        db,
        storage,
        request.receipt.restoredContinuityPointId,
      ),
    ]);
  } catch {
    throw new PolicyOperationProblem("integrity_mismatch");
  }
  const pointRow = await db
    .prepare(
      `SELECT point.project_id, point.project_version_id, point.work_item_id,
        point.work_item_version_id, point.work_packet_id,
        point.source_lease_id, point.source_fencing_token,
        point.acknowledged_at, point.content_sha256
       FROM project_continuity_points point
       JOIN collaboration_projects project
         ON project.project_id = point.project_id
        AND project.status = 'active'
        AND project.active_project_version_id = point.project_version_id
       JOIN collaboration_work_items work
         ON work.work_item_id = point.work_item_id
        AND work.project_id = point.project_id
        AND work.active_work_item_version_id = point.work_item_version_id
        AND work.status IN ('open', 'closed')
       JOIN collaboration_records packet
         ON packet.id = point.work_packet_id
        AND packet.record_type = 'work-packet'
        AND packet.project_id = point.project_id
        AND packet.work_item_id = point.work_item_id
        AND packet.restored_at IS NULL
       JOIN collaboration_record_states packet_state
         ON packet_state.record_id = packet.id
        AND packet_state.disposition IN ('pending', 'accepted')
       WHERE point.continuity_point_id = ? AND point.project_id = ?
         AND point.restored_at IS NULL LIMIT 1`,
    )
    .bind(request.receipt.restoredContinuityPointId, request.projectId)
    .first<{
      acknowledged_at: number;
      content_sha256: string;
      project_id: string;
      project_version_id: string;
      source_fencing_token: number;
      source_lease_id: string | null;
      work_item_id: string;
      work_item_version_id: string;
      work_packet_id: string;
    }>();
  if (
    scheduledRecord?.format !== "owd-operational-evidence-v1" ||
    scheduledRecord.evidenceId !== request.requestId ||
    scheduledRecord.projectId !== request.projectId ||
    scheduledRecord.scheduleId !== scheduled.schedule_id ||
    scheduledRecord.detail.kind !== "continuity-drill-request" ||
    scheduledRecord.detail.dueAt !== scheduled.due_at ||
    scheduledRecord.detail.sourceContinuityPointId !==
      request.receipt.restoredContinuityPointId ||
    continuityPoint === null ||
    continuityPoint.point.project.projectId !== request.projectId ||
    pointRow === null ||
    scheduledRecord.detail.sourceWorkItemId !== pointRow.work_item_id ||
    scheduledRecord.detail.sourceWorkPacketId !== pointRow.work_packet_id ||
    continuityPoint.point.project.projectVersionId !==
      pointRow.project_version_id ||
    continuityPoint.point.workItem.workItemVersionId !==
      pointRow.work_item_version_id ||
    continuityPoint.point.provenance.leadFencingToken !==
      pointRow.source_fencing_token ||
    pointRow.source_lease_id === null ||
    pointRow.source_lease_id === request.leaseId ||
    pointRow.acknowledged_at !==
      request.receipt.sourceTimes.latestAcknowledgedPointAt ||
    pointRow.acknowledged_at !==
      request.receipt.sourceTimes.restoredPointAcknowledgedAt ||
    request.receipt.sourceTimes.simulatedLeadLossAt < scheduled.due_at ||
    request.receipt.emittedAt !== input.now
  ) {
    throw new PolicyOperationProblem("evidence_invalid");
  }
  const prepared = await preparePolicyOperationalRecord(storage, {
    now: input.now,
    record: request.receipt,
  });
  const result = completeContinuityDrillReceiptSchema.parse({
    idempotencyKey: request.idempotencyKey,
    operation: "complete_continuity_drill",
    projectId: request.projectId,
    receivedAt: input.now,
    receipt: request.receipt,
    requestId: request.requestId,
    requestSha256: digest,
  });
  const idempotencyKeySha256 = await sha256Hex(request.idempotencyKey);
  try {
    await db.batch([
      insertPolicyOperationalRecordStatement(db, prepared),
      continuityReceiptProjectionStatement(db, request.receipt),
      insertOperationalDependencyStatement(db, {
        contentSha256: pointRow.content_sha256,
        dependencyId: request.receipt.restoredContinuityPointId,
        dependencyKind: "record",
        operationalRecordId: request.receipt.receiptId,
      }),
      db
        .prepare(
          `UPDATE project_operational_requests
           SET status = 'completed', completed_at = ?
           WHERE request_id = ? AND project_id = ?
             AND status IN ('pending', 'acknowledged')`,
        )
        .bind(input.now, request.requestId, request.projectId),
      receiptStatement(db, {
        extraFence: {
          bindings: [
            request.requestId,
            request.projectId,
            input.now,
            request.receipt.receiptId,
            request.requestId,
          ],
          sql: `EXISTS (
            SELECT 1 FROM project_operational_requests
            WHERE request_id = ? AND project_id = ?
              AND status = 'completed' AND completed_at = ?
          ) AND EXISTS (
            SELECT 1 FROM project_continuity_drill_receipts
            WHERE receipt_id = ? AND drill_id = ?
          )`,
        },
        fence,
        grant,
        idempotencyKeySha256,
        now: input.now,
        operation: "complete_continuity_drill",
        projectId: request.projectId,
        requestSha256: digest,
        result,
      }),
      auditStatement(
        db,
        "policy_operation.continuity_drill_completed",
        request.requestId,
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

export async function resolveProjectException(
  db: D1Database,
  projectId: string,
  exceptionId: string,
  now: number,
): Promise<boolean> {
  const result = await db.batch([
    db
      .prepare(
        `UPDATE project_exceptions SET status = 'resolved', resolved_at = ?
         WHERE exception_id = ? AND project_id = ?
           AND status IN ('open', 'blocking')`,
      )
      .bind(now, exceptionId, projectId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'policy_operation.exception_resolved', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM project_exceptions
           WHERE exception_id = ? AND project_id = ?
             AND status = 'resolved' AND resolved_at = ?
         )`,
      )
      .bind(crypto.randomUUID(), exceptionId, now, exceptionId, projectId, now),
  ]);
  return (result[0]?.meta.changes ?? 0) === 1;
}

export async function getOperationalOverview(
  db: D1Database,
  now = Math.floor(Date.now() / 1_000),
): Promise<OperationalOverview> {
  const rows = await db
    .prepare(
      `SELECT project.project_id,
        binding.binding_id, binding.activated_at,
        decision.decision_id, decision.run_id AS decision_run_id,
        decision.purpose AS decision_purpose,
        decision.outcome AS decision_outcome,
        decision.evaluated_at,
        integrity.status AS integrity_status,
        (SELECT COUNT(*) FROM project_operational_requests request
         WHERE request.project_id = project.project_id
           AND request.status IN ('pending', 'acknowledged'))
          AS pending_request_count,
        point.acknowledged_at AS continuity_acknowledged_at,
        receipt.receipt_id, receipt.rpo_seconds, receipt.rto_seconds,
        receipt.continuity_age_seconds AS receipt_continuity_age_seconds,
        receipt.recovery_quality_bps, receipt.runtime_independent,
        receipt.emitted_at AS receipt_emitted_at
       FROM collaboration_projects project
       LEFT JOIN project_policy_bindings binding
         ON binding.project_id = project.project_id AND binding.status = 'active'
       LEFT JOIN project_policy_decisions decision
         ON decision.decision_id = (
           SELECT candidate.decision_id FROM project_policy_decisions candidate
           WHERE candidate.project_id = project.project_id
           ORDER BY candidate.evaluated_at DESC, candidate.decision_id DESC
           LIMIT 1
         )
       LEFT JOIN project_operational_integrity_reports integrity
         ON integrity.evidence_id = (
           SELECT candidate.evidence_id
           FROM project_operational_integrity_reports candidate
           WHERE candidate.project_id = project.project_id
           ORDER BY candidate.measured_at DESC, candidate.evidence_id DESC
           LIMIT 1
         )
       LEFT JOIN project_continuity_points point
         ON point.continuity_point_id = (
           SELECT candidate.continuity_point_id
           FROM project_continuity_points candidate
           WHERE candidate.project_id = project.project_id
           ORDER BY candidate.acknowledged_at DESC,
             candidate.continuity_point_id DESC LIMIT 1
         )
       LEFT JOIN project_continuity_drill_receipts receipt
         ON receipt.receipt_id = (
           SELECT candidate.receipt_id
           FROM project_continuity_drill_receipts candidate
           WHERE candidate.project_id = project.project_id
           ORDER BY candidate.emitted_at DESC, candidate.receipt_id DESC
           LIMIT 1
         )
       WHERE project.status = 'active' AND (
         binding.binding_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM project_operational_records record
           WHERE record.project_id = project.project_id
         )
       )
       ORDER BY project.project_id LIMIT 256`,
    )
    .all<{
      activated_at: number | null;
      binding_id: string | null;
      continuity_acknowledged_at: number | null;
      decision_id: string | null;
      decision_outcome: "allow" | "exception" | null;
      decision_purpose: "coding" | "research" | null;
      decision_run_id: string | null;
      evaluated_at: number | null;
      integrity_status: "degraded" | "ok" | null;
      pending_request_count: number;
      project_id: string;
      receipt_continuity_age_seconds: number | null;
      receipt_emitted_at: number | null;
      receipt_id: string | null;
      recovery_quality_bps: number | null;
      rpo_seconds: number | null;
      rto_seconds: number | null;
      runtime_independent: number | null;
    }>();
  return operationalOverviewSchema.parse({
    authority: AUTHORITY,
    format: "owd-operational-overview-v1",
    projects: rows.results.map((row) => ({
      continuityAgeSeconds:
        row.continuity_acknowledged_at === null
          ? null
          : Math.max(0, now - row.continuity_acknowledged_at),
      integrityStatus: row.integrity_status ?? "unknown",
      latestDecision:
        row.decision_id === null ||
        row.decision_run_id === null ||
        row.decision_purpose === null ||
        row.decision_outcome === null ||
        row.evaluated_at === null
          ? null
          : {
              decisionId: row.decision_id,
              evaluatedAt: row.evaluated_at,
              outcome: row.decision_outcome,
              purpose: row.decision_purpose,
              runId: row.decision_run_id,
            },
      latestReceipt:
        row.receipt_id === null ||
        row.rpo_seconds === null ||
        row.rto_seconds === null ||
        row.receipt_continuity_age_seconds === null ||
        row.recovery_quality_bps === null ||
        row.runtime_independent === null ||
        row.receipt_emitted_at === null
          ? null
          : {
              continuityAgeSeconds: row.receipt_continuity_age_seconds,
              emittedAt: row.receipt_emitted_at,
              receiptId: row.receipt_id,
              recoveryQualityBps: row.recovery_quality_bps,
              rpoSeconds: row.rpo_seconds,
              rtoSeconds: row.rto_seconds,
              runtimeIndependent: row.runtime_independent === 1,
            },
      pendingRequestCount: row.pending_request_count,
      policyBinding:
        row.binding_id === null || row.activated_at === null
          ? null
          : { activatedAt: row.activated_at, bindingId: row.binding_id },
      projectId: row.project_id,
    })),
    schemaVersion: 1,
  });
}

export async function buildPortableOperationalExport(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
): Promise<OperationalPortableExport> {
  const rows = await db
    .prepare(
      `SELECT operational_record_id, portable_object_id, content_sha256,
        byte_length FROM project_operational_records
       WHERE project_id = ? ORDER BY received_at, operational_record_id
       LIMIT ?`,
    )
    .bind(projectId, MAX_OPERATIONAL_EXPORT_RECORDS + 1)
    .all<{
      byte_length: number;
      content_sha256: string;
      operational_record_id: string;
      portable_object_id: string;
    }>();
  if (rows.results.length > MAX_OPERATIONAL_EXPORT_RECORDS) {
    throw new PolicyOperationProblem("evidence_invalid");
  }
  const dependencyRows = await db
    .prepare(
      `SELECT dependency.operational_record_id, dependency.dependency_id,
        dependency.dependency_kind, dependency.content_sha256
       FROM project_operational_dependencies dependency
       JOIN project_operational_records record
         ON record.operational_record_id = dependency.operational_record_id
       WHERE record.project_id = ?
       ORDER BY dependency.operational_record_id, dependency.dependency_kind,
         dependency.dependency_id`,
    )
    .bind(projectId)
    .all<{
      content_sha256: string | null;
      dependency_id: string;
      dependency_kind: "evidence" | "operational" | "record";
      operational_record_id: string;
    }>();
  const dependencies = new Map<
    string,
    Array<{
      contentSha256: string | null;
      dependencyId: string;
      dependencyKind: "evidence" | "operational" | "record";
    }>
  >();
  for (const row of dependencyRows.results) {
    dependencies.set(row.operational_record_id, [
      ...(dependencies.get(row.operational_record_id) ?? []),
      {
        contentSha256: row.content_sha256,
        dependencyId: row.dependency_id,
        dependencyKind: row.dependency_kind,
      },
    ]);
  }
  const records = [];
  let logicalBytes = 0;
  for (const row of rows.results) {
    const record = await readPolicyOperationalRecord(
      db,
      storage,
      row.operational_record_id,
    );
    if (record === null || record.projectId !== projectId) {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    logicalBytes += row.byte_length;
    records.push({
      byteLength: row.byte_length,
      contentSha256: row.content_sha256,
      dependencies: dependencies.get(row.operational_record_id) ?? [],
      operationalRecordId: row.operational_record_id,
      portableObjectId: row.portable_object_id,
      record,
    });
  }
  const referenceRows = await db
    .prepare(
      `SELECT DISTINCT dependency.dependency_id, dependency.dependency_kind,
        dependency.content_sha256 AS expected_content_sha256,
        CASE dependency.dependency_kind
          WHEN 'evidence' THEN content.object_key
          ELSE COALESCE(
            collaboration.body_object_key,
            lead.body_object_key,
            elastic.body_object_key,
            point.body_object_key
          )
        END AS body_object_key,
        CASE dependency.dependency_kind
          WHEN 'evidence' THEN content.byte_length
          ELSE COALESCE(
            collaboration.byte_length,
            lead.byte_length,
            elastic.byte_length,
            point.byte_length
          )
        END AS byte_length,
        CASE dependency.dependency_kind
          WHEN 'evidence' THEN content.content_sha256
          ELSE COALESCE(
            collaboration.content_sha256,
            lead.content_sha256,
            elastic.content_sha256,
            point.content_sha256
          )
        END AS content_sha256,
        CASE dependency.dependency_kind
          WHEN 'record' THEN COALESCE(
            collaboration.project_id,
            lead.project_id,
            elastic.project_id,
            point.project_id
          )
          ELSE NULL
        END AS referenced_project_id
       FROM project_operational_dependencies dependency
       JOIN project_operational_records owner
         ON owner.operational_record_id = dependency.operational_record_id
       LEFT JOIN collaboration_content_objects content
         ON dependency.dependency_kind = 'evidence'
        AND content.id = dependency.dependency_id
       LEFT JOIN collaboration_records collaboration
         ON dependency.dependency_kind = 'record'
        AND collaboration.id = dependency.dependency_id
       LEFT JOIN project_operation_records lead
         ON dependency.dependency_kind = 'record'
        AND lead.operation_record_id = dependency.dependency_id
       LEFT JOIN project_elastic_records elastic
         ON dependency.dependency_kind = 'record'
        AND elastic.elastic_record_id = dependency.dependency_id
       LEFT JOIN project_continuity_points point
         ON dependency.dependency_kind = 'record'
        AND point.continuity_point_id = dependency.dependency_id
       WHERE owner.project_id = ?
         AND dependency.dependency_kind IN ('record', 'evidence')
       ORDER BY dependency.dependency_kind, dependency.dependency_id
       LIMIT ?`,
    )
    .bind(projectId, MAX_OPERATIONAL_EXPORT_REFERENCES + 1)
    .all<{
      body_object_key: string | null;
      byte_length: number | null;
      content_sha256: string | null;
      dependency_id: string;
      dependency_kind: "evidence" | "record";
      expected_content_sha256: string | null;
      referenced_project_id: string | null;
    }>();
  if (referenceRows.results.length > MAX_OPERATIONAL_EXPORT_REFERENCES) {
    throw new PolicyOperationProblem("evidence_invalid");
  }
  const referencedBodies = [];
  for (const row of referenceRows.results) {
    if (
      row.body_object_key === null ||
      row.byte_length === null ||
      row.content_sha256 === null ||
      (row.expected_content_sha256 !== null &&
        row.expected_content_sha256 !== row.content_sha256) ||
      (row.referenced_project_id !== null &&
        row.referenced_project_id !== projectId)
    ) {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    const object = await storage.get(row.body_object_key);
    if (
      object === null ||
      object.size !== row.byte_length ||
      object.customMetadata?.sha256 !== row.content_sha256
    ) {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
      throw new PolicyOperationProblem("integrity_mismatch");
    }
    logicalBytes += row.byte_length;
    if (logicalBytes > MAX_OPERATIONAL_EXPORT_BYTES) {
      throw new PolicyOperationProblem("evidence_invalid");
    }
    referencedBodies.push({
      bodyBase64Url: encodeBase64Url(bytes),
      byteLength: row.byte_length,
      contentSha256: row.content_sha256,
      dependencyId: row.dependency_id,
      dependencyKind: row.dependency_kind,
    });
  }
  return operationalPortableExportSchema.parse({
    authority: AUTHORITY,
    format: "owd-operational-record-export-v1",
    projectId,
    records,
    referencedBodies,
    schemaVersion: 1,
  });
}

export async function latestOperationalBindingId(
  db: D1Database,
  projectId: string,
): Promise<string | null> {
  return (await readActiveBindingRow(db, projectId))?.binding_id ?? null;
}

export async function readLatestPortableContinuityPoint(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
) {
  return readLatestContinuityPoint(db, storage, projectId);
}
