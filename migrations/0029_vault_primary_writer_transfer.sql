-- Prerequisites: 0006_agent_access.sql, 0010_phase9a_collaboration.sql,
-- 0026_vault_primary_writer.sql, and the stable D1 DB binding.
--
-- OWD MCP remains read-only. This append-only ledger records an authenticated
-- owner's explicit transfer of the advisory local-vault writer assignment to
-- an already active Project participant. The assignment update and ledger
-- insert are performed in one D1 batch by the Worker.

CREATE TABLE IF NOT EXISTS vault_local_writer_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  vault_id TEXT NOT NULL
    REFERENCES vaults(id) ON DELETE RESTRICT,
  from_oauth_client_id TEXT NOT NULL,
  to_oauth_client_id TEXT NOT NULL,
  target_agent_grant_id TEXT NOT NULL
    REFERENCES agent_grants(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  transferred_at INTEGER NOT NULL CHECK (transferred_at >= 0),
  CHECK (from_oauth_client_id != to_oauth_client_id)
) STRICT;

CREATE INDEX IF NOT EXISTS vault_local_writer_transfers_vault_idx
  ON vault_local_writer_transfers(vault_id, transferred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS vault_local_writer_transfers_target_idx
  ON vault_local_writer_transfers(target_agent_grant_id, transferred_at DESC);
