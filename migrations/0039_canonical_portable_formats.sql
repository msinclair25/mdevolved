-- MD9 adds canonical public format markers without rewriting historical rows
-- or weakening the original table constraints. Existing encrypted objects keep
-- their former markers; new application code writes MDevolved markers into the
-- additive columns while the frozen internal format_version remains unchanged.
--
-- Recovery: deploy the prior application while leaving these columns intact.
-- Old code ignores them and continues reading format_version. Never down-migrate,
-- rewrite encrypted objects, or copy grants, credentials, actors, leases, OAuth
-- state, sessions, or live consent during portable-format recovery.

ALTER TABLE backup_artifacts ADD COLUMN portable_format_version TEXT NOT NULL
  DEFAULT 'owd-backup-v1'
  CHECK (portable_format_version IN ('owd-backup-v1', 'mdevolved-backup-v1'));

ALTER TABLE workspace_snapshots ADD COLUMN portable_format_version TEXT NOT NULL
  DEFAULT 'owd-snapshot-v2'
  CHECK (
    portable_format_version IN ('owd-snapshot-v2', 'mdevolved-snapshot-v3')
  );
