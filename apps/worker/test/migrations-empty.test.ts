import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  declaredTables,
  migrations,
} from "./migration-fixture";

describe("D1 migration chain from empty", () => {
  it("applies every migration from 0001 through 0028", async () => {
    await applyMigrations(env.DB, migrations);

    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    const actual = new Set(rows.results.map((row) => row.name));
    const expected = new Set(
      migrations.flatMap((migration) => declaredTables(migration.source)),
    );
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect([...expected].filter((table) => !actual.has(table))).toEqual([]);
    expect(actual.has("collaboration_records")).toBe(true);
    expect(actual.has("snapshot_intelligence_items")).toBe(true);
    expect(actual.has("project_initialization_requests")).toBe(true);
    expect(actual.has("owner_claim_configuration")).toBe(true);
    expect(actual.has("owner_claim_invitations")).toBe(true);
    expect(actual.has("owner_claim_challenges")).toBe(true);
    expect(actual.has("owner_claim_transaction_assertions")).toBe(true);
    expect(actual.has("agent_grant_restore_sources")).toBe(true);
    expect(actual.has("restored_note_lineage")).toBe(true);
    expect(actual.has("owner_credentials")).toBe(true);
    expect(actual.has("vault_sync_states")).toBe(true);
    expect(actual.has("project_initialization_token_aliases")).toBe(true);
    expect(actual.has("collaboration_packet_rotations")).toBe(true);
    expect(actual.has("collaboration_gc_objects")).toBe(true);
    expect(actual.has("project_initialization_approval_claims")).toBe(true);
    expect(actual.has("project_creation_reservations")).toBe(true);
    expect(actual.has("project_creation_requests")).toBe(true);
    expect(actual.has("project_creation_commits")).toBe(true);
    expect(actual.has("agent_grant_replacements")).toBe(true);
    expect(actual.has("vault_local_writer_assignments")).toBe(true);
    expect(actual.has("prepared_project_handoffs")).toBe(true);
    const runtimeProfileColumn = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('vault_sync_states')
       WHERE name = 'runtime_profile_json'`,
    ).first<{ name: string }>();
    const agentPrivateColumn = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('materialized_notes')
       WHERE name = 'agent_private'`,
    ).first<{ name: string }>();
    expect(runtimeProfileColumn?.name).toBe("runtime_profile_json");
    expect(agentPrivateColumn?.name).toBe("agent_private");
    const historicalGrantIndex = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name = 'collaboration_records_historical_grant_received_idx'`,
    ).first<{ name: string }>();
    expect(historicalGrantIndex?.name).toBe(
      "collaboration_records_historical_grant_received_idx",
    );
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
