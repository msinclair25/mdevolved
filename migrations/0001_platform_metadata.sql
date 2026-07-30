-- Phase 1 establishes only deployment metadata. Authentication and vault tables
-- are introduced by later, independently reviewed migrations.
CREATE TABLE app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

INSERT INTO app_metadata (key, value)
VALUES ('schema_version', '1');
