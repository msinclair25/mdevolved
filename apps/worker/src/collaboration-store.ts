import {
  canonicalizeCollaborationJson,
  collaborationDurableRecordSchema,
  collaborationRecordId,
  collaborationRecordStateSchema,
  collaborationScopeSchema,
  ownerEventSchema,
  provenanceEdgeSchema,
  type CollaborationDashboardResponse,
  type CollaborationConnection,
  type CollaborationGrant,
  type CollaborationRecordType,
  type CollaborationTimelineItem,
  type OwnerEvent,
  type ProvenanceEdge,
} from "@owd/contracts";
import {
  decodeBase64Url,
  encodeBase64Url,
  sha256Hex,
  sha256HexBytes,
} from "./security";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_RECORD_BYTES = 1024 * 1024;
const ACTIVE_GRANT_SLIDING_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export type StoredCollaborationRecord =
  | ReturnType<typeof collaborationDurableRecordSchema.parse>
  | OwnerEvent
  | ProvenanceEdge;

export type CollaborationRecordMetadata = {
  attemptId: string | null;
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
  historicalGrantId: string | null;
  id: string;
  participantRefId: string | null;
  portableObjectId: string;
  producerClientId: string | null;
  projectId: string | null;
  receivedAt: number;
  recordType: CollaborationRecordType;
  restoredAt: number | null;
  schemaVersion: 1;
  workItemId: string | null;
  workPacketId: string | null;
};

export type PreparedCollaborationRecord = {
  bytes: Uint8Array;
  metadata: CollaborationRecordMetadata;
  record: StoredCollaborationRecord;
};

export type StoredContentObject = {
  byteLength: number;
  contentSha256: string;
  createdAt: number;
  id: string;
  mediaType: "application/json" | "text/markdown";
  objectKey: string;
  objectKind: "artifact-content" | "packet-evidence";
  portableObjectId: string;
  restoredAt: number | null;
};

export type AuthorizedCollaborationGrant = CollaborationGrant & {
  sourceAgentGrantId: string;
};

type RecordRow = {
  attempt_id: string | null;
  body_object_key: string;
  byte_length: number;
  content_sha256: string;
  historical_grant_id: string | null;
  id: string;
  participant_ref_id: string | null;
  portable_object_id: string;
  producer_client_id: string | null;
  project_id: string | null;
  received_at: number;
  record_type: CollaborationRecordType;
  restored_at: number | null;
  schema_version: 1;
  work_item_id: string | null;
  work_packet_id: string | null;
};

type TimelineRow = RecordRow & {
  disposition:
    "accepted" | "pending" | "quarantined" | "rejected" | "superseded";
  producer_label: string | null;
  visibility: "owner-only" | "private" | "shared";
};

type GrantRow = {
  activated_at: number | null;
  audience: string;
  expires_at: number;
  id: string;
  issued_at: number;
  knowledge_space_version_id: string;
  last_used_at: number | null;
  oauth_client_id: string;
  project_id: string;
  revoked_at: number | null;
  scopes_json: string;
  source_agent_grant_id: string;
  status: "active" | "pending" | "revoked";
};

function metadataFromRow(row: RecordRow): CollaborationRecordMetadata {
  return {
    attemptId: row.attempt_id,
    bodyObjectKey: row.body_object_key,
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
    historicalGrantId: row.historical_grant_id,
    id: row.id,
    participantRefId: row.participant_ref_id,
    portableObjectId: row.portable_object_id,
    producerClientId: row.producer_client_id,
    projectId: row.project_id,
    receivedAt: row.received_at,
    recordType: row.record_type,
    restoredAt: row.restored_at,
    schemaVersion: row.schema_version,
    workItemId: row.work_item_id,
    workPacketId: row.work_packet_id,
  };
}

function recordIdentity(record: StoredCollaborationRecord): string {
  if (record.recordType === "owner-event") return record.eventId;
  if (record.recordType === "provenance-edge") return record.edgeId;
  return collaborationRecordId(record);
}

function recordProjectId(record: StoredCollaborationRecord): string | null {
  return "projectId" in record ? record.projectId : null;
}

function recordWorkItemId(record: StoredCollaborationRecord): string | null {
  return "workItemId" in record ? record.workItemId : null;
}

function recordPacketId(record: StoredCollaborationRecord): string | null {
  if (record.recordType === "work-packet") return record.packetId;
  return "workPacketId" in record ? record.workPacketId : null;
}

function recordAttemptId(record: StoredCollaborationRecord): string | null {
  if (record.recordType === "attempt") return record.attemptId;
  return "attemptId" in record ? record.attemptId : null;
}

function recordParticipantId(record: StoredCollaborationRecord): string | null {
  if (record.recordType === "participant-ref") return record.participantRefId;
  if (record.recordType === "attempt") return record.participantRefId;
  return null;
}

function parseRecordBody(
  recordType: CollaborationRecordType,
  value: unknown,
): StoredCollaborationRecord {
  if (recordType === "owner-event") return ownerEventSchema.parse(value);
  if (recordType === "provenance-edge")
    return provenanceEdgeSchema.parse(value);
  return collaborationDurableRecordSchema.parse(value);
}

async function putImmutableObject(
  storage: R2Bucket,
  input: {
    bytes: Uint8Array;
    contentSha256: string;
    contentType: string;
    objectKey: string;
    role: string;
  },
): Promise<void> {
  const existing = await storage.head(input.objectKey);
  if (existing !== null) {
    if (
      existing.size !== input.bytes.byteLength ||
      existing.customMetadata?.sha256 !== input.contentSha256
    ) {
      throw new Error("collaboration_object_collision");
    }
    return;
  }
  const written = await storage.put(input.objectKey, input.bytes, {
    customMetadata: {
      role: input.role,
      sha256: input.contentSha256,
    },
    httpMetadata: {
      cacheControl: "private, no-store",
      contentType: input.contentType,
    },
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: input.contentSha256,
  });
  if (written === null) {
    const raced = await storage.head(input.objectKey);
    if (
      raced === null ||
      raced.size !== input.bytes.byteLength ||
      raced.customMetadata?.sha256 !== input.contentSha256
    ) {
      throw new Error("collaboration_object_unavailable");
    }
    return;
  }
  if (written.size !== input.bytes.byteLength) {
    throw new Error("collaboration_object_unavailable");
  }
}

export async function prepareCollaborationRecord(
  storage: R2Bucket,
  input: {
    historicalGrantId?: string | null;
    now: number;
    portableObjectId?: string;
    producerClientId?: string | null;
    record: StoredCollaborationRecord;
    restoredAt?: number | null;
  },
): Promise<PreparedCollaborationRecord> {
  const canonical = canonicalizeCollaborationJson(input.record);
  const bytes = encoder.encode(canonical);
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new Error("submission_too_large");
  }
  const contentSha256 = await sha256HexBytes(bytes);
  const id = recordIdentity(input.record);
  const objectKey = `collaboration/records/${contentSha256}.json`;
  await putImmutableObject(storage, {
    bytes,
    contentSha256,
    contentType: "application/json",
    objectKey,
    role: "collaboration-record",
  });
  return {
    bytes,
    metadata: {
      attemptId: recordAttemptId(input.record),
      bodyObjectKey: objectKey,
      byteLength: bytes.byteLength,
      contentSha256,
      historicalGrantId: input.historicalGrantId ?? null,
      id,
      participantRefId: recordParticipantId(input.record),
      portableObjectId: input.portableObjectId ?? crypto.randomUUID(),
      producerClientId: input.producerClientId ?? null,
      projectId: recordProjectId(input.record),
      receivedAt: input.now,
      recordType: input.record.recordType,
      restoredAt: input.restoredAt ?? null,
      schemaVersion: 1,
      workItemId: recordWorkItemId(input.record),
      workPacketId: recordPacketId(input.record),
    },
    record: input.record,
  };
}

export function insertRecordStatement(
  db: D1Database,
  record: PreparedCollaborationRecord,
): D1PreparedStatement {
  const value = record.metadata;
  return db
    .prepare(
      `INSERT INTO collaboration_records (
        id, record_type, schema_version, project_id, work_item_id,
        work_packet_id, attempt_id, participant_ref_id, producer_client_id,
        historical_grant_id, portable_object_id, body_object_key,
        content_sha256, byte_length, received_at, restored_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      value.id,
      value.recordType,
      value.projectId,
      value.workItemId,
      value.workPacketId,
      value.attemptId,
      value.participantRefId,
      value.producerClientId,
      value.historicalGrantId,
      value.portableObjectId,
      value.bodyObjectKey,
      value.contentSha256,
      value.byteLength,
      value.receivedAt,
      value.restoredAt,
    );
}

export function insertStateStatement(
  db: D1Database,
  input: {
    changedAt: number;
    disposition:
      "accepted" | "pending" | "quarantined" | "rejected" | "superseded";
    lastOwnerEventId?: string | null;
    recordId: string;
    visibility: "owner-only" | "private" | "shared";
  },
): D1PreparedStatement {
  collaborationRecordStateSchema.parse({
    disposition: input.disposition,
    visibility: input.visibility,
  });
  return db
    .prepare(
      `INSERT INTO collaboration_record_states (
        record_id, visibility, disposition, last_owner_event_id, changed_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.recordId,
      input.visibility,
      input.disposition,
      input.lastOwnerEventId ?? null,
      input.changedAt,
    );
}

export async function prepareContentObject(
  storage: R2Bucket,
  input: {
    bytes: Uint8Array;
    createdAt: number;
    id: string;
    mediaType: "application/json" | "text/markdown";
    objectKind: "artifact-content" | "packet-evidence";
    portableObjectId: string;
    restoredAt?: number | null;
  },
): Promise<StoredContentObject> {
  if (input.bytes.byteLength > MAX_RECORD_BYTES) {
    throw new Error("submission_too_large");
  }
  const contentSha256 = await sha256HexBytes(input.bytes);
  const objectKey = `collaboration/content/${contentSha256}/${input.portableObjectId}`;
  await putImmutableObject(storage, {
    bytes: input.bytes,
    contentSha256,
    contentType: input.mediaType,
    objectKey,
    role: input.objectKind,
  });
  return {
    byteLength: input.bytes.byteLength,
    contentSha256,
    createdAt: input.createdAt,
    id: input.id,
    mediaType: input.mediaType,
    objectKey,
    objectKind: input.objectKind,
    portableObjectId: input.portableObjectId,
    restoredAt: input.restoredAt ?? null,
  };
}

export function insertContentObjectStatement(
  db: D1Database,
  object: StoredContentObject,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collaboration_content_objects (
        id, portable_object_id, object_kind, media_type, content_sha256,
        byte_length, object_key, created_at, restored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      object.id,
      object.portableObjectId,
      object.objectKind,
      object.mediaType,
      object.contentSha256,
      object.byteLength,
      object.objectKey,
      object.createdAt,
      object.restoredAt,
    );
}

export async function readCollaborationRecord(
  db: D1Database,
  storage: R2Bucket,
  recordId: string,
): Promise<{
  metadata: CollaborationRecordMetadata;
  record: StoredCollaborationRecord;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, record_type, schema_version, project_id, work_item_id,
        work_packet_id, attempt_id, participant_ref_id, producer_client_id,
        historical_grant_id, portable_object_id, body_object_key,
        content_sha256, byte_length, received_at, restored_at
       FROM collaboration_records WHERE id = ?`,
    )
    .bind(recordId)
    .first<RecordRow>();
  if (row === null) return null;
  return readCollaborationRecordBody(storage, row);
}

async function readCollaborationRecordBody(
  storage: R2Bucket,
  row: RecordRow,
): Promise<{
  metadata: CollaborationRecordMetadata;
  record: StoredCollaborationRecord;
}> {
  const object = await storage.get(row.body_object_key);
  if (
    object === null ||
    object.size !== row.byte_length ||
    object.customMetadata?.sha256 !== row.content_sha256
  ) {
    throw new Error("evidence_unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("integrity_mismatch");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new Error("integrity_mismatch");
  }
  return {
    metadata: metadataFromRow(row),
    record: parseRecordBody(row.record_type, value),
  };
}

/**
 * Loads up to a bounded catalog of collaboration records with one D1 metadata
 * statement. Invalid or unavailable bodies are omitted so discovery can skip
 * polluted records while still failing closed for those exact candidates.
 */
export async function readCollaborationRecords(
  db: D1Database,
  storage: R2Bucket,
  recordIds: string[],
): Promise<
  Map<
    string,
    {
      metadata: CollaborationRecordMetadata;
      record: StoredCollaborationRecord;
    }
  >
> {
  const ids = [...new Set(recordIds)];
  if (ids.length === 0) return new Map();
  if (ids.length > 50) throw new Error("record_batch_too_large");
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT id, record_type, schema_version, project_id, work_item_id,
        work_packet_id, attempt_id, participant_ref_id, producer_client_id,
        historical_grant_id, portable_object_id, body_object_key,
        content_sha256, byte_length, received_at, restored_at
       FROM collaboration_records
       WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<RecordRow>();
  const records = new Map<
    string,
    {
      metadata: CollaborationRecordMetadata;
      record: StoredCollaborationRecord;
    }
  >();
  for (let offset = 0; offset < rows.results.length; offset += 8) {
    const batch = await Promise.allSettled(
      rows.results
        .slice(offset, offset + 8)
        .map((row) => readCollaborationRecordBody(storage, row)),
    );
    for (const result of batch) {
      if (result.status === "fulfilled") {
        records.set(result.value.metadata.id, result.value);
      }
    }
  }
  return records;
}

export async function readContentObject(
  db: D1Database,
  storage: R2Bucket,
  objectId: string,
): Promise<{ bytes: Uint8Array; object: StoredContentObject } | null> {
  const row = await db
    .prepare(
      `SELECT id, portable_object_id, object_kind, media_type,
        content_sha256, byte_length, object_key, created_at, restored_at
       FROM collaboration_content_objects WHERE id = ?`,
    )
    .bind(objectId)
    .first<{
      byte_length: number;
      content_sha256: string;
      created_at: number;
      id: string;
      media_type: StoredContentObject["mediaType"];
      object_key: string;
      object_kind: StoredContentObject["objectKind"];
      portable_object_id: string;
      restored_at: number | null;
    }>();
  if (row === null) return null;
  const stored = await storage.get(row.object_key);
  if (
    stored === null ||
    stored.size !== row.byte_length ||
    stored.customMetadata?.sha256 !== row.content_sha256
  ) {
    throw new Error("evidence_unavailable");
  }
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("integrity_mismatch");
  }
  return {
    bytes,
    object: {
      byteLength: row.byte_length,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
      id: row.id,
      mediaType: row.media_type,
      objectKey: row.object_key,
      objectKind: row.object_kind,
      portableObjectId: row.portable_object_id,
      restoredAt: row.restored_at,
    },
  };
}

function grantFromRow(row: GrantRow): AuthorizedCollaborationGrant {
  return {
    audience: row.audience,
    expiresAt: row.expires_at,
    grantId: row.id,
    issuedAt: row.issued_at,
    knowledgeSpaceVersionId: row.knowledge_space_version_id,
    oauthClientId: row.oauth_client_id,
    projectId: row.project_id,
    revokedAt: row.revoked_at,
    scopes: collaborationScopeSchema
      .array()
      .parse(JSON.parse(row.scopes_json) as unknown),
    sourceAgentGrantId: row.source_agent_grant_id,
    status: row.status === "revoked" ? "revoked" : "active",
  };
}

export async function readCollaborationGrant(
  db: D1Database,
  input: {
    audience: string;
    clientId: string;
    grantId: string;
    now: number;
  },
): Promise<AuthorizedCollaborationGrant | null> {
  const row = await db
    .prepare(
      `SELECT grants.id, grants.source_agent_grant_id,
        grants.oauth_client_id, grants.audience, grants.project_id,
        grants.knowledge_space_version_id, grants.scopes_json, grants.status,
        grants.issued_at, grants.expires_at, grants.activated_at,
        grants.revoked_at, grants.last_used_at
       FROM collaboration_grants grants
       JOIN agent_grants source_grants
         ON source_grants.id = grants.source_agent_grant_id
       JOIN vaults source_vault
         ON source_vault.id = source_grants.vault_id
       WHERE grants.id = ? AND grants.oauth_client_id = ?
         AND grants.audience = ?
         AND grants.status = 'active' AND grants.expires_at > ?
         AND source_grants.status = 'active'
         AND source_vault.status = 'active'`,
    )
    .bind(input.grantId, input.clientId, input.audience, input.now)
    .first<GrantRow>();
  return row === null ? null : grantFromRow(row);
}

export async function createPendingCollaborationGrant(
  db: D1Database,
  input: {
    audience: string;
    clientId: string;
    expiresAt: number;
    issuedAt: number;
    knowledgeSpaceVersionId: string;
    projectId: string;
    scopes: CollaborationGrant["scopes"];
    source?: {
      agentGrantId: string;
      clientName: string;
      clientOrigin: string;
    };
  },
): Promise<string> {
  const grantId = crypto.randomUUID();
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = ?
         WHERE oauth_client_id = ? AND project_id = ?
           AND status IN ('active', 'pending')`,
      )
      .bind(input.issuedAt, input.clientId, input.projectId),
    db
      .prepare(
        `INSERT INTO collaboration_grants (
          id, source_agent_grant_id, oauth_client_id, audience, project_id,
          knowledge_space_version_id, scopes_json, status, issued_at, expires_at
        )
        SELECT ?, ?, ?, ?, p.project_id, p.active_knowledge_space_version_id,
          ?, 'pending', ?, ?
        FROM collaboration_projects p
        WHERE p.project_id = ? AND p.status = 'active'
          AND p.agent_visibility = 'discoverable'
          AND p.active_knowledge_space_version_id = ?
        RETURNING id`,
      )
      .bind(
        grantId,
        input.source?.agentGrantId ?? grantId,
        input.clientId,
        input.audience,
        JSON.stringify(input.scopes),
        input.issuedAt,
        input.expiresAt,
        input.projectId,
        input.knowledgeSpaceVersionId,
      ),
  ]);
  if (results[1]?.results[0]?.id !== grantId) {
    throw new Error("project_reference_invalid");
  }
  if (input.source !== undefined) {
    await db
      .prepare(
        `INSERT INTO collaboration_grant_clients (
          grant_id, source_agent_grant_id, client_name, client_origin,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        grantId,
        input.source.agentGrantId,
        input.source.clientName,
        input.source.clientOrigin,
        input.issuedAt,
      )
      .run();
  }
  return grantId;
}

export async function activateCollaborationGrant(
  db: D1Database,
  input: { grantId: string; now: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE collaboration_grants
       SET status = 'active', activated_at = ?
       WHERE id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM collaboration_projects projects
           WHERE projects.project_id = collaboration_grants.project_id
             AND projects.status = 'active'
             AND projects.agent_visibility = 'discoverable'
             AND projects.active_knowledge_space_version_id =
               collaboration_grants.knowledge_space_version_id
         )
       RETURNING id`,
    )
    .bind(input.now, input.grantId)
    .first<{ id: string }>();
  return row?.id === input.grantId;
}

export async function revokeCollaborationGrant(
  db: D1Database,
  input: { grantId: string; now: number },
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE collaboration_grants
       SET status = 'revoked', revoked_at = ?
       WHERE id = ? AND status IN ('active', 'pending') RETURNING id`,
    )
    .bind(input.now, input.grantId)
    .first<{ id: string }>();
  return row?.id === input.grantId;
}

export async function revokeAllCollaborationGrants(
  db: D1Database,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE collaboration_grants
       SET status = 'revoked', revoked_at = ?
       WHERE status IN ('active', 'pending')`,
    )
    .bind(now)
    .run();
}

export async function listCollaborationConnections(
  db: D1Database,
): Promise<CollaborationConnection[]> {
  const rows = await db
    .prepare(
      `SELECT g.id, g.oauth_client_id, g.project_id, p.label AS project_label,
        g.scopes_json, g.status, g.issued_at, g.expires_at, g.revoked_at,
        g.last_used_at
       FROM collaboration_grants g
       JOIN collaboration_projects p ON p.project_id = g.project_id
       WHERE g.status IN ('active', 'revoked')
       ORDER BY g.issued_at DESC LIMIT 250`,
    )
    .all<{
      expires_at: number;
      id: string;
      issued_at: number;
      last_used_at: number | null;
      oauth_client_id: string;
      project_id: string;
      project_label: string;
      revoked_at: number | null;
      scopes_json: string;
      status: "active" | "revoked";
    }>();
  return rows.results.map((row) => ({
    expiresAt: row.expires_at,
    grantId: row.id,
    issuedAt: row.issued_at,
    lastUsedAt: row.last_used_at,
    oauthClientId: row.oauth_client_id,
    projectId: row.project_id,
    projectLabel: row.project_label,
    revokedAt: row.revoked_at,
    scopes: collaborationScopeSchema
      .array()
      .parse(JSON.parse(row.scopes_json) as unknown),
    status: row.status,
  }));
}

export async function touchCollaborationGrant(
  db: D1Database,
  grantId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE collaboration_grants
       SET last_used_at = ?, expires_at = MAX(expires_at, ?)
       WHERE id = ? AND status = 'active'`,
    )
    .bind(now, now + ACTIVE_GRANT_SLIDING_LIFETIME_SECONDS, grantId)
    .run();
}

async function timelineItems(
  db: D1Database,
  whereSql: string,
  bindings: unknown[],
  limit: number,
  cursor: { createdAt: number; recordId: string } | null = null,
): Promise<{
  items: CollaborationTimelineItem[];
  nextCursor: string | null;
}> {
  function producerLabel(value: string | null): string | null {
    if (value === null) return null;
    const bounded = value
      .replace(/[\p{Cc}\p{Cf}]/gu, "�")
      .trim()
      .slice(0, 120);
    return bounded.length === 0 ? "authorized client" : bounded;
  }
  const rows = await db
    .prepare(
      `SELECT r.id, r.record_type, r.schema_version, r.project_id,
        r.work_item_id, r.work_packet_id, r.attempt_id, r.participant_ref_id,
        r.producer_client_id, r.historical_grant_id, r.portable_object_id,
        r.body_object_key, r.content_sha256, r.byte_length, r.received_at,
        r.restored_at, s.visibility, s.disposition,
        COALESCE((
          SELECT clients.client_name
          FROM collaboration_grant_clients clients
          JOIN collaboration_grants grants ON grants.id = clients.grant_id
          WHERE grants.id = r.historical_grant_id
          LIMIT 1
        ), r.producer_client_id) AS producer_label
       FROM collaboration_records r
       JOIN collaboration_record_states s ON s.record_id = r.id
       WHERE (${whereSql})
         AND (? IS NULL OR r.received_at < ?
           OR (r.received_at = ? AND r.id < ?))
       ORDER BY r.received_at DESC, r.id DESC LIMIT ?`,
    )
    .bind(
      ...bindings,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? 0,
      cursor?.createdAt ?? 0,
      cursor?.recordId ?? "",
      limit + 1,
    )
    .all<TimelineRow>();
  const items: CollaborationTimelineItem[] = [];
  for (const row of rows.results.slice(0, limit)) {
    if (row.project_id === null) continue;
    items.push({
      contentSha256: row.content_sha256,
      createdAt: row.received_at,
      disposition: row.disposition,
      producerLabel: producerLabel(row.producer_label),
      projectId: row.project_id,
      recordId: row.id,
      recordType: row.record_type,
      visibility: row.visibility,
      workItemId: row.work_item_id,
    });
  }
  const last = rows.results.slice(0, limit).at(-1);
  return {
    items,
    nextCursor:
      rows.results.length > limit && last !== undefined
        ? encodeBase64Url(
            encoder.encode(
              JSON.stringify({
                createdAt: last.received_at,
                recordId: last.id,
              }),
            ),
          )
        : null,
  };
}

function parseTimelineCursor(
  raw: string | null,
): { createdAt: number; recordId: string } | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(decoder.decode(decodeBase64Url(raw))) as {
      createdAt?: unknown;
      recordId?: unknown;
    };
    if (
      !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0 ||
      typeof value.recordId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.recordId,
      )
    ) {
      throw new Error("invalid");
    }
    return {
      createdAt: value.createdAt as number,
      recordId: value.recordId,
    };
  } catch {
    throw new Error("collaboration_cursor_invalid");
  }
}

export async function readCollaborationTimelinePage(
  db: D1Database,
  input: {
    cursor: string | null;
    kind: "inbox" | "timeline";
    limit: number;
  },
): Promise<{ items: CollaborationTimelineItem[]; nextCursor: string | null }> {
  return timelineItems(
    db,
    input.kind === "inbox"
      ? `r.record_type IN ('attempt', 'artifact', 'handoff', 'review')
         AND s.disposition = 'pending'`
      : "r.project_id IS NOT NULL",
    [],
    input.limit,
    parseTimelineCursor(input.cursor),
  );
}

export type StoredCollaborationProjectSummary = {
  activeGrantCount: number;
  activeKnowledgeSpaceVersionId: string;
  activeProjectVersionId: string;
  agentVisibility: "discoverable" | "owner-only";
  createdAt: number;
  currentPacketId: string | null;
  currentWorkItemId: string | null;
  currentWorkItemStatus: "closed" | "open" | "quarantined" | null;
  label: string;
  lastActivityAt: number;
  objective: string;
  pendingAuthorizationCount: number;
  projectId: string;
  recordCount: number;
  status: "active" | "archived";
  workItemCount: number;
};

export type StoredCollaborationDashboard = Omit<
  CollaborationDashboardResponse,
  "projects"
> & {
  projects: StoredCollaborationProjectSummary[];
};

export async function setCollaborationProjectArchived(
  db: D1Database,
  input: {
    archived: boolean;
    now: number;
    projectId: string;
    reason: string;
    requestId: string;
  },
): Promise<boolean> {
  const status = input.archived ? "archived" : "active";
  const results = await db.batch<{ project_id: string }>([
    db
      .prepare(
        `UPDATE collaboration_projects
         SET status = ?
         WHERE project_id = ? AND status != ?
         RETURNING project_id`,
      )
      .bind(status, input.projectId, status),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE project_id = ? AND ? = 1
           AND status IN ('active', 'pending')`,
      )
      .bind(input.now, input.projectId, input.archived ? 1 : 0),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, ?, ?, ?
         WHERE changes() >= 0
           AND EXISTS (
             SELECT 1 FROM collaboration_projects WHERE project_id = ?
           )`,
      )
      .bind(
        crypto.randomUUID(),
        input.archived
          ? "collaboration.project_archived"
          : "collaboration.project_reactivated",
        input.requestId,
        input.now,
        input.projectId,
      ),
  ]);
  if (results[0]?.results[0]?.project_id === input.projectId) return true;
  const existing = await db
    .prepare(
      `SELECT project_id FROM collaboration_projects
       WHERE project_id = ? AND status = ?`,
    )
    .bind(input.projectId, status)
    .first<{ project_id: string }>();
  return existing?.project_id === input.projectId;
}

export async function setCollaborationProjectAgentVisibility(
  db: D1Database,
  input: {
    now: number;
    projectId: string;
    reason: string;
    requestId: string;
    visibility: "discoverable" | "owner-only";
  },
): Promise<boolean> {
  const results = await db.batch<{ project_id: string }>([
    db
      .prepare(
        `UPDATE collaboration_projects
         SET agent_visibility = ?
         WHERE project_id = ? AND agent_visibility != ?
         RETURNING project_id`,
      )
      .bind(input.visibility, input.projectId, input.visibility),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE project_id = ? AND ? = 'owner-only'
           AND status IN ('active', 'pending')`,
      )
      .bind(input.now, input.projectId, input.visibility),
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'expired', decided_at = COALESCE(decided_at, ?)
         WHERE ? = 'owner-only'
           AND status IN ('pending', 'approving')
           AND json_valid(draft_json)
           AND json_extract(draft_json, '$.requestKind') = 'join'
           AND COALESCE(
             json_extract(draft_json, '$.target.projectId'),
             json_extract(draft_json, '$.projectId')
           ) = ?`,
      )
      .bind(input.now, input.visibility, input.projectId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM collaboration_projects WHERE project_id = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        input.visibility === "owner-only"
          ? "collaboration.project_hidden_from_agents"
          : "collaboration.project_discoverable_to_agents",
        input.requestId,
        input.now,
        input.projectId,
      ),
  ]);
  if (results[0]?.results[0]?.project_id === input.projectId) return true;
  const existing = await db
    .prepare(
      `SELECT project_id FROM collaboration_projects
       WHERE project_id = ? AND agent_visibility = ?`,
    )
    .bind(input.projectId, input.visibility)
    .first<{ project_id: string }>();
  return existing?.project_id === input.projectId;
}

export async function setCollaborationWorkItemReopened(
  db: D1Database,
  input: {
    now: number;
    projectId: string;
    reason: string;
    requestId: string;
    workItemId: string;
  },
): Promise<boolean> {
  const results = await db.batch<{ work_item_id: string }>([
    db
      .prepare(
        `UPDATE collaboration_work_items
         SET status = 'open'
         WHERE work_item_id = ? AND project_id = ? AND status = 'closed'
           AND EXISTS (
             SELECT 1
             FROM collaboration_projects projects
             WHERE projects.project_id = collaboration_work_items.project_id
               AND projects.status = 'active'
           )
         RETURNING work_item_id`,
      )
      .bind(input.workItemId, input.projectId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'collaboration.work_item_reopened', ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM collaboration_work_items work
           JOIN collaboration_projects projects
             ON projects.project_id = work.project_id
           WHERE work.work_item_id = ? AND work.project_id = ?
             AND work.status = 'open' AND projects.status = 'active'
         )`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        input.workItemId,
        input.projectId,
      ),
  ]);
  if (results[0]?.results[0]?.work_item_id === input.workItemId) return true;
  const existing = await db
    .prepare(
      `SELECT work_item_id
       FROM collaboration_work_items
       WHERE work_item_id = ? AND project_id = ? AND status = 'open'`,
    )
    .bind(input.workItemId, input.projectId)
    .first<{ work_item_id: string }>();
  return existing?.work_item_id === input.workItemId;
}

export async function readCollaborationDashboard(
  db: D1Database,
  now = Math.floor(Date.now() / 1_000),
): Promise<StoredCollaborationDashboard> {
  const projectRows = await db
    .prepare(
      `SELECT p.project_id, p.active_project_version_id,
        p.active_knowledge_space_version_id, p.agent_visibility, p.label,
        p.objective, p.status, p.created_at,
        (
          SELECT COUNT(*) FROM collaboration_work_items work
          WHERE work.project_id = p.project_id
        ) AS work_item_count,
        (
          SELECT COUNT(*) FROM collaboration_records records
          WHERE records.project_id = p.project_id
        ) AS record_count,
        COALESCE(
          (
            SELECT MAX(records.received_at)
            FROM collaboration_records records
            WHERE records.project_id = p.project_id
          ),
          p.created_at
        ) AS last_activity_at,
        (
          SELECT COUNT(*) FROM collaboration_grants grants
          WHERE grants.project_id = p.project_id
            AND grants.status = 'active' AND grants.expires_at > ?
        ) AS active_grant_count,
        (
          SELECT COUNT(*)
          FROM project_initialization_requests requests
          WHERE requests.result_project_id = p.project_id
            AND requests.status = 'approved'
            AND requests.result_collaboration_grant_id =
              'client-authorization-pending'
        ) AS pending_authorization_count,
        (
          SELECT records.id
          FROM collaboration_records records
          JOIN collaboration_work_items work
            ON work.work_item_id = records.work_item_id
          WHERE records.project_id = p.project_id
            AND records.record_type = 'work-packet'
          ORDER BY
            CASE WHEN work.status = 'open' THEN 0 ELSE 1 END,
            records.received_at DESC, records.id DESC
          LIMIT 1
        ) AS current_packet_id,
        (
          SELECT records.work_item_id
          FROM collaboration_records records
          JOIN collaboration_work_items work
            ON work.work_item_id = records.work_item_id
          WHERE records.project_id = p.project_id
            AND records.record_type = 'work-packet'
          ORDER BY
            CASE WHEN work.status = 'open' THEN 0 ELSE 1 END,
            records.received_at DESC, records.id DESC
          LIMIT 1
        ) AS current_work_item_id,
        (
          SELECT work.status
          FROM collaboration_records records
          JOIN collaboration_work_items work
            ON work.work_item_id = records.work_item_id
          WHERE records.project_id = p.project_id
            AND records.record_type = 'work-packet'
          ORDER BY
            CASE WHEN work.status = 'open' THEN 0 ELSE 1 END,
            records.received_at DESC, records.id DESC
          LIMIT 1
        ) AS current_work_item_status
       FROM collaboration_projects p
       ORDER BY p.created_at DESC LIMIT 100`,
    )
    .bind(now)
    .all<{
      active_grant_count: number;
      active_knowledge_space_version_id: string;
      active_project_version_id: string;
      agent_visibility: "discoverable" | "owner-only";
      created_at: number;
      current_packet_id: string | null;
      current_work_item_id: string | null;
      current_work_item_status: "closed" | "open" | "quarantined" | null;
      label: string;
      last_activity_at: number;
      objective: string;
      pending_authorization_count: number;
      project_id: string;
      record_count: number;
      status: "active" | "archived";
      work_item_count: number;
    }>();
  const participantRows = await db
    .prepare(
      `SELECT g.id AS grant_id, g.oauth_client_id, g.project_id, g.status,
        g.expires_at, g.last_used_at,
        COALESCE(c.client_name, 'Authorized client') AS client_name,
        COALESCE(c.client_origin, 'unknown') AS client_origin,
        SUM(CASE WHEN r.record_type = 'attempt' THEN 1 ELSE 0 END)
          AS attempt_count,
        SUM(CASE WHEN r.record_type = 'artifact' THEN 1 ELSE 0 END)
          AS artifact_count,
        SUM(CASE WHEN r.record_type = 'handoff' THEN 1 ELSE 0 END)
          AS handoff_count,
        SUM(CASE WHEN r.record_type = 'review' THEN 1 ELSE 0 END)
          AS review_count,
        SUM(CASE WHEN r.record_type IN (
          'attempt', 'artifact', 'handoff', 'review', 'decision'
        ) AND s.disposition = 'accepted' THEN 1 ELSE 0 END)
          AS accepted_count,
        SUM(CASE WHEN s.disposition = 'pending' THEN 1 ELSE 0 END)
          AS pending_count
       FROM collaboration_grants g
       LEFT JOIN collaboration_grant_clients c ON c.grant_id = g.id
       LEFT JOIN collaboration_records r
         ON r.historical_grant_id = g.id
       LEFT JOIN collaboration_record_states s ON s.record_id = r.id
       GROUP BY g.id
       ORDER BY g.issued_at DESC LIMIT 250`,
    )
    .all<{
      accepted_count: number;
      artifact_count: number;
      attempt_count: number;
      client_name: string;
      client_origin: string;
      expires_at: number;
      grant_id: string;
      handoff_count: number;
      last_used_at: number | null;
      oauth_client_id: string;
      pending_count: number;
      project_id: string;
      review_count: number;
      status: "active" | "pending" | "revoked";
    }>();
  const countRow = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN r.record_type = 'attempt' THEN 1 ELSE 0 END)
          AS attempt_count,
        SUM(CASE WHEN r.record_type = 'artifact' THEN 1 ELSE 0 END)
          AS artifact_count,
        SUM(CASE WHEN r.record_type = 'handoff' THEN 1 ELSE 0 END)
          AS handoff_count,
        SUM(CASE WHEN r.record_type = 'review' THEN 1 ELSE 0 END)
          AS review_count,
        SUM(CASE WHEN r.record_type = 'decision' THEN 1 ELSE 0 END)
          AS decision_count,
        SUM(CASE WHEN s.disposition = 'accepted' THEN 1 ELSE 0 END)
          AS accepted_count,
        SUM(CASE WHEN r.record_type = 'handoff'
          AND s.disposition = 'pending' THEN 1 ELSE 0 END)
          AS handoffs_to_share,
        SUM(CASE WHEN r.record_type IN ('attempt', 'artifact')
          AND s.disposition = 'pending' THEN 1 ELSE 0 END)
          AS records_to_review,
        SUM(CASE WHEN r.record_type = 'review'
          AND s.disposition = 'pending' THEN 1 ELSE 0 END)
          AS reviews_to_decide
       FROM collaboration_records r
       JOIN collaboration_record_states s ON s.record_id = r.id
       WHERE r.project_id IS NOT NULL`,
    )
    .first<{
      accepted_count: number | null;
      artifact_count: number | null;
      attempt_count: number | null;
      decision_count: number | null;
      handoff_count: number | null;
      handoffs_to_share: number | null;
      records_to_review: number | null;
      review_count: number | null;
      reviews_to_decide: number | null;
    }>();
  const counts = {
    accepted: countRow?.accepted_count ?? 0,
    artifacts: countRow?.artifact_count ?? 0,
    attempts: countRow?.attempt_count ?? 0,
    decisions: countRow?.decision_count ?? 0,
    handoffs: countRow?.handoff_count ?? 0,
    handoffsToShare: countRow?.handoffs_to_share ?? 0,
    recordsToReview: countRow?.records_to_review ?? 0,
    reviews: countRow?.review_count ?? 0,
    reviewsToDecide: countRow?.reviews_to_decide ?? 0,
  };
  const participants = participantRows.results.map((row) => {
    return {
      acceptedRecordCount: row.accepted_count,
      artifactCount: row.artifact_count,
      attemptCount: row.attempt_count,
      authorizationClientId: row.oauth_client_id,
      authorizationClientName: row.client_name.slice(0, 120),
      claimedIdentityLabels: [],
      clientOrigin: row.client_origin,
      grantId: row.grant_id,
      handoffCount: row.handoff_count,
      lastUsedAt: row.last_used_at,
      pendingOwnerActionCount: row.pending_count,
      projectId: row.project_id,
      reviewCount: row.review_count,
      status:
        row.status === "revoked"
          ? ("revoked" as const)
          : row.expires_at <= Math.floor(Date.now() / 1_000)
            ? ("expired" as const)
            : ("active" as const),
    };
  });
  const [inboxPage, timelinePage] = await Promise.all([
    readCollaborationTimelinePage(db, {
      cursor: null,
      kind: "inbox",
      limit: 25,
    }),
    readCollaborationTimelinePage(db, {
      cursor: null,
      kind: "timeline",
      limit: 25,
    }),
  ]);
  return {
    contributionStatistics: {
      acceptedRecordCount: counts.accepted,
      artifactCount: counts.artifacts,
      attemptCount: counts.attempts,
      authorizationClientCount: new Set(
        participantRows.results.map((row) => row.oauth_client_id),
      ).size,
      decisionCount: counts.decisions,
      handoffCount: counts.handoffs,
      reviewCount: counts.reviews,
    },
    inbox: inboxPage.items,
    inboxNextCursor: inboxPage.nextCursor,
    participants,
    pendingActions: {
      handoffsToShare: counts.handoffsToShare,
      recordsToReview: counts.recordsToReview,
      reviewsToDecide: counts.reviewsToDecide,
      total:
        counts.handoffsToShare +
        counts.recordsToReview +
        counts.reviewsToDecide,
    },
    projects: projectRows.results.map((row) => ({
      activeGrantCount: row.active_grant_count,
      activeKnowledgeSpaceVersionId: row.active_knowledge_space_version_id,
      activeProjectVersionId: row.active_project_version_id,
      agentVisibility: row.agent_visibility,
      createdAt: row.created_at,
      currentPacketId: row.current_packet_id,
      currentWorkItemId: row.current_work_item_id,
      currentWorkItemStatus: row.current_work_item_status,
      label: row.label,
      lastActivityAt: row.last_activity_at,
      objective: row.objective,
      pendingAuthorizationCount: row.pending_authorization_count,
      projectId: row.project_id,
      recordCount: row.record_count,
      status: row.status,
      workItemCount: row.work_item_count,
    })),
    timeline: timelinePage.items,
    timelineNextCursor: timelinePage.nextCursor,
  };
}

export async function readCollaborationParticipantClaims(
  db: D1Database,
  storage: R2Bucket,
  grantId: string,
): Promise<string[] | null> {
  const grant = await db
    .prepare(`SELECT id FROM collaboration_grants WHERE id = ?`)
    .bind(grantId)
    .first<{ id: string }>();
  if (grant === null) return null;
  const participantRef = await db
    .prepare(
      `SELECT participant.id
       FROM collaboration_records participant
       JOIN collaboration_dependencies dependency
         ON dependency.dependency_id = participant.id
        AND dependency.dependency_kind = 'record'
       JOIN collaboration_records attempt
         ON attempt.id = dependency.record_id
        AND attempt.record_type = 'attempt'
       WHERE attempt.historical_grant_id = ?
         AND participant.record_type = 'participant-ref'
       ORDER BY attempt.received_at DESC, participant.id DESC LIMIT 1`,
    )
    .bind(grantId)
    .first<{ id: string }>();
  if (participantRef === null) return [];
  const loaded = await readCollaborationRecord(db, storage, participantRef.id);
  if (loaded?.record.recordType !== "participant-ref") return [];
  return [
    ...(loaded.record.claimedHarness === null
      ? []
      : [loaded.record.claimedHarness.name]),
    ...(loaded.record.claimedModel === null
      ? []
      : [loaded.record.claimedModel.name]),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

export async function contentObjectForRecord(
  db: D1Database,
  recordId: string,
): Promise<StoredContentObject | null> {
  const row = await db
    .prepare(
      `SELECT o.id, o.portable_object_id, o.object_kind, o.media_type,
        o.content_sha256, o.byte_length, o.object_key, o.created_at,
        o.restored_at
       FROM collaboration_record_content rc
       JOIN collaboration_content_objects o ON o.id = rc.content_object_id
       WHERE rc.record_id = ? LIMIT 1`,
    )
    .bind(recordId)
    .first<{
      byte_length: number;
      content_sha256: string;
      created_at: number;
      id: string;
      media_type: StoredContentObject["mediaType"];
      object_key: string;
      object_kind: StoredContentObject["objectKind"];
      portable_object_id: string;
      restored_at: number | null;
    }>();
  return row === null
    ? null
    : {
        byteLength: row.byte_length,
        contentSha256: row.content_sha256,
        createdAt: row.created_at,
        id: row.id,
        mediaType: row.media_type,
        objectKey: row.object_key,
        objectKind: row.object_kind,
        portableObjectId: row.portable_object_id,
        restoredAt: row.restored_at,
      };
}

export async function idempotencyKeyHash(value: string): Promise<string> {
  return sha256Hex(value);
}
