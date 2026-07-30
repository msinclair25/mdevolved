-- Prerequisite: 0002_owner_authentication.sql, 0003_vault_pairing.sql,
-- 0005_materialized_generations.sql, D1 binding DB, and OAuth KV binding
-- OAUTH_KV. This additive migration stores owner-approved, read-only agent
-- access policy. OAuth credentials remain hashed in OAUTH_KV; D1 is the
-- fail-closed authorization source checked again on every MCP tool call.
--
-- Authorization invariant: a grant names exactly one active vault, the single
-- vault.read scope, an exact MCP audience, and canonical folder prefixes. A
-- pending or revoked D1 grant cannot read data even if OAuth issuance or
-- cleanup is interrupted.
--
-- Recovery: roll application code back without dropping these tables. Existing
-- rows remain inert when the MCP route is absent. Re-running this migration is
-- safe and never broadens a grant.

CREATE TABLE IF NOT EXISTS oauth_consent_flows (
  flow_hash TEXT PRIMARY KEY NOT NULL,
  owner_session_hash TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  request_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  decision TEXT CHECK (decision IN ('approved', 'denied')),
  CHECK (expires_at > created_at),
  FOREIGN KEY (owner_session_hash) REFERENCES sessions (token_hash)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS oauth_consent_flows_expiry_idx
  ON oauth_consent_flows (expires_at);

CREATE TABLE IF NOT EXISTS agent_grants (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL DEFAULT 1 CHECK (owner_id = 1),
  oauth_client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_origin TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  audience TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  path_prefixes_json TEXT NOT NULL,
  path_key_prefixes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES owners (id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS agent_grants_owner_status_idx
  ON agent_grants (owner_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_grants_client_idx
  ON agent_grants (owner_id, oauth_client_id, status);

CREATE INDEX IF NOT EXISTS agent_grants_vault_idx
  ON agent_grants (vault_id, status);
