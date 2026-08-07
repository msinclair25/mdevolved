-- R2 hands-off lead operation is additive and forward-only. Existing
-- collaboration_records and its checks are intentionally untouched. Restored
-- rows are quarantined and never copied into live actor authority.

CREATE TABLE IF NOT EXISTS project_operation_records (
  operation_record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('policy', 'run', 'actor', 'event-bundle', 'exception')),
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  portable_object_id TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 1048576),
  body_object_key TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0),
  restore_state TEXT NOT NULL CHECK (restore_state IN ('live', 'quarantined')),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id) REFERENCES collaboration_work_items (work_item_id) ON DELETE RESTRICT,
  CHECK ((restore_state = 'live' AND restored_at IS NULL) OR (restore_state = 'quarantined' AND restored_at IS NOT NULL)),
  UNIQUE (operation_record_id, restore_state)
) STRICT;

CREATE INDEX IF NOT EXISTS project_operation_records_project_idx
  ON project_operation_records (project_id, record_type, received_at);
CREATE INDEX IF NOT EXISTS project_operation_records_run_idx
  ON project_operation_records (run_id, record_type);

CREATE TABLE IF NOT EXISTS project_operation_policies (
  policy_id TEXT PRIMARY KEY NOT NULL,
  operation_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  max_actors_per_run INTEGER NOT NULL CHECK (max_actors_per_run = 8),
  max_bundles_per_run INTEGER NOT NULL CHECK (max_bundles_per_run = 64),
  max_events_per_bundle INTEGER NOT NULL CHECK (max_events_per_bundle = 16),
  max_bundle_bytes INTEGER NOT NULL CHECK (max_bundle_bytes = 262144),
  max_run_logical_bytes INTEGER NOT NULL CHECK (max_run_logical_bytes = 4194304),
  independent_review_required INTEGER NOT NULL CHECK (independent_review_required = 1),
  FOREIGN KEY (operation_record_id) REFERENCES project_operation_records (operation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_record_id, operation_restore_state) REFERENCES project_operation_records (operation_record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_operation_policies_project_idx
  ON project_operation_policies (project_id, project_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_operation_policies_version_unique
  ON project_operation_policies (project_id, project_version_id);

CREATE TABLE IF NOT EXISTS project_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  operation_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  work_packet_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  purpose TEXT NOT NULL CHECK (purpose IN ('research', 'coding')),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'aborted', 'restored-inert')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  completion_outcome TEXT,
  actor_count INTEGER NOT NULL DEFAULT 0 CHECK (actor_count >= 0 AND actor_count <= 8),
  bundle_count INTEGER NOT NULL DEFAULT 0 CHECK (bundle_count >= 0 AND bundle_count <= 64),
  logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0 AND logical_bytes <= 4194304),
  max_actors_per_run INTEGER NOT NULL CHECK (max_actors_per_run = 8),
  max_bundles_per_run INTEGER NOT NULL CHECK (max_bundles_per_run = 64),
  max_events_per_bundle INTEGER NOT NULL CHECK (max_events_per_bundle = 16),
  max_bundle_bytes INTEGER NOT NULL CHECK (max_bundle_bytes = 262144),
  max_run_logical_bytes INTEGER NOT NULL CHECK (max_run_logical_bytes = 4194304),
  FOREIGN KEY (operation_record_id) REFERENCES project_operation_records (operation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_record_id, operation_restore_state) REFERENCES project_operation_records (operation_record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id) REFERENCES collaboration_work_items (work_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_packet_id) REFERENCES collaboration_records (id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_id) REFERENCES project_operation_policies (policy_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND completion_outcome IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL AND completion_outcome IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS project_runs_project_status_idx ON project_runs (project_id, status, run_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_runs_work_item_active_unique
  ON project_runs (work_item_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS project_actors (
  actor_id TEXT PRIMARY KEY NOT NULL,
  operation_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  claimed_identity TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER,
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  FOREIGN KEY (operation_record_id) REFERENCES project_operation_records (operation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_record_id, operation_restore_state) REFERENCES project_operation_records (operation_record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id) REFERENCES collaboration_work_items (work_item_id) ON DELETE RESTRICT,
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL) OR (status <> 'revoked' AND revoked_at IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS project_actors_run_status_idx ON project_actors (run_id, status, expires_at);
CREATE TABLE IF NOT EXISTS project_event_bundles (
  bundle_id TEXT PRIMARY KEY NOT NULL,
  operation_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'run-shared-unvetted'),
  event_count INTEGER NOT NULL CHECK (event_count > 0 AND event_count <= 16),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 262144),
  has_provisional_result INTEGER NOT NULL CHECK (has_provisional_result IN (0, 1)),
  review_request_target_bundle_id TEXT,
  requested_reviewer_actor_id TEXT,
  review_result_target_bundle_id TEXT,
  review_verdict TEXT CHECK (
    review_verdict IS NULL OR review_verdict IN (
      'pass', 'pass-with-findings', 'changes-requested', 'inconclusive'
    )
  ),
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  FOREIGN KEY (operation_record_id) REFERENCES project_operation_records (operation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_record_id, operation_restore_state) REFERENCES project_operation_records (operation_record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  CHECK (
    (review_request_target_bundle_id IS NULL AND requested_reviewer_actor_id IS NULL) OR
    (review_request_target_bundle_id IS NOT NULL AND requested_reviewer_actor_id IS NOT NULL)
  ),
  CHECK (
    (review_result_target_bundle_id IS NULL AND review_verdict IS NULL) OR
    (review_result_target_bundle_id IS NOT NULL AND review_verdict IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS project_event_bundles_run_received_idx ON project_event_bundles (run_id, received_at, bundle_id);

CREATE TABLE IF NOT EXISTS project_run_claims (
  run_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  claim_key TEXT NOT NULL,
  value_sha256 TEXT NOT NULL CHECK (length(value_sha256) = 64),
  evidence_sha256 TEXT,
  PRIMARY KEY (run_id, bundle_id, claim_key, value_sha256),
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (bundle_id) REFERENCES project_event_bundles (bundle_id) ON DELETE RESTRICT,
  CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 64)
) STRICT;
CREATE INDEX IF NOT EXISTS project_run_claims_evidence_idx ON project_run_claims (run_id, evidence_sha256);
CREATE INDEX IF NOT EXISTS project_run_claims_key_idx
  ON project_run_claims (run_id, claim_key, value_sha256);

CREATE TABLE IF NOT EXISTS project_exceptions (
  exception_id TEXT PRIMARY KEY NOT NULL,
  operation_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live' CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  run_id TEXT,
  work_item_id TEXT,
  actor_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('authority-expansion', 'destructive-action', 'protected-path-access', 'budget-exhausted', 'evidence-conflict', 'review-independence', 'actor-scope')),
  status TEXT NOT NULL CHECK (status IN ('open', 'blocking', 'resolved')),
  requested_action TEXT,
  normalized_relative_path TEXT,
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  resolved_at INTEGER,
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  FOREIGN KEY (operation_record_id) REFERENCES project_operation_records (operation_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_record_id, operation_restore_state) REFERENCES project_operation_records (operation_record_id, restore_state) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES project_actors (actor_id) ON DELETE RESTRICT,
  CHECK (requested_action IS NULL OR requested_action IN ('authority-expansion', 'destructive-action', 'protected-path-access')),
  CHECK ((status = 'resolved' AND resolved_at IS NOT NULL) OR (status <> 'resolved' AND resolved_at IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS project_exceptions_project_status_idx ON project_exceptions (project_id, status, created_at);

CREATE TABLE IF NOT EXISTS project_operation_receipts (
  authority_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK (length(idempotency_key_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  project_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  PRIMARY KEY (authority_key, operation, idempotency_key_sha256),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_operation_receipts_project_idx ON project_operation_receipts (project_id, received_at);
