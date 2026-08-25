import { compoundingRecordBodySchema } from "@owd/contracts";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCollaborationSnapshotManifest,
  stageCollaborationSnapshot,
} from "../src/collaboration-snapshot";
import {
  canonicalCompoundingBody,
  putImmutableCompoundingBody,
} from "../src/compounding-store";
import { applyMigrations, migrations } from "./migration-fixture";

const NOW = 1_700_000_000;

async function seedProject(): Promise<string> {
  const projectId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const knowledgeVersionId = crypto.randomUUID();
  await env.DB.batch(
    [
      [projectId, "project", null],
      [versionId, "project-version", projectId],
      [knowledgeVersionId, "knowledge-space-version", projectId],
    ].map(([id, recordType, recordProjectId]) =>
      env.DB.prepare(
        `INSERT INTO collaboration_records (
           id, record_type, schema_version, project_id, portable_object_id,
           body_object_key, content_sha256, byte_length, received_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, 2, 1)`,
      ).bind(
        id,
        recordType,
        recordProjectId,
        crypto.randomUUID(),
        `test/${id}.json`,
        "a".repeat(64),
      ),
    ),
  );
  await env.DB.prepare(
    `INSERT INTO collaboration_projects (
       project_id, active_project_version_id, active_knowledge_space_version_id,
       label, objective, status, created_at
     ) VALUES (?, ?, ?, 'Recovery fixture', 'Compounding recovery', 'active', 1)`,
  )
    .bind(projectId, versionId, knowledgeVersionId)
    .run();
  return projectId;
}

async function seedSnapshot(): Promise<string> {
  const snapshotId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO workspace_snapshots (
       id, portable_snapshot_id, format_version, origin, scope, status,
       recipient_fingerprint, capture_started_at, vault_count, item_count,
       logical_bytes, included_sections, unavailable_sections,
       manifest_portable_object_id, created_at
     ) VALUES (?, ?, 'owd-snapshot-v2', 'created', 'all-active', 'creating',
       ?, ?, 1, 0, 0, '["notes"]', '[]', ?, ?)`,
  )
    .bind(
      snapshotId,
      crypto.randomUUID(),
      "e".repeat(64),
      NOW,
      crypto.randomUUID(),
      NOW,
    )
    .run();
  return snapshotId;
}

beforeAll(async () => applyMigrations(env.DB, migrations));

describe("M3 compounding snapshot recovery", () => {
  it("keeps unvetted compounding out of none/approved snapshots and rejects a broken point closure", async () => {
    const projectId = await seedProject();
    const recordId = crypto.randomUUID();
    const observationId = crypto.randomUUID();
    const pointId = crypto.randomUUID();
    const body = compoundingRecordBodySchema.parse({
      correlationNote: "Suggestion only; correlation is not proof.",
      fingerprint: "a".repeat(64),
      learningSignal: {
        kind: "preference",
        key: "package-manager",
        projectId: null,
        scope: "personal",
        value: "Use pnpm.",
      },
      observationId,
      point: {
        acknowledgedAt: NOW,
        continuityPointId: pointId,
        contentSha256: "b".repeat(64),
        producerClientId: "fixture-client",
      },
      recordId,
      type: "checkpoint-observation",
    });
    if (body.type !== "checkpoint-observation") {
      throw new Error("Observation fixture invalid");
    }
    const stored = await putImmutableCompoundingBody(
      env.VAULT_STORAGE,
      canonicalCompoundingBody(body),
      recordId,
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO compounding_records (
          record_id, record_type, portable_object_id, project_id, draft_id,
          observation_id, fingerprint, body_object_key, content_sha256,
          byte_length, created_at, restore_state, restored_authority_allowed
        ) VALUES (?, 'checkpoint-observation', ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'live', 0)`,
      ).bind(
        recordId,
        crypto.randomUUID(),
        projectId,
        observationId,
        body.fingerprint,
        stored.bodyObjectKey,
        stored.contentSha256,
        stored.byteLength,
        NOW,
      ),
      env.DB.prepare(
        `INSERT INTO compounding_observations (
          observation_id, checkpoint_id, project_id, fingerprint, kind, scope,
          candidate_json, point_id, point_content_sha256, producer_client_id,
          acknowledged_at, record_id, restore_state, restored_authority_allowed
        ) VALUES (?, ?, ?, ?, 'preference', 'personal', ?, ?, ?, ?, ?, ?, 'live', 0)`,
      ).bind(
        observationId,
        pointId,
        projectId,
        body.fingerprint,
        canonicalCompoundingBody(body.learningSignal),
        pointId,
        body.point.contentSha256,
        body.point.producerClientId,
        NOW,
        recordId,
      ),
    ]);

    for (const selection of ["none", "approved"] as const) {
      const snapshotId = await seedSnapshot();
      await stageCollaborationSnapshot(env.DB, {
        now: NOW,
        selection,
        snapshotId,
      });
      const manifest = await buildCollaborationSnapshotManifest(
        env.DB,
        snapshotId,
      );
      expect(manifest.compounding).toBeUndefined();
      expect(manifest.requiredCapabilities).not.toContain(
        "owd.snapshot.compounding-v1",
      );
      await env.DB.prepare(
        "UPDATE workspace_snapshots SET status = 'ready' WHERE id = ?",
      )
        .bind(snapshotId)
        .run();
    }

    await expect(
      stageCollaborationSnapshot(env.DB, {
        now: NOW,
        selection: "approved-and-unvetted",
        snapshotId: await seedSnapshot(),
      }),
    ).rejects.toMatchObject({ code: "snapshot_dependency_missing" });
  });
});
