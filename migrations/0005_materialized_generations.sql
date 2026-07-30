-- Prerequisite: 0003_vault_pairing.sql plus D1 and R2 bindings named DB and
-- VAULT_STORAGE. This additive migration creates the derived, rebuildable
-- browse/search projection. YAOS/Yjs Durable Object state remains canonical.
--
-- Publication invariant: note objects and projection rows are staged under a
-- fresh generation ID. Readers only follow current_materializations, which is
-- changed in the same D1 batch that marks a complete generation published.
-- A failed or interrupted generation therefore cannot become visible.
--
-- Recovery: roll application code back without dropping these tables or R2
-- objects. The prior current_materializations pointer remains readable. Failed
-- generation rows and orphaned immutable objects may be reclaimed only by a
-- separately reviewed retention job after a known-good generation exists.

CREATE TABLE IF NOT EXISTS materialization_generations (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL,
  source_state_vector_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'published', 'failed')),
  note_count INTEGER NOT NULL CHECK (note_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  manifest_key TEXT NOT NULL,
  manifest_sha256 TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_code TEXT,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS materialization_generations_vault_idx
  ON materialization_generations (vault_id, created_at DESC);

CREATE TABLE IF NOT EXISTS current_materializations (
  vault_id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES materialization_generations (id)
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS materialized_notes (
  generation_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  modified_at INTEGER,
  PRIMARY KEY (generation_id, path_key),
  FOREIGN KEY (generation_id) REFERENCES materialization_generations (id)
    ON DELETE CASCADE,
  FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS materialized_notes_browse_idx
  ON materialized_notes (vault_id, generation_id, path_key);

CREATE VIRTUAL TABLE IF NOT EXISTS materialized_note_search USING fts5(
  generation_id UNINDEXED,
  vault_id UNINDEXED,
  path_key UNINDEXED,
  path,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
