import {
  MAX_R2_BUNDLES_PER_RUN,
  MAX_R2_RUN_LOGICAL_BYTES,
  MAX_R3_ACTIVE_ACTORS,
  MAX_R3_ACTOR_RECORDS,
  MAX_R3_DELTA_PAGE,
  actorRecoverySchema,
  actorSchema,
  budgetEntrySchema,
  canonicalizeCollaborationJson,
  elasticOperationOverviewSchema,
  eventBundleSchema,
  getRunContextRequestSchema,
  orcaProjectionSchema,
  projectOrcaMetadataRequestSchema,
  recoverActorRequestSchema,
  registerActorsBatchRequestSchema,
  runDeltaPageSchema,
  runDeltaSchema,
  runObservationSchema,
  submitBudgetEntryRequestSchema,
  submitBundlesBatchRequestSchema,
  submitObservationRequestSchema,
  type Actor,
  type ElasticOperationRecord,
  type ElasticOperationOverview,
  type EventBundle,
  type ProjectException,
} from "@owd/contracts";
import type { CollaborationAuthorizationContext } from "./collaboration-service";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";
import {
  prepareElasticOperationRecord,
  type PreparedElasticOperationRecord,
} from "./elastic-operation-store";
import {
  LeadOperationProblem,
  LIVE_FENCE_SQL,
  actorScopes,
  auditStatement,
  authorizeLead,
  authorizeLeadRead,
  fenceBindings,
  makeException,
  persistDeniedException,
  readActorRow,
  readReceipt,
  readRunRow,
  receiptStatement,
  replayResult,
  requestSha256,
  type Fence,
} from "./lead-operation-service";
import {
  prepareLeadOperationRecord,
  type PreparedLeadOperationRecord,
} from "./lead-operation-store";
import { decodeBase64Url, encodeBase64Url, sha256Hex } from "./security";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HOT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const WARM_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const CURSOR_LIFETIME_SECONDS = 24 * 60 * 60;

type MutationInput = {
  authorization: CollaborationAuthorizationContext;
  now: number;
  request: unknown;
};

type MutationContext = {
  fence: Fence;
  grant: Awaited<ReturnType<typeof authorizeLead>>;
  idempotencyKeySha256: string;
  requestDigest: string;
};

type MutationStart =
  | ({ kind: "mutation" } & MutationContext)
  | { kind: "replay"; result: Record<string, unknown> };

type PlaneRow = {
  active_actor_count: number;
  actor_record_count: number;
  max_active_actors: number;
  max_actor_records: number;
};

function authority() {
  return {
    liveAuthorityIncluded: false as const,
    restoredAuthorityAllowed: false as const,
  };
}

function metadata(now: number, tier: "hot" | "warm" = "hot") {
  return {
    retainUntil:
      now + (tier === "hot" ? HOT_RETENTION_SECONDS : WARM_RETENTION_SECONDS),
    retentionTier: tier,
  } as const;
}

async function beginMutation(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
  request: {
    fencingToken: number;
    idempotencyKey: string;
    leaseId: string;
    projectId: string;
  },
  operation: string,
): Promise<MutationStart> {
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
    operation,
    requestSha256: requestDigest,
  });
  if (replay !== null) {
    const prior = replayResult(replay);
    return { kind: "replay", result: { ...prior, replayed: true } };
  }
  return {
    fence,
    grant,
    idempotencyKeySha256: await sha256Hex(request.idempotencyKey),
    kind: "mutation",
    requestDigest,
  };
}

async function readConcurrentReplay(
  db: D1Database,
  input: {
    idempotencyKey: string;
    operation: string;
    started: MutationContext;
  },
): Promise<Record<string, unknown> | null> {
  const replay = await readReceipt(db, {
    grantId: input.started.grant.grantId,
    idempotencyKey: input.idempotencyKey,
    operation: input.operation,
    requestSha256: input.started.requestDigest,
  });
  return replay === null ? null : { ...replayResult(replay), replayed: true };
}

async function requireElasticPlane(
  db: D1Database,
  projectId: string,
  runId: string,
): Promise<PlaneRow> {
  const plane = await db
    .prepare(
      `SELECT active_actor_count, actor_record_count, max_active_actors,
        max_actor_records FROM project_elastic_planes
       WHERE project_id = ? AND run_id = ?`,
    )
    .bind(projectId, runId)
    .first<PlaneRow>();
  if (plane === null) throw new LeadOperationProblem("run_invalid");
  return plane;
}

async function reconcileExpiredElasticActors(
  db: D1Database,
  input: { now: number; projectId: string; runId: string },
): Promise<void> {
  const expired = await db
    .prepare(
      `SELECT actor.actor_id FROM project_actors actor
       JOIN project_elastic_actor_slots slot ON slot.actor_id = actor.actor_id
       WHERE actor.project_id = ? AND actor.run_id = ?
         AND actor.status = 'active' AND actor.expires_at <= ?
         AND slot.active_slot IS NOT NULL
       ORDER BY actor.actor_id LIMIT ?`,
    )
    .bind(input.projectId, input.runId, input.now, MAX_R3_ACTIVE_ACTORS)
    .all<{ actor_id: string }>();
  if (expired.results.length === 0) return;
  const ids = JSON.stringify(expired.results.map((row) => row.actor_id));
  await db.batch([
    db
      .prepare(
        `UPDATE project_actors SET status = 'expired'
         WHERE project_id = ? AND run_id = ? AND status = 'active'
           AND expires_at <= ?
           AND actor_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(input.projectId, input.runId, input.now, ids),
    db
      .prepare(
        `UPDATE project_elastic_actor_slots SET active_slot = NULL
         WHERE run_id = ?
           AND actor_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(input.runId, ids),
    db
      .prepare(
        `UPDATE project_elastic_planes
         SET active_actor_count = (
           SELECT COUNT(*) FROM project_elastic_actor_slots slot
           WHERE slot.run_id = project_elastic_planes.run_id
             AND slot.active_slot IS NOT NULL
         ), updated_at = ? WHERE project_id = ? AND run_id = ?`,
      )
      .bind(input.now, input.projectId, input.runId),
    db
      .prepare(
        `UPDATE project_elastic_accounts
         SET active_actor_count = (
           SELECT COUNT(*) FROM project_elastic_actor_slots slot
           WHERE slot.run_id = project_elastic_accounts.run_id
             AND slot.active_slot IS NOT NULL
         ), updated_at = ? WHERE project_id = ? AND run_id = ?`,
      )
      .bind(input.now, input.projectId, input.runId),
  ]);
}

async function readAvailableActiveSlots(
  db: D1Database,
  input: { count: number; maxActiveActors: number; runId: string },
): Promise<number[]> {
  const occupied = await db
    .prepare(
      `SELECT active_slot FROM project_elastic_actor_slots
       WHERE run_id = ? AND active_slot IS NOT NULL`,
    )
    .bind(input.runId)
    .all<{ active_slot: number }>();
  const occupiedSlots = new Set(occupied.results.map((row) => row.active_slot));
  const available = Array.from(
    { length: input.maxActiveActors },
    (_, index) => index + 1,
  )
    .filter((slot) => !occupiedSlots.has(slot))
    .slice(0, input.count);
  if (available.length !== input.count) {
    throwBackpressure(input.count, available.length);
  }
  return available;
}

function throwBackpressure(batchSize: number, capacity: number): never {
  throw new LeadOperationProblem("backpressure", {
    reason: "capacity",
    reduceBatchTo: Math.max(1, Math.min(batchSize - 1, capacity)),
    retryAfterMs: 250,
    retryable: capacity > 0,
  });
}

function mapDatabaseFailure(error: unknown, batchSize: number): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("project_elastic_actor_slots")) {
    throwBackpressure(batchSize, Math.max(1, batchSize - 1));
  }
  if (
    message.includes("project_elastic_records.elastic_record_id") ||
    message.includes("project_run_budget_entries.entry_id") ||
    message.includes("project_run_observations.observation_id") ||
    message.includes("project_orca_projections.projection_id")
  ) {
    throw new LeadOperationProblem("idempotency_conflict");
  }
  if (
    message.includes(
      "project_run_budget_entries.budget_id, project_run_budget_entries.budget_version",
    ) ||
    message.includes("project_run_budget_versions")
  ) {
    throw new LeadOperationProblem("backpressure", {
      reason: "database-overloaded",
      reduceBatchTo: Math.max(1, Math.floor(batchSize / 2)),
      retryAfterMs: 250,
      retryable: true,
    });
  }
  if (
    message.includes("project_run_budgets") ||
    message.includes("project_run_budget_entries")
  ) {
    throw new LeadOperationProblem("budget_exhausted");
  }
  if (message.includes("project_actor_recoveries")) {
    throw new LeadOperationProblem("actor_recovery_invalid");
  }
  if (/overload|busy|locked|too many|SQLITE_BUSY/iu.test(message)) {
    throw new LeadOperationProblem("backpressure", {
      reason: "database-overloaded",
      reduceBatchTo: Math.max(1, Math.floor(batchSize / 2)),
      retryAfterMs: 500,
      retryable: true,
    });
  }
  throw error;
}

function actorSlotRowsStatement(
  db: D1Database,
  input: {
    activeSlots: number[];
    actors: Actor[];
    now: number;
    recordSlotStart: number;
    runId: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_elastic_actor_slots (
        run_id, actor_id, active_slot, record_slot, created_at
      ) SELECT ?, json_extract(value, '$.actorId'),
        json_extract(value, '$.activeSlot'),
        json_extract(value, '$.recordSlot'), ? FROM json_each(?)`,
    )
    .bind(
      input.runId,
      input.now,
      JSON.stringify(
        input.actors.map((actor, index) => ({
          activeSlot: input.activeSlots[index],
          actorId: actor.actorId,
          recordSlot: input.recordSlotStart + index,
        })),
      ),
    );
}

function bulkLeadRecordsStatement(
  db: D1Database,
  records: PreparedLeadOperationRecord[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_operation_records (
        operation_record_id, record_type, project_id, work_item_id, run_id,
        actor_id, portable_object_id, content_sha256, byte_length,
        body_object_key, received_at, restored_at, restore_state
      ) SELECT
        json_extract(value, '$.id'), json_extract(value, '$.recordType'),
        json_extract(value, '$.projectId'), json_extract(value, '$.workItemId'),
        json_extract(value, '$.runId'), json_extract(value, '$.actorId'),
        json_extract(value, '$.portableObjectId'),
        json_extract(value, '$.contentSha256'), json_extract(value, '$.byteLength'),
        json_extract(value, '$.bodyObjectKey'), json_extract(value, '$.receivedAt'),
        NULL, 'live' FROM json_each(?)`,
    )
    .bind(
      JSON.stringify(
        records.map((prepared) => {
          const record = prepared.record;
          return {
            actorId: "actorId" in record ? record.actorId : null,
            bodyObjectKey: prepared.bodyObjectKey,
            byteLength: prepared.byteLength,
            contentSha256: prepared.contentSha256,
            id: prepared.operationRecordId,
            portableObjectId: prepared.portableObjectId,
            projectId: record.projectId,
            receivedAt:
              "createdAt" in record ? record.createdAt : record.issuedAt,
            recordType:
              record.format === "owd-actor-v1"
                ? "actor"
                : record.format === "owd-event-bundle-v1"
                  ? "event-bundle"
                  : "exception",
            runId: "runId" in record ? record.runId : null,
            workItemId: "workItemId" in record ? record.workItemId : null,
          };
        }),
      ),
    );
}

function bulkElasticRecordsStatement(
  db: D1Database,
  records: PreparedElasticOperationRecord[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_elastic_records (
        elastic_record_id, record_type, project_id, run_id, actor_id,
        portable_object_id, content_sha256, byte_length, body_object_key,
        received_at, restored_at, restore_state, retention_tier, retain_until
      ) SELECT json_extract(value, '$.id'), json_extract(value, '$.recordType'),
        json_extract(value, '$.projectId'), json_extract(value, '$.runId'),
        json_extract(value, '$.actorId'), json_extract(value, '$.portableObjectId'),
        json_extract(value, '$.contentSha256'), json_extract(value, '$.byteLength'),
        json_extract(value, '$.bodyObjectKey'), json_extract(value, '$.receivedAt'),
        NULL, 'live', json_extract(value, '$.retentionTier'),
        json_extract(value, '$.retainUntil') FROM json_each(?)`,
    )
    .bind(
      JSON.stringify(
        records.map((prepared) => {
          const record = prepared.record;
          const policy =
            "retention" in record ? record.retention : record.metadata;
          const receivedAt =
            record.format === "owd-elastic-run-plane-v1"
              ? record.createdAt
              : record.format === "owd-elastic-account-v1" ||
                  record.format === "owd-run-budget-v1"
                ? record.updatedAt
                : record.format === "owd-actor-recovery-v1"
                  ? record.recoveredAt
                  : record.format === "owd-run-delta-v1"
                    ? record.occurredAt
                    : record.format === "owd-budget-entry-v1"
                      ? record.createdAt
                      : record.format === "owd-run-observation-v1"
                        ? record.measuredAt
                        : record.observedAt;
          return {
            actorId:
              record.format === "owd-actor-recovery-v1"
                ? record.replacementActorId
                : record.format === "owd-budget-entry-v1" ||
                    record.format === "owd-orca-projection-v1"
                  ? record.actorId
                  : null,
            bodyObjectKey: prepared.bodyObjectKey,
            byteLength: prepared.byteLength,
            contentSha256: prepared.contentSha256,
            id: prepared.elasticRecordId,
            portableObjectId: prepared.portableObjectId,
            projectId: record.projectId,
            receivedAt,
            recordType:
              record.format === "owd-elastic-run-plane-v1"
                ? "plane"
                : record.format === "owd-elastic-account-v1"
                  ? "account"
                  : record.format === "owd-actor-recovery-v1"
                    ? "recovery"
                    : record.format === "owd-run-delta-v1"
                      ? "delta"
                      : record.format === "owd-run-budget-v1"
                        ? "budget"
                        : record.format === "owd-budget-entry-v1"
                          ? "budget-entry"
                          : record.format === "owd-run-observation-v1"
                            ? "observation"
                            : "orca",
            retainUntil: policy.retainUntil,
            retentionTier: policy.retentionTier,
            runId: record.runId,
          };
        }),
      ),
    );
}

async function prepareRunDeltas(
  db: D1Database,
  storage: R2Bucket,
  input: {
    deltas: Array<{
      contentSha256: string | null;
      evidenceMetadata?: Record<string, string>;
      occurredAt: number;
      recordId: string;
      recordType:
        | "actor"
        | "budget"
        | "event-bundle"
        | "observation"
        | "orca"
        | "recovery";
    }>;
    projectId: string;
    runId: string;
  },
): Promise<PreparedElasticOperationRecord[]> {
  const allocated = await db
    .prepare(
      `UPDATE project_run_delta_clock
       SET next_sequence = next_sequence + ? WHERE singleton_id = 1
       RETURNING next_sequence - ? AS start_sequence`,
    )
    .bind(input.deltas.length, input.deltas.length)
    .first<{ start_sequence: number }>();
  if (allocated === null) throw new LeadOperationProblem("integrity_mismatch");
  return Promise.all(
    input.deltas.map((delta, index) =>
      prepareElasticOperationRecord(storage, {
        now: delta.occurredAt,
        record: runDeltaSchema.parse({
          authority: authority(),
          contentSha256: delta.contentSha256,
          ...(delta.evidenceMetadata === undefined
            ? {}
            : { evidenceMetadata: delta.evidenceMetadata }),
          format: "owd-run-delta-v1",
          metadata: metadata(delta.occurredAt),
          occurredAt: delta.occurredAt,
          projectId: input.projectId,
          recordId: delta.recordId,
          recordType: delta.recordType,
          runId: input.runId,
          schemaVersion: 1,
          sequence: allocated.start_sequence + index,
        }),
      }),
    ),
  );
}

function actorRowsStatement(
  db: D1Database,
  actors: Actor[],
  context: MutationContext,
  projectId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_actors (
        actor_id, operation_record_id, project_id, run_id, work_item_id,
        claimed_identity, scopes_json, status, issued_at, expires_at,
        revoked_at, source_lease_id, source_fencing_token, live_fence_valid
      ) SELECT json_extract(value, '$.actorId'), json_extract(value, '$.actorId'),
        json_extract(value, '$.projectId'), json_extract(value, '$.runId'),
        json_extract(value, '$.workItemId'),
        json_extract(value, '$.claimedIdentity'),
        json_extract(value, '$.scopesJson'), 'active',
        json_extract(value, '$.issuedAt'), json_extract(value, '$.expiresAt'),
        NULL, ?, ?, ${LIVE_FENCE_SQL}
       FROM json_each(?)`,
    )
    .bind(
      context.fence.leaseId,
      context.fence.fencingToken,
      ...fenceBindings(projectId, context.fence, context.grant, now),
      JSON.stringify(
        actors.map((actor) => ({
          ...actor,
          scopesJson: JSON.stringify(actor.scopes),
        })),
      ),
    );
}

function bulkExceptionProjectionStatement(
  db: D1Database,
  exceptions: ProjectException[],
  context: MutationContext,
  projectId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_exceptions (
        exception_id, operation_record_id, project_id, run_id, work_item_id,
        actor_id, kind, status, requested_action, normalized_relative_path,
        evidence_refs_json, created_at, resolved_at, source_lease_id,
        source_fencing_token, live_fence_valid
      ) SELECT json_extract(value, '$.exceptionId'),
        json_extract(value, '$.exceptionId'), json_extract(value, '$.projectId'),
        json_extract(value, '$.runId'), json_extract(value, '$.workItemId'),
        json_extract(value, '$.actorId'), json_extract(value, '$.kind'),
        json_extract(value, '$.status'), json_extract(value, '$.requestedAction'),
        json_extract(value, '$.normalizedRelativePath'),
        json_extract(value, '$.evidenceRefsJson'),
        json_extract(value, '$.createdAt'), json_extract(value, '$.resolvedAt'),
        ?, ?, ${LIVE_FENCE_SQL} FROM json_each(?)`,
    )
    .bind(
      context.fence.leaseId,
      context.fence.fencingToken,
      ...fenceBindings(projectId, context.fence, context.grant, now),
      JSON.stringify(
        exceptions.map((exception) => ({
          ...exception,
          evidenceRefsJson: JSON.stringify(exception.evidenceRefs),
        })),
      ),
    );
}

function deltaRowsStatement(
  db: D1Database,
  preparedDeltas: PreparedElasticOperationRecord[],
): D1PreparedStatement {
  const deltas = preparedDeltas.map((prepared) =>
    runDeltaSchema.parse(prepared.record),
  );
  return db
    .prepare(
      `INSERT INTO project_run_deltas (
        delta_sequence, delta_id, project_id, run_id, record_type, record_id,
        content_sha256, evidence_metadata_json, occurred_at, retention_tier,
        retain_until
      ) SELECT json_extract(value, '$.sequence'), json_extract(value, '$.deltaId'),
        json_extract(value, '$.projectId'), json_extract(value, '$.runId'),
        json_extract(value, '$.recordType'), json_extract(value, '$.recordId'),
        json_extract(value, '$.contentSha256'),
        json_extract(value, '$.evidenceMetadataJson'),
        json_extract(value, '$.occurredAt'),
        json_extract(value, '$.retentionTier'),
        json_extract(value, '$.retainUntil') FROM json_each(?)`,
    )
    .bind(
      JSON.stringify(
        deltas.map((delta, index) => ({
          ...delta,
          deltaId: preparedDeltas[index]?.elasticRecordId,
          evidenceMetadataJson:
            delta.evidenceMetadata === undefined
              ? null
              : JSON.stringify(delta.evidenceMetadata),
          retainUntil: delta.metadata.retainUntil,
          retentionTier: delta.metadata.retentionTier,
        })),
      ),
    );
}

export async function registerRunActorsBatch(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = registerActorsBatchRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const started = await beginMutation(
    db,
    storage,
    input,
    request,
    "register_actors_batch",
  );
  if (started.kind === "replay") return started.result;
  const run = await readRunRow(db, request.projectId, request.runId);
  if (
    run === null ||
    run.status !== "active" ||
    run.work_item_id !== request.workItemId
  ) {
    throw new LeadOperationProblem("run_invalid");
  }
  await reconcileExpiredElasticActors(db, {
    now: input.now,
    projectId: request.projectId,
    runId: request.runId,
  });
  const plane = await requireElasticPlane(db, request.projectId, request.runId);
  const activeCapacity = plane.max_active_actors - plane.active_actor_count;
  const recordCapacity = plane.max_actor_records - plane.actor_record_count;
  if (
    request.actors.length > activeCapacity ||
    request.actors.length > recordCapacity
  ) {
    throwBackpressure(
      request.actors.length,
      Math.min(activeCapacity, recordCapacity),
    );
  }
  const existing = await db
    .prepare(
      `SELECT actor_id FROM project_actors
       WHERE actor_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .bind(JSON.stringify(request.actors.map((actor) => actor.actorId)))
    .first();
  if (existing !== null) throw new LeadOperationProblem("actor_invalid");
  const leaseExpiry = await db
    .prepare(
      `SELECT expires_at FROM project_lead_leases
       WHERE project_id = ? AND lease_id = ? AND status = 'active'`,
    )
    .bind(request.projectId, request.leaseId)
    .first<{ expires_at: number }>();
  if (leaseExpiry === null || leaseExpiry.expires_at <= input.now) {
    throw new LeadOperationProblem("lease_invalid");
  }
  const actors = request.actors.map((candidate) =>
    actorSchema.parse({
      actorId: candidate.actorId,
      authority: authority(),
      claimedIdentity: candidate.claimedIdentity,
      expiresAt: Math.min(
        input.now + candidate.lifetimeSeconds,
        leaseExpiry.expires_at,
      ),
      format: "owd-actor-v1",
      issuedAt: input.now,
      projectId: request.projectId,
      revokedAt: null,
      runId: request.runId,
      schemaVersion: 1,
      scopes: candidate.scopes,
      workItemId: request.workItemId,
    }),
  );
  const activeSlots = await readAvailableActiveSlots(db, {
    count: actors.length,
    maxActiveActors: plane.max_active_actors,
    runId: request.runId,
  });
  const prepared = await Promise.all(
    actors.map((actor) =>
      prepareLeadOperationRecord(storage, { now: input.now, record: actor }),
    ),
  );
  const preparedDeltas = await prepareRunDeltas(db, storage, {
    deltas: actors.map((actor, index) => ({
      contentSha256: prepared[index]?.contentSha256 ?? null,
      ...(request.actors[index]?.metadata === undefined
        ? {}
        : { evidenceMetadata: request.actors[index]?.metadata }),
      occurredAt: input.now,
      recordId: actor.actorId,
      recordType: "actor",
    })),
    projectId: request.projectId,
    runId: request.runId,
  });
  const result = {
    actors,
    idempotencyKey: request.idempotencyKey,
    operation: "register_actors_batch",
    projectId: request.projectId,
    receivedAt: input.now,
    replayed: false,
    requestSha256: started.requestDigest,
    runId: request.runId,
  };
  try {
    await db.batch([
      bulkLeadRecordsStatement(db, prepared),
      actorRowsStatement(db, actors, started, request.projectId, input.now),
      actorSlotRowsStatement(db, {
        activeSlots,
        actors,
        now: input.now,
        recordSlotStart: plane.actor_record_count + 1,
        runId: request.runId,
      }),
      db
        .prepare(
          `UPDATE project_elastic_planes
           SET active_actor_count = active_actor_count + ?,
             actor_record_count = actor_record_count + ?, updated_at = ?
           WHERE project_id = ? AND run_id = ?`,
        )
        .bind(
          actors.length,
          actors.length,
          input.now,
          request.projectId,
          request.runId,
        ),
      db
        .prepare(
          `UPDATE project_elastic_accounts
           SET active_actor_count = active_actor_count + ?,
             actor_record_count = actor_record_count + ?, updated_at = ?
           WHERE project_id = ? AND run_id = ?`,
        )
        .bind(
          actors.length,
          actors.length,
          input.now,
          request.projectId,
          request.runId,
        ),
      db
        .prepare(
          `UPDATE project_runs SET actor_count = MIN(max_actors_per_run, actor_count + ?)
           WHERE project_id = ? AND run_id = ? AND status = 'active'`,
        )
        .bind(actors.length, request.projectId, request.runId),
      bulkElasticRecordsStatement(db, preparedDeltas),
      deltaRowsStatement(db, preparedDeltas),
      receiptStatement(db, {
        extraFence: {
          bindings: [
            actors.length,
            request.runId,
            JSON.stringify(actors.map((actor) => actor.actorId)),
          ],
          sql: `? = (SELECT COUNT(*) FROM project_actors
            WHERE run_id = ? AND actor_id IN (SELECT value FROM json_each(?)))`,
        },
        fence: started.fence,
        grant: started.grant,
        idempotencyKeySha256: started.idempotencyKeySha256,
        now: input.now,
        operation: "register_actors_batch",
        projectId: request.projectId,
        requestSha256: started.requestDigest,
        result,
      }),
      auditStatement(
        db,
        "elastic_operation.actors_registered",
        started.idempotencyKeySha256,
        input.now,
      ),
    ]);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [...prepared, ...preparedDeltas].map((value) => value.bodyObjectKey),
      input.now,
    );
    const concurrentReplay = await readConcurrentReplay(db, {
      idempotencyKey: request.idempotencyKey,
      operation: "register_actors_batch",
      started,
    });
    if (concurrentReplay !== null) return concurrentReplay;
    mapDatabaseFailure(error, actors.length);
  }
  return result;
}

function validateBundleScope(
  scopes: Actor["scopes"],
  bundle: EventBundle,
): void {
  const needsReview = bundle.events.some(
    (event) => event.eventType === "review.completed",
  );
  const needsBundle = bundle.events.some(
    (event) => event.eventType !== "review.completed",
  );
  if (
    (needsBundle && !scopes.includes("run.bundle.submit")) ||
    (needsReview && !scopes.includes("run.review.submit"))
  ) {
    throw new LeadOperationProblem("scope_required");
  }
}

function parseEvidenceMetadata(
  value: string | null,
): Record<string, string> | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((item) => typeof item !== "string")
    ) {
      throw new Error("invalid_metadata");
    }
    return parsed as Record<string, string>;
  } catch {
    throw new LeadOperationProblem("integrity_mismatch");
  }
}

export async function submitRunBundlesBatch(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = submitBundlesBatchRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const started = await beginMutation(
    db,
    storage,
    input,
    request,
    "submit_bundles_batch",
  );
  if (started.kind === "replay") return started.result;
  const run = await readRunRow(db, request.projectId, request.runId);
  if (run === null || run.status !== "active")
    throw new LeadOperationProblem("run_invalid");
  await requireElasticPlane(db, request.projectId, request.runId);
  const bundles = request.items.map((item) =>
    eventBundleSchema.parse(item.bundle),
  );
  const actorIds = [
    ...new Set(
      bundles.flatMap((bundle) => [
        bundle.actorId,
        ...bundle.events.flatMap((event) =>
          event.eventType === "review.requested" ? [event.reviewerActorId] : [],
        ),
      ]),
    ),
  ];
  const actorRows = await db
    .prepare(
      `SELECT actor_id, run_id, scopes_json, status, expires_at, revoked_at
       FROM project_actors WHERE project_id = ? AND run_id = ?
         AND actor_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(request.projectId, request.runId, JSON.stringify(actorIds))
    .all<{
      actor_id: string;
      expires_at: number;
      revoked_at: number | null;
      run_id: string;
      scopes_json: string;
      status: "active" | "expired" | "revoked";
    }>();
  const byActor = new Map(actorRows.results.map((row) => [row.actor_id, row]));
  for (const bundle of bundles) {
    const actor = byActor.get(bundle.actorId);
    if (
      actor === undefined ||
      actor.status !== "active" ||
      actor.expires_at <= input.now
    ) {
      throw new LeadOperationProblem("actor_invalid");
    }
    validateBundleScope(actorScopes(actor), bundle);
  }
  const priorBundles = await db
    .prepare(
      `SELECT bundle_id, actor_id, has_provisional_result,
        review_request_target_bundle_id, requested_reviewer_actor_id
       FROM project_event_bundles WHERE project_id = ? AND run_id = ?`,
    )
    .bind(request.projectId, request.runId)
    .all<{
      actor_id: string;
      bundle_id: string;
      has_provisional_result: number;
      requested_reviewer_actor_id: string | null;
      review_request_target_bundle_id: string | null;
    }>();
  const bundleIndex = new Map<
    string,
    {
      actorId: string;
      hasProvisional: boolean;
      requestedReviewerActorId: string | null;
      reviewRequestTargetBundleId: string | null;
    }
  >(
    priorBundles.results.map((bundle) => [
      bundle.bundle_id,
      {
        actorId: bundle.actor_id,
        hasProvisional: bundle.has_provisional_result === 1,
        requestedReviewerActorId: bundle.requested_reviewer_actor_id,
        reviewRequestTargetBundleId: bundle.review_request_target_bundle_id,
      },
    ]),
  );
  for (const bundle of bundles) {
    const requestEvent = bundle.events.find(
      (event) => event.eventType === "review.requested",
    );
    bundleIndex.set(bundle.bundleId, {
      actorId: bundle.actorId,
      hasProvisional: bundle.events.some(
        (event) => event.eventType === "result.provisional",
      ),
      requestedReviewerActorId: requestEvent?.reviewerActorId ?? null,
      reviewRequestTargetBundleId: requestEvent?.targetBundleId ?? null,
    });
  }
  const denyReview = async (
    actorId: string,
    summary: string,
  ): Promise<never> => {
    const exception = makeException({
      actorId,
      kind: "review-independence",
      now: input.now,
      projectId: request.projectId,
      runId: request.runId,
      summary,
      workItemId: run.work_item_id,
    });
    await persistDeniedException(db, storage, {
      exception,
      fence: started.fence,
      grant: started.grant,
      idempotencyKeySha256: started.idempotencyKeySha256,
      now: input.now,
      operation: "submit_bundles_batch",
      requestSha256: started.requestDigest,
    });
    throw new LeadOperationProblem("review_independence");
  };
  for (const bundle of bundles) {
    for (const event of bundle.events) {
      if (event.eventType === "review.requested") {
        const target = bundleIndex.get(event.targetBundleId);
        const reviewer = byActor.get(event.reviewerActorId);
        if (
          target === undefined ||
          !target.hasProvisional ||
          reviewer === undefined ||
          reviewer.status !== "active" ||
          reviewer.expires_at <= input.now ||
          target.actorId === event.reviewerActorId ||
          !actorScopes(reviewer).includes("run.review.submit")
        ) {
          return denyReview(
            bundle.actorId,
            "The batch review request did not target an independent active reviewer inside this Run.",
          );
        }
      }
      if (event.eventType === "review.completed") {
        const target = bundleIndex.get(event.targetBundleId);
        const routed = [...bundleIndex.values()].some(
          (candidate) =>
            candidate.reviewRequestTargetBundleId === event.targetBundleId &&
            candidate.requestedReviewerActorId === bundle.actorId,
        );
        if (
          target === undefined ||
          !target.hasProvisional ||
          target.actorId === bundle.actorId ||
          !routed
        ) {
          return denyReview(
            bundle.actorId,
            "The batch review result was not submitted by the independently routed reviewer.",
          );
        }
      }
    }
  }
  const existingBundle = await db
    .prepare(
      `SELECT bundle_id FROM project_event_bundles
       WHERE bundle_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
    )
    .bind(JSON.stringify(bundles.map((bundle) => bundle.bundleId)))
    .first();
  if (existingBundle !== null)
    throw new LeadOperationProblem("idempotency_conflict");
  const preparedBundles = await Promise.all(
    bundles.map((bundle) =>
      prepareLeadOperationRecord(storage, { now: input.now, record: bundle }),
    ),
  );
  const addedBytes = preparedBundles.reduce(
    (sum, value) => sum + value.byteLength,
    0,
  );
  if (
    run.bundle_count + bundles.length > MAX_R2_BUNDLES_PER_RUN ||
    run.logical_bytes + addedBytes > MAX_R2_RUN_LOGICAL_BYTES
  ) {
    await queueCollaborationObjectCleanup(
      db,
      preparedBundles.map((value) => value.bodyObjectKey),
      input.now,
    );
    throwBackpressure(
      bundles.length,
      Math.max(0, MAX_R2_BUNDLES_PER_RUN - run.bundle_count),
    );
  }
  const budget = await db
    .prepare(
      `SELECT budget_id, accounting_version, logical_unit_limit, cost_microunit_limit,
        logical_units_used, cost_microunits_used
       FROM project_run_budgets WHERE project_id = ? AND run_id = ?`,
    )
    .bind(request.projectId, request.runId)
    .first<{
      accounting_version: number;
      budget_id: string;
      cost_microunit_limit: number;
      cost_microunits_used: number;
      logical_unit_limit: number;
      logical_units_used: number;
    }>();
  if (budget === null) throw new LeadOperationProblem("run_invalid");
  const logicalUnits = request.items.reduce(
    (sum, item) => sum + item.usage.logicalUnits,
    0,
  );
  const costMicrounits = request.items.reduce(
    (sum, item) => sum + item.usage.costMicrounits,
    0,
  );
  if (
    budget.logical_units_used + logicalUnits > budget.logical_unit_limit ||
    budget.cost_microunits_used + costMicrounits > budget.cost_microunit_limit
  ) {
    await queueCollaborationObjectCleanup(
      db,
      preparedBundles.map((value) => value.bodyObjectKey),
      input.now,
    );
    const exception = makeException({
      kind: "budget-exhausted",
      now: input.now,
      projectId: request.projectId,
      runId: request.runId,
      summary:
        "The harness-reported logical-unit or cost budget is exhausted; no batch records were accepted.",
      workItemId: run.work_item_id,
    });
    await persistDeniedException(db, storage, {
      exception,
      fence: started.fence,
      grant: started.grant,
      idempotencyKeySha256: started.idempotencyKeySha256,
      now: input.now,
      operation: "submit_bundles_batch",
      requestSha256: started.requestDigest,
    });
    throw new LeadOperationProblem("budget_exhausted");
  }
  const entries = request.items.map((item, index) =>
    budgetEntrySchema.parse({
      actorId: bundles[index]?.actorId ?? null,
      authority: authority(),
      budgetId: budget.budget_id,
      costMicrounits: item.usage.costMicrounits,
      createdAt: input.now,
      entryId: crypto.randomUUID(),
      format: "owd-budget-entry-v1",
      harnessReported: true,
      logicalUnits: item.usage.logicalUnits,
      metadata: metadata(input.now, "warm"),
      projectId: request.projectId,
      reportedBy: item.usage.reportedBy,
      runId: request.runId,
      schemaVersion: 1,
    }),
  );
  const preparedEntries = await Promise.all(
    entries.map((entry) =>
      prepareElasticOperationRecord(storage, { now: input.now, record: entry }),
    ),
  );
  const uniqueClaims = [
    ...new Map(
      bundles
        .flatMap((bundle) =>
          bundle.events.flatMap((event) =>
            event.eventType === "result.provisional"
              ? event.claims.map((claim) => ({
                  ...claim,
                  bundleId: bundle.bundleId,
                }))
              : [],
          ),
        )
        .map((claim) => [`${claim.key}\u0000${claim.valueSha256}`, claim]),
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
  const claimValues = new Map<string, Set<string>>();
  for (const claim of [
    ...existingClaims.results.map((row) => ({
      key: row.claim_key,
      valueSha256: row.value_sha256,
    })),
    ...uniqueClaims,
  ]) {
    const values = claimValues.get(claim.key) ?? new Set<string>();
    values.add(claim.valueSha256);
    claimValues.set(claim.key, values);
  }
  const conflictingKeys = [...claimValues]
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key)
    .sort();
  const exceptions: ProjectException[] = bundles.flatMap((bundle) =>
    bundle.requestedActions.map((action) =>
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
        summary: `The Run requested ${action}; OWD recorded an exception and did not execute it.`,
        workItemId: run.work_item_id,
      }),
    ),
  );
  if (conflictingKeys.length > 0) {
    exceptions.push(
      makeException({
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
        summary: `Conflicting evidence was reported for ${conflictingKeys.length} claim key${conflictingKeys.length === 1 ? "" : "s"}.`,
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
  const preparedDeltas = await prepareRunDeltas(db, storage, {
    deltas: bundles.flatMap((bundle, index) => [
      {
        contentSha256: preparedBundles[index]?.contentSha256 ?? null,
        occurredAt: input.now,
        recordId: bundle.bundleId,
        recordType: "event-bundle" as const,
      },
      {
        contentSha256: preparedEntries[index]?.contentSha256 ?? null,
        occurredAt: input.now,
        recordId: entries[index]?.entryId ?? crypto.randomUUID(),
        recordType: "budget" as const,
      },
    ]),
    projectId: request.projectId,
    runId: request.runId,
  });
  const result = {
    bundleIds: bundles.map((bundle) => bundle.bundleId),
    idempotencyKey: request.idempotencyKey,
    operation: "submit_bundles_batch",
    projectId: request.projectId,
    receivedAt: input.now,
    replayed: false,
    requestSha256: started.requestDigest,
    runId: request.runId,
  };
  const statements: D1PreparedStatement[] = [
    bulkLeadRecordsStatement(db, [...preparedBundles, ...preparedExceptions]),
    db
      .prepare(
        `INSERT INTO project_event_bundles (
          bundle_id, operation_record_id, project_id, run_id, actor_id,
          visibility, event_count, byte_length, has_provisional_result,
          review_request_target_bundle_id, requested_reviewer_actor_id,
          review_result_target_bundle_id, review_verdict, source_lease_id,
          source_fencing_token, live_fence_valid, received_at
        ) SELECT json_extract(value, '$.bundleId'), json_extract(value, '$.bundleId'),
          ?, ?, json_extract(value, '$.actorId'), 'run-shared-unvetted',
          json_extract(value, '$.eventCount'), json_extract(value, '$.byteLength'),
          json_extract(value, '$.hasProvisional'),
          json_extract(value, '$.reviewRequestTarget'), json_extract(value, '$.reviewerActorId'),
          json_extract(value, '$.reviewResultTarget'), json_extract(value, '$.reviewVerdict'),
          ?, ?, 1, ? FROM json_each(?)`,
      )
      .bind(
        request.projectId,
        request.runId,
        started.fence.leaseId,
        started.fence.fencingToken,
        input.now,
        JSON.stringify(
          bundles.map((bundle, index) => {
            const reviewRequest = bundle.events.find(
              (event) => event.eventType === "review.requested",
            );
            const reviewResult = bundle.events.find(
              (event) => event.eventType === "review.completed",
            );
            return {
              actorId: bundle.actorId,
              bundleId: bundle.bundleId,
              byteLength: preparedBundles[index]?.byteLength,
              eventCount: bundle.events.length,
              hasProvisional: bundle.events.some(
                (event) => event.eventType === "result.provisional",
              )
                ? 1
                : 0,
              reviewRequestTarget: reviewRequest?.targetBundleId ?? null,
              reviewerActorId: reviewRequest?.reviewerActorId ?? null,
              reviewResultTarget: reviewResult?.targetBundleId ?? null,
              reviewVerdict: reviewResult?.verdict ?? null,
            };
          }),
        ),
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO project_run_claims (
          run_id, bundle_id, claim_key, value_sha256, evidence_sha256
        ) SELECT ?, json_extract(value, '$.bundleId'),
          json_extract(value, '$.key'), json_extract(value, '$.valueSha256'),
          json_extract(value, '$.evidenceSha256') FROM json_each(?)`,
      )
      .bind(request.runId, JSON.stringify(uniqueClaims)),
    bulkElasticRecordsStatement(db, [...preparedEntries, ...preparedDeltas]),
    db
      .prepare(
        `UPDATE project_runs SET bundle_count = bundle_count + ?, logical_bytes = logical_bytes + ?
         WHERE project_id = ? AND run_id = ? AND status = 'active'`,
      )
      .bind(bundles.length, addedBytes, request.projectId, request.runId),
    db
      .prepare(
        `UPDATE project_elastic_accounts SET accepted_bundle_count = accepted_bundle_count + ?, updated_at = ?
         WHERE project_id = ? AND run_id = ?`,
      )
      .bind(bundles.length, input.now, request.projectId, request.runId),
    deltaRowsStatement(db, preparedDeltas),
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const prepared = preparedEntries[index];
    if (entry === undefined || prepared === undefined) {
      throw new LeadOperationProblem("integrity_mismatch");
    }
    const expectedVersion = budget.accounting_version + index;
    const logicalUnitsUsed =
      budget.logical_units_used +
      entries
        .slice(0, index + 1)
        .reduce((sum, candidate) => sum + candidate.logicalUnits, 0);
    const costMicrounitsUsed =
      budget.cost_microunits_used +
      entries
        .slice(0, index + 1)
        .reduce((sum, candidate) => sum + candidate.costMicrounits, 0);
    statements.push(
      db
        .prepare(
          `UPDATE project_run_budgets
           SET logical_units_used = logical_units_used + ?,
             cost_microunits_used = cost_microunits_used + ?,
             accounting_version = accounting_version + 1, updated_at = ?
           WHERE budget_id = ? AND project_id = ? AND run_id = ?
             AND accounting_version = ?
             AND logical_units_used + ? <= logical_unit_limit
             AND cost_microunits_used + ? <= cost_microunit_limit`,
        )
        .bind(
          entry.logicalUnits,
          entry.costMicrounits,
          input.now,
          entry.budgetId,
          request.projectId,
          request.runId,
          expectedVersion,
          entry.logicalUnits,
          entry.costMicrounits,
        ),
      db
        .prepare(
          `INSERT INTO project_run_budget_versions (
            budget_id, budget_version, logical_units_used,
            cost_microunits_used, recorded_at
          ) SELECT budget_id, accounting_version, logical_units_used,
            cost_microunits_used, ? FROM project_run_budgets
          WHERE budget_id = ? AND accounting_version = ?
            AND logical_units_used = ? AND cost_microunits_used = ?`,
        )
        .bind(
          input.now,
          entry.budgetId,
          expectedVersion + 1,
          logicalUnitsUsed,
          costMicrounitsUsed,
        ),
      db
        .prepare(
          `INSERT INTO project_run_budget_entries (
            entry_id, elastic_record_id, budget_id, project_id, run_id,
            actor_id, logical_units, cost_microunits, budget_version,
            reported_by, harness_reported, created_at, retention_tier,
            retain_until
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          entry.entryId,
          prepared.elasticRecordId,
          entry.budgetId,
          request.projectId,
          request.runId,
          entry.actorId,
          entry.logicalUnits,
          entry.costMicrounits,
          expectedVersion + 1,
          entry.reportedBy,
          entry.createdAt,
          entry.metadata.retentionTier,
          entry.metadata.retainUntil,
        ),
    );
  }
  if (exceptions.length > 0) {
    statements.push(
      bulkExceptionProjectionStatement(
        db,
        exceptions,
        started,
        request.projectId,
        input.now,
      ),
    );
  }
  statements.push(
    receiptStatement(db, {
      extraFence: {
        bindings: [
          request.runId,
          JSON.stringify(bundles.map((bundle) => bundle.bundleId)),
          bundles.length,
        ],
        sql: `(SELECT COUNT(*) FROM project_event_bundles WHERE run_id = ?
          AND bundle_id IN (SELECT value FROM json_each(?))) = ?`,
      },
      fence: started.fence,
      grant: started.grant,
      idempotencyKeySha256: started.idempotencyKeySha256,
      now: input.now,
      operation: "submit_bundles_batch",
      projectId: request.projectId,
      requestSha256: started.requestDigest,
      result,
    }),
    auditStatement(
      db,
      "elastic_operation.bundles_submitted",
      started.idempotencyKeySha256,
      input.now,
    ),
  );
  const objectKeys = [
    ...preparedBundles,
    ...preparedEntries,
    ...preparedExceptions,
    ...preparedDeltas,
  ].map((value) => value.bodyObjectKey);
  try {
    await db.batch(statements);
  } catch (error) {
    await queueCollaborationObjectCleanup(db, objectKeys, input.now);
    const concurrentReplay = await readConcurrentReplay(db, {
      idempotencyKey: request.idempotencyKey,
      operation: "submit_bundles_batch",
      started,
    });
    if (concurrentReplay !== null) return concurrentReplay;
    mapDatabaseFailure(error, bundles.length);
  }
  return result;
}

type CursorPayload = {
  checksum: string;
  expiresAt: number;
  grantId: string;
  projectId: string;
  runId: string;
  sequence: number;
  version: 1;
};

async function cursorChecksum(
  value: Omit<CursorPayload, "checksum">,
): Promise<string> {
  return sha256Hex(
    `owd-run-delta-cursor-v1\u0000${canonicalizeCollaborationJson(value)}`,
  );
}

async function encodeCursor(
  value: Omit<CursorPayload, "checksum">,
): Promise<string> {
  return encodeBase64Url(
    encoder.encode(
      JSON.stringify({ ...value, checksum: await cursorChecksum(value) }),
    ),
  );
}

async function decodeCursor(value: string): Promise<CursorPayload> {
  try {
    const decoded = decoder.decode(decodeBase64Url(value));
    if (decoded.length > 2_048) throw new Error("cursor_too_large");
    const parsed = JSON.parse(decoded) as CursorPayload;
    const { checksum, ...unsigned } = parsed;
    if (checksum !== (await cursorChecksum(unsigned)))
      throw new Error("cursor_checksum");
    return parsed;
  } catch {
    throw new LeadOperationProblem("cursor_invalid");
  }
}

export async function getRunDeltas(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = getRunContextRequestSchema.safeParse(input.request);
  if (!parsed.success || parsed.data.mode !== "delta")
    throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const grant = await authorizeLeadRead(db, storage, input, request.projectId);
  await requireElasticPlane(db, request.projectId, request.runId);
  if (request.actorId !== undefined) {
    const actor = await readActorRow(db, {
      actorId: request.actorId,
      projectId: request.projectId,
      runId: request.runId,
    });
    if (
      actor === null ||
      actor.status !== "active" ||
      actor.expires_at <= input.now ||
      !actorScopes(actor).includes("run.context.read")
    ) {
      throw new LeadOperationProblem(
        actor === null ? "actor_invalid" : "scope_required",
      );
    }
  }
  let sequence = 0;
  if (request.cursor !== undefined) {
    const cursor = await decodeCursor(request.cursor);
    if (
      cursor.version !== 1 ||
      cursor.projectId !== request.projectId ||
      cursor.runId !== request.runId ||
      cursor.grantId !== grant.grantId ||
      cursor.expiresAt <= input.now
    )
      throw new LeadOperationProblem("cursor_invalid");
    sequence = cursor.sequence;
  }
  const limit = request.limit ?? MAX_R3_DELTA_PAGE;
  const rows = await db
    .prepare(
      `SELECT delta_sequence, record_type, record_id, content_sha256,
        evidence_metadata_json,
        occurred_at, retention_tier, retain_until
       FROM project_run_deltas WHERE project_id = ? AND run_id = ?
         AND delta_sequence > ? ORDER BY delta_sequence LIMIT ?`,
    )
    .bind(request.projectId, request.runId, sequence, limit + 1)
    .all<{
      content_sha256: string | null;
      delta_sequence: number;
      evidence_metadata_json: string | null;
      occurred_at: number;
      record_id: string;
      record_type:
        | "actor"
        | "budget"
        | "event-bundle"
        | "observation"
        | "orca"
        | "recovery";
      retain_until: number;
      retention_tier: "cold" | "hot" | "quarantine" | "warm";
    }>();
  const visible = rows.results.slice(0, limit);
  const last = visible.at(-1)?.delta_sequence ?? sequence;
  const hasMore = rows.results.length > limit;
  const cursor =
    visible.length === 0
      ? null
      : await encodeCursor({
          expiresAt: input.now + CURSOR_LIFETIME_SECONDS,
          grantId: grant.grantId,
          projectId: request.projectId,
          runId: request.runId,
          sequence: last,
          version: 1,
        });
  const page = runDeltaPageSchema.parse({
    authority: authority(),
    cursor,
    deltas: visible.map((row) => ({
      authority: authority(),
      contentSha256: row.content_sha256,
      ...(parseEvidenceMetadata(row.evidence_metadata_json) === undefined
        ? {}
        : {
            evidenceMetadata: parseEvidenceMetadata(row.evidence_metadata_json),
          }),
      format: "owd-run-delta-v1",
      metadata: {
        retainUntil: row.retain_until,
        retentionTier: row.retention_tier,
      },
      occurredAt: row.occurred_at,
      projectId: request.projectId,
      recordId: row.record_id,
      recordType: row.record_type,
      runId: request.runId,
      schemaVersion: 1,
      sequence: row.delta_sequence,
    })),
    format: "owd-run-delta-v1",
    hasMore,
    projectId: request.projectId,
    runId: request.runId,
    schemaVersion: 1,
  });
  return { operation: "get_run_delta", page };
}

export async function recoverRunActor(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = recoverActorRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const started = await beginMutation(
    db,
    storage,
    input,
    request,
    "recover_actor",
  );
  if (started.kind === "replay") return started.result;
  const run = await readRunRow(db, request.projectId, request.runId);
  await reconcileExpiredElasticActors(db, {
    now: input.now,
    projectId: request.projectId,
    runId: request.runId,
  });
  const plane = await requireElasticPlane(db, request.projectId, request.runId);
  if (
    run === null ||
    run.status !== "active" ||
    run.work_item_id !== request.workItemId
  )
    throw new LeadOperationProblem("run_invalid");
  const abandoned = await readActorRow(db, {
    actorId: request.abandonedActorId,
    projectId: request.projectId,
    runId: request.runId,
  });
  if (
    abandoned === null ||
    abandoned.status === "revoked" ||
    (request.reason === "expired" && abandoned.expires_at > input.now)
  ) {
    throw new LeadOperationProblem("actor_recovery_invalid");
  }
  if (
    (await db
      .prepare(
        `SELECT 1 FROM project_actor_recoveries
         WHERE run_id = ? AND abandoned_actor_id = ?`,
      )
      .bind(request.runId, request.abandonedActorId)
      .first()) !== null
  ) {
    throw new LeadOperationProblem("actor_recovery_invalid");
  }
  if (
    (await db
      .prepare(`SELECT 1 FROM project_actors WHERE actor_id = ?`)
      .bind(request.replacement.actorId)
      .first()) !== null
  ) {
    throw new LeadOperationProblem("actor_invalid");
  }
  const previousScopes = actorScopes(abandoned);
  const abandonedSlot = await db
    .prepare(
      `SELECT active_slot, record_slot FROM project_elastic_actor_slots
       WHERE run_id = ? AND actor_id = ?`,
    )
    .bind(request.runId, request.abandonedActorId)
    .first<{ active_slot: number | null; record_slot: number }>();
  if (abandonedSlot === null) {
    throw new LeadOperationProblem("actor_recovery_invalid");
  }
  if (
    request.allowedScopes.some((scope) => !previousScopes.includes(scope)) ||
    request.replacement.scopes.some((scope) => !previousScopes.includes(scope))
  ) {
    throw new LeadOperationProblem("actor_recovery_invalid");
  }
  if (plane.actor_record_count >= MAX_R3_ACTOR_RECORDS) throwBackpressure(1, 0);
  const lease = await db
    .prepare(
      `SELECT expires_at FROM project_lead_leases WHERE project_id = ? AND lease_id = ?`,
    )
    .bind(request.projectId, request.leaseId)
    .first<{ expires_at: number }>();
  if (lease === null || lease.expires_at <= input.now)
    throw new LeadOperationProblem("lease_invalid");
  const replacement = actorSchema.parse({
    actorId: request.replacement.actorId,
    authority: authority(),
    claimedIdentity: request.replacement.claimedIdentity,
    expiresAt: Math.min(
      input.now + request.replacement.lifetimeSeconds,
      lease.expires_at,
    ),
    format: "owd-actor-v1",
    issuedAt: input.now,
    projectId: request.projectId,
    revokedAt: null,
    runId: request.runId,
    schemaVersion: 1,
    scopes: request.replacement.scopes,
    workItemId: request.workItemId,
  });
  const replacementActiveSlot =
    abandonedSlot.active_slot ??
    (
      await readAvailableActiveSlots(db, {
        count: 1,
        maxActiveActors: plane.max_active_actors,
        runId: request.runId,
      })
    )[0];
  if (replacementActiveSlot === undefined) {
    throwBackpressure(1, 0);
  }
  const recovery = actorRecoverySchema.parse({
    abandonedActorId: request.abandonedActorId,
    authority: authority(),
    detectedAt: request.detectedAt,
    format: "owd-actor-recovery-v1",
    metadata: metadata(input.now, "warm"),
    projectId: request.projectId,
    reason: request.reason,
    recoveredAt: input.now,
    recoveryId: crypto.randomUUID(),
    replacementActorId: replacement.actorId,
    runId: request.runId,
    schemaVersion: 1,
  });
  const preparedActor = await prepareLeadOperationRecord(storage, {
    now: input.now,
    record: replacement,
  });
  const preparedRecovery = await prepareElasticOperationRecord(storage, {
    now: input.now,
    record: recovery,
  });
  const preparedDeltas = await prepareRunDeltas(db, storage, {
    deltas: [
      {
        contentSha256: preparedActor.contentSha256,
        ...(request.replacement.metadata === undefined
          ? {}
          : { evidenceMetadata: request.replacement.metadata }),
        occurredAt: input.now,
        recordId: replacement.actorId,
        recordType: "actor",
      },
      {
        contentSha256: preparedRecovery.contentSha256,
        occurredAt: input.now,
        recordId: recovery.recoveryId,
        recordType: "recovery",
      },
    ],
    projectId: request.projectId,
    runId: request.runId,
  });
  const result = {
    idempotencyKey: request.idempotencyKey,
    operation: "recover_actor",
    projectId: request.projectId,
    receivedAt: input.now,
    recovery,
    requestSha256: started.requestDigest,
  };
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE project_actors SET status = ?, revoked_at = ? WHERE actor_id = ? AND run_id = ? AND status IN ('active','expired')`,
        )
        .bind(
          request.reason === "expired" ? "expired" : "revoked",
          request.reason === "expired" ? null : input.now,
          request.abandonedActorId,
          request.runId,
        ),
      db
        .prepare(
          `UPDATE project_elastic_actor_slots SET active_slot = NULL WHERE run_id = ? AND actor_id = ?`,
        )
        .bind(request.runId, request.abandonedActorId),
      db
        .prepare(
          `UPDATE project_elastic_planes SET active_actor_count = active_actor_count - ?, updated_at = ? WHERE run_id = ?`,
        )
        .bind(
          abandonedSlot.active_slot === null ? 0 : 1,
          input.now,
          request.runId,
        ),
      bulkLeadRecordsStatement(db, [preparedActor]),
      actorRowsStatement(
        db,
        [replacement],
        started,
        request.projectId,
        input.now,
      ),
      actorSlotRowsStatement(db, {
        activeSlots: [replacementActiveSlot],
        actors: [replacement],
        now: input.now,
        recordSlotStart: plane.actor_record_count + 1,
        runId: request.runId,
      }),
      db
        .prepare(
          `UPDATE project_elastic_planes SET active_actor_count = active_actor_count + 1, actor_record_count = actor_record_count + 1, updated_at = ? WHERE run_id = ?`,
        )
        .bind(input.now, request.runId),
      db
        .prepare(
          `UPDATE project_elastic_accounts SET active_actor_count = active_actor_count + ?, actor_record_count = actor_record_count + 1, updated_at = ? WHERE run_id = ?`,
        )
        .bind(
          abandonedSlot.active_slot === null ? 1 : 0,
          input.now,
          request.runId,
        ),
      bulkElasticRecordsStatement(db, [preparedRecovery, ...preparedDeltas]),
      db
        .prepare(
          `INSERT INTO project_actor_recoveries (recovery_id, elastic_record_id, project_id, run_id, abandoned_actor_id, replacement_actor_id, reason, detected_at, recovered_at, retention_tier, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'warm', ?)`,
        )
        .bind(
          recovery.recoveryId,
          preparedRecovery.elasticRecordId,
          request.projectId,
          request.runId,
          request.abandonedActorId,
          replacement.actorId,
          request.reason,
          request.detectedAt,
          input.now,
          recovery.metadata.retainUntil,
        ),
      deltaRowsStatement(db, preparedDeltas),
      receiptStatement(db, {
        fence: started.fence,
        grant: started.grant,
        idempotencyKeySha256: started.idempotencyKeySha256,
        now: input.now,
        operation: "recover_actor",
        projectId: request.projectId,
        requestSha256: started.requestDigest,
        result,
      }),
      auditStatement(
        db,
        "elastic_operation.actor_recovered",
        started.idempotencyKeySha256,
        input.now,
      ),
    ]);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [preparedActor, preparedRecovery, ...preparedDeltas].map(
        (value) => value.bodyObjectKey,
      ),
      input.now,
    );
    const concurrentReplay = await readConcurrentReplay(db, {
      idempotencyKey: request.idempotencyKey,
      operation: "recover_actor",
      started,
    });
    if (concurrentReplay !== null) return concurrentReplay;
    mapDatabaseFailure(error, 1);
  }
  return result;
}

async function persistSimpleElasticRecord(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
  options: {
    beforeProjection?: D1PreparedStatement[];
    operation:
      "project_orca_metadata" | "submit_budget_entry" | "submit_observation";
    projection: (
      prepared: PreparedElasticOperationRecord,
      context: MutationContext,
    ) => D1PreparedStatement;
    record: ElasticOperationRecord;
    recordId: string;
    recordType: "budget" | "observation" | "orca";
    request: {
      fencingToken: number;
      idempotencyKey: string;
      leaseId: string;
      projectId: string;
    };
    started?: MutationContext;
  },
): Promise<Record<string, unknown>> {
  const beginning =
    options.started ??
    (await beginMutation(
      db,
      storage,
      input,
      options.request,
      options.operation,
    ));
  if ("kind" in beginning && beginning.kind === "replay") {
    return beginning.result;
  }
  const started = beginning as MutationContext;
  await requireElasticPlane(
    db,
    options.request.projectId,
    options.record.runId,
  );
  if (
    (await db
      .prepare(
        `SELECT 1 FROM project_elastic_records
         WHERE elastic_record_id = ?`,
      )
      .bind(options.recordId)
      .first()) !== null
  ) {
    throw new LeadOperationProblem("idempotency_conflict");
  }
  const prepared = await prepareElasticOperationRecord(storage, {
    now: input.now,
    record: options.record,
  });
  const preparedDeltas = await prepareRunDeltas(db, storage, {
    deltas: [
      {
        contentSha256: prepared.contentSha256,
        occurredAt: input.now,
        recordId: options.recordId,
        recordType: options.recordType,
      },
    ],
    projectId: options.request.projectId,
    runId: options.record.runId,
  });
  const result = {
    accepted: true,
    idempotencyKey: options.request.idempotencyKey,
    operation: options.operation,
    projectId: options.request.projectId,
    receivedAt: input.now,
    requestSha256: started.requestDigest,
    ...(options.operation === "project_orca_metadata"
      ? { projectionId: options.recordId }
      : options.operation === "submit_observation"
        ? { observationId: options.recordId }
        : { entryId: options.recordId }),
  };
  try {
    await db.batch([
      bulkElasticRecordsStatement(db, [prepared, ...preparedDeltas]),
      ...(options.beforeProjection ?? []),
      options.projection(prepared, started),
      deltaRowsStatement(db, preparedDeltas),
      receiptStatement(db, {
        fence: started.fence,
        grant: started.grant,
        idempotencyKeySha256: started.idempotencyKeySha256,
        now: input.now,
        operation: options.operation,
        projectId: options.request.projectId,
        requestSha256: started.requestDigest,
        result,
      }),
      auditStatement(
        db,
        `elastic_operation.${options.operation}`,
        started.idempotencyKeySha256,
        input.now,
      ),
    ]);
  } catch (error) {
    await queueCollaborationObjectCleanup(
      db,
      [prepared, ...preparedDeltas].map((value) => value.bodyObjectKey),
      input.now,
    );
    const concurrentReplay = await readConcurrentReplay(db, {
      idempotencyKey: options.request.idempotencyKey,
      operation: options.operation,
      started,
    });
    if (concurrentReplay !== null) return concurrentReplay;
    mapDatabaseFailure(error, 1);
  }
  return result;
}

export async function submitRunBudgetEntry(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = submitBudgetEntryRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const entry = budgetEntrySchema.parse(request.entry);
  if (entry.projectId !== request.projectId)
    throw new LeadOperationProblem("submission_invalid");
  const beginning = await beginMutation(
    db,
    storage,
    input,
    request,
    "submit_budget_entry",
  );
  if (beginning.kind === "replay") return beginning.result;
  const run = await readRunRow(db, request.projectId, entry.runId);
  if (run === null || run.status !== "active") {
    throw new LeadOperationProblem("run_invalid");
  }
  await requireElasticPlane(db, request.projectId, entry.runId);
  const budget = await db
    .prepare(
      `SELECT budget_id, accounting_version, logical_units_used, logical_unit_limit, cost_microunits_used, cost_microunit_limit FROM project_run_budgets WHERE project_id = ? AND run_id = ?`,
    )
    .bind(request.projectId, entry.runId)
    .first<{
      accounting_version: number;
      budget_id: string;
      cost_microunit_limit: number;
      cost_microunits_used: number;
      logical_unit_limit: number;
      logical_units_used: number;
    }>();
  if (budget === null || budget.budget_id !== entry.budgetId)
    throw new LeadOperationProblem("run_invalid");
  if (
    budget.logical_units_used + entry.logicalUnits >
      budget.logical_unit_limit ||
    budget.cost_microunits_used + entry.costMicrounits >
      budget.cost_microunit_limit
  ) {
    const exception = makeException({
      actorId: entry.actorId,
      kind: "budget-exhausted",
      now: input.now,
      projectId: request.projectId,
      runId: entry.runId,
      summary:
        "The harness-reported logical-unit or cost budget is exhausted; the budget entry was not accepted.",
      workItemId: run.work_item_id,
    });
    await persistDeniedException(db, storage, {
      exception,
      fence: beginning.fence,
      grant: beginning.grant,
      idempotencyKeySha256: beginning.idempotencyKeySha256,
      now: input.now,
      operation: "submit_budget_entry",
      requestSha256: beginning.requestDigest,
    });
    throw new LeadOperationProblem("budget_exhausted");
  }
  if (entry.actorId !== null) {
    const actor = await readActorRow(db, {
      actorId: entry.actorId,
      projectId: request.projectId,
      runId: entry.runId,
    });
    if (
      actor === null ||
      actor.status !== "active" ||
      actor.expires_at <= input.now
    )
      throw new LeadOperationProblem("actor_invalid");
  }
  return persistSimpleElasticRecord(db, storage, input, {
    beforeProjection: [
      db
        .prepare(
          `UPDATE project_run_budgets SET logical_units_used = logical_units_used + ?, cost_microunits_used = cost_microunits_used + ?, accounting_version = accounting_version + 1, updated_at = ? WHERE budget_id = ? AND accounting_version = ? AND logical_units_used + ? <= logical_unit_limit AND cost_microunits_used + ? <= cost_microunit_limit`,
        )
        .bind(
          entry.logicalUnits,
          entry.costMicrounits,
          input.now,
          entry.budgetId,
          budget.accounting_version,
          entry.logicalUnits,
          entry.costMicrounits,
        ),
      db
        .prepare(
          `INSERT INTO project_run_budget_versions (
            budget_id, budget_version, logical_units_used,
            cost_microunits_used, recorded_at
          ) SELECT budget_id, accounting_version, logical_units_used,
            cost_microunits_used, ? FROM project_run_budgets
          WHERE budget_id = ? AND accounting_version = ?
            AND logical_units_used = ? AND cost_microunits_used = ?`,
        )
        .bind(
          input.now,
          entry.budgetId,
          budget.accounting_version + 1,
          budget.logical_units_used + entry.logicalUnits,
          budget.cost_microunits_used + entry.costMicrounits,
        ),
    ],
    operation: "submit_budget_entry",
    projection: (prepared) =>
      db
        .prepare(
          `INSERT INTO project_run_budget_entries (entry_id, elastic_record_id, budget_id, project_id, run_id, actor_id, logical_units, cost_microunits, budget_version, reported_by, harness_reported, created_at, retention_tier, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          entry.entryId,
          prepared.elasticRecordId,
          entry.budgetId,
          entry.projectId,
          entry.runId,
          entry.actorId,
          entry.logicalUnits,
          entry.costMicrounits,
          budget.accounting_version + 1,
          entry.reportedBy,
          entry.createdAt,
          entry.metadata.retentionTier,
          entry.metadata.retainUntil,
        ),
    record: entry,
    recordId: entry.entryId,
    recordType: "budget",
    request,
    started: beginning,
  });
}

export async function submitRunObservation(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = submitObservationRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const observation = runObservationSchema.parse(request.observation);
  if (observation.projectId !== request.projectId)
    throw new LeadOperationProblem("submission_invalid");
  return persistSimpleElasticRecord(db, storage, input, {
    operation: "submit_observation",
    projection: (prepared) =>
      db
        .prepare(
          `INSERT INTO project_run_observations (observation_id, elastic_record_id, project_id, run_id, actor_count, active_actor_count, accepted_bundle_count, delta_page_count, retry_count, rejected_count, p50_latency_ms, p95_latency_ms, owner_action_count, raw_content_included, transcripts_included, hidden_reasoning_included, terminal_history_included, credentials_included, oauth_state_included, provider_runtime_included, production_logs_included, measured_at, retention_tier, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
        )
        .bind(
          observation.observationId,
          prepared.elasticRecordId,
          observation.projectId,
          observation.runId,
          observation.actorCount,
          observation.activeActorCount,
          observation.acceptedBundleCount,
          observation.deltaPageCount,
          observation.retryCount,
          observation.rejectedCount,
          observation.p50LatencyMs,
          observation.p95LatencyMs,
          observation.ownerActionCount,
          observation.measuredAt,
          observation.metadata.retentionTier,
          observation.metadata.retainUntil,
        ),
    record: observation,
    recordId: observation.observationId,
    recordType: "observation",
    request,
  });
}

export async function projectRunOrcaMetadata(
  db: D1Database,
  storage: R2Bucket,
  input: MutationInput,
): Promise<Record<string, unknown>> {
  const parsed = projectOrcaMetadataRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new LeadOperationProblem("submission_invalid");
  const request = parsed.data;
  const projection = orcaProjectionSchema.parse(request.projection);
  if (projection.projectId !== request.projectId)
    throw new LeadOperationProblem("submission_invalid");
  const beginning = await beginMutation(
    db,
    storage,
    input,
    request,
    "project_orca_metadata",
  );
  if (beginning.kind === "replay") return beginning.result;
  if (projection.actorId !== null) {
    const actor = await readActorRow(db, {
      actorId: projection.actorId,
      projectId: request.projectId,
      runId: projection.runId,
    });
    if (
      actor === null ||
      actor.status !== "active" ||
      actor.expires_at <= input.now
    ) {
      throw new LeadOperationProblem("actor_invalid");
    }
  }
  return persistSimpleElasticRecord(db, storage, input, {
    operation: "project_orca_metadata",
    projection: (prepared) =>
      db
        .prepare(
          `INSERT INTO project_orca_projections (projection_id, elastic_record_id, project_id, run_id, actor_id, worktree_ref, branch_ref, commit_sha, pull_request_ref, session_ref, provider, observed_at, retention_tier, retain_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'orca', ?, ?, ?)`,
        )
        .bind(
          projection.projectionId,
          prepared.elasticRecordId,
          projection.projectId,
          projection.runId,
          projection.actorId,
          projection.worktreeRef,
          projection.branchRef,
          projection.commitSha,
          projection.pullRequestRef,
          projection.sessionRef,
          projection.observedAt,
          projection.metadata.retentionTier,
          projection.metadata.retainUntil,
        ),
    record: projection,
    recordId: projection.projectionId,
    recordType: "orca",
    request,
    started: beginning,
  });
}

export async function getElasticOperationOverview(
  db: D1Database,
  now = Math.floor(Date.now() / 1_000),
): Promise<ElasticOperationOverview> {
  const rows = await db
    .prepare(
      `SELECT plane.project_id, plane.run_id, run.status,
        (SELECT COUNT(*) FROM project_actors actor
         WHERE actor.run_id = plane.run_id AND actor.project_id = plane.project_id
           AND actor.status = 'active' AND actor.expires_at > ?)
          AS active_actor_count,
        plane.actor_record_count,
        account.accepted_bundle_count, budget.logical_units_used,
        budget.logical_unit_limit, budget.cost_microunits_used,
        budget.cost_microunit_limit,
        (SELECT COUNT(*) FROM project_exceptions exception
         WHERE exception.project_id = plane.project_id
           AND (exception.run_id = plane.run_id OR exception.run_id IS NULL)
           AND exception.status IN ('open', 'blocking'))
          AS blocking_exception_count,
        observation.owner_action_count, observation.p95_latency_ms,
        observation.measured_at
       FROM project_elastic_planes plane
       JOIN project_runs run ON run.run_id = plane.run_id
       JOIN project_elastic_accounts account ON account.run_id = plane.run_id
       JOIN project_run_budgets budget ON budget.run_id = plane.run_id
       LEFT JOIN project_run_observations observation
         ON observation.observation_id = (
           SELECT newest.observation_id FROM project_run_observations newest
           WHERE newest.run_id = plane.run_id
           ORDER BY newest.measured_at DESC, newest.observation_id DESC LIMIT 1
         )
       ORDER BY plane.updated_at DESC, plane.run_id LIMIT 256`,
    )
    .bind(now)
    .all<{
      accepted_bundle_count: number;
      active_actor_count: number;
      actor_record_count: number;
      blocking_exception_count: number;
      cost_microunit_limit: number;
      cost_microunits_used: number;
      logical_unit_limit: number;
      logical_units_used: number;
      measured_at: number | null;
      owner_action_count: number | null;
      p95_latency_ms: number | null;
      project_id: string;
      run_id: string;
      status: "aborted" | "active" | "completed" | "restored-inert";
    }>();
  return elasticOperationOverviewSchema.parse({
    authority: authority(),
    format: "owd-elastic-operation-overview-v1",
    runs: rows.results.map((row) => ({
      acceptedBundleCount: row.accepted_bundle_count,
      activeActorCount: row.active_actor_count,
      actorRecordCount: row.actor_record_count,
      blockingExceptionCount: row.blocking_exception_count,
      costMicrounitLimit: row.cost_microunit_limit,
      costMicrounitsUsed: row.cost_microunits_used,
      logicalUnitLimit: row.logical_unit_limit,
      logicalUnitsUsed: row.logical_units_used,
      measuredAt: row.measured_at,
      ownerActionCount: row.owner_action_count,
      p95LatencyMs: row.p95_latency_ms,
      projectId: row.project_id,
      runId: row.run_id,
      status: row.status,
    })),
    schemaVersion: 1,
  });
}
