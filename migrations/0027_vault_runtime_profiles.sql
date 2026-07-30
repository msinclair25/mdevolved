-- A paired plugin may report a validated vault-runtime compatibility profile.
-- The profile can only narrow agent visibility and supply setup defaults. It is
-- never an OAuth grant, Project identity, or owner approval.
--
-- Existing vaults remain unprofiled. A new plugin confirmation atomically marks
-- the library stale and queues a rebuild, so a profiled vault cannot serve an
-- older generation whose private-note flags were not projected.

ALTER TABLE vault_sync_states
  ADD COLUMN runtime_profile_json TEXT;

ALTER TABLE materialized_notes
  ADD COLUMN agent_private INTEGER NOT NULL DEFAULT 0
  CHECK (agent_private IN (0, 1));
