-- Prerequisite: 0008_snapshot_recovery.sql.
--
-- Forward action: add presentation-only archive records for workspace
-- snapshots. Archiving does not change snapshot membership, pin state,
-- retention eligibility, integrity state, restore/download behavior, or any
-- D1/R2 recovery object.
--
-- Recovery: application rollback may ignore this table. Do not drop the table
-- or rewrite migration history. Unarchive through the supported API if a
-- snapshot should return to the primary timeline.

CREATE TABLE IF NOT EXISTS snapshot_archives (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  archived_at INTEGER NOT NULL CHECK (archived_at >= 0),
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots (id)
    ON DELETE CASCADE
) STRICT;
