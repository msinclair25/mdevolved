-- Prerequisites: 0011_phase9b_agent_first.sql and a reviewed D1 backup.
--
-- Forward action: index immutable collaboration records by the exact
-- historical grant that authorized them. Dashboard counts and provenance
-- labels use this identity instead of a mutable OAuth client/project pair.
--
-- Recovery: every change below is additive. Application rollback may leave
-- the index, job/GC tables, and nullable restore column in place; older code
-- will simply stop populating them. Do not drop tables or rewrite historical
-- grant IDs during rollback.

CREATE INDEX IF NOT EXISTS collaboration_records_historical_grant_received_idx
  ON collaboration_records (historical_grant_id, received_at DESC)
  WHERE historical_grant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS materialization_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL,
  source_state_vector_sha256 TEXT NOT NULL CHECK (
    length(source_state_vector_sha256) = 64
  ),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed')
  ),
  staging_object_key TEXT NOT NULL UNIQUE,
  staging_object_bytes INTEGER NOT NULL CHECK (staging_object_bytes >= 0),
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  processed_note_count INTEGER NOT NULL DEFAULT 0 CHECK (
    processed_note_count >= 0
  ),
  total_note_count INTEGER NOT NULL CHECK (total_note_count >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  request_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  completed_at INTEGER,
  failure_code TEXT,
  FOREIGN KEY (generation_id) REFERENCES materialization_generations (id)
    ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS materialization_jobs_vault_status_idx
  ON materialization_jobs (vault_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS materialization_jobs_active_source_idx
  ON materialization_jobs (vault_id, source_state_vector_sha256)
  WHERE status IN ('queued', 'running');

ALTER TABLE restore_jobs ADD COLUMN materialization_job_id TEXT
  REFERENCES materialization_jobs (id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS materialization_gc_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  queued_at INTEGER NOT NULL CHECK (queued_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS materialization_gc_objects_queue_idx
  ON materialization_gc_objects (queued_at, object_key);
