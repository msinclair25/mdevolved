-- Prerequisites: 0006_agent_access.sql and the stable D1 DB binding.
--
-- A normal OAuth reauthorization replaces the active vault grant for the same
-- client and vault. This explicit lineage distinguishes that safe rotation from
-- an owner revocation, so one pending Project approval can follow an equivalent
-- successor without weakening explicit revocation.

CREATE TABLE IF NOT EXISTS agent_grant_replacements (
  prior_grant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES agent_grants(id) ON DELETE RESTRICT,
  successor_grant_id TEXT NOT NULL
    REFERENCES agent_grants(id) ON DELETE RESTRICT,
  replaced_at INTEGER NOT NULL CHECK (replaced_at >= 0),
  CHECK (prior_grant_id != successor_grant_id)
) STRICT;

CREATE INDEX IF NOT EXISTS agent_grant_replacements_successor_idx
  ON agent_grant_replacements(successor_grant_id, replaced_at);
