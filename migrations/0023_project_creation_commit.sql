-- Prerequisites: 0022_project_creation_identity.sql and the stable D1 DB
-- binding.
--
-- Reservations coordinate agent consent requests. This commit ledger is the
-- shared database fence used by every Project creator, including the owner
-- API. A Project and all of its vault identities commit in the same D1 batch;
-- a concurrent creator for any matching (vault, normalized label) therefore
-- loses by primary-key constraint and its entire Project write rolls back.

CREATE TABLE IF NOT EXISTS project_creation_commits (
  vault_id TEXT NOT NULL
    REFERENCES vaults(id) ON DELETE RESTRICT,
  project_label_key TEXT NOT NULL CHECK (
    length(project_label_key) BETWEEN 1 AND 512
  ),
  creation_payload_sha256 TEXT CHECK (
    creation_payload_sha256 IS NULL
      OR length(creation_payload_sha256) = 64
  ),
  project_id TEXT NOT NULL
    REFERENCES collaboration_projects(project_id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL
    REFERENCES collaboration_work_items(work_item_id) ON DELETE RESTRICT,
  packet_id TEXT NOT NULL
    REFERENCES collaboration_records(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (vault_id, project_label_key)
) STRICT;

CREATE INDEX IF NOT EXISTS project_creation_commits_project_idx
  ON project_creation_commits(project_id, vault_id);

-- Bound agent reservations are authoritative legacy identities. Their exact
-- payload hash cannot be reconstructed in SQL from immutable R2 bodies, so
-- backfill them with a NULL hash. Later same-name creation fails closed rather
-- than silently treating an unverified legacy Project as equivalent.
INSERT OR IGNORE INTO project_creation_commits (
  vault_id, project_label_key, creation_payload_sha256,
  project_id, work_item_id, packet_id, created_at
)
SELECT reservations.vault_id, reservations.project_label_key, NULL,
  reservations.project_id, reservations.work_item_id,
  reservations.packet_id, reservations.created_at
FROM project_creation_reservations reservations
JOIN collaboration_projects projects
  ON projects.project_id = reservations.project_id
JOIN collaboration_work_items work_items
  ON work_items.work_item_id = reservations.work_item_id
 AND work_items.project_id = reservations.project_id
JOIN collaboration_records packets
  ON packets.id = reservations.packet_id
 AND packets.record_type = 'work-packet'
 AND packets.project_id = reservations.project_id
 AND packets.work_item_id = reservations.work_item_id
WHERE reservations.project_id IS NOT NULL
  AND reservations.work_item_id IS NOT NULL
  AND reservations.packet_id IS NOT NULL;
