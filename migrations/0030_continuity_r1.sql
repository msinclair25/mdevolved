-- R1 lead-substitution continuity is additive and forward-only.
-- Application rollback leaves these tables, triggers, and immutable R2 bodies
-- in place. Restored Continuity Points never create rows in the lease or
-- checkpoint-receipt tables.

CREATE TABLE IF NOT EXISTS project_lead_leases (
  project_id TEXT PRIMARY KEY NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  holder_grant_id TEXT NOT NULL,
  holder_client_id TEXT NOT NULL,
  lead_identity_json TEXT NOT NULL CHECK (json_valid(lead_identity_json)),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  claim_authority_key TEXT NOT NULL,
  claim_idempotency_key_sha256 TEXT NOT NULL
    CHECK (length(claim_idempotency_key_sha256) = 64),
  claim_request_sha256 TEXT NOT NULL
    CHECK (length(claim_request_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  renewed_at INTEGER NOT NULL CHECK (renewed_at >= claimed_at),
  expires_at INTEGER NOT NULL CHECK (expires_at > renewed_at),
  revoked_at INTEGER,
  CHECK (
    (status = 'active' AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (holder_grant_id) REFERENCES collaboration_grants (id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_lead_leases_holder_idx
  ON project_lead_leases (
    holder_grant_id, holder_client_id, status, expires_at
  );

CREATE TABLE IF NOT EXISTS project_continuity_points (
  continuity_point_id TEXT PRIMARY KEY NOT NULL,
  portable_object_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  project_version_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  work_item_version_id TEXT NOT NULL,
  knowledge_space_version_id TEXT NOT NULL,
  work_packet_id TEXT NOT NULL,
  previous_continuity_point_id TEXT,
  parent_key TEXT NOT NULL,
  source_lease_id TEXT,
  source_fencing_token INTEGER NOT NULL CHECK (source_fencing_token > 0),
  producer_client_id TEXT,
  body_object_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 1048576),
  acknowledged_at INTEGER NOT NULL CHECK (acknowledged_at >= 0),
  restored_at INTEGER,
  live_fence_valid INTEGER NOT NULL,
  live_context_valid INTEGER NOT NULL,
  live_parent_valid INTEGER NOT NULL,
  UNIQUE (project_id, continuity_point_id),
  UNIQUE (project_id, parent_key),
  CONSTRAINT project_lead_lease_invalid CHECK (live_fence_valid = 1),
  CONSTRAINT project_checkpoint_context_stale CHECK (live_context_valid = 1),
  CONSTRAINT project_continuity_point_conflict CHECK (live_parent_valid = 1),
  CHECK (
    (previous_continuity_point_id IS NULL AND parent_key = 'root') OR
    (previous_continuity_point_id IS NOT NULL AND parent_key = previous_continuity_point_id)
  ),
  CHECK (
    (restored_at IS NULL AND source_lease_id IS NOT NULL AND producer_client_id IS NOT NULL) OR
    (restored_at IS NOT NULL AND source_lease_id IS NULL AND producer_client_id IS NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id) REFERENCES collaboration_work_items (work_item_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (work_item_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (knowledge_space_version_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (work_packet_id) REFERENCES collaboration_records (id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id, previous_continuity_point_id)
    REFERENCES project_continuity_points (project_id, continuity_point_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_continuity_points_latest_idx
  ON project_continuity_points (
    project_id, acknowledged_at DESC, continuity_point_id DESC
  );

CREATE TABLE IF NOT EXISTS continuity_point_dependencies (
  continuity_point_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  dependency_kind TEXT NOT NULL CHECK (
    dependency_kind IN ('record', 'evidence')
  ),
  PRIMARY KEY (continuity_point_id, dependency_id),
  FOREIGN KEY (continuity_point_id)
    REFERENCES project_continuity_points (continuity_point_id)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS continuity_point_dependencies_lookup_idx
  ON continuity_point_dependencies (dependency_id, dependency_kind);

CREATE TABLE IF NOT EXISTS continuity_checkpoint_receipts (
  authority_key TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL
    CHECK (length(idempotency_key_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  continuity_point_id TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  previous_continuity_point_id TEXT,
  project_id TEXT NOT NULL,
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  PRIMARY KEY (authority_key, idempotency_key_sha256),
  FOREIGN KEY (continuity_point_id)
    REFERENCES project_continuity_points (continuity_point_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES collaboration_projects (project_id)
    ON DELETE RESTRICT
) STRICT;
