-- Prerequisites: 0011_phase9b_agent_first.sql,
-- 0020_onboarding_lifecycle.sql, and the stable D1 DB binding.
--
-- Project creation identity is vault-wide rather than OAuth-client-local.
-- Multiple agents may retain separate consent requests, but every request for
-- the same case-insensitive Project name converges on one durable reservation.
-- The creator request is a fencing identity: only its atomically committed
-- project_initialization_projects receipt may bind the reservation. Followers
-- can then receive their own exact Project grant without creating another
-- Project.

CREATE TABLE IF NOT EXISTS project_creation_reservations (
  vault_id TEXT NOT NULL
    REFERENCES vaults(id) ON DELETE RESTRICT,
  project_label_key TEXT NOT NULL CHECK (
    length(project_label_key) BETWEEN 1 AND 512
  ),
  creator_initialization_request_id TEXT
    REFERENCES project_initialization_requests(id) ON DELETE RESTRICT,
  creation_contract_sha256 TEXT CHECK (
    creation_contract_sha256 IS NULL
      OR length(creation_contract_sha256) = 64
  ),
  project_id TEXT
    REFERENCES collaboration_projects(project_id) ON DELETE RESTRICT,
  work_item_id TEXT
    REFERENCES collaboration_work_items(work_item_id) ON DELETE RESTRICT,
  packet_id TEXT
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (vault_id, project_label_key),
  CHECK (
    (
      project_id IS NULL
      AND work_item_id IS NULL
      AND packet_id IS NULL
    )
    OR (
      project_id IS NOT NULL
      AND work_item_id IS NOT NULL
      AND packet_id IS NOT NULL
      AND creator_initialization_request_id IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX IF NOT EXISTS project_creation_reservations_creator_idx
  ON project_creation_reservations(creator_initialization_request_id);

CREATE INDEX IF NOT EXISTS project_creation_reservations_project_idx
  ON project_creation_reservations(project_id);

CREATE TABLE IF NOT EXISTS project_creation_requests (
  initialization_request_id TEXT PRIMARY KEY NOT NULL
    REFERENCES project_initialization_requests(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  project_label_key TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (vault_id, project_label_key)
    REFERENCES project_creation_reservations(vault_id, project_label_key)
    ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS project_creation_requests_identity_idx
  ON project_creation_requests(vault_id, project_label_key, created_at);

-- Existing agent-created Projects already have an atomic creation receipt.
-- Prefer the oldest receipt as the canonical identity when a polluted legacy
-- cell contains duplicates; retain every historical Project for owner repair.
WITH legacy_creations AS (
  SELECT requests.id, requests.vault_id, requests.created_at,
    LOWER(TRIM(CAST(
      json_extract(requests.draft_json, '$.project.label') AS TEXT
    ))) AS project_label_key,
    receipts.project_id, receipts.work_item_id, receipts.packet_id,
    ROW_NUMBER() OVER (
      PARTITION BY requests.vault_id, LOWER(TRIM(CAST(
        json_extract(requests.draft_json, '$.project.label') AS TEXT
      )))
      ORDER BY
        CASE WHEN receipts.project_id IS NULL THEN 1 ELSE 0 END,
        receipts.created_at,
        requests.created_at,
        requests.id
    ) AS identity_rank
  FROM project_initialization_requests requests
  LEFT JOIN project_initialization_projects receipts
    ON receipts.initialization_request_id = requests.id
  WHERE requests.semantic_key_sha256 IS NOT NULL
    AND json_valid(requests.draft_json)
    AND COALESCE(
      json_extract(requests.draft_json, '$.requestKind'),
      'create'
    ) = 'create'
    AND LENGTH(TRIM(CAST(
      json_extract(requests.draft_json, '$.project.label') AS TEXT
    ))) BETWEEN 1 AND 120
)
INSERT OR IGNORE INTO project_creation_reservations (
  vault_id, project_label_key, creator_initialization_request_id,
  creation_contract_sha256, project_id, work_item_id, packet_id,
  created_at, updated_at
)
SELECT vault_id, project_label_key,
  CASE WHEN project_id IS NULL THEN NULL ELSE id END,
  NULL, project_id, work_item_id, packet_id, created_at, created_at
FROM legacy_creations
WHERE identity_rank = 1;

INSERT OR IGNORE INTO project_creation_requests (
  initialization_request_id, vault_id, project_label_key, created_at
)
SELECT requests.id, requests.vault_id,
  LOWER(TRIM(CAST(
    json_extract(requests.draft_json, '$.project.label') AS TEXT
  ))),
  requests.created_at
FROM project_initialization_requests requests
WHERE requests.semantic_key_sha256 IS NOT NULL
  AND json_valid(requests.draft_json)
  AND COALESCE(
    json_extract(requests.draft_json, '$.requestKind'),
    'create'
  ) = 'create'
  AND EXISTS (
    SELECT 1 FROM project_creation_reservations reservations
    WHERE reservations.vault_id = requests.vault_id
      AND reservations.project_label_key = LOWER(TRIM(CAST(
        json_extract(requests.draft_json, '$.project.label') AS TEXT
      )))
  );
