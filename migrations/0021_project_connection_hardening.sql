-- Prerequisites: 0010_phase9a_collaboration.sql and the stable D1 DB binding.
-- These additive tables make automatic Work Packet rotation idempotent,
-- reclaim losing immutable-object writes, and lease owner approval work so a
-- crashed request cannot wedge Project setup. They do not delete or rewrite
-- immutable collaboration records. Retry is safe; an application rollback
-- leaves the ledger, cleanup queue, and expired leases inert.

CREATE TABLE IF NOT EXISTS collaboration_packet_rotations (
  prior_packet_id TEXT PRIMARY KEY NOT NULL
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  successor_packet_id TEXT NOT NULL UNIQUE
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    REFERENCES collaboration_projects(project_id) ON DELETE RESTRICT,
  project_version_id TEXT NOT NULL
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  knowledge_space_version_id TEXT NOT NULL
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  work_item_version_id TEXT NOT NULL
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (successor_packet_id != prior_packet_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collaboration_packet_rotations_project
  ON collaboration_packet_rotations(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_gc_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  queued_at INTEGER NOT NULL CHECK (queued_at >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at INTEGER CHECK (last_attempt_at IS NULL OR last_attempt_at >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_collaboration_gc_objects_queue
  ON collaboration_gc_objects(queued_at, object_key);

CREATE TABLE IF NOT EXISTS project_initialization_approval_claims (
  initialization_request_id TEXT PRIMARY KEY NOT NULL
    REFERENCES project_initialization_requests(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > claimed_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_project_initialization_approval_claims_expiry
  ON project_initialization_approval_claims(expires_at);
