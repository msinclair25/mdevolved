import {
  MAX_OPERATIONAL_RECORD_BYTES,
  canonicalizeCollaborationJson,
  policyOperationalRecordSchema,
  type PolicyOperationalRecord,
} from "@mdevolved/contracts";
import { sha256HexBytes } from "./security";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const LONG_RETENTION_SECONDS = 10 * 365 * 24 * 60 * 60;
const DECISION_RETENTION_SECONDS = 365 * 24 * 60 * 60;

export type PreparedPolicyOperationalRecord = {
  bodyObjectKey: string;
  byteLength: number;
  bytes: Uint8Array;
  contentSha256: string;
  operationalRecordId: string;
  portableObjectId: string;
  record: PolicyOperationalRecord;
  restoredAt: number | null;
  retentionTier: "cold" | "hot" | "quarantine" | "warm";
  retainUntil: number;
};

function recordId(record: PolicyOperationalRecord): string {
  switch (record.format) {
    case "owd-policy-binding-v1":
      return record.bindingId;
    case "owd-policy-decision-v1":
      return record.decisionId;
    case "owd-operational-schedule-v1":
      return record.scheduleId;
    case "owd-operational-evidence-v1":
      return record.evidenceId;
    case "owd-continuity-receipt-v1":
      return record.receiptId;
  }
}

function recordType(record: PolicyOperationalRecord) {
  switch (record.format) {
    case "owd-policy-binding-v1":
      return "policy-binding" as const;
    case "owd-policy-decision-v1":
      return "policy-decision" as const;
    case "owd-operational-schedule-v1":
      return "schedule" as const;
    case "owd-operational-evidence-v1":
      return "evidence" as const;
    case "owd-continuity-receipt-v1":
      return "continuity-receipt" as const;
  }
}

function receivedAt(record: PolicyOperationalRecord): number {
  switch (record.format) {
    case "owd-policy-binding-v1":
      return record.activatedAt;
    case "owd-policy-decision-v1":
      return record.evaluatedAt;
    case "owd-operational-schedule-v1":
      return record.createdAt;
    case "owd-operational-evidence-v1":
      return record.occurredAt;
    case "owd-continuity-receipt-v1":
      return record.emittedAt;
  }
}

function runId(record: PolicyOperationalRecord): string | null {
  switch (record.format) {
    case "owd-policy-decision-v1":
      return record.runId;
    case "owd-operational-evidence-v1":
      return record.runId;
    default:
      return null;
  }
}

function retention(record: PolicyOperationalRecord): {
  retentionTier: "cold" | "hot" | "warm";
  retainUntil: number;
} {
  const at = receivedAt(record);
  if (record.format === "owd-operational-evidence-v1") {
    return {
      retentionTier:
        record.retentionTier === "quarantine" ? "warm" : record.retentionTier,
      retainUntil: record.retainUntil,
    };
  }
  if (record.format === "owd-policy-decision-v1") {
    return {
      retentionTier: "warm",
      retainUntil: at + DECISION_RETENTION_SECONDS,
    };
  }
  return {
    retentionTier: "cold",
    retainUntil: at + LONG_RETENTION_SECONDS,
  };
}

export async function preparePolicyOperationalRecord(
  storage: R2Bucket,
  input: {
    now: number;
    operationalRecordId?: string;
    portableObjectId?: string;
    record: PolicyOperationalRecord;
    restoredAt?: number | null;
  },
): Promise<PreparedPolicyOperationalRecord> {
  const record = policyOperationalRecordSchema.parse(input.record);
  const bytes = encoder.encode(canonicalizeCollaborationJson(record));
  if (bytes.byteLength > MAX_OPERATIONAL_RECORD_BYTES) {
    throw new Error("operational_record_too_large");
  }
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `policy-operations/records/${contentSha256}.json`;
  const existing = await storage.head(bodyObjectKey);
  if (
    existing !== null &&
    (existing.size !== bytes.byteLength ||
      existing.customMetadata?.sha256 !== contentSha256)
  ) {
    throw new Error("operational_object_collision");
  }
  if (existing === null) {
    const written = await storage.put(bodyObjectKey, bytes, {
      customMetadata: { role: "policy-operation", sha256: contentSha256 },
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
        throw new Error("operational_object_unavailable");
      }
    }
  }
  const restoredAt = input.restoredAt ?? null;
  const liveRetention = retention(record);
  return {
    bodyObjectKey,
    byteLength: bytes.byteLength,
    bytes,
    contentSha256,
    operationalRecordId: input.operationalRecordId ?? recordId(record),
    portableObjectId: input.portableObjectId ?? crypto.randomUUID(),
    record,
    restoredAt,
    retentionTier:
      restoredAt === null ? liveRetention.retentionTier : "quarantine",
    retainUntil:
      restoredAt === null
        ? liveRetention.retainUntil
        : Math.max(
            liveRetention.retainUntil,
            restoredAt + DECISION_RETENTION_SECONDS,
          ),
  };
}

export function insertPolicyOperationalRecordStatement(
  db: D1Database,
  prepared: PreparedPolicyOperationalRecord,
): D1PreparedStatement {
  const record = prepared.record;
  return db
    .prepare(
      `INSERT INTO project_operational_records (
        operational_record_id, record_type, project_id, run_id,
        portable_object_id, content_sha256, byte_length, body_object_key,
        received_at, restored_at, restore_state, retention_tier, retain_until,
        restored_authority_allowed, live_authority_included,
        scheduler_authority_included
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    )
    .bind(
      prepared.operationalRecordId,
      recordType(record),
      record.projectId,
      runId(record),
      prepared.portableObjectId,
      prepared.contentSha256,
      prepared.byteLength,
      prepared.bodyObjectKey,
      receivedAt(record),
      prepared.restoredAt,
      prepared.restoredAt === null ? "live" : "quarantined",
      prepared.retentionTier,
      prepared.retainUntil,
    );
}

export function insertQuarantinedPolicyOperationalRecordStatement(
  db: D1Database,
  prepared: PreparedPolicyOperationalRecord,
): D1PreparedStatement {
  if (prepared.restoredAt === null) {
    throw new Error("operational_restore_timestamp_required");
  }
  return insertPolicyOperationalRecordStatement(db, prepared);
}

export function insertOperationalDependencyStatement(
  db: D1Database,
  input: {
    contentSha256?: string | null;
    dependencyId: string;
    dependencyKind: "evidence" | "operational" | "record";
    operationalRecordId: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_operational_dependencies (
        operational_record_id, dependency_id, dependency_kind, content_sha256
      ) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      input.operationalRecordId,
      input.dependencyId,
      input.dependencyKind,
      input.contentSha256 ?? null,
    );
}

export async function readPolicyOperationalRecord(
  db: D1Database,
  storage: R2Bucket,
  operationalRecordId: string,
): Promise<PolicyOperationalRecord | null> {
  const row = await db
    .prepare(
      `SELECT body_object_key, byte_length, content_sha256
       FROM project_operational_records WHERE operational_record_id = ?`,
    )
    .bind(operationalRecordId)
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
    throw new Error("operational_integrity_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("operational_integrity_mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error("operational_integrity_mismatch");
  }
  const record = policyOperationalRecordSchema.parse(value);
  if (canonicalizeCollaborationJson(record) !== decoder.decode(bytes)) {
    throw new Error("operational_integrity_mismatch");
  }
  return record;
}
