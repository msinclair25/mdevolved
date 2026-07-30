import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  phase9bMigration,
  priorReleaseMigrations,
} from "./migration-fixture";

describe("D1 prior-release upgrade", () => {
  it("upgrades a Phase 9A fixture to 0011 without changing prior data", async () => {
    await applyMigrations(env.DB, priorReleaseMigrations);
    const vaultId = "00000000-0000-4000-8000-000000000009";
    const snapshotId = "00000000-0000-4000-8000-000000000008";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_metadata (key, value)
           VALUES ('prior_release_fixture', 'phase-8')`,
      ),
      env.DB.prepare(
        `INSERT INTO vaults (
             id, display_name, status, created_at, paired_at
           ) VALUES (?, 'Prior release vault', 'active', 100, 101)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO workspace_snapshots (
             id, portable_snapshot_id, format_version, origin, scope, status,
             integrity_status, recipient_fingerprint, capture_started_at,
             capture_completed_at, vault_count, item_count, logical_bytes,
             changed_item_count, processed_object_count, total_object_count,
             newly_stored_bytes, included_sections, unavailable_sections,
             manifest_portable_object_id, pinned, created_at, completed_at,
             verified_at
           ) VALUES (
             ?, 'portable-phase-8', 'owd-snapshot-v2', 'created', 'selected',
             'ready', 'verified', 'recipient-phase-8', 110, 120, 1, 0, 0,
             0, 0, 0, 0, '["notes"]', '[]', 'manifest-phase-8', 1, 110,
             120, 120
           )`,
      ).bind(snapshotId),
      env.DB.prepare(
        `INSERT INTO snapshot_archives (snapshot_id, archived_at)
           VALUES (?, 130)`,
      ).bind(snapshotId),
    ]);

    await applyMigrations(env.DB, [phase9bMigration]);
    await applyMigrations(env.DB, [phase9bMigration]);

    const metadata = await env.DB.prepare(
      `SELECT value FROM app_metadata WHERE key = 'prior_release_fixture'`,
    ).first<{ value: string }>();
    const vault = await env.DB.prepare(
      "SELECT display_name, status FROM vaults WHERE id = ?",
    )
      .bind(vaultId)
      .first<{ display_name: string; status: string }>();
    const snapshot = await env.DB.prepare(
      `SELECT snapshots.status, snapshots.integrity_status, archives.archived_at
       FROM workspace_snapshots AS snapshots
       JOIN snapshot_archives AS archives
         ON archives.snapshot_id = snapshots.id
       WHERE snapshots.id = ?`,
    )
      .bind(snapshotId)
      .first<{
        archived_at: number;
        integrity_status: string;
        status: string;
      }>();
    const collaborationTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'collaboration_records'`,
    ).first<{ name: string }>();
    const grantCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_grants",
    ).first<{ count: number }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(metadata?.value).toBe("phase-8");
    expect(vault).toEqual({
      display_name: "Prior release vault",
      status: "active",
    });
    expect(snapshot).toEqual({
      archived_at: 130,
      integrity_status: "verified",
      status: "ready",
    });
    expect(collaborationTable?.name).toBe("collaboration_records");
    const initializationTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'project_initialization_requests'`,
    ).first<{ name: string }>();
    expect(initializationTable?.name).toBe("project_initialization_requests");
    expect(grantCount?.count).toBe(0);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
