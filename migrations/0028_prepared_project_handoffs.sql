-- One owner-prepared, single-use first-Project handoff per vault.
-- This is application authorization state and is never restored from an OWD
-- content snapshot. A matching agent request may consume it once; every
-- mismatch continues through the existing exact owner-approval path.

CREATE TABLE IF NOT EXISTS prepared_project_handoffs (
  id TEXT PRIMARY KEY,
  agent_grant_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  project_label TEXT NOT NULL
    CHECK (length(project_label) BETWEEN 1 AND 120),
  project_label_key TEXT NOT NULL
    CHECK (length(project_label_key) BETWEEN 1 AND 512),
  folder_path TEXT NOT NULL CHECK (length(folder_path) <= 1024),
  folder_path_key TEXT NOT NULL CHECK (length(folder_path_key) <= 1024),
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'claiming', 'consumed', 'revoked')),
  initialization_request_id TEXT,
  prepared_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claim_expires_at INTEGER,
  consumed_at INTEGER,
  revoked_at INTEGER,
  CHECK (
    status != 'claiming'
    OR (
      initialization_request_id IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
    )
  ),
  CHECK (
    status != 'consumed'
    OR (
      initialization_request_id IS NOT NULL
      AND consumed_at IS NOT NULL
    )
  ),
  CHECK (status != 'revoked' OR revoked_at IS NOT NULL),
  FOREIGN KEY (agent_grant_id)
    REFERENCES agent_grants(id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id)
    REFERENCES vaults(id) ON DELETE CASCADE,
  FOREIGN KEY (initialization_request_id)
    REFERENCES project_initialization_requests(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS prepared_project_handoffs_agent_active_idx
  ON prepared_project_handoffs(agent_grant_id)
  WHERE status IN ('prepared', 'claiming');

CREATE UNIQUE INDEX IF NOT EXISTS prepared_project_handoffs_vault_active_idx
  ON prepared_project_handoffs(vault_id)
  WHERE status IN ('prepared', 'claiming');

CREATE INDEX IF NOT EXISTS prepared_project_handoffs_request_idx
  ON prepared_project_handoffs(initialization_request_id, status);
