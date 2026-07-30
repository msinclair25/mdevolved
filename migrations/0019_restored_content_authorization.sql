-- Prerequisites: 0018_invited_owner_claim.sql and a reviewed D1 backup.
--
-- Forward action: keep content copied into a vault by a recovery restore
-- outside every agent grant unless the owner explicitly approves that exact
-- restore source during OAuth consent. Existing grants intentionally receive
-- no rows and therefore fail closed for restored note content.
--
-- Recovery: this migration is additive. Rolling application code back leaves
-- approval rows inert, but the prior code does not enforce this boundary and
-- must not be redeployed after an isolation incident. Do not synthesize
-- approval rows or infer approval from the target vault grant.

CREATE TABLE IF NOT EXISTS restored_note_lineage (
  restore_id TEXT NOT NULL,
  target_vault_id TEXT NOT NULL,
  path_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
  PRIMARY KEY (restore_id, path_key),
  FOREIGN KEY (restore_id) REFERENCES restore_jobs (id) ON DELETE RESTRICT,
  FOREIGN KEY (target_vault_id) REFERENCES vaults (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS restored_note_lineage_target_path_idx
  ON restored_note_lineage (target_vault_id, path_key, restore_id);

INSERT OR IGNORE INTO restored_note_lineage (
  restore_id, target_vault_id, path_key, recorded_at
)
SELECT entries.restore_id, jobs.target_vault_id, entries.path_key,
  COALESCE(entries.applied_at, jobs.applied_at, jobs.updated_at)
FROM restore_entries entries
JOIN restore_jobs jobs ON jobs.id = entries.restore_id
WHERE entries.status = 'applied' AND jobs.status = 'applied';

-- Plaintext restore entries expire normally. Prefer the exact retained source
-- generation when it is still complete; otherwise conservatively quarantine
-- the verified post-restore target generation. The final current-generation
-- fallback ensures an active target fails closed even if older derived
-- generations were already reclaimed. A conservative superset may require
-- fresh consent for a pre-existing target note, but never exposes a restored
-- note by guessing.
INSERT OR IGNORE INTO restored_note_lineage (
  restore_id, target_vault_id, path_key, recorded_at
)
SELECT jobs.id, jobs.target_vault_id, source_notes.path_key,
  COALESCE(jobs.applied_at, jobs.updated_at)
FROM restore_jobs jobs
JOIN materialized_notes source_notes
  ON source_notes.generation_id = jobs.source_generation_id
  AND source_notes.vault_id = jobs.source_vault_id
WHERE jobs.status = 'applied'
  AND jobs.expected_note_count > 0
  AND (
    SELECT COUNT(*)
    FROM materialized_notes complete_source
    WHERE complete_source.generation_id = jobs.source_generation_id
      AND complete_source.vault_id = jobs.source_vault_id
  ) = jobs.expected_note_count
  AND NOT EXISTS (
    SELECT 1 FROM restored_note_lineage existing
    WHERE existing.restore_id = jobs.id
  );

INSERT OR IGNORE INTO restored_note_lineage (
  restore_id, target_vault_id, path_key, recorded_at
)
SELECT jobs.id, jobs.target_vault_id, target_notes.path_key,
  COALESCE(jobs.applied_at, jobs.updated_at)
FROM restore_jobs jobs
JOIN materialized_notes target_notes
  ON target_notes.generation_id = jobs.verified_generation_id
  AND target_notes.vault_id = jobs.target_vault_id
WHERE jobs.status = 'applied'
  AND jobs.expected_note_count > 0
  AND NOT EXISTS (
    SELECT 1 FROM restored_note_lineage existing
    WHERE existing.restore_id = jobs.id
  );

INSERT OR IGNORE INTO restored_note_lineage (
  restore_id, target_vault_id, path_key, recorded_at
)
SELECT jobs.id, jobs.target_vault_id, current_notes.path_key,
  COALESCE(jobs.applied_at, jobs.updated_at)
FROM restore_jobs jobs
JOIN current_materializations current
  ON current.vault_id = jobs.target_vault_id
JOIN materialized_notes current_notes
  ON current_notes.generation_id = current.generation_id
  AND current_notes.vault_id = current.vault_id
WHERE jobs.status = 'applied'
  AND jobs.expected_note_count > 0
  AND NOT EXISTS (
    SELECT 1 FROM restored_note_lineage existing
    WHERE existing.restore_id = jobs.id
  );

CREATE TABLE IF NOT EXISTS agent_grant_restore_sources (
  grant_id TEXT NOT NULL,
  restore_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  PRIMARY KEY (grant_id, restore_id),
  FOREIGN KEY (grant_id) REFERENCES agent_grants (id) ON DELETE CASCADE,
  FOREIGN KEY (restore_id) REFERENCES restore_jobs (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS agent_grant_restore_sources_restore_idx
  ON agent_grant_restore_sources (restore_id, grant_id);
