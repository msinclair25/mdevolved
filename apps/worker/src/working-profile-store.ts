import { canonicalizeCollaborationJson } from "@mdevolved/contracts";
import { sha256HexBytes } from "./security";

const encoder = new TextEncoder();

export type WorkingProfileRecordType =
  | "preference-version"
  | "preference-deleted"
  | "skill-version"
  | "skill-deleted"
  | "skill-attached"
  | "skill-detached";

export type WorkingProfileRecord = {
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
  createdAt: number;
  dependencies: string[];
  portableObjectId: string;
  preferenceId: string | null;
  projectId: string | null;
  recordId: string;
  recordType: WorkingProfileRecordType;
  skillId: string | null;
};

export class WorkingProfileStoreProblem extends Error {
  constructor(readonly code: "body_collision" | "body_integrity_mismatch") {
    super(code);
    this.name = "WorkingProfileStoreProblem";
  }
}

export function canonicalWorkingProfileBody(value: unknown): string {
  return canonicalizeCollaborationJson(value);
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function objectMatches(
  bucket: R2Bucket,
  key: string,
  contentSha256: string,
  byteLength: number,
): Promise<boolean> {
  const object = await bucket.get(key);
  return (
    object !== null &&
    object.size === byteLength &&
    object.customMetadata?.contentSha256 === contentSha256 &&
    (await sha256HexBytes(await object.bytes())) === contentSha256
  );
}

export async function putImmutableWorkingProfileBody(
  bucket: R2Bucket,
  body: string,
  portableObjectId: string,
): Promise<{
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
}> {
  const bytes = encoder.encode(body);
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `working-profile/${portableObjectId}.json`;
  const existing = await bucket.head(bodyObjectKey);
  if (existing !== null) {
    if (
      await objectMatches(
        bucket,
        bodyObjectKey,
        contentSha256,
        bytes.byteLength,
      )
    ) {
      return { bodyObjectKey, byteLength: bytes.byteLength, contentSha256 };
    }
    throw new WorkingProfileStoreProblem("body_collision");
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
  if (
    stored === null &&
    !(await objectMatches(
      bucket,
      bodyObjectKey,
      contentSha256,
      bytes.byteLength,
    ))
  ) {
    throw new WorkingProfileStoreProblem("body_collision");
  }
  return { bodyObjectKey, byteLength: bytes.byteLength, contentSha256 };
}

export async function readWorkingProfileBody(
  bucket: R2Bucket,
  input: { bodyObjectKey: string; byteLength: number; contentSha256: string },
): Promise<unknown> {
  const object = await bucket.get(input.bodyObjectKey);
  if (object === null || object.size !== input.byteLength) {
    throw new WorkingProfileStoreProblem("body_integrity_mismatch");
  }
  const bytes = await object.bytes();
  if ((await sha256HexBytes(bytes)) !== input.contentSha256) {
    throw new WorkingProfileStoreProblem("body_integrity_mismatch");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkingProfileStoreProblem("body_integrity_mismatch");
  }
}

export function insertWorkingProfileRecordStatement(
  db: D1Database,
  record: WorkingProfileRecord,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO working_profile_records (
         record_id, record_type, portable_object_id, project_id, preference_id,
         skill_id, dependencies_json, body_object_key, content_sha256,
         byte_length, created_at, restored_at, restore_state,
         restored_authority_allowed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'live', 0)`,
    )
    .bind(
      record.recordId,
      record.recordType,
      record.portableObjectId,
      record.projectId,
      record.preferenceId,
      record.skillId,
      canonicalWorkingProfileBody(record.dependencies),
      record.bodyObjectKey,
      record.contentSha256,
      record.byteLength,
      record.createdAt,
    );
}

export type MutationReceipt = {
  inputSha256: string;
  operation: string;
  responseJson: string;
};

export async function readWorkingProfileReceipt(
  db: D1Database,
  idempotencyKeyHash: string,
): Promise<MutationReceipt | null> {
  const row = await db
    .prepare(
      `SELECT input_sha256, operation, response_json
       FROM working_profile_mutation_receipts
       WHERE idempotency_key_hash = ?`,
    )
    .bind(idempotencyKeyHash)
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

export function insertWorkingProfileReceiptStatement(
  db: D1Database,
  input: {
    createdAt: number;
    idempotencyKeyHash: string;
    inputSha256: string;
    operation: string;
    responseJson: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO working_profile_mutation_receipts (
         idempotency_key_hash, operation, input_sha256, response_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.idempotencyKeyHash,
      input.operation,
      input.inputSha256,
      input.responseJson,
      input.createdAt,
    );
}

export async function activeProjectExists(
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
