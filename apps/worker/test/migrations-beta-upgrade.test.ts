import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  betaHardeningMigrationEntry,
  preBetaMigrations,
} from "./migration-fixture";

describe("D1 beta-hardening upgrade", () => {
  it("upgrades a populated 0011 database to 0012 without changing prior data", async () => {
    await applyMigrations(env.DB, preBetaMigrations);
    const vaultId = "10000000-0000-4000-8000-000000000012";
    const restoreId = "20000000-0000-4000-8000-000000000012";

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_metadata (key, value)
         VALUES ('pre_beta_fixture', 'phase-9b')`,
      ),
      env.DB.prepare(
        `INSERT INTO vaults (
            id, display_name, status, created_at, paired_at
          ) VALUES (?, 'Pre-beta vault', 'active', 200, 201)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO restore_jobs (
            id, target_vault_id, source_backup_id, source_vault_id,
            source_vault_name, source_generation_id, status,
            expected_note_count, expected_bytes, created_at, updated_at,
            expires_at
          ) VALUES (?, ?, ?, ?, 'Imported vault', ?, 'staging', 0, 0, 210,
            210, 300)`,
      ).bind(
        restoreId,
        vaultId,
        "30000000-0000-4000-8000-000000000012",
        "40000000-0000-4000-8000-000000000012",
        "50000000-0000-4000-8000-000000000012",
      ),
    ]);

    await applyMigrations(env.DB, [betaHardeningMigrationEntry]);

    const metadata = await env.DB.prepare(
      `SELECT value FROM app_metadata WHERE key = 'pre_beta_fixture'`,
    ).first<{ value: string }>();
    const restore = await env.DB.prepare(
      `SELECT status, materialization_job_id
       FROM restore_jobs WHERE id = ?`,
    )
      .bind(restoreId)
      .first<{
        materialization_job_id: string | null;
        status: string;
      }>();
    const jobTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'materialization_jobs'`,
    ).first<{ name: string }>();
    const gcTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'materialization_gc_objects'`,
    ).first<{ name: string }>();
    const historicalGrantIndex = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name = 'collaboration_records_historical_grant_received_idx'`,
    ).first<{ name: string }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(metadata?.value).toBe("phase-9b");
    expect(restore).toEqual({
      materialization_job_id: null,
      status: "staging",
    });
    expect(jobTable?.name).toBe("materialization_jobs");
    expect(gcTable?.name).toBe("materialization_gc_objects");
    expect(historicalGrantIndex?.name).toBe(
      "collaboration_records_historical_grant_received_idx",
    );
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
