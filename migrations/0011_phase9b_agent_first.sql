-- Prerequisites: 0010_phase9a_collaboration.sql and the production migration
-- command completed before ordinary Worker traffic.
--
-- Forward action: add private, expiring Project-initialization requests,
-- an idempotent request-to-Project receipt, and authorization-bound client
-- labels for collaboration activity projections.
--
-- Authorization invariant: initialization is request-only bootstrap state.
-- It creates no Project or grant until an authenticated owner approves the
-- exact client, vault, folder, objective, and Project capabilities. The
-- resulting collaboration grant is separate from the reusable vault grant.
--
-- Recovery: pending/rejected/expired bootstrap requests and all grants are
-- excluded from snapshots. Approved Projects continue to use the Phase 9A
-- Approved or Approved-plus-Unvetted recovery contract. Application rollback
-- may ignore these additive tables; never rewrite migration history.
--
-- Operational invariant: this migration is applied by the release workflow.
-- Ordinary request handlers perform no schema discovery, DDL, or migration.

CREATE TABLE IF NOT EXISTS project_initialization_requests (
  id TEXT PRIMARY KEY NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  bootstrap_agent_grant_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_origin TEXT NOT NULL,
  audience TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  vault_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  folder_path_key TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  draft_sha256 TEXT NOT NULL CHECK (length(draft_sha256) = 64),
  authorization_url TEXT NOT NULL,
  requested_scopes_json TEXT NOT NULL,
  url_elicitation_supported INTEGER NOT NULL
    CHECK (url_elicitation_supported IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approving', 'approved', 'rejected', 'expired')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  decided_at INTEGER,
  result_project_id TEXT,
  result_work_item_id TEXT,
  result_packet_id TEXT,
  result_collaboration_grant_id TEXT,
  CHECK (
    (status = 'approved' AND result_project_id IS NOT NULL
      AND result_work_item_id IS NOT NULL AND result_packet_id IS NOT NULL
      AND result_collaboration_grant_id IS NOT NULL)
    OR status != 'approved'
  ),
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_initialization_status_idx
  ON project_initialization_requests (status, expires_at, created_at);

CREATE INDEX IF NOT EXISTS project_initialization_bootstrap_idx
  ON project_initialization_requests (
    bootstrap_agent_grant_id, created_at DESC
  );

CREATE TABLE IF NOT EXISTS project_initialization_projects (
  initialization_request_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (initialization_request_id)
    REFERENCES project_initialization_requests (id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id)
    REFERENCES collaboration_projects (project_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id)
    REFERENCES collaboration_work_items (work_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (packet_id)
    REFERENCES collaboration_records (id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS collaboration_grant_clients (
  grant_id TEXT PRIMARY KEY NOT NULL,
  source_agent_grant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (grant_id)
    REFERENCES collaboration_grants (id) ON DELETE RESTRICT
) STRICT;
