-- Prerequisite: 0007_encrypted_backups.sql plus D1 and R2 bindings named DB
-- and VAULT_STORAGE. This additive migration introduces immutable workspace
-- snapshots without changing or deleting the legacy owd-backup-v1 path.
--
-- Publication invariant: membership and exact source generations are fixed
-- before encryption begins. A snapshot remains creating/importing until every
-- referenced ciphertext object and the encrypted manifest have durable R2
-- size/version/ETag receipts. Readers list only ready snapshots.
--
-- Deduplication invariant: snapshot_entries are logically complete. They may
-- reuse a ready randomized ciphertext object only inside the same recovery
-- recipient and logical-section boundary. Plaintext hashes never determine
-- ciphertext. source_r2_key retains a canonical repair source for locally
-- created snapshots while they are retained.
--
-- Recovery: roll application code back without dropping these tables or R2
-- objects. Legacy backup_artifacts and restore_jobs remain unchanged. Never
-- delete the last ready workspace snapshot. Deletion queues R2 keys in
-- snapshot_gc_objects before removing D1 membership so interrupted cleanup is
-- conservative and resumable.

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  portable_snapshot_id TEXT NOT NULL UNIQUE,
  format_version TEXT NOT NULL CHECK (format_version = 'owd-snapshot-v2'),
  origin TEXT NOT NULL CHECK (origin IN ('created', 'imported')),
  scope TEXT NOT NULL CHECK (scope IN ('all-active', 'selected', 'imported')),
  status TEXT NOT NULL
    CHECK (status IN ('creating', 'importing', 'ready', 'failed')),
  integrity_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (integrity_status IN ('pending', 'verified', 'degraded')),
  recipient_fingerprint TEXT NOT NULL,
  capture_started_at INTEGER NOT NULL,
  capture_completed_at INTEGER,
  vault_count INTEGER NOT NULL CHECK (vault_count > 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  changed_item_count INTEGER NOT NULL DEFAULT 0
    CHECK (changed_item_count >= 0),
  processed_object_count INTEGER NOT NULL DEFAULT 0
    CHECK (processed_object_count >= 0),
  total_object_count INTEGER NOT NULL DEFAULT 0
    CHECK (total_object_count >= 0),
  newly_stored_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (newly_stored_bytes >= 0),
  included_sections TEXT NOT NULL,
  unavailable_sections TEXT NOT NULL,
  manifest_portable_object_id TEXT NOT NULL,
  manifest_object_key TEXT UNIQUE,
  manifest_ciphertext_bytes INTEGER,
  manifest_object_etag TEXT,
  manifest_object_version TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  verified_at INTEGER,
  failure_code TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS workspace_snapshots_timeline_idx
  ON workspace_snapshots (status, capture_started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_snapshots_one_build_idx
  ON workspace_snapshots (format_version)
  WHERE status IN ('creating', 'importing');

CREATE TABLE IF NOT EXISTS snapshot_vaults (
  snapshot_id TEXT NOT NULL,
  snapshot_vault_id TEXT NOT NULL,
  source_vault_id TEXT,
  source_vault_name TEXT NOT NULL,
  generation_id TEXT,
  source_state_vector_sha256 TEXT,
  generation_created_at INTEGER,
  generation_completed_at INTEGER,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (snapshot_id, snapshot_vault_id),
  UNIQUE (snapshot_id, ordinal),
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots (id)
    ON DELETE CASCADE,
  FOREIGN KEY (source_vault_id) REFERENCES vaults (id) ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES materialization_generations (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS snapshot_vaults_source_idx
  ON snapshot_vaults (source_vault_id, snapshot_id);

CREATE TABLE IF NOT EXISTS snapshot_objects (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
  section TEXT NOT NULL
    CHECK (section IN ('notes', 'attachments', 'obsidian-allowlist')),
  recipient_fingerprint TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  ciphertext_bytes INTEGER,
  object_key TEXT NOT NULL UNIQUE,
  object_etag TEXT,
  object_version TEXT,
  created_by_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  failure_code TEXT,
  FOREIGN KEY (created_by_snapshot_id) REFERENCES workspace_snapshots (id)
    ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS snapshot_objects_reuse_idx
  ON snapshot_objects (
    recipient_fingerprint, section, content_sha256, plaintext_bytes, status,
    verified_at DESC
  );

CREATE TABLE IF NOT EXISTS snapshot_entries (
  snapshot_id TEXT NOT NULL,
  snapshot_vault_id TEXT NOT NULL,
  section TEXT NOT NULL
    CHECK (section IN ('notes', 'attachments', 'obsidian-allowlist')),
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  modified_at INTEGER,
  portable_object_id TEXT NOT NULL,
  recovery_object_id TEXT,
  source_r2_key TEXT,
  PRIMARY KEY (snapshot_id, snapshot_vault_id, section, path_key),
  FOREIGN KEY (snapshot_id, snapshot_vault_id)
    REFERENCES snapshot_vaults (snapshot_id, snapshot_vault_id)
    ON DELETE CASCADE,
  FOREIGN KEY (recovery_object_id) REFERENCES snapshot_objects (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS snapshot_entries_object_idx
  ON snapshot_entries (recovery_object_id, snapshot_id);

CREATE INDEX IF NOT EXISTS snapshot_entries_pending_idx
  ON snapshot_entries (snapshot_id, recovery_object_id, section, content_sha256);

CREATE TABLE IF NOT EXISTS snapshot_retention_policy (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  keep_ready_count INTEGER NOT NULL DEFAULT 5
    CHECK (keep_ready_count BETWEEN 2 AND 100),
  max_retained_ciphertext_bytes INTEGER
    CHECK (max_retained_ciphertext_bytes IS NULL
      OR max_retained_ciphertext_bytes >= 0),
  updated_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO snapshot_retention_policy (
  id, enabled, keep_ready_count, max_retained_ciphertext_bytes, updated_at
) VALUES (1, 0, 5, NULL, 0);

CREATE TABLE IF NOT EXISTS snapshot_gc_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS snapshot_gc_objects_queue_idx
  ON snapshot_gc_objects (queued_at, object_key);
