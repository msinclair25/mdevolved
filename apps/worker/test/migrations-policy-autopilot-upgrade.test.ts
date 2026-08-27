import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  policyAutopilotR4MigrationEntry,
} from "./migration-fixture";

const projectId = "project-r4-migration";
const projectRecordId = projectId;
const projectVersionId = "record-project-version-r4-migration";
const knowledgeVersionId = "record-knowledge-version-r4-migration";
const workItemId = "work-item-r4-migration";
const workItemRecordId = workItemId;
const workItemVersionId = "record-work-item-version-r4-migration";
const packetId = "record-work-packet-r4-migration";
const runId = "run-r4-migration";
const policyId = "policy-r4-migration";
const continuityPointId = "continuity-point-r4-migration";

const hash = "a".repeat(64);

async function seedPriorReleaseRows(): Promise<void> {
  const record = (
    id: string,
    recordType: string,
    recordProjectId: string | null,
    recordWorkItemId: string | null = null,
  ) =>
    env.DB.prepare(
      `INSERT INTO collaboration_records (
         id, record_type, schema_version, project_id, work_item_id,
         portable_object_id, body_object_key, content_sha256, byte_length,
         received_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, 10)`,
    ).bind(
      id,
      recordType,
      recordProjectId,
      recordWorkItemId,
      `portable-${id}`,
      `body-${id}`,
      hash,
    );

  await env.DB.batch([
    record(projectRecordId, "project", null),
    record(projectVersionId, "project-version", projectId),
    record(knowledgeVersionId, "knowledge-space-version", projectId),
    record(workItemRecordId, "work-item", projectId, workItemId),
    record(workItemVersionId, "work-item-version", projectId, workItemId),
    record(packetId, "work-packet", projectId, workItemId),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO collaboration_projects (
         project_id, active_project_version_id,
         active_knowledge_space_version_id, label, objective, created_at
       ) VALUES (?, ?, ?, 'R4 migration project', 'Preserve old rows', 10)`,
    ).bind(projectId, projectVersionId, knowledgeVersionId),
    env.DB.prepare(
      `INSERT INTO collaboration_work_items (
         work_item_id, project_id, active_work_item_version_id, created_at
       ) VALUES (?, ?, ?, 10)`,
    ).bind(workItemId, projectId, workItemVersionId),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_continuity_points (
         continuity_point_id, portable_object_id, project_id,
         project_version_id, work_item_id, work_item_version_id,
         knowledge_space_version_id, work_packet_id, parent_key,
         source_lease_id, source_fencing_token, producer_client_id,
         body_object_key, content_sha256, byte_length, acknowledged_at,
         live_fence_valid, live_context_valid, live_parent_valid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'root', 'lease-r4', 1, 'lead-r4',
         'body-continuity-r4', ?, 1, 20, 1, 1, 1)`,
    ).bind(
      continuityPointId,
      "portable-continuity-r4",
      projectId,
      projectVersionId,
      workItemId,
      workItemVersionId,
      knowledgeVersionId,
      packetId,
      hash,
    ),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_operation_records (
         operation_record_id, record_type, project_id, work_item_id,
         portable_object_id, content_sha256, byte_length, body_object_key,
         received_at, restore_state
       ) VALUES ('operation-record-r4', 'policy', ?, ?,
         'portable-operation-r4', ?, 1, 'body-operation-r4', 20, 'live')`,
    ).bind(projectId, workItemId, hash),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_operation_policies (
         policy_id, operation_record_id, project_id, project_version_id,
         max_actors_per_run, max_bundles_per_run, max_events_per_bundle,
         max_bundle_bytes, max_run_logical_bytes, independent_review_required
       ) VALUES (?, 'operation-record-r4', ?, ?, 8, 64, 16, 262144,
         4194304, 1)`,
    ).bind(policyId, projectId, projectVersionId),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_runs (
         run_id, operation_record_id, project_id, work_item_id, work_packet_id,
         policy_id, source_lease_id, source_fencing_token, live_fence_valid,
         purpose, status, created_at, max_actors_per_run, max_bundles_per_run,
         max_events_per_bundle, max_bundle_bytes, max_run_logical_bytes
       ) VALUES (?, 'operation-record-r4', ?, ?, ?, ?, 'lease-r4', 1, 1,
         'research', 'active', 20, 8, 64, 16, 262144, 4194304)`,
    ).bind(runId, projectId, workItemId, packetId, policyId),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_elastic_records (
         elastic_record_id, record_type, project_id, run_id,
         portable_object_id, content_sha256, byte_length, body_object_key,
         received_at, restore_state, retention_tier, retain_until
       ) VALUES ('elastic-record-r4', 'plane', ?, ?, 'portable-elastic-r4',
         ?, 1, 'body-elastic-r4', 21, 'live', 'hot', 100)`,
    ).bind(projectId, runId, hash),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_elastic_planes (
         run_id, elastic_record_id, project_id, profile, max_active_actors,
         max_actor_records, max_register_batch, max_bundle_batch,
         max_delta_page, created_at, updated_at, retention_tier, retain_until
       ) VALUES (?, 'elastic-record-r4', ?, 'owd-elastic-run-plane-v1',
         32, 64, 16, 8, 100, 21, 21, 'hot', 100)`,
    ).bind(runId, projectId),
    env.DB.prepare(
      `INSERT INTO project_run_deltas (
         delta_id, project_id, run_id, record_type, record_id, content_sha256,
         occurred_at, retention_tier, retain_until
       ) VALUES ('delta-r4', ?, ?, 'actor', 'actor-r4', ?, 21, 'hot', 100)`,
    ).bind(projectId, runId, hash),
  ]);
}

describe("D1 R4 policy-autopilot migration", () => {
  it("upgrades a populated 0032 database and preserves R1-R3 rows", async () => {
    await applyMigrations(
      env.DB,
      migrations.slice(0, migrations.indexOf(policyAutopilotR4MigrationEntry)),
    );
    await seedPriorReleaseRows();

    await applyMigrations(env.DB, [policyAutopilotR4MigrationEntry]);
    await applyMigrations(env.DB, [policyAutopilotR4MigrationEntry]);

    const preserved = await Promise.all([
      env.DB.prepare(
        "SELECT project_id, objective FROM collaboration_projects WHERE project_id = ?",
      )
        .bind(projectId)
        .first<{ objective: string; project_id: string }>(),
      env.DB.prepare(
        "SELECT continuity_point_id, acknowledged_at FROM project_continuity_points WHERE continuity_point_id = ?",
      )
        .bind(continuityPointId)
        .first<{ acknowledged_at: number; continuity_point_id: string }>(),
      env.DB.prepare(
        "SELECT run_id, purpose, status FROM project_runs WHERE run_id = ?",
      )
        .bind(runId)
        .first<{ purpose: string; run_id: string; status: string }>(),
      env.DB.prepare(
        "SELECT elastic_record_id, record_type FROM project_elastic_records WHERE elastic_record_id = 'elastic-record-r4'",
      ).first<{ elastic_record_id: string; record_type: string }>(),
      env.DB.prepare(
        "SELECT delta_id, record_type FROM project_run_deltas WHERE delta_id = 'delta-r4'",
      ).first<{ delta_id: string; record_type: string }>(),
    ]);
    expect(preserved).toEqual([
      { project_id: projectId, objective: "Preserve old rows" },
      { continuity_point_id: continuityPointId, acknowledged_at: 20 },
      { run_id: runId, purpose: "research", status: "active" },
      { elastic_record_id: "elastic-record-r4", record_type: "plane" },
      { delta_id: "delta-r4", record_type: "actor" },
    ]);

    const r4OperationalRecordId = "operational-record-r4";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO project_operational_records (
           operational_record_id, record_type, project_id,
           portable_object_id, content_sha256, byte_length, body_object_key,
           received_at, restore_state, retention_tier, retain_until
         ) VALUES (?, 'policy-binding', ?, 'portable-r4-operational', ?, 1,
           'body-r4-operational', 30, 'live', 'hot', 100)`,
      ).bind(r4OperationalRecordId, projectId, hash),
      env.DB.prepare(
        `INSERT INTO project_operational_dependencies (
           operational_record_id, dependency_id, dependency_kind, content_sha256
         ) VALUES (?, 'evidence-r4', 'evidence', ?)`,
      ).bind(r4OperationalRecordId, hash),
      env.DB.prepare(
        `INSERT INTO project_policy_bindings (
           binding_id, operational_record_id, project_id, project_version_id,
           policy_id, policy_sha256, owner_policy_input_record_id,
           owner_policy_input_sha256, owner_authored, gate_research, gate_coding,
           checkpoint_interval_seconds, drill_interval_seconds, status,
           activated_at
         ) VALUES ('binding-r4', ?, ?, ?, ?, ?, 'owner-policy-input-r4', ?, 1,
           'owd-research-completion-gate-v1', 'owd-coding-completion-gate-v1',
           300, 3600, 'active', 30)`,
      ).bind(
        r4OperationalRecordId,
        projectId,
        projectVersionId,
        policyId,
        hash,
        hash,
      ),
    ]);

    const authority = await env.DB.prepare(
      `SELECT restored_authority_allowed, live_authority_included,
              scheduler_authority_included, restore_state, restored_at
       FROM project_operational_records WHERE operational_record_id = ?`,
    )
      .bind(r4OperationalRecordId)
      .first<{
        live_authority_included: number;
        restore_state: string;
        restored_at: number | null;
        restored_authority_allowed: number;
        scheduler_authority_included: number;
      }>();
    const bindingState = await env.DB.prepare(
      "SELECT operation_restore_state FROM project_policy_bindings WHERE binding_id = 'binding-r4'",
    ).first<{ operation_restore_state: string }>();
    expect(authority).toEqual({
      restored_authority_allowed: 0,
      live_authority_included: 0,
      scheduler_authority_included: 0,
      restore_state: "live",
      restored_at: null,
    });
    expect(bindingState?.operation_restore_state).toBe("live");
    await expect(
      env.DB.prepare(
        `INSERT INTO project_operational_records (
           operational_record_id, record_type, project_id,
           portable_object_id, content_sha256, byte_length, body_object_key,
           received_at, restore_state, retention_tier, retain_until,
           restored_authority_allowed
         ) VALUES ('invalid-authority-r4', 'evidence', ?,
           'portable-invalid-authority-r4', ?, 1, 'body-invalid-authority-r4',
           30, 'live', 'hot', 100, 1)`,
      )
        .bind(projectId, hash)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO project_operational_records (
           operational_record_id, record_type, project_id,
           portable_object_id, content_sha256, byte_length, body_object_key,
           received_at, restored_at, restore_state, retention_tier, retain_until
         ) VALUES ('invalid-restore-r4', 'evidence', ?,
           'portable-invalid-restore-r4', ?, 1, 'body-invalid-restore-r4',
           30, NULL, 'quarantined', 'quarantine', 100)`,
      )
        .bind(projectId, hash)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO project_operational_records (
           operational_record_id, record_type, project_id,
           portable_object_id, content_sha256, byte_length, body_object_key,
           received_at, restore_state, retention_tier, retain_until
         ) VALUES ('invalid-fk-r4', 'evidence', 'missing-project-r4',
           'portable-invalid-fk-r4', ?, 1, 'body-invalid-fk-r4',
           30, 'live', 'hot', 100)`,
      )
        .bind(hash)
        .run(),
    ).rejects.toThrow();

    const tableCounts = await env.DB.prepare(
      `SELECT name, COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'project_operational_records', 'project_operational_dependencies',
         'project_policy_bindings', 'project_policy_decisions',
         'project_operational_schedules', 'project_operational_requests',
         'project_operational_integrity_reports',
         'project_continuity_drill_receipts', 'project_operational_job_clock'
       ) GROUP BY name`,
    ).all<{ count: number; name: string }>();
    expect(tableCounts.results).toHaveLength(9);
    expect(tableCounts.results.every((row) => row.count === 1)).toBe(true);
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
