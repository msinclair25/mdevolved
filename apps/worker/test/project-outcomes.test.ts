import { projectOutcomeResponseSchema } from "@mdevolved/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { commitFirstOwner, createSessionMaterial } from "../src/auth-store";
import { getProjectOutcome } from "../src/project-outcome-service";
import { applyMigrations, migrations } from "./migration-fixture";

const ORIGIN = "https://owd.test";

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function seedProject(withEvidence = true): Promise<string> {
  const projectId = crypto.randomUUID();
  const projectVersionId = crypto.randomUUID();
  const knowledgeVersionId = crypto.randomUUID();
  const workItemId = crypto.randomUUID();
  const workItemVersionId = crypto.randomUUID();
  const packetId = crypto.randomUUID();
  const record = (
    id: string,
    recordType: string,
    recordProjectId: string | null,
    recordWorkItemId?: string,
  ) =>
    env.DB.prepare(
      `INSERT INTO collaboration_records (
           id, record_type, schema_version, project_id, work_item_id,
           portable_object_id, body_object_key, content_sha256, byte_length,
           received_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 2, 1)`,
    ).bind(
      id,
      recordType,
      recordProjectId,
      recordWorkItemId ?? null,
      crypto.randomUUID(),
      `test/${id}.json`,
      "a".repeat(64),
    );
  await env.DB.batch([
    record(projectId, "project", null),
    record(projectVersionId, "project-version", projectId),
    record(knowledgeVersionId, "knowledge-space-version", projectId),
    record(workItemId, "work-item", projectId, workItemId),
    record(workItemVersionId, "work-item-version", projectId, workItemId),
    record(packetId, "work-packet", projectId, workItemId),
    env.DB.prepare(
      `INSERT INTO collaboration_projects (
         project_id, active_project_version_id,
         active_knowledge_space_version_id, label, objective, created_at
       ) VALUES (?, ?, ?, 'Outcome fixture', 'Bounded outcome evidence', 1)`,
    ).bind(projectId, projectVersionId, knowledgeVersionId),
    env.DB.prepare(
      `INSERT INTO collaboration_work_items (
         work_item_id, project_id, active_work_item_version_id, created_at
       ) VALUES (?, ?, ?, 1)`,
    ).bind(workItemId, projectId, workItemVersionId),
  ]);
  if (!withEvidence) return projectId;

  const hash = "b".repeat(64);
  const firstPointId = crypto.randomUUID();
  const secondPointId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_continuity_points (
         continuity_point_id, portable_object_id, project_id,
         project_version_id, work_item_id, work_item_version_id,
         knowledge_space_version_id, work_packet_id, parent_key,
         source_lease_id, source_fencing_token, producer_client_id,
         body_object_key, content_sha256, byte_length, acknowledged_at,
         live_fence_valid, live_context_valid, live_parent_valid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'root', 'fixture-lease-a', 1,
         'fixture-client-a', ?, ?, 1, 10, 1, 1, 1)`,
    ).bind(
      firstPointId,
      crypto.randomUUID(),
      projectId,
      projectVersionId,
      workItemId,
      workItemVersionId,
      knowledgeVersionId,
      packetId,
      `body/${firstPointId}`,
      hash,
    ),
    env.DB.prepare(
      `INSERT INTO project_continuity_points (
         continuity_point_id, portable_object_id, project_id,
         project_version_id, work_item_id, work_item_version_id,
         knowledge_space_version_id, work_packet_id,
         previous_continuity_point_id, parent_key,
         source_lease_id, source_fencing_token, producer_client_id,
         body_object_key, content_sha256, byte_length, acknowledged_at,
         live_fence_valid, live_context_valid, live_parent_valid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture-lease-b', 1,
         'fixture-client-b', ?, ?, 1, 20, 1, 1, 1)`,
    ).bind(
      secondPointId,
      crypto.randomUUID(),
      projectId,
      projectVersionId,
      workItemId,
      workItemVersionId,
      knowledgeVersionId,
      packetId,
      firstPointId,
      firstPointId,
      `body/${secondPointId}`,
      hash,
    ),
  ]);
  const preferenceId = crypto.randomUUID();
  const preferenceRecordId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO working_profile_records (
         record_id, record_type, portable_object_id, preference_id,
         body_object_key, content_sha256, byte_length, created_at
       ) VALUES (?, 'preference-version', ?, ?, ?, ?, 2, 20)`,
    ).bind(
      preferenceRecordId,
      crypto.randomUUID(),
      preferenceId,
      `profile/${preferenceRecordId}`,
      hash,
    ),
    env.DB.prepare(
      `INSERT INTO working_preferences (
         preference_id, project_id, preference_key, current_record_id,
         status, value, source_label, updated_at
       ) VALUES (?, NULL, ?, ?, 'active', 'bounded', 'Owner', 20)`,
    ).bind(
      preferenceId,
      `fixture-${projectId.slice(0, 8)}`,
      preferenceRecordId,
    ),
  ]);
  const suggestionRecordId = crypto.randomUUID();
  const suggestionId = crypto.randomUUID();
  const fingerprint =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO compounding_records (
         record_id, record_type, portable_object_id, project_id, draft_id,
         fingerprint, body_object_key, content_sha256, byte_length, created_at
       ) VALUES (?, 'draft-version', ?, ?, ?, ?, ?, ?, 2, 20)`,
    ).bind(
      suggestionRecordId,
      crypto.randomUUID(),
      projectId,
      suggestionId,
      fingerprint,
      `compounding/${suggestionRecordId}`,
      hash,
    ),
    env.DB.prepare(
      `INSERT INTO compounding_drafts (
         draft_id, fingerprint, kind, scope, project_id, candidate_json,
         status, observation_count, evidence_json, first_observed_at,
         last_observed_at, current_record_id
       ) VALUES (?, ?, 'preference', 'project', ?, ?, 'pending', 1, '[]', 20, 20, ?)`,
    ).bind(
      suggestionId,
      fingerprint,
      projectId,
      JSON.stringify({
        key: "fixture-preference",
        kind: "preference",
        projectId,
        scope: "project",
        value: "bounded",
      }),
      suggestionRecordId,
    ),
  ]);
  return projectId;
}

async function ownerCookie(): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: `outcome-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `outcome-owner-${crypto.randomUUID()}`,
    },
    session,
    crypto.randomUUID(),
    now,
  );
  return `__Host-mdevolved_session=${session.token}`;
}

beforeAll(async () => applyMigrations(env.DB, migrations));

describe("Project outcome evidence", () => {
  it("returns a zero state and a nonzero privacy-safe aggregate", async () => {
    const projectId = await seedProject(false);
    const initial = await getProjectOutcome(env.DB, projectId);
    expect(initial).toEqual({
      acceptedMemoryCount: 0,
      attention: "checkpoint_again",
      checkpointedByMultipleClients: false,
      latestCheckpointAt: null,
      pendingSuggestionCount: 0,
      readiness: "not_started",
    });

    const evidenceProjectId = await seedProject();
    const outcome = await getProjectOutcome(env.DB, evidenceProjectId);
    expect(outcome).toMatchObject({
      acceptedMemoryCount: 1,
      attention: "review_suggestions",
      checkpointedByMultipleClients: true,
      latestCheckpointAt: 20,
      pendingSuggestionCount: 1,
      readiness: "ready",
    });
    expect(Object.keys(outcome).sort()).toEqual([
      "acceptedMemoryCount",
      "attention",
      "checkpointedByMultipleClients",
      "latestCheckpointAt",
      "pendingSuggestionCount",
      "readiness",
    ]);
    expect(JSON.stringify(outcome)).not.toContain(evidenceProjectId);
    expect(JSON.stringify(outcome)).not.toContain("fixture-client");
  });

  it("keeps Project isolation and authentication fail closed", async () => {
    const projectId = await seedProject();
    await expect(
      getProjectOutcome(env.DB, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "project_not_found" });
    const unauthenticated = await fetchWorker(
      `${ORIGIN}/api/project-outcomes?projectId=${projectId}`,
    );
    expect(unauthenticated.status).toBe(401);

    const cookie = await ownerCookie();
    const malformed = await fetchWorker(
      `${ORIGIN}/api/project-outcomes?projectId=not-a-uuid`,
      { headers: { Cookie: cookie } },
    );
    expect(malformed.status).toBe(400);
    const response = await fetchWorker(
      `${ORIGIN}/api/project-outcomes?projectId=${projectId}`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(projectOutcomeResponseSchema.parse(await response.json()).ok).toBe(
      true,
    );
  });
});
