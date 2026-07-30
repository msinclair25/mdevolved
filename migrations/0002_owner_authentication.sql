-- Prerequisite: a D1 binding named DB. This migration is deliberately
-- idempotent because the Worker can bootstrap it during first-run onboarding
-- before an operator applies the migration ledger.
--
-- Forward action: add the singleton owner credential, short-lived ceremony
-- challenges, hashed sessions, rate-limit counters, and redacted audit events.
--
-- Failure behavior: all statements are additive. Re-running the migration is
-- safe. A failed first-owner transaction rolls back without leaving a session.
--
-- Recovery: restore the D1 database from a pre-migration backup if the schema
-- itself is damaged. Never delete or rewrite a released migration file.

CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  webauthn_user_id TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_authenticated_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS auth_challenges (
  flow_hash TEXT PRIMARY KEY NOT NULL,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  webauthn_user_id TEXT,
  expected_origin TEXT NOT NULL,
  expected_rp_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx
  ON auth_challenges (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  owner_id INTEGER NOT NULL CHECK (owner_id = 1),
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (owner_id) REFERENCES owners (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (key_hash, action, bucket_start)
) STRICT;

CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx
  ON auth_rate_limits (updated_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS audit_events_created_idx
  ON audit_events (created_at);
