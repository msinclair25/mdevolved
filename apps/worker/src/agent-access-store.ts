import agentAccessMigration from "../../../migrations/0006_agent_access.sql";
import {
  agentVaultScopesSchema,
  obsidianMindRuntimeProfileSchema,
  type AgentConnection,
  type AgentVaultScopes,
  type ObsidianMindRuntimeProfile,
  type RestoredSource,
} from "@owd/contracts";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { listPreparedProjectHandoffs } from "./prepared-project-handoff-store";
import { randomToken, sha256Hex } from "./security";

const CONSENT_LIFETIME_SECONDS = 10 * 60;
const OWNER_ID = 1;

const authRequestSchema = z
  .object({
    responseType: z.string().min(1).max(64),
    clientId: z.string().min(1).max(2_048),
    redirectUri: z.string().url().max(2_048),
    scope: z.array(z.string().min(1).max(128)).max(32),
    state: z.string().max(4_096),
    codeChallenge: z.string().min(1).max(256).optional(),
    codeChallengeMethod: z.string().min(1).max(32).optional(),
    resource: z
      .union([
        z.string().url().max(2_048),
        z.array(z.string().url().max(2_048)).max(8),
      ])
      .optional(),
  })
  .strict();

const storedPrefixesSchema = z.array(z.string().max(1_024)).max(32);

type ConsentFlowRow = {
  client_name: string;
  oauth_client_id: string;
  redirect_uri: string;
  request_json: string;
  project_initialization_request_id: string | null;
};

type AgentGrantRow = {
  activated_at: number | null;
  audience: string;
  client_name: string;
  client_origin: string;
  created_at: number;
  id: string;
  last_used_at: number | null;
  oauth_client_id: string;
  path_key_prefixes_json: string;
  path_prefixes_json: string;
  revoked_at: number | null;
  runtime_profile_json: string | null;
  scopes_json: string;
  status: "active" | "revoked";
  vault_id: string;
  vault_name: string;
};

export type StoredConsentFlow = {
  clientName: string;
  oauthClientId: string;
  redirectUri: string;
  request: AuthRequest;
  projectInitializationRequestId: string | null;
};

export type ActiveAgentGrant = {
  approvedRestoreIds: string[];
  audience: string;
  clientId: string;
  clientName: string;
  clientOrigin: string;
  id: string;
  pathKeyPrefixes: string[];
  pathPrefixes: string[];
  runtimeProfile: ObsidianMindRuntimeProfile | null;
  scopes: AgentVaultScopes;
  vaultId: string;
  vaultName: string;
};

type RestoredSourceRow = {
  applied_at: number;
  note_count: number;
  restore_id: string;
  source_vault_id: string;
  source_vault_name: string;
  target_vault_id: string;
};

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseRuntimeProfile(
  value: string | null,
): ObsidianMindRuntimeProfile | null {
  if (value === null) return null;
  try {
    const parsed = obsidianMindRuntimeProfileSchema.safeParse(parseJson(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function ensureAgentAccessSchema(db: D1Database): Promise<void> {
  const objects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'oauth_consent_flows',
         'oauth_consent_flows_expiry_idx',
         'agent_grants',
         'agent_grants_owner_status_idx',
         'agent_grants_client_idx',
         'agent_grants_vault_idx'
       )`,
    )
    .first<{ count: number }>();

  if (objects?.count !== 6) {
    await db.exec(executableMigration(agentAccessMigration));
  }
}

export async function createConsentFlow(
  db: D1Database,
  input: {
    clientName: string;
    now: number;
    ownerSessionHash: string;
    projectInitializationRequestId?: string;
    request: AuthRequest;
  },
): Promise<{ expiresAt: number; flowToken: string }> {
  const flowToken = randomToken();
  const flowHash = await sha256Hex(flowToken);
  const expiresAt = input.now + CONSENT_LIFETIME_SECONDS;

  await db.batch([
    db
      .prepare(
        `DELETE FROM oauth_consent_flows
         WHERE expires_at <= ? OR used_at IS NOT NULL`,
      )
      .bind(input.now),
    db
      .prepare(
        `INSERT INTO oauth_consent_flows (
          flow_hash, owner_session_hash, oauth_client_id, client_name,
          redirect_uri, request_json, created_at, expires_at,
          project_initialization_request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        flowHash,
        input.ownerSessionHash,
        input.request.clientId,
        input.clientName,
        input.request.redirectUri,
        JSON.stringify(input.request),
        input.now,
        expiresAt,
        input.projectInitializationRequestId ?? null,
      ),
  ]);

  return { expiresAt, flowToken };
}

export async function consumeConsentFlow(
  db: D1Database,
  input: {
    decision: "approved" | "denied";
    flowToken: string;
    now: number;
    ownerSessionHash: string;
  },
): Promise<StoredConsentFlow | null> {
  const row = await db
    .prepare(
      `UPDATE oauth_consent_flows
       SET used_at = ?, decision = ?
       WHERE flow_hash = ?
         AND owner_session_hash = ?
         AND used_at IS NULL
         AND expires_at > ?
       RETURNING oauth_client_id, client_name, redirect_uri, request_json,
         project_initialization_request_id`,
    )
    .bind(
      input.now,
      input.decision,
      await sha256Hex(input.flowToken),
      input.ownerSessionHash,
      input.now,
    )
    .first<ConsentFlowRow>();

  if (row === null) return null;
  return {
    clientName: row.client_name,
    oauthClientId: row.oauth_client_id,
    projectInitializationRequestId: row.project_initialization_request_id,
    redirectUri: row.redirect_uri,
    request: authRequestSchema.parse(parseJson(row.request_json)),
  };
}

export async function createPendingAgentGrant(
  db: D1Database,
  input: {
    audience: string;
    approvedRestoreIds: string[];
    clientName: string;
    now: number;
    oauthClientId: string;
    pathKeyPrefixes: string[];
    pathPrefixes: string[];
    redirectUri: string;
    requestId: string;
    scopes: AgentVaultScopes;
    vaultId: string;
  },
): Promise<string | null> {
  const grantId = crypto.randomUUID();
  const clientOrigin = new URL(input.redirectUri).origin;
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO agent_grants (
          id, owner_id, oauth_client_id, client_name, client_origin,
          redirect_uri, audience, vault_id, scopes_json,
          path_prefixes_json, path_key_prefixes_json, status, created_at
        )
        SELECT ?, 1, ?, ?, ?, ?, ?, id, ?, ?, ?, 'pending', ?
        FROM vaults WHERE id = ? AND status = 'active'
        RETURNING id`,
      )
      .bind(
        grantId,
        input.oauthClientId,
        input.clientName,
        clientOrigin,
        input.redirectUri,
        input.audience,
        JSON.stringify(input.scopes),
        JSON.stringify(input.pathPrefixes),
        JSON.stringify(input.pathKeyPrefixes),
        input.now,
        input.vaultId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'agent.authorization_started', ?, ?
         FROM vaults WHERE id = ? AND status = 'active'`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.vaultId),
    ...input.approvedRestoreIds.map((restoreId) =>
      db
        .prepare(
          `INSERT INTO agent_grant_restore_sources (
            grant_id, restore_id, approved_at
          )
          SELECT ?, jobs.id, ?
          FROM restore_jobs jobs
          WHERE jobs.id = ? AND jobs.target_vault_id = ?
            AND jobs.status = 'applied'`,
        )
        .bind(grantId, input.now, restoreId, input.vaultId),
    ),
  ]);

  return results[0]?.results[0]?.id === grantId ? grantId : null;
}

export async function activateAgentGrant(
  db: D1Database,
  input: { grantId: string; now: number; requestId: string },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE agent_grants
         SET status = 'active', activated_at = ?
         WHERE id = ? AND owner_id = 1 AND status = 'pending'
         RETURNING id`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `INSERT OR IGNORE INTO agent_grant_replacements (
          prior_grant_id, successor_grant_id, replaced_at
        )
        SELECT prior.id, successor.id, ?
        FROM agent_grants successor
        JOIN agent_grants prior
          ON prior.owner_id = successor.owner_id
         AND prior.oauth_client_id = successor.oauth_client_id
         AND prior.vault_id = successor.vault_id
         AND prior.id != successor.id
        WHERE successor.id = ? AND successor.owner_id = 1
          AND successor.status = 'active'
          AND prior.status = 'active'`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `UPDATE agent_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id != ? AND owner_id = 1 AND status = 'active'
           AND oauth_client_id = (
             SELECT oauth_client_id FROM agent_grants
             WHERE id = ? AND owner_id = 1 AND status = 'active'
           )
           AND vault_id = (
             SELECT vault_id FROM agent_grants
             WHERE id = ? AND owner_id = 1 AND status = 'active'
           )`,
      )
      .bind(input.now, input.grantId, input.grantId, input.grantId),
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'revoked', revoked_at = ?,
           claim_expires_at = NULL
         WHERE status IN ('prepared', 'claiming')
           AND agent_grant_id IN (
             SELECT prior.id
             FROM agent_grants successor
             JOIN agent_grants prior
               ON prior.owner_id = successor.owner_id
              AND prior.oauth_client_id = successor.oauth_client_id
              AND prior.vault_id = successor.vault_id
              AND prior.id != successor.id
             WHERE successor.id = ? AND successor.owner_id = 1
               AND successor.status = 'active'
               AND prior.status = 'revoked'
           )`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'agent.authorized', ?, ?
         FROM agent_grants WHERE id = ? AND status = 'active'`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.grantId),
  ]);
  return results[0]?.results[0]?.id === input.grantId;
}

function connectionFromRow(
  row: AgentGrantRow,
  approvedRestoredSources: RestoredSource[],
  preparedProjectHandoff: AgentConnection["preparedProjectHandoff"],
): AgentConnection {
  return {
    activatedAt: row.activated_at,
    approvedRestoredSources,
    clientId: row.oauth_client_id,
    clientName: row.client_name,
    clientOrigin: row.client_origin,
    createdAt: row.created_at,
    id: row.id,
    lastUsedAt: row.last_used_at,
    pathPrefixes: storedPrefixesSchema.parse(parseJson(row.path_prefixes_json)),
    preparedProjectHandoff,
    revokedAt: row.revoked_at,
    scopes: agentVaultScopesSchema.parse(parseJson(row.scopes_json)),
    status: row.status,
    vaultId: row.vault_id,
    vaultName: row.vault_name,
  };
}

const grantSelect = `SELECT grants.id, grants.oauth_client_id,
  grants.client_name, grants.client_origin, grants.audience, grants.vault_id,
  COALESCE(vaults.display_name, 'Unnamed vault') AS vault_name,
  grants.scopes_json, grants.path_prefixes_json,
  grants.path_key_prefixes_json, grants.status, grants.created_at,
  grants.activated_at, grants.revoked_at, grants.last_used_at,
  sync.runtime_profile_json
  FROM agent_grants grants
  JOIN vaults ON vaults.id = grants.vault_id
  LEFT JOIN vault_sync_states sync ON sync.vault_id = grants.vault_id`;

export async function listAgentConnections(
  db: D1Database,
): Promise<AgentConnection[]> {
  const rows = await db
    .prepare(
      `${grantSelect}
       WHERE grants.owner_id = 1 AND grants.status IN ('active', 'revoked')
       ORDER BY grants.created_at DESC LIMIT 1000`,
    )
    .all<AgentGrantRow>();
  const restored = await db
    .prepare(
      `SELECT approvals.grant_id, jobs.id AS restore_id,
        jobs.target_vault_id, jobs.source_vault_id, jobs.source_vault_name,
        jobs.applied_at, COUNT(lineage.path_key) AS note_count
       FROM agent_grant_restore_sources approvals
       JOIN agent_grants grants ON grants.id = approvals.grant_id
       JOIN restore_jobs jobs ON jobs.id = approvals.restore_id
       JOIN restored_note_lineage lineage ON lineage.restore_id = jobs.id
       WHERE grants.owner_id = 1 AND jobs.applied_at IS NOT NULL
       GROUP BY approvals.grant_id, jobs.id, jobs.target_vault_id,
        jobs.source_vault_id, jobs.source_vault_name, jobs.applied_at
       ORDER BY jobs.applied_at DESC, jobs.id DESC
       LIMIT 64000`,
    )
    .all<RestoredSourceRow & { grant_id: string }>();
  const byGrant = new Map<string, RestoredSource[]>();
  for (const source of restored.results) {
    const values = byGrant.get(source.grant_id) ?? [];
    values.push({
      appliedAt: source.applied_at,
      noteCount: source.note_count,
      restoreId: source.restore_id,
      sourceVaultId: source.source_vault_id,
      sourceVaultName: source.source_vault_name,
      targetVaultId: source.target_vault_id,
    });
    byGrant.set(source.grant_id, values);
  }
  const preparedProjectHandoffs = await listPreparedProjectHandoffs(db);
  return rows.results.map((row) =>
    connectionFromRow(
      row,
      byGrant.get(row.id) ?? [],
      preparedProjectHandoffs.get(row.id) ?? null,
    ),
  );
}

export async function readActiveAgentGrant(
  db: D1Database,
  input: { audience: string; clientId: string; grantId: string },
): Promise<ActiveAgentGrant | null> {
  const row = await db
    .prepare(
      `${grantSelect}
       WHERE grants.id = ? AND grants.owner_id = 1
         AND grants.oauth_client_id = ? AND grants.audience = ?
         AND grants.status = 'active' AND vaults.status = 'active'`,
    )
    .bind(input.grantId, input.clientId, input.audience)
    .first<AgentGrantRow>();
  if (row === null) return null;
  const runtimeProfile = parseRuntimeProfile(row.runtime_profile_json);
  if (row.runtime_profile_json !== null && runtimeProfile === null) {
    return null;
  }
  const approved = await db
    .prepare(
      `SELECT restore_id
       FROM agent_grant_restore_sources
       WHERE grant_id = ?
       ORDER BY restore_id`,
    )
    .bind(row.id)
    .all<{ restore_id: string }>();

  return {
    approvedRestoreIds: approved.results.map((value) => value.restore_id),
    audience: row.audience,
    clientId: row.oauth_client_id,
    clientName: row.client_name,
    clientOrigin: row.client_origin,
    id: row.id,
    pathKeyPrefixes: storedPrefixesSchema.parse(
      parseJson(row.path_key_prefixes_json),
    ),
    pathPrefixes: storedPrefixesSchema.parse(parseJson(row.path_prefixes_json)),
    runtimeProfile,
    scopes: agentVaultScopesSchema.parse(parseJson(row.scopes_json)),
    vaultId: row.vault_id,
    vaultName: row.vault_name,
  };
}

export async function listAppliedRestoredSources(
  db: D1Database,
): Promise<RestoredSource[]> {
  const rows = await db
    .prepare(
      `SELECT jobs.id AS restore_id, jobs.target_vault_id,
        jobs.source_vault_id, jobs.source_vault_name, jobs.applied_at,
        COUNT(lineage.path_key) AS note_count
       FROM restore_jobs jobs
       JOIN vaults ON vaults.id = jobs.target_vault_id
       JOIN restored_note_lineage lineage ON lineage.restore_id = jobs.id
       WHERE jobs.status = 'applied' AND jobs.applied_at IS NOT NULL
         AND vaults.status = 'active'
       GROUP BY jobs.id, jobs.target_vault_id, jobs.source_vault_id,
         jobs.source_vault_name, jobs.applied_at
       ORDER BY jobs.applied_at DESC, jobs.id DESC
       LIMIT 1000`,
    )
    .all<RestoredSourceRow>();
  return rows.results.map((row) => ({
    appliedAt: row.applied_at,
    noteCount: row.note_count,
    restoreId: row.restore_id,
    sourceVaultId: row.source_vault_id,
    sourceVaultName: row.source_vault_name,
    targetVaultId: row.target_vault_id,
  }));
}

export async function validateRestoredSourceSelection(
  db: D1Database,
  input: { restoreIds: string[]; vaultId: string },
): Promise<boolean> {
  if (input.restoreIds.length === 0) return true;
  const placeholders = input.restoreIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM restore_jobs
       WHERE target_vault_id = ? AND status = 'applied'
         AND id IN (${placeholders})`,
    )
    .bind(input.vaultId, ...input.restoreIds)
    .first<{ count: number }>();
  return row?.count === input.restoreIds.length;
}

export async function touchAgentGrant(
  db: D1Database,
  grantId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_grants SET last_used_at = ?
       WHERE id = ? AND owner_id = 1 AND status = 'active'`,
    )
    .bind(now, grantId)
    .run();
}

export async function revokeAgentGrant(
  db: D1Database,
  input: { grantId: string; now: number; requestId: string },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'revoked', revoked_at = ?,
           claim_expires_at = NULL
         WHERE agent_grant_id = ?
           AND status IN ('prepared', 'claiming')`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE source_agent_grant_id = ?
           AND status IN ('active', 'pending')`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `UPDATE agent_grants
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND owner_id = 1 AND status IN ('active', 'pending')
         RETURNING id`,
      )
      .bind(input.now, input.grantId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'agent.revoked', ?, ? FROM agent_grants
         WHERE id = ? AND status = 'revoked'`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.grantId),
  ]);
  return results[2]?.results[0]?.id === input.grantId;
}

export async function revokeAllAgentGrants(
  db: D1Database,
  input: { now: number; requestId: string },
): Promise<number> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'revoked', revoked_at = ?,
           claim_expires_at = NULL
         WHERE status IN ('prepared', 'claiming')`,
      )
      .bind(input.now),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE status IN ('active', 'pending')
           AND source_agent_grant_id IN (
             SELECT id FROM agent_grants
             WHERE owner_id = 1 AND status IN ('active', 'pending')
           )`,
      )
      .bind(input.now),
    db
      .prepare(
        `UPDATE agent_grants SET status = 'revoked', revoked_at = ?
         WHERE owner_id = 1 AND status IN ('active', 'pending') RETURNING id`,
      )
      .bind(input.now),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'agent.all_revoked', ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now),
  ]);
  return results[2]?.results.length ?? 0;
}

export const AGENT_OWNER_ID = OWNER_ID;
