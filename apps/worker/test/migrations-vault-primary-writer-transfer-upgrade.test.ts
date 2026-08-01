import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  vaultPrimaryWriterTransferMigrationEntry,
} from "./migration-fixture";

describe("0029 vault primary writer transfer upgrade", () => {
  it("adds the append-only transfer ledger and remains idempotent", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 23));
    await applyMigrations(env.DB, [vaultPrimaryWriterTransferMigrationEntry]);
    await applyMigrations(env.DB, [vaultPrimaryWriterTransferMigrationEntry]);

    const objects = await env.DB.prepare(
      `SELECT name, type
       FROM sqlite_master
       WHERE name IN (
         'vault_local_writer_transfers',
         'vault_local_writer_transfers_vault_idx',
         'vault_local_writer_transfers_target_idx'
       )
       ORDER BY name`,
    ).all<{ name: string; type: string }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(objects.results).toEqual([
      { name: "vault_local_writer_transfers", type: "table" },
      { name: "vault_local_writer_transfers_target_idx", type: "index" },
      { name: "vault_local_writer_transfers_vault_idx", type: "index" },
    ]);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
