import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  compoundingDraftsMigrationEntry,
  migrations,
} from "./migration-fixture";

describe("D1 compounding migration", () => {
  beforeAll(async () => {
    await applyMigrations(
      env.DB,
      migrations.slice(0, migrations.indexOf(compoundingDraftsMigrationEntry)),
    );
    await env.DB.prepare(
      "INSERT INTO app_metadata (key, value) VALUES ('m3_fixture', 'preserved')",
    ).run();
    await applyMigrations(env.DB, [compoundingDraftsMigrationEntry]);
    await applyMigrations(env.DB, [compoundingDraftsMigrationEntry]);
  });

  it("upgrades a populated 0034 database and remains idempotent", async () => {
    const metadata = await env.DB.prepare(
      "SELECT value FROM app_metadata WHERE key = 'm3_fixture'",
    ).first<{ value: string }>();
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name LIKE 'compounding_%' ORDER BY name`,
    ).all<{ name: string }>();
    expect(metadata?.value).toBe("preserved");
    expect(tables.results.map((row) => row.name)).toEqual([
      "compounding_checkpoint_bindings",
      "compounding_draft_action_claims",
      "compounding_drafts",
      "compounding_mutation_receipts",
      "compounding_observations",
      "compounding_records",
    ]);
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("keeps restored records authority-free and requires quarantine identity", async () => {
    const recordId = "00000000-0000-4035-8000-000000000001";
    await expect(
      env.DB.prepare(
        `INSERT INTO compounding_records (
           record_id, record_type, portable_object_id, fingerprint,
           body_object_key, content_sha256, byte_length, created_at,
           restored_at, restore_state, restored_authority_allowed, draft_id
         ) VALUES (?, 'draft-version', ?, ?, ?, ?, 2, 1, 2, 'quarantined', 1, ?)`,
      )
        .bind(
          recordId,
          "00000000-0000-4035-8000-000000000002",
          "a".repeat(64),
          "compounding/authority.json",
          "b".repeat(64),
          "00000000-0000-4035-8000-000000000003",
        )
        .run(),
    ).rejects.toThrow();
  });
});
