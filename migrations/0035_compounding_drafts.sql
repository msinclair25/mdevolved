-- M3 compounding is a derived, owner-reviewed layer.  It never stores
-- transcripts, hidden reasoning, runtime state, credentials, or authority.
-- Rollback is forward-only: leave immutable bodies and ledger rows in place;
-- disable the feature with the application capability until a later repair.

CREATE TABLE IF NOT EXISTS compounding_records (
  record_id TEXT PRIMARY KEY NOT NULL CHECK (length(record_id) = 36),
  record_type TEXT NOT NULL CHECK (record_type IN (
    'checkpoint-observation', 'draft-version', 'draft-accepted',
    'draft-ignored', 'draft-deleted'
  )),
  portable_object_id TEXT NOT NULL UNIQUE CHECK (length(portable_object_id) = 36),
  project_id TEXT,
  source_project_id TEXT CHECK (
    source_project_id IS NULL OR length(source_project_id) = 36
  ),
  draft_id TEXT CHECK (draft_id IS NULL OR length(draft_id) = 36),
  observation_id TEXT CHECK (observation_id IS NULL OR length(observation_id) = 36),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  body_object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 524288),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (
    restore_state IN ('live', 'quarantined')
  ),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (
    restored_authority_allowed = 0
  ),
  CHECK (
    (restore_state = 'live' AND restored_at IS NULL AND source_project_id IS NULL) OR
    (restore_state = 'quarantined' AND restored_at IS NOT NULL)
  ),
  CHECK (
    (record_type = 'checkpoint-observation' AND observation_id IS NOT NULL AND draft_id IS NULL) OR
    (record_type != 'checkpoint-observation' AND draft_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS compounding_observations (
  observation_id TEXT PRIMARY KEY NOT NULL CHECK (length(observation_id) = 36),
  checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) = 36),
  project_id TEXT NOT NULL CHECK (length(project_id) = 36),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'skill')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project')),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  point_id TEXT NOT NULL CHECK (length(point_id) = 36),
  point_content_sha256 TEXT NOT NULL CHECK (
    length(point_content_sha256) = 64 AND point_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  producer_client_id TEXT NOT NULL CHECK (length(producer_client_id) BETWEEN 1 AND 200),
  acknowledged_at INTEGER NOT NULL CHECK (acknowledged_at >= 0),
  record_id TEXT NOT NULL UNIQUE CHECK (length(record_id) = 36),
  restore_state TEXT NOT NULL DEFAULT 'live' CHECK (restore_state = 'live'),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  UNIQUE (checkpoint_id, fingerprint),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (record_id) REFERENCES compounding_records (record_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS compounding_observations_fingerprint_idx
  ON compounding_observations (fingerprint, acknowledged_at DESC, observation_id);
CREATE INDEX IF NOT EXISTS compounding_observations_project_idx
  ON compounding_observations (project_id, acknowledged_at DESC, observation_id);

CREATE TABLE IF NOT EXISTS compounding_drafts (
  draft_id TEXT PRIMARY KEY NOT NULL CHECK (length(draft_id) = 36),
  fingerprint TEXT NOT NULL UNIQUE CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'skill')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project')),
  project_id TEXT,
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'ignored', 'deleted')),
  conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
  observation_count INTEGER NOT NULL CHECK (observation_count > 0 AND observation_count <= 256),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  first_observed_at INTEGER NOT NULL CHECK (first_observed_at >= 0),
  last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= first_observed_at),
  current_record_id TEXT NOT NULL UNIQUE CHECK (length(current_record_id) = 36),
  record_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (record_restore_state = 'live'),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_record_id) REFERENCES compounding_records (record_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS compounding_drafts_scope_idx
  ON compounding_drafts (project_id, status, last_observed_at DESC, draft_id);
CREATE INDEX IF NOT EXISTS compounding_drafts_fingerprint_idx
  ON compounding_drafts (fingerprint, status);

CREATE TABLE IF NOT EXISTS compounding_mutation_receipts (
  idempotency_key_sha256 TEXT PRIMARY KEY NOT NULL CHECK (
    length(idempotency_key_sha256) = 64 AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN ('accept', 'edit', 'ignore', 'delete')),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

-- A short-lived, fail-closed claim serializes owner review for one draft.
-- Successful actions remove their claim in the same batch that records the
-- immutable disposition and receipt. An interrupted action can only be
-- resumed with the same idempotency key.
CREATE TABLE IF NOT EXISTS compounding_draft_action_claims (
  draft_id TEXT PRIMARY KEY NOT NULL CHECK (length(draft_id) = 36),
  idempotency_key_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key_sha256) = 64 AND
    idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL CHECK (operation IN ('accept', 'edit', 'ignore', 'delete')),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (draft_id) REFERENCES compounding_drafts (draft_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS compounding_checkpoint_bindings (
  checkpoint_id TEXT PRIMARY KEY NOT NULL CHECK (length(checkpoint_id) = 36),
  learning_signals_sha256 TEXT NOT NULL CHECK (
    length(learning_signals_sha256) = 64 AND
    learning_signals_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
