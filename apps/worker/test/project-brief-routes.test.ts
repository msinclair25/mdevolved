import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { commitFirstOwner, createSessionMaterial } from "../src/auth-store";
import { createCollaborationProject } from "../src/collaboration-service";
import worker from "../src/index";
import { applyMigrations, migrations } from "./migration-fixture";

const ORIGIN = "https://owd.test";

async function fetchWorker(input: RequestInfo | URL, init?: RequestInit) {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function createProject(label: string) {
  const now = Math.floor(Date.now() / 1_000);
  const vaultId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO vaults (id, display_name, status, created_at, paired_at)
     VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(vaultId, `${label} vault`, now, now)
    .run();
  return createCollaborationProject(
    env.DB,
    env.VAULT_STORAGE,
    {
      knowledgeSpace: {
        label: `${label} sources`,
        members: [
          {
            exclusions: [],
            pathPrefixes: [{ path: "", pathKey: "" }],
            vaultId,
          },
        ],
      },
      packetExpiresInSeconds: 600,
      project: { label, objective: `${label} objective` },
      requestedRole: "contributor",
      sourceNotes: [],
      workItem: {
        constraints: [],
        definitionOfDone: ["The route stays owner-only."],
        objective: `${label} task`,
        requestedOutput: "A bounded receipt.",
      },
    },
    now,
    crypto.randomUUID(),
  );
}

describe("M4 owner Project brief route", () => {
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    await applyMigrations(env.DB, migrations);
    const now = Math.floor(Date.now() / 1_000);
    const session = await createSessionMaterial(now);
    await commitFirstOwner(
      env.DB,
      {
        backedUp: true,
        counter: 0,
        credentialId: `brief-route-${crypto.randomUUID()}`,
        deviceType: "multiDevice",
        publicKey: new Uint8Array([1, 2, 3]),
        transports: ["internal"],
        webauthnUserId: `brief-owner-${crypto.randomUUID()}`,
      },
      session,
      crypto.randomUUID(),
      now,
    );
    cookie = `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`;
    csrf = session.csrfToken;
  });

  it("requires the owner session and exact CSRF, then rejects stale and cross-Project edits", async () => {
    const first = await createProject("First brief");
    const second = await createProject("Second brief");
    const path = `${ORIGIN}/api/collaboration/projects/${first.projectId}/brief`;
    const body = {
      expectedProjectVersionId: first.packet.projectVersionId,
      expectedWorkItemVersionId: first.packet.workItemVersionId,
      idempotencyKey: `route-${crypto.randomUUID()}`,
      workItem: {
        ...first.packet.brief,
        objective: "Save this exact owner edit.",
      },
    };
    const request = (headers: HeadersInit) =>
      fetchWorker(path, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST",
      });

    expect((await request({})).status).toBe(401);
    expect((await request({ Cookie: cookie })).status).toBe(403);
    const accepted = await request({
      Cookie: cookie,
      Origin: ORIGIN,
      "X-OWD-CSRF": csrf,
    });
    expect(accepted.status).toBe(200);
    const replay = await request({
      Cookie: cookie,
      Origin: ORIGIN,
      "X-OWD-CSRF": csrf,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await accepted.clone().json());

    const stale = await fetchWorker(path, {
      body: JSON.stringify({
        ...body,
        idempotencyKey: undefined,
        workItem: { ...body.workItem, objective: "Conflicting stale edit." },
      }),
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-OWD-CSRF": csrf,
      },
      method: "POST",
    });
    expect(stale.status).toBe(409);

    const crossProject = await fetchWorker(path, {
      body: JSON.stringify({
        expectedProjectVersionId: second.packet.projectVersionId,
        expectedWorkItemVersionId: second.packet.workItemVersionId,
        project: { objective: "Never cross the Project boundary." },
      }),
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-OWD-CSRF": csrf,
      },
      method: "POST",
    });
    expect(crossProject.status).toBe(409);

    await env.DB.prepare(
      "UPDATE collaboration_projects SET status = 'archived' WHERE project_id = ?",
    )
      .bind(second.projectId)
      .run();
    const archived = await fetchWorker(
      `${ORIGIN}/api/collaboration/projects/${second.projectId}/brief`,
      {
        body: JSON.stringify({
          expectedProjectVersionId: second.packet.projectVersionId,
          expectedWorkItemVersionId: second.packet.workItemVersionId,
          project: { objective: "Archived history must remain immutable." },
        }),
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "X-OWD-CSRF": csrf,
        },
        method: "POST",
      },
    );
    expect(archived.status).toBe(404);
  });
});
