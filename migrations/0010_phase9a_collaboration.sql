-- Prerequisites: 0005_materialized_generations.sql, 0006_agent_access.sql,
-- 0008_snapshot_recovery.sql, and bindings DB plus VAULT_STORAGE.
--
-- Forward action: add the Phase 9A provider-neutral collaboration ledger,
-- Project-specific grants, portable-object metadata, notebook projection
-- receipts, and snapshot-intelligence staging. Immutable record and content
-- bodies remain content-addressed R2 objects; D1 holds bounded identity,
-- authorization, relationship, event, and query projections.
--
-- Authorization invariant: collaboration_grants never widen or replace an
-- existing vault grant. Every live call rechecks its exact OAuth client,
-- audience, Project, Knowledge Space version, named scope, expiry, and
-- revocation. Restores never insert collaboration_grants.
--
-- Recovery: application rollback may ignore these additive tables. Do not
-- drop them, delete collaboration R2 objects, or rewrite migration history.
-- Records and owner events are append-only. Failed pre-publication R2 writes
-- may leave unreferenced content-addressed objects; a future reviewed,
-- reference-aware collector may reclaim them. Snapshot intelligence remains
-- encrypted and unavailable unless the matching manifest capabilities are
-- understood. Unvetted restore rows stay owner-only and quarantined.

CREATE TABLE IF NOT EXISTS collaboration_records (
  id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN (
    'knowledge-space', 'knowledge-space-version', 'project',
    'project-version', 'work-item', 'work-item-version', 'participant-ref',
    'work-packet', 'attempt', 'artifact', 'handoff', 'review', 'decision',
    'owner-event', 'provenance-edge'
  )),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT,
  work_item_id TEXT,
  work_packet_id TEXT,
  attempt_id TEXT,
  participant_ref_id TEXT,
  producer_client_id TEXT,
  historical_grant_id TEXT,
  portable_object_id TEXT NOT NULL UNIQUE,
  body_object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (
    byte_length >= 0 AND byte_length <= 1048576
  ),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_records_project_timeline_idx
  ON collaboration_records (project_id, received_at DESC, id);

CREATE INDEX IF NOT EXISTS collaboration_records_work_item_idx
  ON collaboration_records (work_item_id, received_at, id);

CREATE INDEX IF NOT EXISTS collaboration_records_packet_idx
  ON collaboration_records (work_packet_id, record_type, received_at);

CREATE INDEX IF NOT EXISTS collaboration_records_attempt_idx
  ON collaboration_records (attempt_id, record_type, received_at);

CREATE TABLE IF NOT EXISTS collaboration_projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  active_project_version_id TEXT NOT NULL,
  active_knowledge_space_version_id TEXT NOT NULL,
  label TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (project_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (active_project_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (active_knowledge_space_version_id)
    REFERENCES collaboration_records (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_projects_status_idx
  ON collaboration_projects (status, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_work_items (
  work_item_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  active_work_item_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'quarantined')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (work_item_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (active_work_item_version_id)
    REFERENCES collaboration_records (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_work_items_project_idx
  ON collaboration_work_items (project_id, status, created_at);

CREATE TABLE IF NOT EXISTS collaboration_record_states (
  record_id TEXT PRIMARY KEY NOT NULL,
  visibility TEXT NOT NULL
    CHECK (visibility IN ('private', 'shared', 'owner-only')),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'pending', 'accepted', 'rejected', 'quarantined', 'superseded'
  )),
  last_owner_event_id TEXT,
  changed_at INTEGER NOT NULL CHECK (changed_at >= 0),
  FOREIGN KEY (record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (last_owner_event_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_record_states_inbox_idx
  ON collaboration_record_states (disposition, visibility, changed_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_owner_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'record.shared', 'record.accepted', 'record.rejected',
    'record.quarantined', 'record.superseded', 'work-item.closed',
    'work-item.reopened', 'project.archived', 'project.reactivated',
    'project.version-activated'
  )),
  target_record_id TEXT,
  replacement_record_id TEXT,
  work_item_id TEXT,
  project_version_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (event_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (target_record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (replacement_record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_owner_events_project_idx
  ON collaboration_owner_events (project_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS collaboration_provenance_edges (
  edge_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN (
    'used', 'was-generated-by', 'was-derived-from', 'was-revision-of',
    'was-informed-by', 'was-attributed-to', 'was-associated-with'
  )),
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_class TEXT NOT NULL CHECK (
    subject_class IN ('entity', 'activity', 'agent')
  ),
  object_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_class TEXT NOT NULL CHECK (
    object_class IN ('entity', 'activity', 'agent')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (edge_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (subject_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (object_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_provenance_subject_idx
  ON collaboration_provenance_edges (project_id, subject_id, relation);

CREATE INDEX IF NOT EXISTS collaboration_provenance_object_idx
  ON collaboration_provenance_edges (project_id, object_id, relation);

CREATE TABLE IF NOT EXISTS collaboration_dependencies (
  record_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN (
    'record', 'evidence', 'artifact-content'
  )),
  PRIMARY KEY (record_id, dependency_id),
  FOREIGN KEY (record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_dependencies_reverse_idx
  ON collaboration_dependencies (dependency_id, record_id);

CREATE TABLE IF NOT EXISTS collaboration_content_objects (
  id TEXT PRIMARY KEY NOT NULL,
  portable_object_id TEXT NOT NULL UNIQUE,
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('artifact-content', 'packet-evidence')
  ),
  media_type TEXT NOT NULL CHECK (
    media_type IN ('text/markdown', 'application/json')
  ),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (
    byte_length >= 0 AND byte_length <= 1048576
  ),
  object_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_content_hash_idx
  ON collaboration_content_objects (
    object_kind, content_sha256, byte_length, created_at DESC
  );

CREATE TABLE IF NOT EXISTS collaboration_record_content (
  record_id TEXT NOT NULL,
  content_object_id TEXT NOT NULL,
  PRIMARY KEY (record_id, content_object_id),
  FOREIGN KEY (record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (content_object_id) REFERENCES collaboration_content_objects (id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS collaboration_grants (
  id TEXT PRIMARY KEY NOT NULL,
  source_agent_grant_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  project_id TEXT NOT NULL,
  knowledge_space_version_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  activated_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (knowledge_space_version_id)
    REFERENCES collaboration_records (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS collaboration_grants_authorization_idx
  ON collaboration_grants (
    id, oauth_client_id, audience, project_id, status, expires_at
  );

CREATE INDEX IF NOT EXISTS collaboration_grants_source_idx
  ON collaboration_grants (source_agent_grant_id, status);

CREATE TABLE IF NOT EXISTS collaboration_submission_receipts (
  authority_key TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL
    CHECK (length(idempotency_key_sha256) = 64),
  submission_id TEXT NOT NULL UNIQUE,
  submission_sha256 TEXT NOT NULL CHECK (length(submission_sha256) = 64),
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (
    record_type IN ('attempt', 'artifact', 'handoff', 'review')
  ),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  PRIMARY KEY (authority_key, idempotency_key_sha256),
  FOREIGN KEY (record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS collaboration_notebook_projections (
  projection_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  target_content_version TEXT NOT NULL
    CHECK (length(target_content_version) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (project_id, record_id),
  UNIQUE (vault_id, path_key),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (record_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS snapshot_intelligence_selections (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  selection TEXT NOT NULL CHECK (
    selection IN ('none', 'approved', 'approved-and-unvetted')
  ),
  approved_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (approved_record_count >= 0),
  approved_evidence_count INTEGER NOT NULL DEFAULT 0
    CHECK (approved_evidence_count >= 0),
  approved_logical_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (approved_logical_bytes >= 0),
  approved_newly_stored_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (approved_newly_stored_bytes >= 0),
  unvetted_record_count INTEGER NOT NULL DEFAULT 0
    CHECK (unvetted_record_count >= 0),
  unvetted_evidence_count INTEGER NOT NULL DEFAULT 0
    CHECK (unvetted_evidence_count >= 0),
  unvetted_logical_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (unvetted_logical_bytes >= 0),
  unvetted_newly_stored_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (unvetted_newly_stored_bytes >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots (id)
    ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS snapshot_intelligence_items (
  snapshot_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('record', 'evidence')),
  classification TEXT NOT NULL CHECK (
    classification IN ('approved', 'unvetted')
  ),
  portable_object_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  source_object_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (
    byte_length >= 0 AND byte_length <= 1048576
  ),
  encrypted_object_key TEXT,
  encrypted_bytes INTEGER,
  object_etag TEXT,
  object_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  PRIMARY KEY (snapshot_id, item_id),
  UNIQUE (snapshot_id, portable_object_id),
  UNIQUE (encrypted_object_key),
  FOREIGN KEY (snapshot_id)
    REFERENCES snapshot_intelligence_selections (snapshot_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS snapshot_intelligence_items_pending_idx
  ON snapshot_intelligence_items (snapshot_id, status, portable_object_id);

CREATE TABLE IF NOT EXISTS collaboration_restore_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('staging', 'preview', 'confirmed', 'applied', 'failed')
  ),
  manifest_json TEXT NOT NULL,
  expected_item_count INTEGER NOT NULL CHECK (expected_item_count >= 0),
  staged_item_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_item_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  confirmed_at INTEGER,
  applied_at INTEGER,
  failure_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS collaboration_restore_items (
  restore_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  portable_object_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (
    byte_length >= 0 AND byte_length <= 1048576
  ),
  PRIMARY KEY (restore_id, item_id),
  FOREIGN KEY (restore_id) REFERENCES collaboration_restore_jobs (id)
    ON DELETE CASCADE
) STRICT;
