-- R3 elastic actor plane is additive and forward-only.  Existing R2 tables are
-- intentionally untouched: elastic counts live in these projection tables so
-- project_runs.actor_count remains an R2 compatibility field.

CREATE TABLE IF NOT EXISTS project_elastic_records (
  elastic_record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('plane', 'account', 'recovery', 'budget', 'budget-entry', 'observation', 'orca', 'delta')),
  project_id TEXT NOT NULL,
  run_id TEXT,
  actor_id TEXT,
  portable_object_id TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 1048576),
  body_object_key TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0),
  restore_state TEXT NOT NULL CHECK (restore_state IN ('live', 'quarantined')),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= received_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  CHECK ((restore_state = 'live' AND restored_at IS NULL) OR (restore_state = 'quarantined' AND restored_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS project_elastic_records_project_idx ON project_elastic_records (project_id, record_type, received_at);
CREATE INDEX IF NOT EXISTS project_elastic_records_run_idx ON project_elastic_records (run_id, received_at, elastic_record_id);
CREATE INDEX IF NOT EXISTS project_elastic_records_retention_idx ON project_elastic_records (retention_tier, retain_until);

CREATE TABLE IF NOT EXISTS project_elastic_planes (
  run_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile = 'owd-elastic-run-plane-v1'),
  max_active_actors INTEGER NOT NULL CHECK (max_active_actors = 32),
  max_actor_records INTEGER NOT NULL CHECK (max_actor_records = 64),
  max_register_batch INTEGER NOT NULL CHECK (max_register_batch = 16),
  max_bundle_batch INTEGER NOT NULL CHECK (max_bundle_batch = 8),
  max_delta_page INTEGER NOT NULL CHECK (max_delta_page = 100),
  active_actor_count INTEGER NOT NULL DEFAULT 0 CHECK (active_actor_count >= 0 AND active_actor_count <= 32),
  actor_record_count INTEGER NOT NULL DEFAULT 0 CHECK (actor_record_count >= 0 AND actor_record_count <= 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= created_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_elastic_planes_project_idx ON project_elastic_planes (project_id, updated_at);

CREATE TABLE IF NOT EXISTS project_elastic_accounts (
  account_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  active_actor_count INTEGER NOT NULL DEFAULT 0 CHECK (active_actor_count >= 0 AND active_actor_count <= 32),
  actor_record_count INTEGER NOT NULL DEFAULT 0 CHECK (actor_record_count >= 0 AND actor_record_count <= 64),
  accepted_bundle_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_bundle_count >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= updated_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS project_elastic_accounts_run_unique ON project_elastic_accounts (run_id);

-- Slot rows are transport-safe hard guards for concurrent capacity admission.
-- They replace CREATE TRIGGER because Wrangler's remote D1 splitter does not
-- preserve trigger terminators.  Active slots may be released, record slots
-- never are.
CREATE TABLE IF NOT EXISTS project_elastic_actor_slots (
  run_id TEXT NOT NULL,
  actor_id TEXT PRIMARY KEY NOT NULL,
  active_slot INTEGER CHECK (active_slot IS NULL OR active_slot BETWEEN 1 AND 32),
  record_slot INTEGER NOT NULL CHECK (record_slot BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (run_id) REFERENCES project_elastic_planes (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  UNIQUE (run_id, active_slot),
  UNIQUE (run_id, record_slot)
) STRICT;
CREATE INDEX IF NOT EXISTS project_elastic_actor_slots_run_idx ON project_elastic_actor_slots (run_id, record_slot);

CREATE TABLE IF NOT EXISTS project_actor_recoveries (
  recovery_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  abandoned_actor_id TEXT NOT NULL,
  replacement_actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('abandoned', 'expired')),
  detected_at INTEGER NOT NULL CHECK (detected_at >= 0),
  recovered_at INTEGER NOT NULL CHECK (recovered_at >= detected_at),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= recovered_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (abandoned_actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  UNIQUE (run_id, abandoned_actor_id),
  CHECK (abandoned_actor_id <> replacement_actor_id)
) STRICT;
CREATE INDEX IF NOT EXISTS project_actor_recoveries_run_idx ON project_actor_recoveries (run_id, recovered_at);

CREATE TABLE IF NOT EXISTS project_run_budgets (
  budget_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  logical_unit_limit INTEGER NOT NULL CHECK (logical_unit_limit > 0),
  cost_microunit_limit INTEGER NOT NULL CHECK (cost_microunit_limit >= 0),
  logical_units_used INTEGER NOT NULL DEFAULT 0 CHECK (logical_units_used >= 0 AND logical_units_used <= logical_unit_limit),
  cost_microunits_used INTEGER NOT NULL DEFAULT 0 CHECK (cost_microunits_used >= 0 AND cost_microunits_used <= cost_microunit_limit),
  accounting_version INTEGER NOT NULL DEFAULT 0 CHECK (accounting_version >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= updated_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  UNIQUE (budget_id, accounting_version)
) STRICT;
CREATE INDEX IF NOT EXISTS project_run_budgets_project_idx ON project_run_budgets (project_id, updated_at);

-- Immutable version rows prove that every accepted accounting entry advanced
-- the bounded current budget row. This avoids a foreign key to a mutable
-- parent key, which would invalidate older entries as accounting advances.
CREATE TABLE IF NOT EXISTS project_run_budget_versions (
  budget_id TEXT NOT NULL,
  budget_version INTEGER NOT NULL CHECK (budget_version >= 0),
  logical_units_used INTEGER NOT NULL CHECK (logical_units_used >= 0),
  cost_microunits_used INTEGER NOT NULL CHECK (cost_microunits_used >= 0),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (budget_id, budget_version),
  FOREIGN KEY (budget_id) REFERENCES project_run_budgets (budget_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS project_run_budget_entries (
  entry_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  budget_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT,
  logical_units INTEGER NOT NULL CHECK (logical_units >= 0),
  cost_microunits INTEGER NOT NULL CHECK (cost_microunits >= 0),
  budget_version INTEGER NOT NULL CHECK (budget_version > 0),
  reported_by TEXT NOT NULL CHECK (length(reported_by) BETWEEN 1 AND 256),
  harness_reported INTEGER NOT NULL CHECK (harness_reported = 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= created_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (budget_id, budget_version) REFERENCES project_run_budget_versions (budget_id, budget_version) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  CHECK (logical_units > 0 OR cost_microunits > 0),
  UNIQUE (budget_id, budget_version)
) STRICT;
CREATE INDEX IF NOT EXISTS project_run_budget_entries_run_idx ON project_run_budget_entries (run_id, created_at);

CREATE TABLE IF NOT EXISTS project_run_observations (
  observation_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_count INTEGER NOT NULL CHECK (actor_count >= 0 AND actor_count <= 64),
  active_actor_count INTEGER NOT NULL CHECK (active_actor_count >= 0 AND active_actor_count <= 32),
  accepted_bundle_count INTEGER NOT NULL CHECK (accepted_bundle_count >= 0),
  delta_page_count INTEGER NOT NULL CHECK (delta_page_count >= 0),
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  rejected_count INTEGER NOT NULL CHECK (rejected_count >= 0),
  p50_latency_ms INTEGER NOT NULL CHECK (p50_latency_ms >= 0),
  p95_latency_ms INTEGER NOT NULL CHECK (p95_latency_ms >= p50_latency_ms),
  owner_action_count INTEGER NOT NULL CHECK (owner_action_count >= 0),
  raw_content_included INTEGER NOT NULL DEFAULT 0 CHECK (raw_content_included = 0),
  transcripts_included INTEGER NOT NULL DEFAULT 0 CHECK (transcripts_included = 0),
  hidden_reasoning_included INTEGER NOT NULL DEFAULT 0 CHECK (hidden_reasoning_included = 0),
  terminal_history_included INTEGER NOT NULL DEFAULT 0 CHECK (terminal_history_included = 0),
  credentials_included INTEGER NOT NULL DEFAULT 0 CHECK (credentials_included = 0),
  oauth_state_included INTEGER NOT NULL DEFAULT 0 CHECK (oauth_state_included = 0),
  provider_runtime_included INTEGER NOT NULL DEFAULT 0 CHECK (provider_runtime_included = 0),
  production_logs_included INTEGER NOT NULL DEFAULT 0 CHECK (production_logs_included = 0),
  measured_at INTEGER NOT NULL CHECK (measured_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= measured_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_run_observations_run_idx ON project_run_observations (run_id, measured_at);

CREATE TABLE IF NOT EXISTS project_orca_projections (
  projection_id TEXT PRIMARY KEY NOT NULL,
  elastic_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT,
  worktree_ref TEXT,
  branch_ref TEXT,
  commit_sha TEXT CHECK (
    commit_sha IS NULL OR (
      length(commit_sha) IN (40, 64)
      AND commit_sha NOT GLOB '*[^0-9a-f]*'
    )
  ),
  pull_request_ref TEXT,
  session_ref TEXT,
  provider TEXT NOT NULL CHECK (provider = 'orca'),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= 0),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (elastic_record_id) REFERENCES project_elastic_records (elastic_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_orca_projections_run_idx ON project_orca_projections (run_id, projection_id);

CREATE TABLE IF NOT EXISTS project_run_delta_clock (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
) STRICT;
INSERT OR IGNORE INTO project_run_delta_clock (singleton_id, next_sequence) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS project_run_deltas (
  delta_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  delta_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('actor', 'event-bundle', 'recovery', 'budget', 'observation', 'orca')),
  record_id TEXT NOT NULL,
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  evidence_metadata_json TEXT CHECK (evidence_metadata_json IS NULL OR length(evidence_metadata_json) <= 8192),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  retention_tier TEXT NOT NULL CHECK (retention_tier IN ('hot', 'warm', 'cold', 'quarantine')),
  retain_until INTEGER NOT NULL CHECK (retain_until >= occurred_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0 CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0 CHECK (live_authority_included = 0),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  UNIQUE (run_id, record_type, record_id)
) STRICT;
CREATE INDEX IF NOT EXISTS project_run_deltas_run_sequence_idx ON project_run_deltas (run_id, delta_sequence);
CREATE INDEX IF NOT EXISTS project_run_deltas_project_sequence_idx ON project_run_deltas (project_id, delta_sequence);
