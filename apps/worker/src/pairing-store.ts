import pairingMigration from "../../../migrations/0003_vault_pairing.sql";
import pairingOriginMigration from "../../../migrations/0004_pairing_origin.sql";
import type {
  ObsidianMindRuntimeProfile,
  PairingExchangeRequest,
  PairingExchangeResponse,
  PairingGrantResponse,
  SourceDescriptor,
  VaultSummary,
} from "@owd/contracts";
import { obsidianMindRuntimeProfileSchema } from "@owd/contracts";
import {
  sourceDescriptorInputSchema,
  sourceDescriptorSchema,
} from "@owd/contracts";
import {
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  SERVER_VERSION,
} from "@owd/yaos-core";
import { randomToken, sha256Hex } from "./security";

const PAIRING_GRANT_LIFETIME_SECONDS = 10 * 60;

export interface VaultCredentialRecord {
  created_at: number;
  id: string;
  plugin_version: string;
  schema_version: number;
  token_hash: string;
  vault_id: string;
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

export async function createPairingGrant(
  db: D1Database,
  input: {
    deploymentUrl: string;
    now: number;
    requestId: string;
    maxVaults?: number;
    vaultId?: string;
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
          grant_hash, vault_id, created_at, expires_at
        )
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM vaults WHERE id = ?)
        RETURNING vault_id`,
      )
      .bind(grantHash, vaultId, input.now, expiresAt, vaultId),
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

  const pairingUrl = new URL("owd-pair://connect");
  pairingUrl.searchParams.set("deployment", input.deploymentUrl);
  pairingUrl.searchParams.set("grant", grant);
  const obsidianUrl = new URL("obsidian://owd-pair");
  obsidianUrl.searchParams.set("deployment", input.deploymentUrl);
  obsidianUrl.searchParams.set("grant", grant);

  return {
    vaultId,
    pairingUrl: pairingUrl.toString(),
    obsidianUrl: obsidianUrl.toString(),
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
): Promise<PairingExchangeResponse | null> {
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
        c.schema_version, c.created_at
       FROM vault_credentials c
       JOIN vaults v ON v.id = c.vault_id
       WHERE c.vault_id = ?
         AND c.token_hash = ?
         AND c.revoked_at IS NULL
         AND v.status = 'active'`,
    )
    .bind(vaultId, tokenHash)
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
        c.schema_version, c.created_at
       FROM vault_credentials c
       JOIN vaults v ON v.id = c.vault_id
       WHERE c.vault_id = ?
         AND c.id = ?
         AND c.revoked_at IS NULL
         AND v.status = 'active'`,
    )
    .bind(vaultId, credentialId)
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
           AND created_at < ?`,
      )
      .bind(
        input.now,
        input.vaultId,
        input.credential.id,
        input.credential.created_at,
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

  return results[0]?.results[0]?.vault_id === input.vaultId;
}

export async function listVaults(db: D1Database): Promise<VaultSummary[]> {
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
    return {
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      createdAt: row.created_at,
      pairedAt: row.paired_at,
      lastConnectedAt: row.last_connected_at,
      ...(runtimeProfile === null ? {} : { runtimeProfile }),
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
