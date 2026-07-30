-- Prerequisite: 0005_materialized_generations.sql plus D1 and R2 bindings
-- named DB and VAULT_STORAGE. This additive migration records only public
-- encryption recipients and metadata for immutable encrypted backup objects.
-- The matching age identity is generated and retained by the owner browser;
-- it must never be submitted to or stored by the Worker.
--
-- Publication invariant: an artifact starts in creating state and becomes
-- downloadable only after the encrypted R2 object has been written and its
-- stored size verified. A failed attempt never replaces a known-good backup.
--
-- Recovery: roll application code back without dropping these tables or R2
-- objects. Never delete the last ready artifact for a vault. Restore D1 from a
-- database backup if schema integrity is damaged.

CREATE TABLE IF NOT EXISTS backup_recipients (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  recipient TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS backup_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  format_version TEXT NOT NULL CHECK (format_version = 'owd-backup-v1'),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
  object_key TEXT NOT NULL UNIQUE,
  recipient_fingerprint TEXT NOT NULL,
  note_count INTEGER NOT NULL CHECK (note_count >= 0),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  ciphertext_bytes INTEGER,
  object_etag TEXT,
  object_version TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  verified_at INTEGER,
  failure_code TEXT,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE RESTRICT,
  FOREIGN KEY (generation_id) REFERENCES materialization_generations (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS backup_artifacts_vault_idx
  ON backup_artifacts (vault_id, created_at DESC);

CREATE INDEX IF NOT EXISTS backup_artifacts_status_idx
  ON backup_artifacts (status, created_at);

CREATE TABLE IF NOT EXISTS restore_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  target_vault_id TEXT NOT NULL,
  source_backup_id TEXT NOT NULL,
  source_vault_id TEXT NOT NULL,
  source_vault_name TEXT NOT NULL,
  source_generation_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('staging', 'preview', 'applying', 'applied', 'failed')),
  expected_note_count INTEGER NOT NULL CHECK (expected_note_count >= 0),
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes >= 0),
  uploaded_note_count INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_note_count >= 0),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  added_count INTEGER,
  changed_count INTEGER,
  unchanged_count INTEGER,
  applied_note_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_note_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  confirmed_at INTEGER,
  applied_at INTEGER,
  verified_generation_id TEXT,
  failure_code TEXT,
  FOREIGN KEY (target_vault_id) REFERENCES vaults (id) ON DELETE RESTRICT,
  FOREIGN KEY (verified_generation_id) REFERENCES materialization_generations (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS restore_jobs_vault_idx
  ON restore_jobs (target_vault_id, created_at DESC);

CREATE TABLE IF NOT EXISTS restore_entries (
  restore_id TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  modified_at INTEGER,
  staging_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'staged', 'applied')),
  target_content_sha256 TEXT,
  staged_at INTEGER,
  applied_at INTEGER,
  PRIMARY KEY (restore_id, path_key),
  FOREIGN KEY (restore_id) REFERENCES restore_jobs (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS restore_entries_status_idx
  ON restore_entries (restore_id, status, path_key);

CREATE TABLE IF NOT EXISTS restore_cleanup_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  last_run_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO restore_cleanup_state (id, last_run_at) VALUES (1, 0);
