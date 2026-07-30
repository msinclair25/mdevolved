-- Prerequisites: 0010_phase9a_collaboration.sql and the stable D1 DB binding.
--
-- Owner-only Projects remain fully visible to their authenticated owner but
-- never enter agent discovery, exact lookup, or Project selection. Existing
-- Projects remain discoverable until the owner explicitly changes this
-- boundary.

ALTER TABLE collaboration_projects
  ADD COLUMN agent_visibility TEXT NOT NULL DEFAULT 'discoverable'
  CHECK (agent_visibility IN ('discoverable', 'owner-only'));

CREATE INDEX IF NOT EXISTS collaboration_projects_agent_visibility_idx
  ON collaboration_projects(status, agent_visibility, created_at);
