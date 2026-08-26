import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  sourceDescriptorsMigrationEntry,
} from "./migration-fixture";

describe("D1 source descriptor migration", () => {
  beforeAll(async () => {
    await applyMigrations(
      env.DB,
      migrations.slice(0, migrations.indexOf(sourceDescriptorsMigrationEntry)),
    );
    await env.DB.prepare(
      "INSERT INTO app_metadata (key, value) VALUES ('md2_descriptor_fixture', 'preserved')",
    ).run();
    await applyMigrations(env.DB, [sourceDescriptorsMigrationEntry]);
  });

  it("upgrades a populated 0035 database with nullable descriptor columns", async () => {
    const metadata = await env.DB.prepare(
      "SELECT value FROM app_metadata WHERE key = 'md2_descriptor_fixture'",
    ).first<{ value: string }>();
    const vaultColumn = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('vaults') WHERE name = 'source_descriptor_json'",
    ).first<{ name: string }>();
    const snapshotColumn = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('snapshot_vaults') WHERE name = 'source_descriptor_json'",
    ).first<{ name: string }>();
    expect(metadata?.value).toBe("preserved");
    expect(vaultColumn?.name).toBe("source_descriptor_json");
    expect(snapshotColumn?.name).toBe("source_descriptor_json");
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });
});
