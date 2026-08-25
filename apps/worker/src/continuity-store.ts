import {
  MAX_SUBMISSION_BYTES,
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  continuityCheckpointReceiptSchema,
  continuityPointSchema,
  projectLeadIdentitySchema,
  projectLeadLeaseSchema,
  type ContinuityCheckpointReceipt,
  type ContinuityPoint,
  type ProjectLeadIdentity,
  type ProjectLeadLease,
} from "@owd/contracts";
import { sha256Hex, sha256HexBytes } from "./security";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type LeadLeaseRow = {
  claim_authority_key: string;
  claim_idempotency_key_sha256: string;
  claim_request_sha256: string;
  claimed_at: number;
  expires_at: number;
  fencing_token: number;
  holder_client_id: string;
  holder_grant_id: string;
  lead_identity_json: string;
  lease_id: string;
  project_id: string;
  renewed_at: number;
  revoked_at: number | null;
  status: "active" | "revoked";
};

type ContinuityPointRow = {
  acknowledged_at: number;
  body_object_key: string;
  byte_length: number;
  content_sha256: string;
  continuity_point_id: string;
  portable_object_id: string;
  previous_continuity_point_id: string | null;
  producer_client_id: string | null;
  project_id: string;
  project_version_id: string;
  knowledge_space_version_id: string;
  restored_at: number | null;
  source_fencing_token: number;
  source_lease_id: string | null;
  work_item_id: string;
  work_item_version_id: string;
  work_packet_id: string;
};

export type StoredLeadLease = {
  claimAuthorityKey: string;
  claimIdempotencyKeySha256: string;
  claimRequestSha256: string;
  holderClientId: string;
  holderGrantId: string;
  lease: ProjectLeadLease;
};

export type PreparedContinuityPoint = {
  bodyObjectKey: string;
  byteLength: number;
  contentSha256: string;
  point: ContinuityPoint;
  portableObjectId: string;
};

export type StoredContinuityPoint = PreparedContinuityPoint & {
  producerClientId: string | null;
  restoredAt: number | null;
  sourceLeaseId: string | null;
};

export type StoredCheckpointReceipt = ContinuityCheckpointReceipt & {
  requestSha256: string;
};

function leaseFromRow(row: LeadLeaseRow, now: number): StoredLeadLease {
  const leadIdentity = projectLeadIdentitySchema.parse(
    JSON.parse(row.lead_identity_json) as unknown,
  );
  return {
    claimAuthorityKey: row.claim_authority_key,
    claimIdempotencyKeySha256: row.claim_idempotency_key_sha256,
    claimRequestSha256: row.claim_request_sha256,
    holderClientId: row.holder_client_id,
    holderGrantId: row.holder_grant_id,
    lease: projectLeadLeaseSchema.parse({
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      fencingToken: row.fencing_token,
      leadIdentity,
      leaseId: row.lease_id,
      projectId: row.project_id,
      renewedAt: row.renewed_at,
      revokedAt: row.revoked_at,
      status:
        row.status === "revoked"
          ? "revoked"
          : row.expires_at <= now
            ? "expired"
            : "active",
    }),
  };
}

const LEASE_COLUMNS = `project_id, lease_id, holder_grant_id,
  holder_client_id, lead_identity_json, fencing_token, claim_authority_key,
  claim_idempotency_key_sha256, claim_request_sha256, status, claimed_at,
  renewed_at, expires_at, revoked_at`;

export async function readProjectLeadLease(
  db: D1Database,
  projectId: string,
  now: number,
): Promise<StoredLeadLease | null> {
  const row = await db
    .prepare(
      `SELECT ${LEASE_COLUMNS}
       FROM project_lead_leases WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<LeadLeaseRow>();
  return row === null ? null : leaseFromRow(row, now);
}

export async function claimProjectLeadLeaseRow(
  db: D1Database,
  input: {
    authorityKey: string;
    claimIdempotencyKeySha256: string;
    claimRequestSha256: string;
    clientId: string;
    expiresAt: number;
    grantId: string;
    leadIdentity: ProjectLeadIdentity;
    leaseId: string;
    now: number;
    projectId: string;
  },
): Promise<StoredLeadLease | null> {
  const row = await db
    .prepare(
      `INSERT INTO project_lead_leases (
        project_id, lease_id, holder_grant_id, holder_client_id,
        lead_identity_json, fencing_token, claim_authority_key,
        claim_idempotency_key_sha256, claim_request_sha256, status,
        claimed_at, renewed_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'active', ?, ?, ?, NULL)
      ON CONFLICT (project_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        holder_grant_id = excluded.holder_grant_id,
        holder_client_id = excluded.holder_client_id,
        lead_identity_json = excluded.lead_identity_json,
        fencing_token = project_lead_leases.fencing_token + 1,
        claim_authority_key = excluded.claim_authority_key,
        claim_idempotency_key_sha256 = excluded.claim_idempotency_key_sha256,
        claim_request_sha256 = excluded.claim_request_sha256,
        status = 'active',
        claimed_at = excluded.claimed_at,
        renewed_at = excluded.renewed_at,
        expires_at = excluded.expires_at,
        revoked_at = NULL
      WHERE project_lead_leases.status = 'revoked'
        OR project_lead_leases.expires_at <= excluded.claimed_at
        OR NOT EXISTS (
          SELECT 1
          FROM collaboration_grants current_grant
          JOIN agent_grants source_grant
            ON source_grant.id = current_grant.source_agent_grant_id
          JOIN vaults source_vault ON source_vault.id = source_grant.vault_id
          WHERE current_grant.id = project_lead_leases.holder_grant_id
            AND current_grant.status = 'active'
            AND current_grant.expires_at > excluded.claimed_at
            AND source_grant.status = 'active'
            AND source_vault.status = 'active'
        )
      RETURNING ${LEASE_COLUMNS}`,
    )
    .bind(
      input.projectId,
      input.leaseId,
      input.grantId,
      input.clientId,
      JSON.stringify(projectLeadIdentitySchema.parse(input.leadIdentity)),
      input.authorityKey,
      input.claimIdempotencyKeySha256,
      input.claimRequestSha256,
      input.now,
      input.now,
      input.expiresAt,
    )
    .first<LeadLeaseRow>();
  return row === null ? null : leaseFromRow(row, input.now);
}

export async function renewProjectLeadLeaseRow(
  db: D1Database,
  input: {
    clientId: string;
    expiresAt: number;
    fencingToken: number;
    grantId: string;
    leaseId: string;
    now: number;
    projectId: string;
  },
): Promise<StoredLeadLease | null> {
  const row = await db
    .prepare(
      `UPDATE project_lead_leases
       SET renewed_at = ?, expires_at = ?
       WHERE project_id = ? AND lease_id = ? AND fencing_token = ?
         AND holder_grant_id = ? AND holder_client_id = ?
         AND status = 'active' AND expires_at > ?
       RETURNING ${LEASE_COLUMNS}`,
    )
    .bind(
      input.now,
      input.expiresAt,
      input.projectId,
      input.leaseId,
      input.fencingToken,
      input.grantId,
      input.clientId,
      input.now,
    )
    .first<LeadLeaseRow>();
  return row === null ? null : leaseFromRow(row, input.now);
}

export async function revokeProjectLeadLeaseRow(
  db: D1Database,
  input: { now: number; projectId: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE project_lead_leases
       SET status = 'revoked', revoked_at = ?
       WHERE project_id = ? AND status = 'active'
       RETURNING project_id`,
    )
    .bind(input.now, input.projectId)
    .first<{ project_id: string }>();
  return row?.project_id === input.projectId;
}

export function releaseProjectLeadLeaseStatement(
  db: D1Database,
  input: {
    clientId: string;
    fencingToken: number;
    grantId: string;
    leadIdentity: ProjectLeadIdentity;
    leaseId: string;
    now: number;
    projectId: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE project_lead_leases
       SET status = 'revoked', revoked_at = ?
       WHERE project_id = ? AND lease_id = ? AND fencing_token = ?
         AND holder_grant_id = ? AND holder_client_id = ?
         AND lead_identity_json = ? AND status = 'active'
       RETURNING project_id`,
    )
    .bind(
      input.now,
      input.projectId,
      input.leaseId,
      input.fencingToken,
      input.grantId,
      input.clientId,
      JSON.stringify(projectLeadIdentitySchema.parse(input.leadIdentity)),
    );
}

async function putImmutableContinuityObject(
  storage: R2Bucket,
  input: { bytes: Uint8Array; objectKey: string; sha256: string },
): Promise<void> {
  const existing = await storage.head(input.objectKey);
  if (existing !== null) {
    if (
      existing.size !== input.bytes.byteLength ||
      existing.customMetadata?.sha256 !== input.sha256
    ) {
      throw new Error("continuity_object_collision");
    }
    return;
  }
  const written = await storage.put(input.objectKey, input.bytes, {
    customMetadata: { role: "continuity-point", sha256: input.sha256 },
    httpMetadata: {
      cacheControl: "private, no-store",
      contentType: "application/json",
    },
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: input.sha256,
  });
  if (written === null) {
    const raced = await storage.head(input.objectKey);
    if (
      raced === null ||
      raced.size !== input.bytes.byteLength ||
      raced.customMetadata?.sha256 !== input.sha256
    ) {
      throw new Error("continuity_object_unavailable");
    }
  } else if (written.size !== input.bytes.byteLength) {
    throw new Error("continuity_object_unavailable");
  }
}

export async function prepareContinuityPoint(
  storage: R2Bucket,
  point: ContinuityPoint,
  portableObjectId: string = crypto.randomUUID(),
): Promise<PreparedContinuityPoint> {
  const parsed = continuityPointSchema.parse(point);
  const expectedIntegrity = await sha256Hex(
    canonicalizeIntegrityPayload(
      parsed as ContinuityPoint & Record<string, unknown>,
    ),
  );
  if (expectedIntegrity !== parsed.integrity.digest) {
    throw new Error("integrity_mismatch");
  }
  const bytes = encoder.encode(canonicalizeCollaborationJson(parsed));
  if (bytes.byteLength > MAX_SUBMISSION_BYTES) {
    throw new Error("submission_too_large");
  }
  const contentSha256 = await sha256HexBytes(bytes);
  const bodyObjectKey = `collaboration/continuity/${contentSha256}.json`;
  await putImmutableContinuityObject(storage, {
    bytes,
    objectKey: bodyObjectKey,
    sha256: contentSha256,
  });
  return {
    bodyObjectKey,
    byteLength: bytes.byteLength,
    contentSha256,
    point: parsed,
    portableObjectId,
  };
}

export function insertContinuityPointStatement(
  db: D1Database,
  prepared: PreparedContinuityPoint,
  input: {
    producerClientId: string | null;
    restoredAt: number | null;
    sourceLeaseId: string | null;
  },
): D1PreparedStatement {
  const point = prepared.point;
  return db
    .prepare(
      `WITH candidate (
        continuity_point_id, portable_object_id, project_id,
        project_version_id, work_item_id, work_item_version_id,
        knowledge_space_version_id, work_packet_id,
        previous_continuity_point_id, parent_key,
        source_lease_id, source_fencing_token, producer_client_id,
        body_object_key, content_sha256, byte_length, acknowledged_at,
        restored_at
      ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
      INSERT INTO project_continuity_points (
        continuity_point_id, portable_object_id, project_id,
        project_version_id, work_item_id, work_item_version_id,
        knowledge_space_version_id, work_packet_id,
        previous_continuity_point_id, parent_key,
        source_lease_id, source_fencing_token, producer_client_id,
        body_object_key, content_sha256, byte_length, acknowledged_at,
        restored_at, live_fence_valid, live_context_valid, live_parent_valid
      )
      SELECT candidate.*,
        CASE WHEN candidate.restored_at IS NOT NULL OR EXISTS (
          SELECT 1
          FROM project_lead_leases lease
          JOIN collaboration_grants project_grant
            ON project_grant.id = lease.holder_grant_id
          JOIN agent_grants source_grant
            ON source_grant.id = project_grant.source_agent_grant_id
          JOIN vaults source_vault ON source_vault.id = source_grant.vault_id
          WHERE lease.project_id = candidate.project_id
            AND lease.lease_id = candidate.source_lease_id
            AND lease.fencing_token = candidate.source_fencing_token
            AND lease.holder_client_id = candidate.producer_client_id
            AND lease.status = 'active'
            AND lease.expires_at > unixepoch()
            AND project_grant.status = 'active'
            AND project_grant.expires_at > unixepoch()
            AND project_grant.oauth_client_id = candidate.producer_client_id
            AND project_grant.project_id = candidate.project_id
            AND source_grant.status = 'active'
            AND source_vault.status = 'active'
        ) THEN 1 ELSE 0 END,
        CASE WHEN candidate.restored_at IS NOT NULL OR EXISTS (
          SELECT 1
          FROM collaboration_projects project
          JOIN collaboration_work_items work_item
            ON work_item.work_item_id = candidate.work_item_id
          WHERE project.project_id = candidate.project_id
            AND project.status = 'active'
            AND project.active_project_version_id = candidate.project_version_id
            AND project.active_knowledge_space_version_id =
              candidate.knowledge_space_version_id
            AND work_item.project_id = candidate.project_id
            AND work_item.status = 'open'
            AND work_item.active_work_item_version_id =
              candidate.work_item_version_id
            AND candidate.work_packet_id = (
              SELECT packet.id
              FROM collaboration_records packet
              WHERE packet.project_id = candidate.project_id
                AND packet.work_item_id = candidate.work_item_id
                AND packet.record_type = 'work-packet'
              ORDER BY packet.received_at DESC, packet.id DESC
              LIMIT 1
            )
        ) THEN 1 ELSE 0 END,
        CASE WHEN candidate.restored_at IS NOT NULL OR
          COALESCE(candidate.previous_continuity_point_id, 'root') =
            COALESCE((
              SELECT current.continuity_point_id
              FROM project_continuity_points current
              WHERE current.project_id = candidate.project_id
                AND NOT EXISTS (
                  SELECT 1 FROM project_continuity_points child
                  WHERE child.project_id = current.project_id
                    AND child.parent_key = current.continuity_point_id
                )
              LIMIT 1
            ), 'root')
        THEN 1 ELSE 0 END
      FROM candidate`,
    )
    .bind(
      point.continuityPointId,
      prepared.portableObjectId,
      point.project.projectId,
      point.project.projectVersionId,
      point.workItem.workItemId,
      point.workItem.workItemVersionId,
      point.context.knowledgeSpaceVersionId,
      point.context.workPacketId,
      point.previousContinuityPointId,
      point.previousContinuityPointId ?? "root",
      input.sourceLeaseId,
      point.provenance.leadFencingToken,
      input.producerClientId,
      prepared.bodyObjectKey,
      prepared.contentSha256,
      prepared.byteLength,
      point.provenance.acknowledgedAt,
      input.restoredAt,
    );
}

export function insertContinuityDependencyStatement(
  db: D1Database,
  input: {
    continuityPointId: string;
    dependencyId: string;
    dependencyKind: "evidence" | "record";
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO continuity_point_dependencies (
        continuity_point_id, dependency_id, dependency_kind
      ) VALUES (?, ?, ?)`,
    )
    .bind(input.continuityPointId, input.dependencyId, input.dependencyKind);
}

export function insertContinuityDependenciesStatement(
  db: D1Database,
  continuityPointId: string,
  dependencies: Array<{
    dependencyId: string;
    dependencyKind: "evidence" | "record";
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO continuity_point_dependencies (
        continuity_point_id, dependency_id, dependency_kind
      )
      SELECT ?,
        json_extract(item.value, '$.dependencyId'),
        json_extract(item.value, '$.dependencyKind')
      FROM json_each(?) AS item
      ORDER BY CAST(item.key AS INTEGER)`,
    )
    .bind(continuityPointId, JSON.stringify(dependencies));
}

export function insertCheckpointReceiptStatement(
  db: D1Database,
  input: StoredCheckpointReceipt & { authorityKey: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO continuity_checkpoint_receipts (
        authority_key, idempotency_key_sha256, request_sha256,
        continuity_point_id, content_sha256, previous_continuity_point_id,
        project_id, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.authorityKey,
      input.idempotencyKeySha256,
      input.requestSha256,
      input.continuityPointId,
      input.contentSha256,
      input.previousContinuityPointId,
      input.projectId,
      input.acknowledgedAt,
    );
}

export async function readCheckpointReceipt(
  db: D1Database,
  input: { authorityKey: string; idempotencyKeySha256: string },
): Promise<StoredCheckpointReceipt | null> {
  const row = await db
    .prepare(
      `SELECT request_sha256, continuity_point_id, content_sha256,
        previous_continuity_point_id, project_id, received_at
       FROM continuity_checkpoint_receipts
       WHERE authority_key = ? AND idempotency_key_sha256 = ?`,
    )
    .bind(input.authorityKey, input.idempotencyKeySha256)
    .first<{
      content_sha256: string;
      continuity_point_id: string;
      previous_continuity_point_id: string | null;
      project_id: string;
      received_at: number;
      request_sha256: string;
    }>();
  if (row === null) return null;
  return {
    ...continuityCheckpointReceiptSchema.parse({
      acknowledgedAt: row.received_at,
      contentSha256: row.content_sha256,
      continuityPointId: row.continuity_point_id,
      idempotencyKeySha256: input.idempotencyKeySha256,
      previousContinuityPointId: row.previous_continuity_point_id,
      projectId: row.project_id,
    }),
    requestSha256: row.request_sha256,
  };
}

async function readContinuityPointBody(
  storage: R2Bucket,
  row: ContinuityPointRow,
): Promise<StoredContinuityPoint> {
  const object = await storage.get(row.body_object_key);
  if (object === null || object.size !== row.byte_length) {
    throw new Error("continuity_object_unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256HexBytes(bytes)) !== row.content_sha256) {
    throw new Error("integrity_mismatch");
  }
  const text = decoder.decode(bytes);
  const point = continuityPointSchema.parse(JSON.parse(text) as unknown);
  if (
    canonicalizeCollaborationJson(point) !== text ||
    point.continuityPointId !== row.continuity_point_id ||
    point.project.projectId !== row.project_id ||
    point.project.projectVersionId !== row.project_version_id ||
    point.workItem.workItemId !== row.work_item_id ||
    point.workItem.workItemVersionId !== row.work_item_version_id ||
    point.context.knowledgeSpaceVersionId !== row.knowledge_space_version_id ||
    point.context.workPacketId !== row.work_packet_id ||
    point.previousContinuityPointId !== row.previous_continuity_point_id ||
    point.provenance.leadFencingToken !== row.source_fencing_token ||
    point.provenance.acknowledgedAt !== row.acknowledged_at
  ) {
    throw new Error("integrity_mismatch");
  }
  const expectedIntegrity = await sha256Hex(
    canonicalizeIntegrityPayload(
      point as ContinuityPoint & Record<string, unknown>,
    ),
  );
  if (expectedIntegrity !== point.integrity.digest) {
    throw new Error("integrity_mismatch");
  }
  return {
    bodyObjectKey: row.body_object_key,
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
    point,
    portableObjectId: row.portable_object_id,
    producerClientId: row.producer_client_id,
    restoredAt: row.restored_at,
    sourceLeaseId: row.source_lease_id,
  };
}

const CONTINUITY_COLUMNS = `continuity_point_id, portable_object_id,
  project_id, project_version_id, work_item_id, work_item_version_id,
  knowledge_space_version_id, work_packet_id, previous_continuity_point_id,
  source_lease_id, source_fencing_token, producer_client_id, body_object_key,
  content_sha256, byte_length, acknowledged_at, restored_at`;

export async function readContinuityPoint(
  db: D1Database,
  storage: R2Bucket,
  continuityPointId: string,
): Promise<StoredContinuityPoint | null> {
  const row = await db
    .prepare(
      `SELECT ${CONTINUITY_COLUMNS}
       FROM project_continuity_points WHERE continuity_point_id = ?`,
    )
    .bind(continuityPointId)
    .first<ContinuityPointRow>();
  return row === null ? null : readContinuityPointBody(storage, row);
}

export async function readLatestContinuityPoint(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
): Promise<StoredContinuityPoint | null> {
  const row = await db
    .prepare(
      `SELECT ${CONTINUITY_COLUMNS}
       FROM project_continuity_points current
       WHERE project_id = ? AND NOT EXISTS (
         SELECT 1 FROM project_continuity_points child
         WHERE child.project_id = current.project_id
           AND child.parent_key = current.continuity_point_id
       )
       LIMIT 1`,
    )
    .bind(projectId)
    .first<ContinuityPointRow>();
  return row === null ? null : readContinuityPointBody(storage, row);
}
