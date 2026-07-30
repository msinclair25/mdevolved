-- Prerequisites: 0011_phase9b_agent_first.sql,
-- 0022_project_creation_identity.sql, and the stable D1 DB binding.
--
-- OWD MCP remains read-only. This additive table records only the advisory
-- identity used to coordinate separate local Obsidian CLI, skill, shell, or
-- filesystem access. The first approved Project agent for a vault wins by an
-- atomic INSERT OR IGNORE inside owner approval. It never grants owner
-- authority or a server-side mutation capability.

CREATE TABLE IF NOT EXISTS vault_local_writer_assignments (
  vault_id TEXT PRIMARY KEY NOT NULL
    REFERENCES vaults(id) ON DELETE RESTRICT,
  oauth_client_id TEXT NOT NULL,
  initialization_request_id TEXT NOT NULL
    REFERENCES project_initialization_requests(id) ON DELETE RESTRICT,
  assignment_basis TEXT NOT NULL CHECK (
    assignment_basis IN ('project-creator', 'first-project-agent')
  ),
  assigned_at INTEGER NOT NULL CHECK (assigned_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= assigned_at)
) STRICT;

CREATE INDEX IF NOT EXISTS vault_local_writer_assignments_client_idx
  ON vault_local_writer_assignments(oauth_client_id, vault_id);

-- Releases before 0026 already have durable approved initialization history.
-- Backfill the earliest approved request available for each vault. rowid is
-- only a deterministic tie-breaker for historical second-resolution times;
-- all new assignments are fenced atomically during approval.
WITH candidates AS (
  SELECT
    requests.vault_id,
    requests.oauth_client_id,
    requests.id AS initialization_request_id,
    CASE WHEN EXISTS (
      SELECT 1
      FROM project_creation_reservations reservations
      WHERE reservations.vault_id = requests.vault_id
        AND reservations.project_id = requests.result_project_id
        AND reservations.creator_initialization_request_id = requests.id
    )
      THEN 'project-creator'
      ELSE 'first-project-agent'
    END AS assignment_basis,
    COALESCE(requests.decided_at, requests.created_at) AS assigned_at,
    requests.rowid AS request_order,
    ROW_NUMBER() OVER (
      PARTITION BY requests.vault_id
      ORDER BY
        COALESCE(requests.decided_at, requests.created_at),
        requests.rowid
    ) AS assignment_rank
  FROM project_initialization_requests requests
  JOIN collaboration_projects projects
    ON projects.project_id = requests.result_project_id
  WHERE requests.status = 'approved'
    AND requests.result_project_id IS NOT NULL
)
INSERT OR IGNORE INTO vault_local_writer_assignments (
  vault_id, oauth_client_id, initialization_request_id, assignment_basis,
  assigned_at, updated_at
)
SELECT
  vault_id, oauth_client_id, initialization_request_id, assignment_basis,
  assigned_at, assigned_at
FROM candidates
WHERE assignment_rank = 1;
