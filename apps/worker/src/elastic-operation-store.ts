import {
  canonicalizeCollaborationJson,
  elasticOperationRecordSchema,
  type ElasticOperationRecord,
} from "@owd/contracts";
import { sha256HexBytes } from "./security";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type PreparedElasticOperationRecord = {
  bodyObjectKey: string;
  byteLength: number;
  bytes: Uint8Array;
  contentSha256: string;
  elasticRecordId: string;
  portableObjectId: string;
  record: ElasticOperationRecord;
  restoredAt: number | null;
};

function recordId(record: ElasticOperationRecord): string {
  switch (record.format) {
    case "owd-elastic-run-plane-v1":
      return crypto.randomUUID();
    case "owd-elastic-account-v1":
      return record.accountId;
    case "owd-actor-recovery-v1":
      return record.recoveryId;
    case "owd-run-delta-v1":
      return crypto.randomUUID();
    case "owd-run-budget-v1":
      return record.budgetId;
    case "owd-budget-entry-v1":
      return record.entryId;
    case "owd-run-observation-v1":
      return record.observationId;
    case "owd-orca-projection-v1":
      return record.projectionId;
  }
}

function recordType(record: ElasticOperationRecord) {
  switch (record.format) {
    case "owd-elastic-run-plane-v1":
      return "plane" as const;
    case "owd-elastic-account-v1":
      return "account" as const;
    case "owd-actor-recovery-v1":
      return "recovery" as const;
    case "owd-run-delta-v1":
      return "delta" as const;
    case "owd-run-budget-v1":
      return "budget" as const;
    case "owd-budget-entry-v1":
      return "budget-entry" as const;
    case "owd-run-observation-v1":
      return "observation" as const;
    case "owd-orca-projection-v1":
      return "orca" as const;
  }
}

function receivedAt(record: ElasticOperationRecord): number {
  switch (record.format) {
    case "owd-elastic-run-plane-v1":
      return record.createdAt;
    case "owd-elastic-account-v1":
    case "owd-run-budget-v1":
      return record.updatedAt;
    case "owd-actor-recovery-v1":
      return record.recoveredAt;
    case "owd-run-delta-v1":
      return record.occurredAt;
    case "owd-budget-entry-v1":
      return record.createdAt;
    case "owd-run-observation-v1":
      return record.measuredAt;
    case "owd-orca-projection-v1":
      return record.observedAt;
  }
}

function runId(record: ElasticOperationRecord): string {
  return record.runId;
}

function actorId(record: ElasticOperationRecord): string | null {
  switch (record.format) {
    case "owd-actor-recovery-v1":
      return record.replacementActorId;
    case "owd-budget-entry-v1":
    case "owd-orca-projection-v1":
      return record.actorId;
    default:
      return null;
  }
}

function retention(record: ElasticOperationRecord): {
  retentionTier: "cold" | "hot" | "quarantine" | "warm";
  retainUntil: number;
} {
  return "retention" in record ? record.retention : record.metadata;
}

export async function prepareElasticOperationRecord(
  storage: R2Bucket,
  input: {
    elasticRecordId?: string;
    now: number;
    portableObjectId?: string;
    record: ElasticOperationRecord;
    restoredAt?: number | null;
  },
): Promise<PreparedElasticOperationRecord> {
  const record = elasticOperationRecordSchema.parse(input.record);
  const bytes = encoder.encode(canonicalizeCollaborationJson(record));
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `elastic-operations/records/${contentSha256}.json`;
  const existing = await storage.head(bodyObjectKey);
  if (
    existing !== null &&
    (existing.size !== bytes.byteLength ||
      existing.customMetadata?.sha256 !== contentSha256)
  ) {
    throw new Error("elastic_object_collision");
  }
  if (existing === null) {
    const written = await storage.put(bodyObjectKey, bytes, {
      customMetadata: { role: "elastic-operation", sha256: contentSha256 },
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "application/json",
      },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: contentSha256,
    });
    if (written === null) {
      const raced = await storage.head(bodyObjectKey);
      if (
        raced === null ||
        raced.size !== bytes.byteLength ||
        raced.customMetadata?.sha256 !== contentSha256
      ) {
        throw new Error("elastic_object_unavailable");
      }
    }
  }
  return {
    bodyObjectKey,
    byteLength: bytes.byteLength,
    bytes,
    contentSha256,
    elasticRecordId: input.elasticRecordId ?? recordId(record),
    portableObjectId: input.portableObjectId ?? crypto.randomUUID(),
    record,
    restoredAt: input.restoredAt ?? null,
  };
}

export function insertElasticOperationRecordStatement(
  db: D1Database,
  prepared: PreparedElasticOperationRecord,
): D1PreparedStatement {
  const record = prepared.record;
  const policy = retention(record);
  return db
    .prepare(
      `INSERT INTO project_elastic_records (
        elastic_record_id, record_type, project_id, run_id, actor_id,
        portable_object_id, content_sha256, byte_length, body_object_key,
        received_at, restored_at, restore_state, retention_tier, retain_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      prepared.elasticRecordId,
      recordType(record),
      record.projectId,
      runId(record),
      actorId(record),
      prepared.portableObjectId,
      prepared.contentSha256,
      prepared.byteLength,
      prepared.bodyObjectKey,
      receivedAt(record),
      prepared.restoredAt,
      prepared.restoredAt === null ? "live" : "quarantined",
      prepared.restoredAt === null ? policy.retentionTier : "quarantine",
      policy.retainUntil,
    );
}

export function insertQuarantinedElasticOperationRecordStatement(
  db: D1Database,
  prepared: PreparedElasticOperationRecord,
): D1PreparedStatement {
  if (prepared.restoredAt === null) {
    throw new Error("elastic_restore_timestamp_required");
  }
  return insertElasticOperationRecordStatement(db, prepared);
}

export async function readElasticOperationRecord(
  db: D1Database,
  storage: R2Bucket,
  elasticRecordId: string,
): Promise<ElasticOperationRecord | null> {
  const row = await db
    .prepare(
      `SELECT body_object_key, byte_length, content_sha256
       FROM project_elastic_records WHERE elastic_record_id = ?`,
    )
    .bind(elasticRecordId)
    .first<{
      body_object_key: string;
      byte_length: number;
      content_sha256: string;
    }>();
  if (row === null) return null;
  const object = await storage.get(row.body_object_key);
  if (
    object === null ||
    object.size !== row.byte_length ||
    object.customMetadata?.sha256 !== row.content_sha256
  ) {
    throw new Error("elastic_integrity_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("elastic_integrity_mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error("elastic_integrity_mismatch");
  }
  const record = elasticOperationRecordSchema.parse(value);
  if (canonicalizeCollaborationJson(record) !== decoder.decode(bytes)) {
    throw new Error("elastic_integrity_mismatch");
  }
  return record;
}
