import { canonicalizeCollaborationJson } from "@mdevolved/contracts";
import { sha256HexBytes } from "./security";

const encoder = new TextEncoder();

export type CompoundingRecord = {
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
  createdAt: number;
  draftId: string | null;
  fingerprint: string;
  observationId: string | null;
  portableObjectId: string;
  projectId: string | null;
  recordId: string;
  recordType:
    | "checkpoint-observation"
    | "draft-version"
    | "draft-accepted"
    | "draft-ignored"
    | "draft-deleted";
};

export class CompoundingStoreProblem extends Error {
  constructor(readonly code: "body_collision" | "body_integrity_mismatch") {
    super(code);
    this.name = "CompoundingStoreProblem";
  }
}

export function canonicalCompoundingBody(value: unknown): string {
  return canonicalizeCollaborationJson(value);
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function putImmutableCompoundingBody(
  bucket: R2Bucket,
  body: string,
  recordId: string,
): Promise<{
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
}> {
  const bytes = encoder.encode(body);
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `compounding/${recordId}.json`;
  const existing = await bucket.head(bodyObjectKey);
  if (existing !== null) {
    if (
      existing.size === bytes.byteLength &&
      existing.customMetadata?.contentSha256 === contentSha256
    ) {
      return { bodyObjectKey, byteLength: bytes.byteLength, contentSha256 };
    }
    throw new CompoundingStoreProblem("body_collision");
  }
  const stored = await bucket.put(bodyObjectKey, bytes, {
    customMetadata: { contentSha256 },
    httpMetadata: {
      cacheControl: "private, no-store",
      contentType: "application/json; charset=utf-8",
    },
    onlyIf: new Headers({ "If-None-Match": "*" }),
    sha256: hexBytes(contentSha256),
  });
  if (stored === null) {
    const raced = await bucket.head(bodyObjectKey);
    if (
      raced === null ||
      raced.size !== bytes.byteLength ||
      raced.customMetadata?.contentSha256 !== contentSha256
    ) {
      throw new CompoundingStoreProblem("body_collision");
    }
  }
  return { bodyObjectKey, byteLength: bytes.byteLength, contentSha256 };
}

export async function readCompoundingBody(
  bucket: R2Bucket,
  input: { bodyObjectKey: string; byteLength: number; contentSha256: string },
): Promise<unknown> {
  const object = await bucket.get(input.bodyObjectKey);
  if (object === null || object.size !== input.byteLength) {
    throw new CompoundingStoreProblem("body_integrity_mismatch");
  }
  const bytes = await object.bytes();
  if ((await sha256HexBytes(bytes)) !== input.contentSha256) {
    throw new CompoundingStoreProblem("body_integrity_mismatch");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CompoundingStoreProblem("body_integrity_mismatch");
  }
}

export function insertCompoundingRecordStatement(
  db: D1Database,
  record: CompoundingRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO compounding_records (
         record_id, record_type, portable_object_id, project_id, draft_id,
         observation_id, fingerprint, body_object_key, content_sha256,
         byte_length, created_at, restored_at, restore_state,
         restored_authority_allowed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'live', 0)`,
    )
    .bind(
      record.recordId,
      record.recordType,
      record.portableObjectId,
      record.projectId,
      record.draftId,
      record.observationId,
      record.fingerprint,
      record.bodyObjectKey,
      record.contentSha256,
      record.byteLength,
      record.createdAt,
    );
}

export type CompoundingMutationReceipt = {
  inputSha256: string;
  operation: string;
  responseJson: string;
};

export async function readCompoundingReceipt(
  db: D1Database,
  idempotencyKeySha256: string,
): Promise<CompoundingMutationReceipt | null> {
  const row = await db
    .prepare(
      `SELECT input_sha256, operation, response_json
       FROM compounding_mutation_receipts WHERE idempotency_key_sha256 = ?`,
    )
    .bind(idempotencyKeySha256)
    .first<{
      input_sha256: string;
      operation: string;
      response_json: string;
    }>();
  return row === null
    ? null
    : {
        inputSha256: row.input_sha256,
        operation: row.operation,
        responseJson: row.response_json,
      };
}

export function insertCompoundingReceiptStatement(
  db: D1Database,
  input: {
    createdAt: number;
    idempotencyKeySha256: string;
    inputSha256: string;
    operation: string;
    responseJson: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO compounding_mutation_receipts (
         idempotency_key_sha256, operation, input_sha256, response_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.idempotencyKeySha256,
      input.operation,
      input.inputSha256,
      input.responseJson,
      input.createdAt,
    );
}
