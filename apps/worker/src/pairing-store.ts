import pairingMigration from "../../../migrations/0003_vault_pairing.sql";
import pairingOriginMigration from "../../../migrations/0004_pairing_origin.sql";
import type {
  ObsidianMindRuntimeProfile,
  PairingExchangeRequest,
  PairingExchangeResponse,
  SourceDevicePairingExchangeResponse,
  PairingGrantResponse,
  SourceDeviceEnrollment,
  SourceDescriptor,
  VaultSummary,
} from "@mdevolved/contracts";
import { obsidianMindRuntimeProfileSchema } from "@mdevolved/contracts";
import {
  sourceDescriptorInputSchema,
  sourceDescriptorSchema,
} from "@mdevolved/contracts";
import {
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  SERVER_VERSION,
} from "@mdevolved/yaos-core";
import { randomToken, sha256Hex } from "./security";
import {
  SourceDeviceError,
  listAllSourceDevices,
  markSourceDevicePublished,
  readSourceDeviceByEnrollmentKey,
  verifySourceBoundary,
} from "./source-device-service";

const PAIRING_GRANT_LIFETIME_SECONDS = 10 * 60;

export interface VaultCredentialRecord {
  created_at: number;
  id: string;
  plugin_version: string;
  schema_version: number;
  token_hash: string;
  vault_id: string;
  source_device_id: string | null;
}

interface VaultSummaryRow {
  id: string;
  display_name: string | null;
  status: "active" | "pending" | "revoked";
  created_at: number;
  paired_at: number | null;
  last_connected_at: number | null;
}

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function ensurePairingSchema(db: D1Database): Promise<void> {
  const schemaObjects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'vaults',
         'vaults_status_idx',
         'pairing_grants',
         'pairing_grants_vault_idx',
         'pairing_grant_origins',
         'vault_credentials',
         'vault_credentials_vault_idx'
       )`,
    )
    .first<{ count: number }>();

  if (schemaObjects?.count !== 7) {
    await db.exec(executableMigration(pairingMigration));
    await db.exec(executableMigration(pairingOriginMigration));
  }

  // This helper exists for isolated test/bootstrap databases. Production
  // releases still apply 0020 before the matching Worker is deployed.
  await db.exec(
    executableMigration(`
    CREATE TABLE IF NOT EXISTS vault_sync_states (
      vault_id TEXT PRIMARY KEY NOT NULL,
      credential_id TEXT,
      plugin_version TEXT,
      schema_version INTEGER CHECK (
        schema_version IS NULL OR schema_version > 0
      ),
      connection_confirmed_at INTEGER CHECK (
        connection_confirmed_at IS NULL OR connection_confirmed_at >= 0
      ),
      initial_sync_at INTEGER CHECK (
        initial_sync_at IS NULL OR initial_sync_at >= 0
      ),
      last_sync_at INTEGER CHECK (
        last_sync_at IS NULL OR last_sync_at >= 0
      ),
      current_state_vector_sha256 TEXT CHECK (
        current_state_vector_sha256 IS NULL
        OR length(current_state_vector_sha256) = 64
      ),
      library_stale INTEGER NOT NULL DEFAULT 1
        CHECK (library_stale IN (0, 1)),
      last_error_code TEXT,
      last_error_at INTEGER CHECK (
        last_error_at IS NULL OR last_error_at >= 0
      ),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE,
      FOREIGN KEY (credential_id) REFERENCES vault_credentials (id)
        ON DELETE SET NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_sync_states_readiness_idx
      ON vault_sync_states (
        initial_sync_at, library_stale, connection_confirmed_at
      );
    `),
  );
  const runtimeProfileColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('vault_sync_states')
       WHERE name = 'runtime_profile_json'`,
    )
    .first<{ count: number }>();
  if (runtimeProfileColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE vault_sync_states
         ADD COLUMN runtime_profile_json TEXT`,
      )
      .run();
  }
  const sourceDescriptorColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('vaults')
       WHERE name = 'source_descriptor_json'`,
    )
    .first<{ count: number }>();
  if (sourceDescriptorColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE vaults ADD COLUMN source_descriptor_json TEXT
         CHECK (source_descriptor_json IS NULL OR json_valid(source_descriptor_json))`,
      )
      .run();
  }
  // Isolated test/bootstrap databases use the same additive MD4 shape.
  // Production applies 0037 as a release prerequisite; requests never call
  // this helper or discover schema.
  const addColumnIfMissing = async (
    table: string,
    column: string,
    statement: string,
  ): Promise<void> => {
    const present = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM pragma_table_info(?) WHERE name = ?`,
      )
      .bind(table, column)
      .first<{ count: number }>();
    if (present?.count !== 1) await db.prepare(statement).run();
  };
  await addColumnIfMissing(
    "vaults",
    "source_boundary_json",
    `ALTER TABLE vaults ADD COLUMN source_boundary_json TEXT
     CHECK (source_boundary_json IS NULL OR json_valid(source_boundary_json))`,
  );
  await addColumnIfMissing(
    "vaults",
    "source_boundary_sha256",
    `ALTER TABLE vaults ADD COLUMN source_boundary_sha256 TEXT
     CHECK (source_boundary_sha256 IS NULL OR length(source_boundary_sha256) = 64)`,
  );
  await addColumnIfMissing(
    "pairing_grants",
    "device_enrollment",
    `ALTER TABLE pairing_grants ADD COLUMN device_enrollment INTEGER NOT NULL
     DEFAULT 0 CHECK (device_enrollment IN (0, 1))`,
  );
  await addColumnIfMissing(
    "pairing_grants",
    "device_expires_at",
    `ALTER TABLE pairing_grants ADD COLUMN device_expires_at INTEGER
     CHECK (device_expires_at IS NULL OR device_expires_at > created_at)`,
  );
  await db.exec(
    executableMigration(`CREATE TABLE IF NOT EXISTS source_devices (
      id TEXT PRIMARY KEY NOT NULL,
      vault_id TEXT NOT NULL,
      display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
      root_fingerprint_sha256 TEXT NOT NULL CHECK (length(root_fingerprint_sha256) = 64),
      boundary_json TEXT NOT NULL CHECK (json_valid(boundary_json)),
      boundary_sha256 TEXT NOT NULL CHECK (length(boundary_sha256) = 64),
      client_version TEXT NOT NULL CHECK (length(client_version) BETWEEN 1 AND 64),
      sync_schema_version INTEGER NOT NULL CHECK (sync_schema_version > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      enrollment_idempotency_key TEXT NOT NULL UNIQUE,
      enrollment_request_sha256 TEXT NOT NULL CHECK (length(enrollment_request_sha256) = 64),
      enrollment_grant_sha256 TEXT NOT NULL CHECK (length(enrollment_grant_sha256) = 64),
      enrollment_origin_sha256 TEXT NOT NULL CHECK (length(enrollment_origin_sha256) = 64),
      enrolled_at INTEGER NOT NULL CHECK (enrolled_at >= 0),
      expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > enrolled_at),
      revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= enrolled_at),
      last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= enrolled_at),
      last_published_at INTEGER CHECK (last_published_at IS NULL OR last_published_at >= enrolled_at),
      last_published_state_vector_sha256 TEXT CHECK (
        last_published_state_vector_sha256 IS NULL OR length(last_published_state_vector_sha256) = 64
      ),
      last_published_credential_id TEXT,
      last_published_sequence INTEGER CHECK (
        last_published_sequence IS NULL OR last_published_sequence > 0
      ),
      FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_devices_vault_status_idx
      ON source_devices (vault_id, status, enrolled_at);
    CREATE UNIQUE INDEX IF NOT EXISTS source_devices_active_root_idx
      ON source_devices (vault_id, root_fingerprint_sha256)
      WHERE status = 'active';`),
  );
  await addColumnIfMissing(
    "source_devices",
    "last_published_sequence",
    `ALTER TABLE source_devices ADD COLUMN last_published_sequence INTEGER
     CHECK (last_published_sequence IS NULL OR last_published_sequence > 0)`,
  );
  await addColumnIfMissing(
    "vault_credentials",
    "source_device_id",
    `ALTER TABLE vault_credentials ADD COLUMN source_device_id TEXT
     REFERENCES source_devices (id) ON DELETE RESTRICT`,
  );
  await db.exec(
    executableMigration(`CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_source_device_active_idx
      ON vault_credentials (source_device_id)
      WHERE source_device_id IS NOT NULL AND revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS quarantined_source_devices (
      portable_id TEXT PRIMARY KEY NOT NULL,
      restore_id TEXT,
      target_vault_id TEXT NOT NULL,
      source_vault_id TEXT,
      body_json TEXT NOT NULL CHECK (json_valid(body_json)),
      body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
      restored_at INTEGER NOT NULL CHECK (restored_at >= 0),
      authority_restored INTEGER NOT NULL DEFAULT 0 CHECK (authority_restored = 0),
      credential_restored INTEGER NOT NULL DEFAULT 0 CHECK (credential_restored = 0),
      connection_restored INTEGER NOT NULL DEFAULT 0 CHECK (connection_restored = 0),
      FOREIGN KEY (target_vault_id) REFERENCES vaults (id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS quarantined_source_devices_target_idx
      ON quarantined_source_devices (target_vault_id, restored_at);`),
  );
  await addColumnIfMissing(
    "quarantined_source_devices",
    "restore_id",
    `ALTER TABLE quarantined_source_devices ADD COLUMN restore_id TEXT`,
  );
}

async function storedSourceDescriptor(
  input: PairingExchangeRequest["sourceDescriptor"],
  now: number,
): Promise<SourceDescriptor | null> {
  if (input === undefined) return null;
  const descriptorInput = sourceDescriptorInputSchema.parse(input);
  const canonical = JSON.stringify({
    sourceKind: descriptorInput.sourceKind,
    label: descriptorInput.label,
    capabilities: descriptorInput.capabilities,
    clientVersion: descriptorInput.clientVersion,
    syncSchemaVersion: descriptorInput.syncSchemaVersion,
  });
  const descriptorSha256 = await sha256Hex(canonical);
  return sourceDescriptorSchema.parse({
    ...descriptorInput,
    descriptorVersion: 1,
    provenance: { pairedAt: now, descriptorSha256 },
  });
}

interface DeviceGrantRow {
  vault_id: string;
  vault_status: "active" | "pending" | "revoked";
  device_enrollment: number;
  device_expires_at: number | null;
  source_boundary_json: string | null;
  source_boundary_sha256: string | null;
  source_descriptor_json: string | null;
}

async function exchangeSourceDeviceGrant(
  db: D1Database,
  input: PairingExchangeRequest & {
    deploymentUrl: string;
    now: number;
    requestId: string;
  },
  enrollment: SourceDeviceEnrollment,
  descriptor: SourceDescriptor | null,
  grantHash: string,
): Promise<SourceDevicePairingExchangeResponse | null> {
  const boundary = await verifySourceBoundary(enrollment.boundary);
  const originSha256 = await sha256Hex(input.deploymentUrl);
  const requestSha256 = await sha256Hex(
    JSON.stringify({
      grantSha256: grantHash,
      originSha256,
      vaultName: input.vaultName,
      pluginVersion: input.pluginVersion,
      schemaVersion: input.schemaVersion,
      sourceDescriptor: input.sourceDescriptor,
      sourceDevice: enrollment,
    }),
  );
  const replay = await readSourceDeviceByEnrollmentKey(
    db,
    enrollment.idempotencyKey,
    input.now,
  );
  if (replay !== null) {
    if (
      replay.grantSha256 !== grantHash ||
      replay.originSha256 !== originSha256 ||
      replay.requestSha256 !== requestSha256
    ) {
      throw new SourceDeviceError("idempotency_conflict");
    }
    return {
      credentialAccepted: true,
      deploymentUrl: input.deploymentUrl,
      serverVersion: SERVER_VERSION,
      sourceDevice: replay.summary,
      supportedSchemaVersions: {
        min: SERVER_MIN_SCHEMA_VERSION,
        max: SERVER_MAX_SCHEMA_VERSION,
      },
      vaultId: replay.vaultId,
    };
  }

  const grant = await db
    .prepare(
      `SELECT grants.vault_id, vault.status AS vault_status,
        grants.device_enrollment, grants.device_expires_at,
        vault.source_boundary_json, vault.source_boundary_sha256,
        vault.source_descriptor_json
       FROM pairing_grants grants
       JOIN pairing_grant_origins origins
         ON origins.grant_hash = grants.grant_hash
       JOIN vaults vault ON vault.id = grants.vault_id
       WHERE grants.grant_hash = ?
         AND origins.deployment_origin = ?
         AND grants.used_at IS NULL
         AND grants.expires_at > ?`,
    )
    .bind(grantHash, input.deploymentUrl, input.now)
    .first<DeviceGrantRow>();
  if (grant === null || grant.vault_status === "revoked") return null;
  if (grant.vault_status === "active" && grant.device_enrollment !== 1) {
    throw new SourceDeviceError("source_device_denied");
  }
  if (
    descriptor === null ||
    descriptor.sourceKind !== boundary.sourceKind ||
    JSON.stringify(descriptor.capabilities) !==
      JSON.stringify(boundary.capabilities)
  ) {
    throw new SourceDeviceError("source_boundary_mismatch");
  }
  if (grant.source_descriptor_json !== null) {
    let storedDescriptor: SourceDescriptor;
    try {
      storedDescriptor = sourceDescriptorSchema.parse(
        JSON.parse(grant.source_descriptor_json) as unknown,
      );
    } catch {
      throw new SourceDeviceError("source_boundary_invalid");
    }
    if (
      storedDescriptor.sourceKind !== descriptor.sourceKind ||
      JSON.stringify(storedDescriptor.capabilities) !==
        JSON.stringify(descriptor.capabilities)
    ) {
      throw new SourceDeviceError("source_boundary_mismatch");
    }
  }
  if (
    grant.source_boundary_sha256 !== null &&
    grant.source_boundary_sha256 !== boundary.boundarySha256
  ) {
    throw new SourceDeviceError("source_boundary_mismatch");
  }
  if (grant.source_boundary_json !== null) {
    let storedBoundary: unknown;
    try {
      storedBoundary = JSON.parse(grant.source_boundary_json);
    } catch {
      throw new SourceDeviceError("source_boundary_invalid");
    }
    if (!sourceDescriptorSchema.safeParse(descriptor).success) {
      throw new SourceDeviceError("source_boundary_invalid");
    }
    const parsedStored = await verifySourceBoundary(
      storedBoundary as SourceDeviceEnrollment["boundary"],
    );
    if (parsedStored.boundarySha256 !== boundary.boundarySha256) {
      throw new SourceDeviceError("source_boundary_mismatch");
    }
  }

  const exchangeId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const boundaryJson = JSON.stringify(boundary);
  const deviceConflict = await db
    .prepare(
      `SELECT id FROM source_devices
       WHERE id = ? OR enrollment_idempotency_key = ?`,
    )
    .bind(enrollment.deviceId, enrollment.idempotencyKey)
    .first<{ id: string }>();
  if (deviceConflict !== null) {
    throw new SourceDeviceError("source_device_conflict");
  }
  const historyCount = await db
    .prepare(`SELECT COUNT(*) AS count FROM source_devices WHERE vault_id = ?`)
    .bind(grant.vault_id)
    .first<{ count: number }>();
  if ((historyCount?.count ?? 0) >= 64) {
    throw new SourceDeviceError("source_device_limit");
  }

  let results: D1Result<{ vault_id: string }>[];
  try {
    results = await db.batch<{ vault_id: string }>([
      db
        .prepare(
          `UPDATE pairing_grants
           SET used_at = ?, exchange_id = ?
           WHERE grant_hash = ? AND used_at IS NULL AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM vaults vault
               WHERE vault.id = pairing_grants.vault_id
                 AND vault.status != 'revoked'
                 AND (vault.source_boundary_sha256 IS NULL OR vault.source_boundary_sha256 = ?)
             )
             AND NOT EXISTS (
               SELECT 1 FROM source_devices device
               WHERE device.id = ? OR device.enrollment_idempotency_key = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM source_devices device
               WHERE device.vault_id = pairing_grants.vault_id
                 AND device.root_fingerprint_sha256 = ?
                 AND device.status = 'active'
             )
             AND (
               SELECT COUNT(*) FROM source_devices device
               WHERE device.vault_id = pairing_grants.vault_id
             ) < 64
             AND (
               SELECT COUNT(*) FROM source_devices device
               WHERE device.vault_id = pairing_grants.vault_id
                 AND device.status = 'active'
                 AND (device.expires_at IS NULL OR device.expires_at > ?)
             ) < 16
             AND EXISTS (
               SELECT 1 FROM pairing_grant_origins origins
               WHERE origins.grant_hash = pairing_grants.grant_hash
                 AND origins.deployment_origin = ?
             )
           RETURNING vault_id`,
        )
        .bind(
          input.now,
          exchangeId,
          grantHash,
          input.now,
          boundary.boundarySha256,
          enrollment.deviceId,
          enrollment.idempotencyKey,
          enrollment.rootFingerprintSha256,
          input.now,
          input.deploymentUrl,
        ),
      db
        .prepare(
          `INSERT INTO source_devices (
            id, vault_id, display_name, root_fingerprint_sha256,
            boundary_json, boundary_sha256, client_version,
            sync_schema_version, enrollment_idempotency_key,
            enrollment_request_sha256, enrollment_grant_sha256,
            enrollment_origin_sha256, enrolled_at, expires_at
          )
          SELECT ?, grants.vault_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, grants.device_expires_at
          FROM pairing_grants grants
          JOIN vaults vault ON vault.id = grants.vault_id
          WHERE grant_hash = ? AND exchange_id = ?
            AND (vault.source_boundary_sha256 IS NULL OR vault.source_boundary_sha256 = ?)
            AND (
              SELECT COUNT(*) FROM source_devices
              WHERE source_devices.vault_id = grants.vault_id
                AND source_devices.status = 'active'
                AND (
                  source_devices.expires_at IS NULL
                  OR source_devices.expires_at > ?
                )
            ) < 16
          RETURNING vault_id`,
        )
        .bind(
          enrollment.deviceId,
          enrollment.displayName,
          enrollment.rootFingerprintSha256,
          boundaryJson,
          boundary.boundarySha256,
          input.pluginVersion,
          input.schemaVersion,
          enrollment.idempotencyKey,
          requestSha256,
          grantHash,
          originSha256,
          input.now,
          grantHash,
          exchangeId,
          boundary.boundarySha256,
          input.now,
        ),
      db
        .prepare(
          `INSERT INTO vault_credentials (
            id, vault_id, token_hash, plugin_version, schema_version,
            created_at, source_device_id
          )
          SELECT ?, vault_id, ?, ?, ?, ?, ?
          FROM pairing_grants
          WHERE grant_hash = ? AND exchange_id = ?
            AND EXISTS (
              SELECT 1 FROM source_devices device
              WHERE device.id = ? AND device.vault_id = pairing_grants.vault_id
            )
          RETURNING vault_id`,
        )
        .bind(
          credentialId,
          enrollment.credentialSha256,
          input.pluginVersion,
          input.schemaVersion,
          input.now,
          enrollment.deviceId,
          grantHash,
          exchangeId,
          enrollment.deviceId,
        ),
      db
        .prepare(
          `UPDATE vaults
           SET display_name = COALESCE(display_name, ?),
               status = 'active', paired_at = COALESCE(paired_at, ?),
               source_descriptor_json = COALESCE(source_descriptor_json, ?),
               source_boundary_json = COALESCE(source_boundary_json, ?),
               source_boundary_sha256 = COALESCE(source_boundary_sha256, ?)
           WHERE id = ?
             AND (source_boundary_sha256 IS NULL OR source_boundary_sha256 = ?)
           RETURNING id AS vault_id`,
        )
        .bind(
          input.vaultName,
          input.now,
          descriptor === null ? null : JSON.stringify(descriptor),
          boundaryJson,
          boundary.boundarySha256,
          grant.vault_id,
          boundary.boundarySha256,
        ),
      db
        .prepare(
          `INSERT INTO audit_events (id, event_type, request_id, created_at)
           SELECT ?, 'source.device_enrolled', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM source_devices WHERE id = ? AND vault_id = ?
           )`,
        )
        .bind(
          crypto.randomUUID(),
          input.requestId,
          input.now,
          enrollment.deviceId,
          grant.vault_id,
        ),
    ]);
  } catch (error) {
    if (error instanceof SourceDeviceError) throw error;
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      throw new SourceDeviceError("source_device_conflict");
    }
    throw error;
  }
  if (
    results[0]?.results[0]?.vault_id !== grant.vault_id ||
    results[1]?.results[0]?.vault_id !== grant.vault_id ||
    results[2]?.results[0]?.vault_id !== grant.vault_id ||
    results[3]?.results[0]?.vault_id !== grant.vault_id
  ) {
    const racedReplay = await readSourceDeviceByEnrollmentKey(
      db,
      enrollment.idempotencyKey,
      input.now,
    );
    if (racedReplay === null) return null;
    if (
      racedReplay.vaultId !== grant.vault_id ||
      racedReplay.grantSha256 !== grantHash ||
      racedReplay.originSha256 !== originSha256 ||
      racedReplay.requestSha256 !== requestSha256
    ) {
      throw new SourceDeviceError("idempotency_conflict");
    }
    return {
      credentialAccepted: true,
      deploymentUrl: input.deploymentUrl,
      serverVersion: SERVER_VERSION,
      sourceDevice: racedReplay.summary,
      supportedSchemaVersions: {
        min: SERVER_MIN_SCHEMA_VERSION,
        max: SERVER_MAX_SCHEMA_VERSION,
      },
      vaultId: racedReplay.vaultId,
    };
  }
  const enrolled = await readSourceDeviceByEnrollmentKey(
    db,
    enrollment.idempotencyKey,
    input.now,
  );
  if (enrolled === null) return null;
  return {
    credentialAccepted: true,
    deploymentUrl: input.deploymentUrl,
    serverVersion: SERVER_VERSION,
    sourceDevice: enrolled.summary,
    supportedSchemaVersions: {
      min: SERVER_MIN_SCHEMA_VERSION,
      max: SERVER_MAX_SCHEMA_VERSION,
    },
    vaultId: grant.vault_id,
  };
}

export async function createPairingGrant(
  db: D1Database,
  input: {
    deploymentUrl: string;
    now: number;
    requestId: string;
    maxVaults?: number;
    vaultId?: string;
    deviceEnrollment?: boolean;
    deviceExpiresAt?: number;
  },
): Promise<PairingGrantResponse | null> {
  const vaultId = input.vaultId ?? crypto.randomUUID();
  if (input.vaultId !== undefined) {
    const existing = await db
      .prepare(`SELECT id FROM vaults WHERE id = ? AND status = 'active'`)
      .bind(vaultId)
      .first<{ id: string }>();
    if (existing?.id !== vaultId) return null;
  }
  const grant = randomToken();
  const grantHash = await sha256Hex(grant);
  const expiresAt = input.now + PAIRING_GRANT_LIFETIME_SECONDS;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `DELETE FROM pairing_grants
         WHERE expires_at <= ? OR used_at IS NOT NULL`,
      )
      .bind(input.now),
    db.prepare(
      `DELETE FROM vaults
       WHERE status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM pairing_grants grants
           WHERE grants.vault_id = vaults.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM vault_credentials credentials
           WHERE credentials.vault_id = vaults.id
         )`,
    ),
  ];
  if (input.vaultId === undefined) {
    statements.push(
      input.maxVaults === undefined
        ? db
            .prepare(
              `INSERT INTO vaults (id, status, created_at)
               VALUES (?, 'pending', ?)`,
            )
            .bind(vaultId, input.now)
        : db
            .prepare(
              `INSERT INTO vaults (id, status, created_at)
               SELECT ?, 'pending', ?
               WHERE (
                 SELECT COUNT(*) FROM vaults
                 WHERE status IN ('active', 'pending')
               ) < ?`,
            )
            .bind(vaultId, input.now, input.maxVaults),
    );
  }
  const grantStatementIndex = statements.length;
  statements.push(
    db
      .prepare(
        `INSERT INTO pairing_grants (
          grant_hash, vault_id, created_at, expires_at,
          device_enrollment, device_expires_at
        )
        SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM vaults WHERE id = ?)
        RETURNING vault_id`,
      )
      .bind(
        grantHash,
        vaultId,
        input.now,
        expiresAt,
        input.deviceEnrollment === true ? 1 : 0,
        input.deviceExpiresAt ?? null,
        vaultId,
      ),
    db
      .prepare(
        `INSERT INTO pairing_grant_origins (grant_hash, deployment_origin)
         SELECT ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pairing_grants WHERE grant_hash = ?
         )`,
      )
      .bind(grantHash, input.deploymentUrl, grantHash),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.pairing_grant_created', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM pairing_grants WHERE grant_hash = ?
         )`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, grantHash),
  );
  const results = await db.batch<{ vault_id: string }>(statements);
  if (results[grantStatementIndex]?.results[0]?.vault_id !== vaultId) {
    return null;
  }

  const pairingUrl = new URL("mdevolved://connect");
  pairingUrl.searchParams.set("deployment", input.deploymentUrl);
  pairingUrl.searchParams.set("grant", grant);
  const obsidianUrl = new URL("obsidian://mdevolved-pair");
  obsidianUrl.searchParams.set("deployment", input.deploymentUrl);
  obsidianUrl.searchParams.set("grant", grant);
  const legacyPairingUrl = new URL("owd-pair://connect");
  legacyPairingUrl.searchParams.set("deployment", input.deploymentUrl);
  legacyPairingUrl.searchParams.set("grant", grant);
  const legacyObsidianUrl = new URL("obsidian://owd-pair");
  legacyObsidianUrl.searchParams.set("deployment", input.deploymentUrl);
  legacyObsidianUrl.searchParams.set("grant", grant);

  return {
    vaultId,
    pairingUrl: pairingUrl.toString(),
    obsidianUrl: obsidianUrl.toString(),
    legacyPairingUrl: legacyPairingUrl.toString(),
    legacyObsidianUrl: legacyObsidianUrl.toString(),
    expiresAt,
  };
}

export async function exchangePairingGrant(
  db: D1Database,
  input: PairingExchangeRequest & {
    deploymentUrl: string;
    now: number;
    requestId: string;
  },
): Promise<
  PairingExchangeResponse | SourceDevicePairingExchangeResponse | null
> {
  const descriptor = await storedSourceDescriptor(
    input.sourceDescriptor,
    input.now,
  );
  const descriptorJson =
    descriptor === null ? null : JSON.stringify(descriptor);
  const [grantHash, tokenHash] = await Promise.all([
    sha256Hex(input.grant),
    (async () => {
      const token = randomToken();
      return { token, hash: await sha256Hex(token) };
    })(),
  ]);
  if (input.sourceDevice !== undefined) {
    return exchangeSourceDeviceGrant(
      db,
      input,
      input.sourceDevice,
      descriptor,
      grantHash,
    );
  }
  const currentVault = await db
    .prepare(
      `SELECT v.source_descriptor_json
       FROM pairing_grants grants
       JOIN vaults v ON v.id = grants.vault_id
       JOIN pairing_grant_origins origins
         ON origins.grant_hash = grants.grant_hash
       WHERE grants.grant_hash = ?
         AND origins.deployment_origin = ?
         AND grants.used_at IS NULL
         AND grants.expires_at > ?`,
    )
    .bind(grantHash, input.deploymentUrl, input.now)
    .first<{ source_descriptor_json: string | null }>();
  if (currentVault === null) return null;
  if (currentVault.source_descriptor_json !== null && descriptor !== null) {
    let existing: SourceDescriptor;
    try {
      existing = sourceDescriptorSchema.parse(
        JSON.parse(currentVault.source_descriptor_json) as unknown,
      );
    } catch {
      return null;
    }
    if (
      existing.provenance.descriptorSha256 !==
      descriptor.provenance.descriptorSha256
    ) {
      return null;
    }
  }
  const exchangeId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const results = await db.batch<{ vault_id: string }>([
    db
      .prepare(
        `UPDATE pairing_grants
         SET used_at = ?, exchange_id = ?
         WHERE grant_hash = ?
           AND used_at IS NULL
           AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM pairing_grant_origins origins
             WHERE origins.grant_hash = pairing_grants.grant_hash
               AND origins.deployment_origin = ?
           )
           AND EXISTS (
             SELECT 1 FROM vaults source_vault
             WHERE source_vault.id = pairing_grants.vault_id
               AND (
                 source_vault.source_descriptor_json IS NULL
                 OR ? IS NULL
                 OR json_extract(
                   source_vault.source_descriptor_json,
                   '$.provenance.descriptorSha256'
                 ) = ?
               )
           )
         RETURNING vault_id`,
      )
      .bind(
        input.now,
        exchangeId,
        grantHash,
        input.now,
        input.deploymentUrl,
        descriptor?.provenance.descriptorSha256 ?? null,
        descriptor?.provenance.descriptorSha256 ?? null,
      ),
    db
      .prepare(
        `INSERT INTO vault_credentials (
          id, vault_id, token_hash, plugin_version, schema_version, created_at
        )
        SELECT ?, vault_id, ?, ?, ?, ?
        FROM pairing_grants
        WHERE grant_hash = ? AND exchange_id = ?`,
      )
      .bind(
        credentialId,
        tokenHash.hash,
        input.pluginVersion,
        input.schemaVersion,
        input.now,
        grantHash,
        exchangeId,
      ),
    db
      .prepare(
        `UPDATE vaults
         SET display_name = ?, status = 'active', paired_at = ?,
             source_descriptor_json = COALESCE(source_descriptor_json, ?)
         WHERE id = (
           SELECT vault_id FROM pairing_grants
           WHERE grant_hash = ? AND exchange_id = ?
         )`,
      )
      .bind(input.vaultName, input.now, descriptorJson, grantHash, exchangeId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.paired', ?, ?
         FROM pairing_grants
         WHERE grant_hash = ? AND exchange_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        grantHash,
        exchangeId,
      ),
    db
      .prepare(
        `INSERT INTO vault_sync_states (
          vault_id, credential_id, plugin_version, schema_version,
          library_stale, updated_at
        )
        SELECT vault_id, ?, ?, ?, 1, ?
        FROM pairing_grants
        WHERE grant_hash = ? AND exchange_id = ?
        ON CONFLICT(vault_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          plugin_version = excluded.plugin_version,
          schema_version = excluded.schema_version,
          connection_confirmed_at = NULL,
          initial_sync_at = NULL,
          last_sync_at = NULL,
          current_state_vector_sha256 = NULL,
          library_stale = 1,
          last_error_code = NULL,
          last_error_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .bind(
        credentialId,
        input.pluginVersion,
        input.schemaVersion,
        input.now,
        grantHash,
        exchangeId,
      ),
  ]);

  const vaultId = results[0]?.results[0]?.vault_id;
  if (!vaultId) return null;

  return {
    credential: tokenHash.token,
    deploymentUrl: input.deploymentUrl,
    serverVersion: SERVER_VERSION,
    supportedSchemaVersions: {
      min: SERVER_MIN_SCHEMA_VERSION,
      max: SERVER_MAX_SCHEMA_VERSION,
    },
    vaultId,
  };
}

export async function readVaultCredential(
  db: D1Database,
  vaultId: string,
  tokenHash: string,
): Promise<VaultCredentialRecord | null> {
  return db
    .prepare(
      `SELECT c.id, c.token_hash, c.vault_id, c.plugin_version,
        c.schema_version, c.created_at, c.source_device_id
       FROM vault_credentials c
       JOIN vaults v ON v.id = c.vault_id
       WHERE c.vault_id = ?
         AND c.token_hash = ?
         AND c.revoked_at IS NULL
         AND (
           c.source_device_id IS NULL OR EXISTS (
             SELECT 1 FROM source_devices device
             WHERE device.id = c.source_device_id
               AND device.vault_id = c.vault_id
               AND device.status = 'active'
               AND (device.expires_at IS NULL OR device.expires_at > ?)
           )
         )
         AND v.status = 'active'`,
    )
    .bind(vaultId, tokenHash, Math.floor(Date.now() / 1_000))
    .first<VaultCredentialRecord>();
}

export async function readVaultSourceDescriptor(
  db: D1Database,
  vaultId: string,
): Promise<SourceDescriptor | null> {
  const row = await db
    .prepare(
      `SELECT source_descriptor_json
       FROM vaults WHERE id = ?`,
    )
    .bind(vaultId)
    .first<{ source_descriptor_json: string | null }>();
  if (
    row?.source_descriptor_json === undefined ||
    row.source_descriptor_json === null
  ) {
    return null;
  }
  try {
    return sourceDescriptorSchema.parse(
      JSON.parse(row.source_descriptor_json) as unknown,
    );
  } catch {
    return null;
  }
}

export async function readVaultCredentialById(
  db: D1Database,
  vaultId: string,
  credentialId: string,
): Promise<VaultCredentialRecord | null> {
  return db
    .prepare(
      `SELECT c.id, c.token_hash, c.vault_id, c.plugin_version,
        c.schema_version, c.created_at, c.source_device_id
       FROM vault_credentials c
       JOIN vaults v ON v.id = c.vault_id
       WHERE c.vault_id = ?
         AND c.id = ?
         AND c.revoked_at IS NULL
         AND (
           c.source_device_id IS NULL OR EXISTS (
             SELECT 1 FROM source_devices device
             WHERE device.id = c.source_device_id
               AND device.vault_id = c.vault_id
               AND device.status = 'active'
               AND (device.expires_at IS NULL OR device.expires_at > ?)
           )
         )
         AND v.status = 'active'`,
    )
    .bind(vaultId, credentialId, Math.floor(Date.now() / 1_000))
    .first<VaultCredentialRecord>();
}

export async function markVaultConnected(
  db: D1Database,
  credentialId: string,
  vaultId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE vault_credentials
         SET last_used_at = ?
         WHERE id = ? AND vault_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, credentialId, vaultId),
    db
      .prepare(
        `UPDATE vaults
         SET last_connected_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .bind(now, vaultId),
    db
      .prepare(
        `INSERT INTO vault_sync_states (
          vault_id, credential_id, plugin_version, schema_version,
          connection_confirmed_at, library_stale, updated_at
        )
        SELECT c.vault_id, c.id, c.plugin_version, c.schema_version, ?, 1, ?
        FROM vault_credentials c
        WHERE c.id = ? AND c.vault_id = ? AND c.revoked_at IS NULL
        ON CONFLICT(vault_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          plugin_version = excluded.plugin_version,
          schema_version = excluded.schema_version,
          connection_confirmed_at = excluded.connection_confirmed_at,
          updated_at = excluded.updated_at`,
      )
      .bind(now, now, credentialId, vaultId),
    db
      .prepare(
        `UPDATE source_devices
         SET last_seen_at = ?
         WHERE id = (
           SELECT source_device_id FROM vault_credentials
           WHERE id = ? AND vault_id = ? AND revoked_at IS NULL
         )
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(now, credentialId, vaultId, now),
  ]);
}

export async function confirmVaultSync(
  db: D1Database,
  input: {
    credential: VaultCredentialRecord;
    now: number;
    pluginVersion: string;
    requestId: string;
    runtimeProfile?: ObsidianMindRuntimeProfile;
    schemaVersion: number;
    stateVectorSha256: string;
    vaultId: string;
  },
): Promise<boolean> {
  const runtimeProfileProvided = input.runtimeProfile !== undefined ? 1 : 0;
  const runtimeProfileJson =
    input.runtimeProfile === undefined
      ? null
      : JSON.stringify(
          obsidianMindRuntimeProfileSchema.parse(input.runtimeProfile),
        );
  const results = await db.batch<{ vault_id: string }>([
    db
      .prepare(
        `UPDATE vault_credentials
         SET plugin_version = ?, schema_version = ?, last_used_at = ?
         WHERE id = ? AND vault_id = ? AND revoked_at IS NULL
         RETURNING vault_id`,
      )
      .bind(
        input.pluginVersion,
        input.schemaVersion,
        input.now,
        input.credential.id,
        input.vaultId,
      ),
    db
      .prepare(
        `INSERT INTO vault_sync_states (
          vault_id, credential_id, plugin_version, schema_version,
          connection_confirmed_at, initial_sync_at, last_sync_at,
          current_state_vector_sha256, library_stale, runtime_profile_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(vault_id) DO UPDATE SET
          credential_id = excluded.credential_id,
          plugin_version = excluded.plugin_version,
          schema_version = excluded.schema_version,
          connection_confirmed_at = COALESCE(
            vault_sync_states.connection_confirmed_at,
            excluded.connection_confirmed_at
          ),
          initial_sync_at = COALESCE(
            vault_sync_states.initial_sync_at,
            excluded.initial_sync_at
          ),
          last_sync_at = excluded.last_sync_at,
          current_state_vector_sha256 = excluded.current_state_vector_sha256,
          runtime_profile_json = CASE
            WHEN ? = 1 THEN excluded.runtime_profile_json
            ELSE vault_sync_states.runtime_profile_json
          END,
          library_stale = CASE
            WHEN ? = 1
              AND vault_sync_states.runtime_profile_json
                IS NOT excluded.runtime_profile_json
            THEN 1
            WHEN vault_sync_states.current_state_vector_sha256
              = excluded.current_state_vector_sha256
              AND vault_sync_states.library_stale = 0
            THEN 0
            ELSE 1
          END,
          last_error_code = NULL,
          last_error_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .bind(
        input.vaultId,
        input.credential.id,
        input.pluginVersion,
        input.schemaVersion,
        input.now,
        input.now,
        input.now,
        input.stateVectorSha256,
        runtimeProfileJson,
        input.now,
        runtimeProfileProvided,
        runtimeProfileProvided,
      ),
    db
      .prepare(
        `UPDATE vault_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE vault_id = ? AND id != ? AND revoked_at IS NULL
           AND created_at < ?
           AND ? IS NULL`,
      )
      .bind(
        input.now,
        input.vaultId,
        input.credential.id,
        input.credential.created_at,
        input.credential.source_device_id,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.initial_sync_confirmed', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM vault_credentials
           WHERE id = ? AND vault_id = ? AND revoked_at IS NULL
         )`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        input.credential.id,
        input.vaultId,
      ),
  ]);

  const confirmed = results[0]?.results[0]?.vault_id === input.vaultId;
  if (!confirmed) return false;
  if (input.credential.source_device_id === null) return true;
  return markSourceDevicePublished(db, {
    credentialId: input.credential.id,
    deviceId: input.credential.source_device_id,
    now: input.now,
    requestId: input.requestId,
    stateVectorSha256: input.stateVectorSha256,
    vaultId: input.vaultId,
  });
}

export async function listVaults(db: D1Database): Promise<VaultSummary[]> {
  const now = Math.floor(Date.now() / 1_000);
  const sourceDevices = await listAllSourceDevices(db, now);
  const result = await db
    .prepare(
      `SELECT id, display_name, status, created_at, paired_at,
        last_connected_at, sync.runtime_profile_json
       FROM vaults
       LEFT JOIN vault_sync_states sync ON sync.vault_id = vaults.id
       ORDER BY created_at DESC`,
    )
    .all<VaultSummaryRow & { runtime_profile_json: string | null }>();

  return result.results.map((row) => {
    let parsedProfile: ReturnType<
      typeof obsidianMindRuntimeProfileSchema.safeParse
    > | null = null;
    if (row.runtime_profile_json !== null) {
      try {
        parsedProfile = obsidianMindRuntimeProfileSchema.safeParse(
          JSON.parse(row.runtime_profile_json) as unknown,
        );
      } catch {
        parsedProfile = null;
      }
    }
    const runtimeProfile =
      parsedProfile !== null && parsedProfile.success
        ? parsedProfile.data
        : null;
    const devices = sourceDevices.get(row.id) ?? [];
    const lastPublisher =
      devices
        .filter((device) => device.lastPublishedAt !== null)
        .sort(
          (left, right) =>
            (right.lastPublishedAt ?? 0) - (left.lastPublishedAt ?? 0),
        )[0] ?? null;
    return {
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at,
      pairedAt: row.paired_at,
      lastConnectedAt: row.last_connected_at,
      ...(runtimeProfile === null ? {} : { runtimeProfile }),
      sourceDevices: devices,
      lastPublisher,
    };
  });
}

export async function revokeVault(
  db: D1Database,
  input: { now: number; requestId: string; vaultId: string },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE vaults
         SET status = 'revoked'
         WHERE id = ?
         RETURNING id`,
      )
      .bind(input.vaultId),
    db
      .prepare(
        `UPDATE vault_credentials
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE vault_id = ?`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `UPDATE source_devices
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE vault_id = ?`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'revoked', revoked_at = ?,
           claim_expires_at = NULL
         WHERE vault_id = ?
           AND status IN ('prepared', 'claiming')`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE status IN ('active', 'pending')
           AND source_agent_grant_id IN (
             SELECT id FROM agent_grants WHERE vault_id = ?
           )`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `UPDATE agent_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE vault_id = ? AND status IN ('active', 'pending')`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.revoked', ?, ?
         FROM vaults WHERE id = ?`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.vaultId),
  ]);

  return results[0]?.results[0]?.id === input.vaultId;
}
