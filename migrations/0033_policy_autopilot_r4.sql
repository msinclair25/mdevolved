-- R4 policy autopilot and operational continuity are additive, forward-only,
-- and trigger-free. Application rollback leaves these tables and immutable R2
-- bodies in place. Restored records remain generic quarantined evidence and
-- never recreate policy, scheduler, lease, grant, actor, or credential
-- authority. There is no destructive down-migration or automatic rollback.

CREATE TABLE IF NOT EXISTS project_operational_records (
  operational_record_id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN (
    'policy-binding', 'policy-decision', 'schedule', 'evidence',
    'continuity-receipt'
  )),
  project_id TEXT NOT NULL,
  run_id TEXT,
  portable_object_id TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (
    byte_length > 0 AND byte_length <= 1048576
  ),
  body_object_key TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0),
  restore_state TEXT NOT NULL CHECK (
    restore_state IN ('live', 'quarantined')
  ),
  retention_tier TEXT NOT NULL CHECK (
    retention_tier IN ('hot', 'warm', 'cold', 'quarantine')
  ),
  retain_until INTEGER NOT NULL CHECK (retain_until >= received_at),
  restored_authority_allowed INTEGER NOT NULL DEFAULT 0
    CHECK (restored_authority_allowed = 0),
  live_authority_included INTEGER NOT NULL DEFAULT 0
    CHECK (live_authority_included = 0),
  scheduler_authority_included INTEGER NOT NULL DEFAULT 0
    CHECK (scheduler_authority_included = 0),
  CHECK (
    (restore_state = 'live' AND restored_at IS NULL) OR
    (restore_state = 'quarantined' AND restored_at IS NOT NULL)
  ),
  UNIQUE (operational_record_id, restore_state),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_operational_records_project_idx
  ON project_operational_records (
    project_id, record_type, received_at DESC, operational_record_id
  );
CREATE INDEX IF NOT EXISTS project_operational_records_run_idx
  ON project_operational_records (run_id, record_type, received_at);
CREATE INDEX IF NOT EXISTS project_operational_records_retention_idx
  ON project_operational_records (retention_tier, retain_until);

CREATE TABLE IF NOT EXISTS project_operational_dependencies (
  operational_record_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK (
    dependency_kind IN ('record', 'evidence', 'operational')
  ),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR length(content_sha256) = 64
  ),
  PRIMARY KEY (operational_record_id, dependency_id),
  FOREIGN KEY (operational_record_id)
    REFERENCES project_operational_records (operational_record_id)
    ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_operational_dependencies_lookup_idx
  ON project_operational_dependencies (dependency_id, dependency_kind);

CREATE TABLE IF NOT EXISTS project_policy_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live'
    CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
  owner_policy_input_record_id TEXT NOT NULL,
  owner_policy_input_sha256 TEXT NOT NULL
    CHECK (length(owner_policy_input_sha256) = 64),
  owner_authored INTEGER NOT NULL CHECK (owner_authored = 1),
  gate_research TEXT NOT NULL
    CHECK (gate_research = 'owd-research-completion-gate-v1'),
  gate_coding TEXT NOT NULL
    CHECK (gate_coding = 'owd-coding-completion-gate-v1'),
  checkpoint_interval_seconds INTEGER NOT NULL CHECK (
    checkpoint_interval_seconds BETWEEN 300 AND 86400
  ),
  drill_interval_seconds INTEGER NOT NULL CHECK (
    drill_interval_seconds BETWEEN 3600 AND 2592000
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
  superseded_at INTEGER,
  CHECK (
    (status = 'active' AND superseded_at IS NULL) OR
    (status = 'superseded' AND superseded_at IS NOT NULL)
  ),
  FOREIGN KEY (operational_record_id, operation_restore_state)
    REFERENCES project_operational_records (
      operational_record_id, restore_state
    ) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (policy_id) REFERENCES project_operation_policies (policy_id)
    ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS project_policy_bindings_active_unique
  ON project_policy_bindings (project_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS project_policy_bindings_version_idx
  ON project_policy_bindings (project_id, project_version_id, status);

CREATE TABLE IF NOT EXISTS project_policy_decisions (
  decision_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live'
    CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  work_packet_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_binding_id TEXT NOT NULL,
  continuity_point_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('research', 'coding')),
  gate_profile TEXT NOT NULL CHECK (gate_profile IN (
    'owd-research-completion-gate-v1',
    'owd-coding-completion-gate-v1'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'exception')),
  exception_reason TEXT CHECK (exception_reason IS NULL OR exception_reason IN (
    'authority-expansion', 'policy-editing', 'self-approval',
    'destructive-action', 'protected-path-access', 'conflicting-evidence',
    'budget-exhaustion', 'integrity-failure', 'unsupported-upgrade',
    'unsupported-rollback'
  )),
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  requested_owner_actions_json TEXT NOT NULL
    CHECK (json_valid(requested_owner_actions_json)),
  evidence_fingerprint TEXT NOT NULL
    CHECK (length(evidence_fingerprint) = 64),
  accepted_bundle_count INTEGER NOT NULL CHECK (accepted_bundle_count >= 0),
  evaluated_at INTEGER NOT NULL CHECK (evaluated_at >= 0),
  source_lease_id TEXT NOT NULL,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  live_fence_valid INTEGER NOT NULL CHECK (live_fence_valid = 1),
  CHECK (
    (outcome = 'allow' AND exception_reason IS NULL
      AND continuity_point_id IS NOT NULL) OR
    (outcome = 'exception' AND exception_reason IS NOT NULL)
  ),
  FOREIGN KEY (operational_record_id, operation_restore_state)
    REFERENCES project_operational_records (
      operational_record_id, restore_state
    ) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id) REFERENCES collaboration_work_items (work_item_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (work_packet_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES project_runs (run_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_id) REFERENCES project_operation_policies (policy_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (policy_binding_id)
    REFERENCES project_policy_bindings (binding_id) ON DELETE RESTRICT,
  FOREIGN KEY (continuity_point_id)
    REFERENCES project_continuity_points (continuity_point_id)
    ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_policy_decisions_run_idx
  ON project_policy_decisions (run_id, evaluated_at DESC, decision_id);
CREATE INDEX IF NOT EXISTS project_policy_decisions_project_idx
  ON project_policy_decisions (
    project_id, outcome, evaluated_at DESC, decision_id
  );

CREATE TABLE IF NOT EXISTS project_operational_schedules (
  schedule_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  operation_restore_state TEXT NOT NULL DEFAULT 'live'
    CHECK (operation_restore_state = 'live'),
  project_id TEXT NOT NULL,
  policy_binding_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  checkpoint_interval_seconds INTEGER NOT NULL CHECK (
    checkpoint_interval_seconds BETWEEN 300 AND 86400
  ),
  drill_interval_seconds INTEGER NOT NULL CHECK (
    drill_interval_seconds BETWEEN 3600 AND 2592000
  ),
  next_checkpoint_at INTEGER NOT NULL CHECK (next_checkpoint_at >= 0),
  next_drill_at INTEGER NOT NULL CHECK (next_drill_at >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (operational_record_id, operation_restore_state)
    REFERENCES project_operational_records (
      operational_record_id, restore_state
    ) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (policy_binding_id)
    REFERENCES project_policy_bindings (binding_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS project_operational_schedules_active_unique
  ON project_operational_schedules (project_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS project_operational_schedules_due_idx
  ON project_operational_schedules (
    status, next_checkpoint_at, next_drill_at, schedule_id
  );

CREATE TABLE IF NOT EXISTS project_operational_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  request_kind TEXT NOT NULL CHECK (
    request_kind IN ('continuity-point', 'continuity-drill')
  ),
  schedule_window INTEGER NOT NULL CHECK (schedule_window >= 0),
  due_at INTEGER NOT NULL CHECK (due_at >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'acknowledged', 'completed', 'failed')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  completed_at INTEGER,
  UNIQUE (schedule_id, request_kind, schedule_window),
  CHECK (
    (status IN ('pending', 'acknowledged') AND completed_at IS NULL) OR
    (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (operational_record_id)
    REFERENCES project_operational_records (operational_record_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (schedule_id)
    REFERENCES project_operational_schedules (schedule_id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_operational_requests_pending_idx
  ON project_operational_requests (
    project_id, status, created_at, request_id
  );

CREATE TABLE IF NOT EXISTS project_operational_integrity_reports (
  evidence_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial')),
  inspected_record_count INTEGER NOT NULL CHECK (
    inspected_record_count >= 0 AND inspected_record_count <= 512
  ),
  inspected_body_count INTEGER NOT NULL CHECK (
    inspected_body_count >= 0 AND inspected_body_count <= 512
  ),
  missing_count INTEGER NOT NULL CHECK (
    missing_count >= 0 AND missing_count <= 512
  ),
  mismatched_count INTEGER NOT NULL CHECK (
    mismatched_count >= 0 AND mismatched_count <= 512
  ),
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded')),
  measured_at INTEGER NOT NULL CHECK (measured_at >= 0),
  FOREIGN KEY (operational_record_id)
    REFERENCES project_operational_records (operational_record_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_operational_integrity_project_idx
  ON project_operational_integrity_reports (
    project_id, measured_at DESC, evidence_id
  );

CREATE TABLE IF NOT EXISTS project_continuity_drill_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  operational_record_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  drill_id TEXT NOT NULL UNIQUE,
  restored_continuity_point_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail')),
  rpo_seconds INTEGER NOT NULL CHECK (rpo_seconds >= 0),
  rto_seconds INTEGER NOT NULL CHECK (rto_seconds >= 0),
  continuity_age_seconds INTEGER NOT NULL CHECK (
    continuity_age_seconds >= 0
  ),
  recovery_quality_bps INTEGER NOT NULL CHECK (
    recovery_quality_bps BETWEEN 0 AND 10000
  ),
  recovery_checks_passed INTEGER NOT NULL CHECK (
    recovery_checks_passed >= 0
  ),
  recovery_checks_total INTEGER NOT NULL CHECK (
    recovery_checks_total > 0
    AND recovery_checks_passed <= recovery_checks_total
  ),
  runtime_independent INTEGER NOT NULL CHECK (
    runtime_independent IN (0, 1)
  ),
  redacted INTEGER NOT NULL CHECK (redacted = 1),
  remaining_authority_count INTEGER NOT NULL CHECK (
    remaining_authority_count = 0
  ),
  emitted_at INTEGER NOT NULL CHECK (emitted_at >= 0),
  FOREIGN KEY (operational_record_id)
    REFERENCES project_operational_records (operational_record_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (restored_continuity_point_id)
    REFERENCES project_continuity_points (continuity_point_id)
    ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS project_continuity_drill_receipts_project_idx
  ON project_continuity_drill_receipts (
    project_id, emitted_at DESC, receipt_id
  );

CREATE TABLE IF NOT EXISTS project_operational_job_clock (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  last_scheduled_time INTEGER NOT NULL CHECK (last_scheduled_time >= 0),
  last_completed_at INTEGER NOT NULL CHECK (last_completed_at >= 0)
) STRICT;
INSERT OR IGNORE INTO project_operational_job_clock (
  singleton_id, last_scheduled_time, last_completed_at
) VALUES (1, 0, 0);
