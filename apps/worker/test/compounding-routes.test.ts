import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { commitFirstOwner, createSessionMaterial } from "../src/auth-store";
import {
  observeCompoundingCheckpoint,
  listCompoundingDrafts,
} from "../src/compounding-service";
import worker from "../src/index";
import { applyMigrations, migrations } from "./migration-fixture";

const ORIGIN = "https://owd.test";
type OwnerSession = { cookie: string; csrf: string };

async function fetchWorker(input: RequestInfo | URL, init?: RequestInit) {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

function ownerHeaders(session: OwnerSession, csrf = false): HeadersInit {
  return {
    ...(csrf ? { Origin: ORIGIN, "X-OWD-CSRF": session.csrf } : {}),
    Cookie: session.cookie,
  };
}

async function seedProject(label: string): Promise<string> {
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
     ) VALUES (?, ?, ?, ?, 'Compounding route fixture', 'active', 1)`,
  )
    .bind(projectId, versionId, knowledgeVersionId, label)
    .run();
  return projectId;
}

async function createDraft(projectId: string, key: string) {
  const signal = {
    key,
    kind: "preference" as const,
    projectId,
    scope: "project" as const,
    value: "Use the smallest useful change.",
  };
  for (const acknowledgedAt of [10, 20]) {
    await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
      acknowledgedAt,
      checkpointId: crypto.randomUUID(),
      learningSignals: [signal],
      pointContentSha256: "a".repeat(64),
      producerClientId: `route-client-${acknowledgedAt}`,
      projectId,
    });
  }
  const draft = (
    await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
  ).find(
    (candidate) =>
      candidate.candidate.kind === "preference" &&
      candidate.candidate.key === key,
  );
  if (draft === undefined) throw new Error("Route fixture draft missing.");
  return draft;
}

describe("M3 owner compounding routes", () => {
  let session: OwnerSession;

  beforeAll(async () => {
    await applyMigrations(env.DB, migrations);
    const now = Math.floor(Date.now() / 1_000);
    const material = await createSessionMaterial(now);
    await commitFirstOwner(
      env.DB,
      {
        backedUp: true,
        counter: 0,
        credentialId: `compounding-route-${crypto.randomUUID()}`,
        deviceType: "multiDevice",
        publicKey: new Uint8Array([1, 2, 3]),
        transports: ["internal"],
        webauthnUserId: `compounding-owner-${crypto.randomUUID()}`,
      },
      material,
      crypto.randomUUID(),
      now,
    );
    session = {
      cookie: `__Host-owd_session=${material.token}; __Host-owd_csrf=${material.csrfToken}`,
      csrf: material.csrfToken,
    };
  });

  it("requires the owner session and exact CSRF, then lists personal-plus-project drafts", async () => {
    const unauthenticated = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts`,
    );
    expect(unauthenticated.status).toBe(401);

    const projectId = await seedProject("Route list project");
    await createDraft(projectId, `route-list-${projectId}`);
    const response = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts?projectId=${projectId}`,
      { headers: ownerHeaders(session) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      ((await response.json()) as { drafts: unknown[] }).drafts,
    ).toHaveLength(1);

    const invalidProject = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts?projectId=not-a-uuid`,
      { headers: ownerHeaders(session) },
    );
    expect(invalidProject.status).toBe(400);

    const missingCsrf = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts/accept`,
      {
        body: JSON.stringify({
          draftId: crypto.randomUUID(),
          idempotencyKey: "route-csrf-key",
        }),
        headers: { Cookie: session.cookie, "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(missingCsrf.status).toBe(403);
  });

  it("denies cross-Project draft IDs and truthfully handles edit-and-accept, ignore, and delete", async () => {
    const projectA = await seedProject("Route action A");
    const projectB = await seedProject("Route action B");
    const draft = await createDraft(projectA, `route-action-${projectA}`);
    const body = {
      draftId: draft.draftId,
      idempotencyKey: `route-edit-${projectA}`,
      editedCandidate: {
        key: `route-action-${projectA}`,
        kind: "preference" as const,
        projectId: projectA,
        scope: "project" as const,
        value: "Use a focused, verified change.",
      },
    };
    const crossProject = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts/accept?projectId=${projectB}`,
      {
        body: JSON.stringify(body),
        headers: {
          ...ownerHeaders(session, true),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(crossProject.status).toBe(404);

    const accepted = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts/accept?projectId=${projectA}`,
      {
        body: JSON.stringify(body),
        headers: {
          ...ownerHeaders(session, true),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { effect: string }).effect).toBe(
      "preference-saved",
    );

    const ignored = await createDraft(projectA, `route-ignore-${projectA}`);
    const ignoreResponse = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts/ignore?projectId=${projectA}`,
      {
        body: JSON.stringify({
          draftId: ignored.draftId,
          idempotencyKey: `route-ignore-${projectA}`,
        }),
        headers: {
          ...ownerHeaders(session, true),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(ignoreResponse.status).toBe(200);
    expect(
      ((await ignoreResponse.json()) as { draft: { status: string } }).draft
        .status,
    ).toBe("ignored");

    const deleted = await createDraft(projectA, `route-delete-${projectA}`);
    const deleteResponse = await fetchWorker(
      `${ORIGIN}/api/compounding/drafts/delete?projectId=${projectA}`,
      {
        body: JSON.stringify({
          draftId: deleted.draftId,
          idempotencyKey: `route-delete-${projectA}`,
        }),
        headers: {
          ...ownerHeaders(session, true),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(deleteResponse.status).toBe(200);
    expect(
      ((await deleteResponse.json()) as { draft: { status: string } }).draft
        .status,
    ).toBe("deleted");
  });
});
