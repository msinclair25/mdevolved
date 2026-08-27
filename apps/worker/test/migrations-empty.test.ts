import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  declaredTables,
  declaredIndexes,
  migrations,
  policyAutopilotR4MigrationEntry,
} from "./migration-fixture";

describe("D1 migration chain from empty", () => {
  it("applies every migration from 0001 through 0038", async () => {
    await applyMigrations(env.DB, migrations);

    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    const actual = new Set(rows.results.map((row) => row.name));
    const expected = new Set(
      migrations.flatMap((migration) => declaredTables(migration.source)),
    );
    const r4Migration = policyAutopilotR4MigrationEntry;
    const expectedR4Indexes = declaredIndexes(r4Migration.source);
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();
    const actualIndexes = new Set(indexes.results.map((row) => row.name));
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
    expect(actual.has("vault_local_writer_transfers")).toBe(true);
    expect(actual.has("prepared_project_handoffs")).toBe(true);
    expect(actual.has("project_lead_leases")).toBe(true);
    expect(actual.has("project_continuity_points")).toBe(true);
    expect(actual.has("continuity_point_dependencies")).toBe(true);
    expect(actual.has("continuity_checkpoint_receipts")).toBe(true);
    expect(actual.has("project_operation_records")).toBe(true);
    expect(actual.has("project_operation_policies")).toBe(true);
    expect(actual.has("project_runs")).toBe(true);
    expect(actual.has("project_actors")).toBe(true);
    expect(actual.has("project_event_bundles")).toBe(true);
    expect(actual.has("project_run_claims")).toBe(true);
    expect(actual.has("project_exceptions")).toBe(true);
    expect(actual.has("project_operation_receipts")).toBe(true);
    expect(actual.has("project_elastic_records")).toBe(true);
    expect(actual.has("project_elastic_planes")).toBe(true);
    expect(actual.has("project_elastic_accounts")).toBe(true);
    expect(actual.has("project_elastic_actor_slots")).toBe(true);
    expect(actual.has("project_actor_recoveries")).toBe(true);
    expect(actual.has("project_run_budgets")).toBe(true);
    expect(actual.has("project_run_budget_versions")).toBe(true);
    expect(actual.has("project_run_budget_entries")).toBe(true);
    expect(actual.has("project_run_observations")).toBe(true);
    expect(actual.has("project_orca_projections")).toBe(true);
    expect(actual.has("project_run_deltas")).toBe(true);
    expect(actual.has("project_run_delta_clock")).toBe(true);
    expect(actual.has("working_profile_records")).toBe(true);
    expect(actual.has("working_preferences")).toBe(true);
    expect(actual.has("agent_skills")).toBe(true);
    expect(actual.has("project_skill_attachments")).toBe(true);
    expect(actual.has("working_profile_mutation_receipts")).toBe(true);
    expect(actual.has("compounding_records")).toBe(true);
    expect(actual.has("compounding_observations")).toBe(true);
    expect(actual.has("compounding_drafts")).toBe(true);
    expect(actual.has("compounding_mutation_receipts")).toBe(true);
    expect(actual.has("compounding_checkpoint_bindings")).toBe(true);
    expect(actual.has("compounding_draft_action_claims")).toBe(true);
    for (const table of declaredTables(r4Migration.source)) {
      expect(actual.has(table)).toBe(true);
    }
    for (const index of expectedR4Indexes) {
      expect(actualIndexes.has(index)).toBe(true);
    }
    expect(r4Migration.source).not.toMatch(/CREATE\s+TRIGGER\b/iu);
    expect(
      r4Migration.source.match(/;\s*(?:CREATE|INSERT|$)/gmu)?.length,
    ).toBeGreaterThan(0);
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
    const completionModeColumn = await env.DB.prepare(
      `SELECT dflt_value FROM pragma_table_info('project_runs')
       WHERE name = 'completion_mode'`,
    ).first<{ dflt_value: string }>();
    expect(completionModeColumn?.dflt_value).toBe("'orchestrated-reviewed'");
    const soloPolicyColumn = await env.DB.prepare(
      `SELECT dflt_value FROM pragma_table_info('project_policy_bindings')
       WHERE name = 'solo_verified_allowed'`,
    ).first<{ dflt_value: string }>();
    expect(soloPolicyColumn?.dflt_value).toBe("0");
    const historicalGrantIndex = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name = 'collaboration_records_historical_grant_received_idx'`,
    ).first<{ name: string }>();
    expect(historicalGrantIndex?.name).toBe(
      "collaboration_records_historical_grant_received_idx",
    );
    const operationIndex = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index'
       AND name = 'project_operation_receipts_project_idx'`,
    ).first<{ name: string }>();
    expect(operationIndex?.name).toBe("project_operation_receipts_project_idx");
    const operationRecordColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('project_operation_records')`,
    ).all<{ name: string }>();
    expect(operationRecordColumns.results.map((row) => row.name)).toContain(
      "restore_state",
    );
    const actorColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('project_actors')`,
    ).all<{ name: string }>();
    expect(actorColumns.results.map((row) => row.name)).toContain(
      "operation_restore_state",
    );
    const actorTable = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_actors'`,
    ).first<{ sql: string }>();
    expect(actorTable?.sql).toContain(
      "FOREIGN KEY (operation_record_id, operation_restore_state)",
    );
    const deltaTable = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_run_deltas'`,
    ).first<{ sql: string }>();
    expect(deltaTable?.sql).toContain("AUTOINCREMENT");
    const elasticRecordColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('project_elastic_records')`,
    ).all<{ name: string }>();
    expect(elasticRecordColumns.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "restore_state",
        "retention_tier",
        "retain_until",
        "restored_authority_allowed",
        "live_authority_included",
      ]),
    );
    const observationColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('project_run_observations')`,
    ).all<{ name: string }>();
    expect(observationColumns.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "owner_action_count",
        "raw_content_included",
        "transcripts_included",
        "hidden_reasoning_included",
        "terminal_history_included",
        "credentials_included",
        "oauth_state_included",
        "provider_runtime_included",
        "production_logs_included",
      ]),
    );
    const r4RecordTable = await env.DB.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'project_operational_records'`,
    ).first<{ sql: string }>();
    expect(r4RecordTable?.sql).toContain("restored_authority_allowed = 0");
    expect(r4RecordTable?.sql).toContain("live_authority_included = 0");
    expect(r4RecordTable?.sql).toContain("scheduler_authority_included = 0");
    expect(r4RecordTable?.sql).toContain(
      "restore_state IN ('live', 'quarantined')",
    );
    expect(r4RecordTable?.sql).toContain(
      "(restore_state = 'live' AND restored_at IS NULL)",
    );
    expect(r4RecordTable?.sql).toContain(
      "(restore_state = 'quarantined' AND restored_at IS NOT NULL)",
    );
    const r4TablesWithLiveRestoreState = [
      "project_policy_bindings",
      "project_policy_decisions",
      "project_operational_schedules",
    ];
    for (const table of r4TablesWithLiveRestoreState) {
      const schema = await env.DB.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
        .bind(table)
        .first<{ sql: string }>();
      expect(schema?.sql).toContain("operation_restore_state");
      expect(schema?.sql).toContain("operation_restore_state = 'live'");
    }
    const childForeignKeys = [
      ["project_operational_records", "collaboration_projects"],
      ["project_operational_dependencies", "project_operational_records"],
      ["project_policy_bindings", "project_operational_records"],
      ["project_policy_bindings", "collaboration_projects"],
      ["project_policy_bindings", "collaboration_records"],
      ["project_policy_bindings", "project_operation_policies"],
      ["project_policy_decisions", "project_operational_records"],
      ["project_policy_decisions", "collaboration_projects"],
      ["project_policy_decisions", "collaboration_work_items"],
      ["project_policy_decisions", "project_runs"],
      ["project_policy_decisions", "project_policy_bindings"],
      ["project_policy_decisions", "project_continuity_points"],
      ["project_operational_schedules", "project_operational_records"],
      ["project_operational_schedules", "collaboration_projects"],
      ["project_operational_schedules", "project_policy_bindings"],
      ["project_operational_requests", "project_operational_records"],
      ["project_operational_requests", "collaboration_projects"],
      ["project_operational_requests", "project_operational_schedules"],
      ["project_operational_integrity_reports", "project_operational_records"],
      ["project_operational_integrity_reports", "collaboration_projects"],
      ["project_continuity_drill_receipts", "project_operational_records"],
      ["project_continuity_drill_receipts", "collaboration_projects"],
      ["project_continuity_drill_receipts", "project_continuity_points"],
    ] as const;
    for (const [table, referencedTable] of childForeignKeys) {
      const schema = await env.DB.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
        .bind(table)
        .first<{ sql: string }>();
      expect(schema?.sql).toContain("FOREIGN KEY");
      expect(schema?.sql).toContain(`REFERENCES ${referencedTable}`);
    }
    for (const table of declaredTables(r4Migration.source)) {
      const schema = await env.DB.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
        .bind(table)
        .first<{ sql: string }>();
      expect(schema?.sql).toContain("CHECK");
      expect(schema?.sql).toContain("STRICT");
    }
    const jobClock = await env.DB.prepare(
      "SELECT singleton_id, last_scheduled_time, last_completed_at FROM project_operational_job_clock",
    ).first<{
      last_completed_at: number;
      last_scheduled_time: number;
      singleton_id: number;
    }>();
    expect(jobClock).toEqual({
      singleton_id: 1,
      last_scheduled_time: 0,
      last_completed_at: 0,
    });
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
