import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  workingProfileSkillsMigrationEntry,
} from "./migration-fixture";

describe("D1 working-profile migration", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB, migrations.slice(0, -1));
    await env.DB.prepare(
      "INSERT INTO app_metadata (key, value) VALUES ('m2_fixture', 'preserved')",
    ).run();

    await applyMigrations(env.DB, [workingProfileSkillsMigrationEntry]);
    await applyMigrations(env.DB, [workingProfileSkillsMigrationEntry]);
  });

  it("upgrades a populated 0033 database without changing prior data", async () => {
    const metadata = await env.DB.prepare(
      "SELECT value FROM app_metadata WHERE key = 'm2_fixture'",
    ).first<{ value: string }>();
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'working_profile%'`,
    ).all<{ name: string }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(metadata?.value).toBe("preserved");
    expect(tables.results.map((row) => row.name).sort()).toEqual([
      "working_profile_mutation_receipts",
      "working_profile_records",
    ]);
    expect(foreignKeyFailures.results).toEqual([]);
  });

  it("enforces authority-free quarantine and uses projection indexes", async () => {
    const quarantinedId = "00000000-0000-4000-8000-000000000034";
    await env.DB.prepare(
      `INSERT INTO working_profile_records (
           record_id, record_type, portable_object_id, preference_id,
           dependencies_json, body_object_key, content_sha256, byte_length,
           created_at, restored_at, restore_state, restored_authority_allowed
         ) VALUES (?, 'preference-version', ?, ?, '[]', ?, ?, 2, 10, 11,
                   'quarantined', 0)`,
    )
      .bind(
        quarantinedId,
        "00000000-0000-4000-8000-000000000035",
        "00000000-0000-4000-8000-000000000036",
        "working-profile/quarantine.json",
        "a".repeat(64),
      )
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO working_preferences (
             preference_id, preference_key, current_record_id,
             record_restore_state, status, value, source_label, updated_at
           ) VALUES (?, 'test', ?, 'live', 'active', 'value', 'Owner', 12)`,
      )
        .bind("00000000-0000-4000-8000-000000000036", quarantinedId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO working_profile_records (
             record_id, record_type, portable_object_id, preference_id,
             dependencies_json, body_object_key, content_sha256, byte_length,
             created_at, restored_at, restore_state, restored_authority_allowed
           ) VALUES (?, 'preference-version', ?, ?, '[]', ?, ?, 2, 10, 11,
                     'quarantined', 1)`,
      )
        .bind(
          "00000000-0000-4000-8000-000000000037",
          "00000000-0000-4000-8000-000000000038",
          "00000000-0000-4000-8000-000000000039",
          "working-profile/authority.json",
          "b".repeat(64),
        )
        .run(),
    ).rejects.toThrow();

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT preference_key FROM working_preferences
         WHERE project_id = ? AND status = 'active' ORDER BY preference_key`,
    )
      .bind("00000000-0000-4000-8000-000000000040")
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toMatch(
      /working_preferences_live_project_idx/u,
    );
  });
});
