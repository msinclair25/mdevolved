import {
  canonicalizeCollaborationJson,
  compoundingCandidateSchema,
  compoundingDraftActionResponseSchema,
  compoundingDraftSchema,
  compoundingObservationResultSchema,
  compoundingRecordBodySchema,
  learningSignalsSchema,
  type CompoundingCandidate,
  type CompoundingDraftActionRequest,
  type CompoundingDraftDispositionRequest,
  type CompoundingDraft,
  type CompoundingEvidence,
  type LearningSignal,
} from "@mdevolved/contracts";
import {
  importAgentSkill,
  mutateProjectSkill,
  saveWorkingPreference,
  WorkingProfileProblem,
} from "./working-profile-service";
import {
  canonicalCompoundingBody,
  insertCompoundingReceiptStatement,
  insertCompoundingRecordStatement,
  putImmutableCompoundingBody,
  readCompoundingBody,
  readCompoundingReceipt,
  type CompoundingRecord,
} from "./compounding-store";
import { sha256Hex } from "./security";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";

const MAX_PENDING_DRAFTS = 128;
const MAX_EVIDENCE = 16;
const ACTION_CLAIM_TTL_SECONDS = 30;
const CORRELATION_NOTE = "Suggestion only; correlation is not proof." as const;

export class CompoundingProblem extends Error {
  constructor(
    readonly code:
      | "candidate_conflict"
      | "draft_not_found"
      | "draft_not_pending"
      | "project_not_active"
      | "signal_invalid"
      | "signal_limit_exceeded"
      | "idempotency_conflict"
      | "pending_draft_limit_exceeded",
  ) {
    super(code);
    this.name = "CompoundingProblem";
  }
}

export async function ensureCompoundingCheckpointBinding(
  db: D1Database,
  input: {
    allowCreate?: boolean;
    checkpointId: string;
    learningSignalsSha256: string;
    now: number;
  },
): Promise<void> {
  if (input.learningSignalsSha256 === (await sha256Hex("[]"))) {
    // Legacy checkpoints had no M3 binding; empty signals remain compatible.
    return;
  }
  const existing = await db
    .prepare(
      `SELECT learning_signals_sha256 FROM compounding_checkpoint_bindings
       WHERE checkpoint_id = ?`,
    )
    .bind(input.checkpointId)
    .first<{ learning_signals_sha256: string }>();
  if (existing !== null) {
    if (existing.learning_signals_sha256 !== input.learningSignalsSha256) {
      throw new CompoundingProblem("signal_invalid");
    }
    return;
  }
  if (input.allowCreate === false) {
    throw new CompoundingProblem("signal_invalid");
  }
  try {
    await db
      .prepare(
        `INSERT INTO compounding_checkpoint_bindings (
           checkpoint_id, learning_signals_sha256, created_at
         ) VALUES (?, ?, ?)`,
      )
      .bind(input.checkpointId, input.learningSignalsSha256, input.now)
      .run();
  } catch {
    const raced = await db
      .prepare(
        `SELECT learning_signals_sha256 FROM compounding_checkpoint_bindings
         WHERE checkpoint_id = ?`,
      )
      .bind(input.checkpointId)
      .first<{ learning_signals_sha256: string }>();
    if (raced?.learning_signals_sha256 !== input.learningSignalsSha256) {
      throw new CompoundingProblem("signal_invalid");
    }
  }
}

type CheckpointObservationInput = {
  acknowledgedAt: number;
  checkpointId: string;
  learningSignals: unknown;
  pointContentSha256: string;
  producerClientId: string;
  projectId: string;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function candidateFromSignal(signal: LearningSignal): CompoundingCandidate {
  return signal.kind === "preference"
    ? {
        key: signal.key,
        kind: signal.kind,
        projectId: signal.projectId,
        scope: signal.scope,
        value: signal.value,
      }
    : {
        description: signal.description,
        instruction: signal.instruction,
        kind: signal.kind,
        name: signal.name,
        projectId: signal.projectId,
        scope: signal.scope,
      };
}

async function fingerprint(candidate: CompoundingCandidate): Promise<string> {
  return sha256Hex(
    canonicalizeCollaborationJson({
      content: candidate,
      kind: candidate.kind,
      projectId: candidate.projectId,
      scope: candidate.scope,
    }),
  );
}

async function deterministicUuid(
  namespace: "draft" | "draft-record",
  fingerprintValue: string,
): Promise<string> {
  const hash = await sha256Hex(`${namespace}:${fingerprintValue}`);
  const value = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(
    (Number.parseInt(hash.slice(16, 18), 16) & 0x3f) |
    0x80
  )
    .toString(16)
    .padStart(2, "0")}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
  return value;
}

function candidateKey(candidate: CompoundingCandidate): string {
  return candidate.kind === "preference" ? candidate.key : candidate.name;
}

function containsCredential(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=])/iu.test(
    value,
  );
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function evidenceFromRow(row: {
  acknowledged_at: number;
  point_content_sha256: string;
  point_id: string;
  producer_client_id: string;
}): CompoundingEvidence {
  return {
    acknowledgedAt: row.acknowledged_at,
    continuityPointId: row.point_id,
    contentSha256: row.point_content_sha256,
    producerClientId: row.producer_client_id,
  };
}

type DraftRow = {
  candidate_json: string;
  conflict: number;
  current_record_id: string;
  draft_id: string;
  evidence_json: string;
  fingerprint: string;
  first_observed_at: number;
  kind: "preference" | "skill";
  last_observed_at: number;
  observation_count: number;
  project_id: string | null;
  scope: "personal" | "project";
  status: "pending" | "accepted" | "ignored" | "deleted";
};

function draftFromRow(row: DraftRow): CompoundingDraft {
  return compoundingDraftSchema.parse({
    candidate: JSON.parse(row.candidate_json),
    conflict: row.conflict === 1,
    correlationNote: CORRELATION_NOTE,
    draftId: row.draft_id,
    evidence: JSON.parse(row.evidence_json),
    fingerprint: row.fingerprint,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    observationCount: row.observation_count,
    projectId: row.project_id,
    scope: row.scope,
    status: row.status,
  });
}

async function readDraft(
  db: D1Database,
  storage: R2Bucket,
  draftId: string,
): Promise<{ draft: CompoundingDraft; row: DraftRow }> {
  const row = await db
    .prepare(
      `SELECT draft_id, fingerprint, kind, scope, project_id, candidate_json,
              status, conflict, observation_count, evidence_json,
              first_observed_at, last_observed_at, current_record_id
       FROM compounding_drafts WHERE draft_id = ?`,
    )
    .bind(draftId)
    .first<DraftRow>();
  if (row === null) throw new CompoundingProblem("draft_not_found");
  const draft = draftFromRow(row);
  const record = await db
    .prepare(
      `SELECT body_object_key, byte_length, content_sha256
       FROM compounding_records WHERE record_id = ? AND restore_state = 'live'`,
    )
    .bind(row.current_record_id)
    .first<{
      body_object_key: string;
      byte_length: number;
      content_sha256: string;
    }>();
  if (record === null) throw new CompoundingProblem("draft_not_found");
  const body = compoundingRecordBodySchema.safeParse(
    await readCompoundingBody(storage, {
      bodyObjectKey: record.body_object_key,
      byteLength: record.byte_length,
      contentSha256: record.content_sha256,
    }),
  );
  if (!body.success || body.data.type === "checkpoint-observation") {
    throw new CompoundingProblem("draft_not_found");
  }
  return { draft, row };
}

function recordFromStored(
  stored: Awaited<ReturnType<typeof putImmutableCompoundingBody>>,
  input: Omit<
    CompoundingRecord,
    "bodyObjectKey" | "byteLength" | "contentSha256"
  >,
): CompoundingRecord {
  return { ...input, ...stored };
}

async function projectIsActive(
  db: D1Database,
  projectId: string,
): Promise<boolean> {
  return (
    (
      await db
        .prepare(
          "SELECT 1 AS present FROM collaboration_projects WHERE project_id = ? AND status = 'active'",
        )
        .bind(projectId)
        .first<{ present: number }>()
    )?.present === 1
  );
}

async function evidenceForFingerprint(
  db: D1Database,
  fingerprintValue: string,
): Promise<CompoundingEvidence[]> {
  const rows = await db
    .prepare(
      `SELECT point_id, point_content_sha256, producer_client_id, acknowledged_at
       FROM compounding_observations WHERE fingerprint = ?
       ORDER BY acknowledged_at, observation_id LIMIT ?`,
    )
    .bind(fingerprintValue, MAX_EVIDENCE)
    .all<{
      acknowledged_at: number;
      point_content_sha256: string;
      point_id: string;
      producer_client_id: string;
    }>();
  return rows.results.map(evidenceFromRow);
}

async function hasCompetingCandidate(
  db: D1Database,
  candidate: CompoundingCandidate,
  fingerprintValue: string,
): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT fingerprint FROM compounding_drafts
       WHERE status = 'pending' AND kind = ? AND scope = ?
         AND project_id IS ? AND json_extract(candidate_json, '$.${
           candidate.kind === "preference" ? "key" : "name"
         }') = ?`,
    )
    .bind(
      candidate.kind,
      candidate.scope,
      candidate.projectId,
      candidateKey(candidate),
    )
    .all<{ fingerprint: string }>();
  return rows.results.some((row) => row.fingerprint !== fingerprintValue);
}

async function createDraftIfReady(
  db: D1Database,
  storage: R2Bucket,
  candidate: CompoundingCandidate,
  fingerprintValue: string,
  now: number,
): Promise<string | null> {
  const points = await db
    .prepare(
      `SELECT COUNT(DISTINCT point_id) AS count
       FROM compounding_observations WHERE fingerprint = ?`,
    )
    .bind(fingerprintValue)
    .first<{ count: number }>();
  if ((points?.count ?? 0) < 2) return null;
  const existing = await db
    .prepare("SELECT status FROM compounding_drafts WHERE fingerprint = ?")
    .bind(fingerprintValue)
    .first<{ status: string }>();
  if (existing !== null) return null;
  const pending = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM compounding_drafts WHERE status = 'pending'",
    )
    .first<{ count: number }>();
  if ((pending?.count ?? 0) >= MAX_PENDING_DRAFTS) {
    throw new CompoundingProblem("pending_draft_limit_exceeded");
  }
  const evidence = (await evidenceForFingerprint(db, fingerprintValue)).slice(
    0,
    2,
  );
  if (evidence.length < 2) return null;
  const draftId = await deterministicUuid("draft", fingerprintValue);
  const conflict = await hasCompetingCandidate(db, candidate, fingerprintValue);
  const draft = compoundingDraftSchema.parse({
    candidate,
    conflict,
    correlationNote: CORRELATION_NOTE,
    draftId,
    evidence,
    fingerprint: fingerprintValue,
    firstObservedAt: evidence[0]?.acknowledgedAt ?? now,
    lastObservedAt: evidence.at(-1)?.acknowledgedAt ?? now,
    observationCount: evidence.length,
    projectId: candidate.projectId,
    scope: candidate.scope,
    status: "pending",
  });
  const recordId = await deterministicUuid("draft-record", fingerprintValue);
  const body = canonicalCompoundingBody({
    draft,
    recordId,
    type: "draft-version",
  });
  const stored = await putImmutableCompoundingBody(storage, body, recordId);
  try {
    const committed = await db.batch([
      insertCompoundingRecordStatement(
        db,
        recordFromStored(stored, {
          createdAt: now,
          draftId,
          fingerprint: fingerprintValue,
          observationId: null,
          portableObjectId: recordId,
          projectId: candidate.projectId,
          recordId,
          recordType: "draft-version",
        }),
      ),
      db
        .prepare(
          `INSERT OR IGNORE INTO compounding_drafts (
             draft_id, fingerprint, kind, scope, project_id, candidate_json,
             status, conflict, observation_count, evidence_json,
             first_observed_at, last_observed_at, current_record_id,
             record_restore_state, restored_authority_allowed
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 'live', 0)`,
        )
        .bind(
          draftId,
          fingerprintValue,
          candidate.kind,
          candidate.scope,
          candidate.projectId,
          canonicalCompoundingBody(candidate),
          conflict ? 1 : 0,
          evidence.length,
          canonicalCompoundingBody(evidence),
          draft.firstObservedAt,
          draft.lastObservedAt,
          recordId,
        ),
    ]);
    if ((committed[1]?.meta.changes ?? 0) === 0) return null;
  } catch (error) {
    const winner = await db
      .prepare("SELECT draft_id FROM compounding_drafts WHERE fingerprint = ?")
      .bind(fingerprintValue)
      .first<{ draft_id: string }>();
    if (winner !== null) return null;
    throw error;
  }
  if (conflict) {
    await db
      .prepare(
        `UPDATE compounding_drafts SET conflict = 1
         WHERE status = 'pending' AND kind = ? AND scope = ?
           AND project_id IS ? AND json_extract(candidate_json, '$.${
             candidate.kind === "preference" ? "key" : "name"
           }') = ?`,
      )
      .bind(
        candidate.kind,
        candidate.scope,
        candidate.projectId,
        candidateKey(candidate),
      )
      .run();
  }
  return draftId;
}

export async function observeCompoundingCheckpoint(
  db: D1Database,
  storage: R2Bucket,
  input: CheckpointObservationInput,
): Promise<{ createdDraftIds: string[]; observed: number }> {
  const parsed = learningSignalsSchema.safeParse(input.learningSignals);
  if (!parsed.success) throw new CompoundingProblem("signal_invalid");
  if (parsed.data.length > 4) {
    throw new CompoundingProblem("signal_limit_exceeded");
  }
  if (!(await projectIsActive(db, input.projectId))) {
    throw new CompoundingProblem("project_not_active");
  }
  const createdDraftIds: string[] = [];
  let observed = 0;
  for (const signal of parsed.data) {
    if (signal.scope === "project" && signal.projectId !== input.projectId) {
      throw new CompoundingProblem("signal_invalid");
    }
    const candidateText =
      signal.kind === "preference"
        ? signal.value
        : `${signal.description}\n${signal.instruction}`;
    if (containsCredential(candidateText)) {
      throw new CompoundingProblem("signal_invalid");
    }
    const candidate = compoundingCandidateSchema.parse(
      candidateFromSignal(signal),
    );
    const fingerprintValue = await fingerprint(candidate);
    const existing = await db
      .prepare(
        `SELECT observation_id FROM compounding_observations
         WHERE checkpoint_id = ? AND fingerprint = ?`,
      )
      .bind(input.checkpointId, fingerprintValue)
      .first<{ observation_id: string }>();
    if (existing !== null) continue;
    const observationId = crypto.randomUUID();
    const recordId = crypto.randomUUID();
    const point: CompoundingEvidence = {
      acknowledgedAt: input.acknowledgedAt,
      continuityPointId: input.checkpointId,
      contentSha256: input.pointContentSha256,
      producerClientId: input.producerClientId,
    };
    const body = compoundingRecordBodySchema.parse({
      correlationNote: CORRELATION_NOTE,
      fingerprint: fingerprintValue,
      learningSignal: signal,
      observationId,
      point,
      recordId,
      type: "checkpoint-observation",
    });
    const stored = await putImmutableCompoundingBody(
      storage,
      canonicalCompoundingBody(body),
      recordId,
    );
    await db.batch([
      insertCompoundingRecordStatement(
        db,
        recordFromStored(stored, {
          createdAt: nowSeconds(),
          draftId: null,
          fingerprint: fingerprintValue,
          observationId,
          portableObjectId: recordId,
          projectId: input.projectId,
          recordId,
          recordType: "checkpoint-observation",
        }),
      ),
      db
        .prepare(
          `INSERT INTO compounding_observations (
             observation_id, checkpoint_id, project_id, fingerprint, kind, scope,
             candidate_json, point_id, point_content_sha256, producer_client_id,
             acknowledged_at, record_id, restore_state, restored_authority_allowed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 0)`,
        )
        .bind(
          observationId,
          input.checkpointId,
          input.projectId,
          fingerprintValue,
          candidate.kind,
          candidate.scope,
          canonicalCompoundingBody(candidate),
          input.checkpointId,
          input.pointContentSha256,
          input.producerClientId,
          input.acknowledgedAt,
          recordId,
        ),
    ]);
    observed += 1;
    const draftId = await createDraftIfReady(
      db,
      storage,
      candidate,
      fingerprintValue,
      input.acknowledgedAt,
    );
    if (draftId !== null) createdDraftIds.push(draftId);
  }
  return compoundingObservationResultSchema.parse({
    createdDraftIds,
    observed,
  });
}

export async function listCompoundingDrafts(
  db: D1Database,
  storage: R2Bucket,
  projectId: string | null = null,
): Promise<CompoundingDraft[]> {
  const rows = await db
    .prepare(
      `SELECT draft_id, fingerprint, kind, scope, project_id, candidate_json,
              status, conflict, observation_count, evidence_json,
              first_observed_at, last_observed_at, current_record_id
       FROM compounding_drafts
       WHERE project_id IS NULL OR project_id = ?
       ORDER BY status, last_observed_at DESC, draft_id LIMIT ?`,
    )
    .bind(projectId, MAX_PENDING_DRAFTS)
    .all<DraftRow>();
  for (const row of rows.results) {
    const record = await db
      .prepare(
        `SELECT body_object_key, byte_length, content_sha256 FROM compounding_records
         WHERE record_id = ? AND restore_state = 'live'`,
      )
      .bind(row.current_record_id)
      .first<{
        body_object_key: string;
        byte_length: number;
        content_sha256: string;
      }>();
    if (record === null) throw new CompoundingProblem("draft_not_found");
    const parsed = compoundingRecordBodySchema.safeParse(
      await readCompoundingBody(storage, {
        bodyObjectKey: record.body_object_key,
        byteLength: record.byte_length,
        contentSha256: record.content_sha256,
      }),
    );
    if (!parsed.success || parsed.data.type === "checkpoint-observation") {
      throw new CompoundingProblem("draft_not_found");
    }
  }
  return rows.results.map(draftFromRow);
}

function actionOperation(
  input: "accept" | "edit" | "ignore" | "delete",
): "accept" | "edit" | "ignore" | "delete" {
  return input;
}

async function claimDraftAction(
  db: D1Database,
  input: {
    draftId: string;
    idempotencyKeySha256: string;
    inputSha256: string;
    operation: "accept" | "edit" | "ignore" | "delete";
  },
): Promise<void> {
  const claimed = await db
    .prepare(
      `INSERT OR IGNORE INTO compounding_draft_action_claims (
         draft_id, idempotency_key_sha256, operation, input_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.draftId,
      input.idempotencyKeySha256,
      input.operation,
      input.inputSha256,
      nowSeconds(),
    )
    .run();
  if (claimed.meta.changes === 1) return;
  const existing = await db
    .prepare(
      `SELECT idempotency_key_sha256, operation, input_sha256
       FROM compounding_draft_action_claims WHERE draft_id = ?`,
    )
    .bind(input.draftId)
    .first<{
      idempotency_key_sha256: string;
      input_sha256: string;
      operation: string;
    }>();
  if (
    existing?.idempotency_key_sha256 === input.idempotencyKeySha256 &&
    existing.input_sha256 === input.inputSha256 &&
    existing.operation === input.operation
  ) {
    // Exact retries resume the same idempotent downstream mutations. If the
    // first request is still running, only one final D1 batch can commit.
    return;
  }
  const recovered = await db
    .prepare(
      `UPDATE compounding_draft_action_claims
       SET idempotency_key_sha256 = ?, operation = ?, input_sha256 = ?,
           created_at = ?
       WHERE draft_id = ? AND created_at <= ?`,
    )
    .bind(
      input.idempotencyKeySha256,
      input.operation,
      input.inputSha256,
      nowSeconds(),
      input.draftId,
      nowSeconds() - ACTION_CLAIM_TTL_SECONDS,
    )
    .run();
  if (recovered.meta.changes === 1) return;
  throw new CompoundingProblem("draft_not_pending");
}

async function actionDraft(
  db: D1Database,
  storage: R2Bucket,
  input: {
    draftId: string;
    idempotencyKey: string;
    operation: "accept" | "edit" | "ignore" | "delete";
    editedCandidate?: CompoundingCandidate;
    attachProjectSkill?: boolean;
    sourceLabel?: string;
    sourceUrl?: string | null;
  },
): Promise<ReturnType<typeof compoundingDraftActionResponseSchema.parse>> {
  const idempotencyKeySha256 = await sha256Hex(input.idempotencyKey);
  const inputSha256 = await sha256Hex(canonicalizeCollaborationJson(input));
  const receipt = await readCompoundingReceipt(db, idempotencyKeySha256);
  if (receipt !== null) {
    if (
      receipt.operation !== actionOperation(input.operation) ||
      receipt.inputSha256 !== inputSha256
    ) {
      throw new CompoundingProblem("idempotency_conflict");
    }
    return compoundingDraftActionResponseSchema.parse({
      ...JSON.parse(receipt.responseJson),
      replayed: true,
    });
  }
  const current = await readDraft(db, storage, input.draftId);
  if (current.draft.status !== "pending") {
    throw new CompoundingProblem("draft_not_pending");
  }
  const candidate = input.editedCandidate ?? current.draft.candidate;
  if (
    candidate.kind !== current.draft.candidate.kind ||
    candidate.scope !== current.draft.candidate.scope ||
    candidate.projectId !== current.draft.candidate.projectId
  ) {
    throw new CompoundingProblem("candidate_conflict");
  }
  await claimDraftAction(db, {
    draftId: input.draftId,
    idempotencyKeySha256,
    inputSha256,
    operation: input.operation,
  });
  let publishedActionObjectKey: string | null = null;
  try {
    let effect: "preference-saved" | "skill-saved" | "none" = "none";
    if (input.operation === "accept" || input.operation === "edit") {
      try {
        if (candidate.kind === "preference") {
          await saveWorkingPreference(db, storage, {
            idempotencyKey: `m3.${input.idempotencyKey}`,
            key: candidate.key,
            projectId: candidate.projectId,
            sourceLabel: input.sourceLabel ?? "Owner",
            sourceUrl: input.sourceUrl ?? null,
            value: candidate.value,
          });
          effect = "preference-saved";
        } else {
          const skill = await importAgentSkill(db, storage, {
            files: [
              {
                contentBase64: base64Utf8(
                  `---\nname: ${candidate.name}\ndescription: ${candidate.description}\n---\n\n${candidate.instruction}\n`,
                ),
                path: "SKILL.md",
              },
            ],
            idempotencyKey: `m3.${input.idempotencyKey}`,
          });
          if (
            candidate.scope === "project" &&
            input.attachProjectSkill === true
          ) {
            await mutateProjectSkill(
              db,
              storage,
              {
                idempotencyKey: `m3.attach.${input.idempotencyKey}`,
                projectId: candidate.projectId!,
                skillId: skill.skillId,
              },
              true,
            );
          }
          effect = "skill-saved";
        }
      } catch (error) {
        if (error instanceof WorkingProfileProblem) {
          throw new CompoundingProblem("candidate_conflict");
        }
        throw error;
      }
    }
    const status =
      input.operation === "accept" || input.operation === "edit"
        ? "accepted"
        : input.operation === "ignore"
          ? "ignored"
          : "deleted";
    const nextDraft = compoundingDraftSchema.parse({
      ...current.draft,
      candidate,
      status,
    });
    const recordId = crypto.randomUUID();
    const recordType =
      input.operation === "accept" || input.operation === "edit"
        ? "draft-accepted"
        : input.operation === "ignore"
          ? "draft-ignored"
          : "draft-deleted";
    const body = compoundingRecordBodySchema.parse({
      draft: nextDraft,
      recordId,
      type: recordType,
    });
    const stored = await putImmutableCompoundingBody(
      storage,
      canonicalCompoundingBody(body),
      recordId,
    );
    publishedActionObjectKey = stored.bodyObjectKey;
    const response = compoundingDraftActionResponseSchema.parse({
      draft: nextDraft,
      effect,
      ok: true,
      replayed: false,
    });
    await db.batch([
      insertCompoundingRecordStatement(
        db,
        recordFromStored(stored, {
          createdAt: nowSeconds(),
          draftId: input.draftId,
          fingerprint: current.draft.fingerprint,
          observationId: null,
          portableObjectId: recordId,
          projectId: current.draft.projectId,
          recordId,
          recordType,
        }),
      ),
      db
        .prepare(
          `UPDATE compounding_drafts
         SET candidate_json = ?, status = ?, current_record_id = ?
         WHERE draft_id = ? AND status = 'pending'`,
        )
        .bind(
          canonicalCompoundingBody(candidate),
          status,
          recordId,
          input.draftId,
        ),
      insertCompoundingReceiptStatement(db, {
        createdAt: nowSeconds(),
        idempotencyKeySha256,
        inputSha256,
        operation: input.operation,
        responseJson: canonicalCompoundingBody(response),
      }),
      db
        .prepare(
          `DELETE FROM compounding_draft_action_claims
         WHERE draft_id = ? AND idempotency_key_sha256 = ?`,
        )
        .bind(input.draftId, idempotencyKeySha256),
    ]);
    return response;
  } catch (error) {
    await db
      .prepare(
        `DELETE FROM compounding_draft_action_claims
         WHERE draft_id = ? AND idempotency_key_sha256 = ?`,
      )
      .bind(input.draftId, idempotencyKeySha256)
      .run();
    if (publishedActionObjectKey !== null) {
      await queueCollaborationObjectCleanup(
        db,
        [publishedActionObjectKey],
        nowSeconds(),
      );
    }
    throw error;
  }
}

export async function acceptCompoundingDraft(
  db: D1Database,
  storage: R2Bucket,
  input: CompoundingDraftActionRequest,
) {
  if (input.editedCandidate !== undefined) {
    throw new CompoundingProblem("candidate_conflict");
  }
  return actionDraft(db, storage, { ...input, operation: "accept" });
}

export async function editAndAcceptCompoundingDraft(
  db: D1Database,
  storage: R2Bucket,
  input: CompoundingDraftActionRequest & {
    editedCandidate: CompoundingCandidate;
  },
) {
  return actionDraft(db, storage, { ...input, operation: "edit" });
}

export async function ignoreCompoundingDraft(
  db: D1Database,
  storage: R2Bucket,
  input: CompoundingDraftDispositionRequest,
) {
  return actionDraft(db, storage, { ...input, operation: "ignore" });
}

export async function deleteCompoundingDraft(
  db: D1Database,
  storage: R2Bucket,
  input: CompoundingDraftDispositionRequest,
) {
  return actionDraft(db, storage, { ...input, operation: "delete" });
}
