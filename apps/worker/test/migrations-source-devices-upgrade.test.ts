import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  sourceDevicesMigrationEntry,
} from "./migration-fixture";

describe("D1 source device migration", () => {
  beforeAll(async () => {
    await applyMigrations(env.DB, migrations.slice(0, -1));
    await env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at
      ) VALUES (?, 'Legacy source', 'active', 1, 2)`,
    )
      .bind("10000000-0000-4000-8000-000000000001")
      .run();
    await env.DB.prepare(
      `INSERT INTO vault_credentials (
        id, vault_id, token_hash, plugin_version, schema_version, created_at
      ) VALUES (?, ?, ?, '0.1.7', 3, 2)`,
    )
      .bind(
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000001",
        "a".repeat(64),
      )
      .run();
    await applyMigrations(env.DB, [sourceDevicesMigrationEntry]);
  });

  it("preserves legacy credentials and adds authority-free device surfaces", async () => {
    const legacy = await env.DB.prepare(
      `SELECT source_device_id FROM vault_credentials WHERE token_hash = ?`,
    )
      .bind("a".repeat(64))
      .first<{ source_device_id: string | null }>();
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('source_devices', 'quarantined_source_devices')
       ORDER BY name`,
    ).all<{ name: string }>();
    expect(legacy?.source_device_id).toBeNull();
    expect(tables.results.map((row) => row.name)).toEqual([
      "quarantined_source_devices",
      "source_devices",
    ]);
    const snapshotColumn = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM pragma_table_info('snapshot_vaults')
       WHERE name = 'source_devices_json'`,
    ).first<{ count: number }>();
    const schemas = await env.DB.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE name IN ('source_devices', 'quarantined_source_devices')
       ORDER BY name`,
    ).all<{ name: string; sql: string }>();
    expect(snapshotColumn?.count).toBe(1);
    expect(schemas.results[0]?.sql).toContain("authority_restored = 0");
    expect(schemas.results[0]?.sql).toContain("credential_restored = 0");
    expect(schemas.results[0]?.sql).toContain("connection_restored = 0");
    expect(schemas.results[1]?.sql).not.toMatch(
      /project|owner|agent_grant|session|oauth/iu,
    );
    const credentialSchema = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE name = 'vault_credentials'`,
    ).first<{ sql: string }>();
    expect(credentialSchema?.sql).toContain("ON DELETE RESTRICT");
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
