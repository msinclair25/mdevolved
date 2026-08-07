import {
  canonicalizeCollaborationJson,
  leadOperationRecordSchema,
  type LeadOperationRecord,
} from "@owd/contracts";
import { sha256HexBytes } from "./security";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type PreparedLeadOperationRecord = {
  bodyObjectKey: string;
  byteLength: number;
  bytes: Uint8Array;
  contentSha256: string;
  operationRecordId: string;
  portableObjectId: string;
  record: LeadOperationRecord;
  restoredAt: number | null;
};

function operationRecordId(record: LeadOperationRecord): string {
  switch (record.format) {
    case "owd-project-policy-v1":
      return record.policyId;
    case "owd-run-v1":
      return record.runId;
    case "owd-actor-v1":
      return record.actorId;
    case "owd-event-bundle-v1":
      return record.bundleId;
    case "owd-project-exception-v1":
      return record.exceptionId;
  }
}

function operationRecordType(record: LeadOperationRecord) {
  switch (record.format) {
    case "owd-project-policy-v1":
      return "policy" as const;
    case "owd-run-v1":
      return "run" as const;
    case "owd-actor-v1":
      return "actor" as const;
    case "owd-event-bundle-v1":
      return "event-bundle" as const;
    case "owd-project-exception-v1":
      return "exception" as const;
  }
}

export async function prepareLeadOperationRecord(
  storage: R2Bucket,
  input: {
    now: number;
    portableObjectId?: string;
    record: LeadOperationRecord;
    restoredAt?: number | null;
  },
): Promise<PreparedLeadOperationRecord> {
  const record = leadOperationRecordSchema.parse(input.record);
  const bytes = encoder.encode(canonicalizeCollaborationJson(record));
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `lead-operations/records/${contentSha256}.json`;
  const existing = await storage.head(bodyObjectKey);
  if (
    existing !== null &&
    (existing.size !== bytes.byteLength ||
      existing.customMetadata?.sha256 !== contentSha256)
  ) {
    throw new Error("lead_object_collision");
  }
  if (existing === null) {
    const written = await storage.put(bodyObjectKey, bytes, {
      customMetadata: { role: "lead-operation", sha256: contentSha256 },
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
        throw new Error("lead_object_unavailable");
      }
    }
  }
  return {
    bodyObjectKey,
    byteLength: bytes.byteLength,
    bytes,
    contentSha256,
    operationRecordId: operationRecordId(record),
    portableObjectId: input.portableObjectId ?? crypto.randomUUID(),
    record,
    restoredAt: input.restoredAt ?? null,
  };
}

export function insertLeadOperationRecordStatement(
  db: D1Database,
  prepared: PreparedLeadOperationRecord,
): D1PreparedStatement {
  const record = prepared.record;
  const receivedAt = "createdAt" in record ? record.createdAt : record.issuedAt;
  return db
    .prepare(
      `INSERT INTO project_operation_records (
        operation_record_id, record_type, project_id, work_item_id, run_id,
        actor_id, portable_object_id, content_sha256, byte_length,
        body_object_key, received_at, restored_at, restore_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      prepared.operationRecordId,
      operationRecordType(record),
      record.projectId,
      "workItemId" in record ? record.workItemId : null,
      "runId" in record ? record.runId : null,
      "actorId" in record ? record.actorId : null,
      prepared.portableObjectId,
      prepared.contentSha256,
      prepared.byteLength,
      prepared.bodyObjectKey,
      receivedAt,
      prepared.restoredAt,
      prepared.restoredAt === null ? "live" : "quarantined",
    );
}

export function insertQuarantinedLeadOperationRecordStatement(
  db: D1Database,
  prepared: PreparedLeadOperationRecord,
): D1PreparedStatement {
  if (prepared.restoredAt === null) {
    throw new Error("lead_restore_timestamp_required");
  }
  return insertLeadOperationRecordStatement(db, prepared);
}

export async function readLeadOperationRecord(
  db: D1Database,
  storage: R2Bucket,
  operationRecordId: string,
): Promise<LeadOperationRecord | null> {
  const row = await db
    .prepare(
      `SELECT body_object_key, byte_length, content_sha256
       FROM project_operation_records WHERE operation_record_id = ?`,
    )
    .bind(operationRecordId)
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
    throw new Error("lead_integrity_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("lead_integrity_mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error("lead_integrity_mismatch");
  }
  const record = leadOperationRecordSchema.parse(value);
  if (canonicalizeCollaborationJson(record) !== decoder.decode(bytes)) {
    throw new Error("lead_integrity_mismatch");
  }
  return record;
}
