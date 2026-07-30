-- Prerequisite: 0003_vault_pairing.sql and a D1 binding named DB.
-- This additive table binds each pairing grant to the exact deployment origin
-- that created its Obsidian deep link.
--
-- Failure behavior: a missing origin row makes the grant unusable; it never
-- widens access. Pairing grant creation inserts both records in one D1 batch.
--
-- Recovery: retrying is safe because the table is created with IF NOT EXISTS.
-- Roll application code back without dropping the table.

CREATE TABLE IF NOT EXISTS pairing_grant_origins (
  grant_hash TEXT PRIMARY KEY NOT NULL,
  deployment_origin TEXT NOT NULL,
  FOREIGN KEY (grant_hash) REFERENCES pairing_grants (grant_hash) ON DELETE CASCADE
) STRICT;
