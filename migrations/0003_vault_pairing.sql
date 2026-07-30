-- Prerequisite: 0002_owner_authentication.sql and a D1 binding named DB.
-- This migration is idempotent because the Worker bootstraps the same additive
-- schema for terminal-free deployments.
--
-- Forward action: add vault registrations, single-use pairing grants, and
-- independently revocable hashed vault credentials.
--
-- Failure behavior: all objects are additive. Pairing exchange uses one D1
-- batch transaction, so a credential is never issued without consuming its
-- grant and activating the matching vault.
--
-- Recovery: roll application code back without dropping these tables. Existing
-- credentials remain hashed and inert while the Phase 3 sync route is closed.
-- Restore D1 from backup if the schema itself is damaged.

CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked')),
  created_at INTEGER NOT NULL,
  paired_at INTEGER,
  last_connected_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS vaults_status_idx ON vaults (status, created_at);

CREATE TABLE IF NOT EXISTS pairing_grants (
  grant_hash TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  exchange_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  CHECK (expires_at > created_at),
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS pairing_grants_vault_idx
  ON pairing_grants (vault_id, expires_at);

CREATE TABLE IF NOT EXISTS vault_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  plugin_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS vault_credentials_vault_idx
  ON vault_credentials (vault_id, revoked_at);
