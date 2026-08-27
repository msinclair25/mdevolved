import {
  sourceBoundarySchema,
  sourceDeviceSummarySchema,
  type SourceBoundary,
  type SourceDeviceSummary,
} from "@mdevolved/contracts";
import { sha256Hex } from "./security";

interface SourceDeviceRow {
  id: string;
  vault_id: string;
  display_name: string;
  boundary_json: string;
  boundary_sha256: string;
  status: "active" | "revoked";
  enrolled_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_published_at: number | null;
  last_published_state_vector_sha256: string | null;
}

export class SourceDeviceError extends Error {
  override readonly name = "SourceDeviceError";

  constructor(
    readonly code:
      | "source_boundary_invalid"
      | "source_boundary_mismatch"
      | "source_device_conflict"
      | "source_device_limit"
      | "idempotency_conflict"
      | "source_device_denied",
  ) {
    super(code);
  }
}

function canonicalBoundary(boundary: SourceBoundary): string {
  return JSON.stringify({
    version: boundary.version,
    root: boundary.root,
    pathPolicy: boundary.pathPolicy,
    sourceKind: boundary.sourceKind,
    capabilities: boundary.capabilities,
  });
}

export async function verifySourceBoundary(
  value: SourceBoundary,
): Promise<SourceBoundary> {
  const boundary = sourceBoundarySchema.parse(value);
  if (
    (await sha256Hex(canonicalBoundary(boundary))) !== boundary.boundarySha256
  ) {
    throw new SourceDeviceError("source_boundary_invalid");
  }
  return boundary;
}

function summary(row: SourceDeviceRow, now: number): SourceDeviceSummary {
  let boundary: unknown;
  try {
    boundary = JSON.parse(row.boundary_json);
  } catch {
    throw new SourceDeviceError("source_boundary_invalid");
  }
  return sourceDeviceSummarySchema.parse({
    deviceId: row.id,
    displayName: row.display_name,
    status:
      row.status === "revoked"
        ? "revoked"
        : row.expires_at !== null && row.expires_at <= now
          ? "expired"
          : "active",
    boundary,
    enrolledAt: row.enrolled_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    lastPublishedAt: row.last_published_at,
    lastPublishedStateVectorSha256: row.last_published_state_vector_sha256,
  });
}

export async function readSourceDeviceByEnrollmentKey(
  db: D1Database,
  idempotencyKey: string,
  now: number,
): Promise<{
  requestSha256: string;
  grantSha256: string;
  originSha256: string;
  summary: SourceDeviceSummary;
  vaultId: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, vault_id, display_name, boundary_json, boundary_sha256,
        status, enrolled_at, expires_at, revoked_at, last_seen_at,
        last_published_at, last_published_state_vector_sha256,
        enrollment_request_sha256, enrollment_grant_sha256,
        enrollment_origin_sha256
       FROM source_devices
       WHERE enrollment_idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<
      SourceDeviceRow & {
        enrollment_request_sha256: string;
        enrollment_grant_sha256: string;
        enrollment_origin_sha256: string;
      }
    >();
  return row === null
    ? null
    : {
        requestSha256: row.enrollment_request_sha256,
        grantSha256: row.enrollment_grant_sha256,
        originSha256: row.enrollment_origin_sha256,
        summary: summary(row, now),
        vaultId: row.vault_id,
      };
}

export async function listSourceDevices(
  db: D1Database,
  vaultId: string,
  now: number,
): Promise<SourceDeviceSummary[]> {
  const rows = await db
    .prepare(
      `SELECT id, vault_id, display_name, boundary_json, boundary_sha256,
        status, enrolled_at, expires_at, revoked_at, last_seen_at,
        last_published_at, last_published_state_vector_sha256
       FROM source_devices
       WHERE vault_id = ?
       ORDER BY enrolled_at, id
       LIMIT 64`,
    )
    .bind(vaultId)
    .all<SourceDeviceRow>();
  return rows.results.map((row) => summary(row, now));
}

export async function listAllSourceDevices(
  db: D1Database,
  now: number,
): Promise<Map<string, SourceDeviceSummary[]>> {
  const rows = await db
    .prepare(
      `SELECT id, vault_id, display_name, boundary_json, boundary_sha256,
        status, enrolled_at, expires_at, revoked_at, last_seen_at,
        last_published_at, last_published_state_vector_sha256
       FROM source_devices
       ORDER BY vault_id, last_published_sequence DESC, enrolled_at, id`,
    )
    .all<SourceDeviceRow>();
  const devices = new Map<string, SourceDeviceSummary[]>();
  for (const row of rows.results) {
    const current = devices.get(row.vault_id) ?? [];
    if (current.length < 64) current.push(summary(row, now));
    devices.set(row.vault_id, current);
  }
  return devices;
}

export async function revokeSourceDevice(
  db: D1Database,
  input: { deviceId: string; now: number; requestId: string; vaultId: string },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE source_devices
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND vault_id = ? AND status = 'active'
         RETURNING id`,
      )
      .bind(input.now, input.deviceId, input.vaultId),
    db
      .prepare(
        `UPDATE vault_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE source_device_id = ? AND vault_id = ?`,
      )
      .bind(input.now, input.deviceId, input.vaultId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'source.device_revoked', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM source_devices WHERE id = ? AND vault_id = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        input.deviceId,
        input.vaultId,
      ),
  ]);
  return results[0]?.results[0]?.id === input.deviceId;
}

export async function markSourceDevicePublished(
  db: D1Database,
  input: {
    credentialId: string;
    deviceId: string;
    now: number;
    requestId: string;
    stateVectorSha256: string;
    vaultId: string;
  },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE source_devices
         SET last_seen_at = ?, last_published_at = ?,
             last_published_state_vector_sha256 = ?,
             last_published_credential_id = ?,
             last_published_sequence = COALESCE((
               SELECT MAX(other.last_published_sequence) + 1
               FROM source_devices other
               WHERE other.vault_id = ?
             ), 1)
         WHERE id = ? AND vault_id = ? AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
           AND EXISTS (
             SELECT 1 FROM vault_credentials credential
             WHERE credential.id = ?
               AND credential.vault_id = source_devices.vault_id
               AND credential.source_device_id = source_devices.id
               AND credential.revoked_at IS NULL
           )
         RETURNING id`,
      )
      .bind(
        input.now,
        input.now,
        input.stateVectorSha256,
        input.credentialId,
        input.vaultId,
        input.deviceId,
        input.vaultId,
        input.now,
        input.credentialId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'source.device_published', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM source_devices
           WHERE id = ? AND vault_id = ?
             AND last_published_state_vector_sha256 = ?
         )`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        input.deviceId,
        input.vaultId,
        input.stateVectorSha256,
      ),
  ]);
  return results[0]?.results[0]?.id === input.deviceId;
}
