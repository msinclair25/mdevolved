import {
  apiErrorSchema,
  currentMaterializationResponseSchema,
  materializationGenerationSchema,
  materializationJobSchema,
  materializedNotesResponseSchema,
  materializedSearchResponseSchema,
} from "@owd/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import worker from "../src/index";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import {
  continueNextMaterializationJob,
  createMaterializationJob,
  readMaterializationJob,
} from "../src/materialization-job";
import {
  extractMaterializedSnapshot,
  type MaterializedSnapshot,
} from "../src/materialization-snapshot";
import {
  MaterializationPublishError,
  ensureMaterializationSchema,
  publishMaterialization,
} from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { sha256HexBytes } from "../src/security";
import { VaultCoordinator } from "../src/vault-coordinator";

const ORIGIN = "https://owd.test";

type OwnerSession = { cookie: string; csrf: string };

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function resetDatabase(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await env.DB.exec(`
    DELETE FROM materialized_note_search;
    DELETE FROM current_materializations;
    DELETE FROM materialized_notes;
    DELETE FROM materialization_jobs;
    DELETE FROM materialization_gc_objects;
    DELETE FROM materialization_generations;
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vaults;
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
}

async function createOwnerSession(): Promise<OwnerSession> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: `materialization-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `materialization-owner-${crypto.randomUUID()}`,
    },
    session,
    crypto.randomUUID(),
    now,
  );
  return {
    cookie: `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`,
    csrf: session.csrfToken,
  };
}

function ownerHeaders(session: OwnerSession, origin = ORIGIN): HeadersInit {
  return {
    Cookie: session.cookie,
    Origin: origin,
    "X-OWD-CSRF": session.csrf,
  };
}

async function createActiveVault(displayName = "Materialized vault") {
  const vaultId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO vaults (
      id, display_name, status, created_at, paired_at
    ) VALUES (?, ?, 'active', ?, ?)`,
  )
    .bind(vaultId, displayName, now, now)
    .run();
  return vaultId;
}

function addNote(
  document: Y.Doc,
  fileId: string,
  path: string,
  content: string,
  modifiedAt = 1,
): void {
  const metadata = new Y.Map<unknown>();
  metadata.set("path", path);
  metadata.set("mtime", modifiedAt);
  document.getMap("meta").set(fileId, metadata);
  const text = new Y.Text();
  text.insert(0, content);
  document.getMap<Y.Text>("idToText").set(fileId, text);
}

function createVaultUpdate(
  notes: Array<{ content: string; fileId: string; path: string }>,
): ArrayBuffer {
  const document = new Y.Doc();
  document.getMap("sys").set("schemaVersion", 3);
  for (const [index, note] of notes.entries()) {
    addNote(document, note.fileId, note.path, note.content, index + 1);
  }
  const update = Y.encodeStateAsUpdate(document);
  const copied = new Uint8Array(update.byteLength);
  copied.set(update);
  document.destroy();
  return copied.buffer;
}

async function publishThroughApi(vaultId: string, session: OwnerSession) {
  return fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/materializations`, {
    headers: ownerHeaders(session),
    method: "POST",
  });
}

async function completeMaterialization(vaultId: string, session: OwnerSession) {
  const response = await publishThroughApi(vaultId, session);
  if (!response.ok) return { job: null, response };
  let job = materializationJobSchema.parse(await response.clone().json());
  for (
    let step = 0;
    step < 300 && (job.status === "queued" || job.status === "running");
    step += 1
  ) {
    // Miniflare may deliver the scheduled alarm itself before this helper
    // reaches it. Job status, not ownership of the timer race, is authoritative.
    await runDurableObjectAlarm(env.VAULTS.getByName(vaultId));
    job = materializationJobSchema.parse(
      await (
        await fetchWorker(
          `${ORIGIN}/api/vaults/${vaultId}/materializations/${job.jobId}`,
          { headers: { Cookie: session.cookie } },
        )
      ).json(),
    );
  }
  return { job, response };
}

async function confirmInitialSync(vaultId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `UPDATE vault_sync_states
     SET initial_sync_at = ?, updated_at = ?
     WHERE vault_id = ?`,
  )
    .bind(now, now, vaultId)
    .run();
}

async function waitForAutomaticMaterialization(
  vaultId: string,
  previousGenerationId: string,
): Promise<{
  currentStateVectorSha256: string;
  generationId: string;
  generationStateVectorSha256: string;
  libraryStale: number;
}> {
  const coordinator = env.VAULTS.getByName(vaultId);
  for (let step = 0; step < 300; step += 1) {
    await runDurableObjectAlarm(coordinator);
    const state = await env.DB.prepare(
      `SELECT sync.current_state_vector_sha256,
        sync.library_stale, generation.id AS generation_id,
        generation.source_state_vector_sha256
          AS generation_state_vector_sha256
       FROM vault_sync_states sync
       JOIN current_materializations current
         ON current.vault_id = sync.vault_id
       JOIN materialization_generations generation
         ON generation.id = current.generation_id
       WHERE sync.vault_id = ?`,
    )
      .bind(vaultId)
      .first<{
        current_state_vector_sha256: string;
        generation_id: string;
        generation_state_vector_sha256: string;
        library_stale: number;
      }>();
    if (
      state !== null &&
      state.generation_id !== previousGenerationId &&
      state.current_state_vector_sha256 ===
        state.generation_state_vector_sha256 &&
      state.library_stale === 0
    ) {
      return {
        currentStateVectorSha256: state.current_state_vector_sha256,
        generationId: state.generation_id,
        generationStateVectorSha256: state.generation_state_vector_sha256,
        libraryStale: state.library_stale,
      };
    }
  }
  throw new Error("Automatic materialization did not finish.");
}

beforeEach(async () => {
  await resetDatabase();
});

describe("immutable vault materialization", () => {
  it("uses PartyServer's alarm lifecycle wrapper", () => {
    expect(Object.hasOwn(VaultCoordinator.prototype, "alarm")).toBe(false);
    expect(Object.hasOwn(VaultCoordinator.prototype, "onAlarm")).toBe(true);
  });

  it("does not build automatically before the first sync is confirmed", async () => {
    const vaultId = await createActiveVault();
    const coordinator = env.VAULTS.getByName(vaultId);
    await coordinator.applyUpdate(
      createVaultUpdate([
        { content: "not confirmed", fileId: "note-1", path: "Note.md" },
      ]),
    );

    expect(await runDurableObjectAlarm(coordinator)).toBe(false);
    const job = await env.DB.prepare(
      `SELECT id FROM materialization_jobs WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ id: string }>();
    expect(job).toBeNull();
  });

  it("automatically publishes a successor library after a later vault sync", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    const coordinator = env.VAULTS.getByName(vaultId);
    await coordinator.applyUpdate(
      createVaultUpdate([
        { content: "first", fileId: "note-1", path: "First.md" },
      ]),
    );
    await confirmInitialSync(vaultId);
    const initial = await completeMaterialization(vaultId, session);
    const firstGeneration = materializationGenerationSchema.parse(
      initial.job?.generation,
    );

    await coordinator.applyUpdate(
      createVaultUpdate([
        { content: "second", fileId: "note-2", path: "Second.md" },
      ]),
    );
    const stale = await env.DB.prepare(
      `SELECT library_stale FROM vault_sync_states WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ library_stale: number }>();
    expect(stale?.library_stale).toBe(1);

    const refreshed = await waitForAutomaticMaterialization(
      vaultId,
      firstGeneration.generationId,
    );
    expect(refreshed).toMatchObject({
      currentStateVectorSha256: refreshed.generationStateVectorSha256,
      libraryStale: 0,
    });
    expect(refreshed.generationId).not.toBe(firstGeneration.generationId);
    const projected = await env.DB.prepare(
      `SELECT path FROM materialized_notes
       WHERE vault_id = ? AND generation_id = ?
       ORDER BY path`,
    )
      .bind(vaultId, refreshed.generationId)
      .all<{ path: string }>();
    expect(projected.results.map((note) => note.path)).toEqual([
      "First.md",
      "Second.md",
    ]);
  });

  it("requires owner authentication, exact origin, and CSRF", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "safe", fileId: "note-1", path: "Safe.md" },
      ]),
    );

    const anonymous = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/materializations`,
      { method: "POST" },
    );
    const crossOrigin = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/materializations`,
      {
        headers: ownerHeaders(session, "https://evil.test"),
        method: "POST",
      },
    );
    const missingCsrf = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/materializations`,
      { headers: { Cookie: session.cookie, Origin: ORIGIN }, method: "POST" },
    );

    expect(anonymous.status).toBe(401);
    expect(crossOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
  });

  it("publishes one coherent generation for browse, search, and streamed note reads", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    const hostileMarkdown =
      '# Alpha\n<script>globalThis.pwned = true</script>\n[bad](javascript:alert("x"))';
    const update = createVaultUpdate([
      {
        content: hostileMarkdown,
        fileId: "alpha-id",
        path: "Projects/Alpha.md",
      },
      {
        content: "A quiet beta note",
        fileId: "beta-id",
        path: "βeta.md",
      },
    ]);
    const sourceDocument = new Y.Doc();
    Y.applyUpdate(sourceDocument, new Uint8Array(update));
    const expectedSourceHash = await sha256HexBytes(
      Y.encodeStateVector(sourceDocument),
    );
    sourceDocument.destroy();
    await env.VAULTS.getByName(vaultId).applyUpdate(update);

    const completed = await completeMaterialization(vaultId, session);
    expect(completed.response.status).toBe(202);
    expect(completed.job?.status).toBe("completed");
    const published = materializationGenerationSchema.parse(
      completed.job?.generation,
    );
    expect(published).toMatchObject({
      noteCount: 2,
      sourceStateVectorSha256: expectedSourceHash,
      vaultId,
    });

    const status = currentMaterializationResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/materialization`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    const browse = materializedNotesResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/notes`, {
          body: JSON.stringify({ cursor: null }),
          headers: {
            Cookie: session.cookie,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      ).json(),
    );
    const search = materializedSearchResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/search`, {
          body: JSON.stringify({ query: "Alpha" }),
          headers: {
            Cookie: session.cookie,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      ).json(),
    );
    const noteResponse = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/note`,
      {
        body: JSON.stringify({ path: "Projects/Alpha.md" }),
        headers: {
          Cookie: session.cookie,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );

    expect(status.generation?.generationId).toBe(published.generationId);
    expect(browse.generation.generationId).toBe(published.generationId);
    expect(search.generation.generationId).toBe(published.generationId);
    expect(search.results[0]?.path).toBe("Projects/Alpha.md");
    expect(noteResponse.headers.get("X-OWD-Generation")).toBe(
      published.generationId,
    );
    expect(noteResponse.headers.get("Content-Type")).toContain("text/markdown");
    expect(await noteResponse.text()).toBe(hostileMarkdown);

    const stored = await env.DB.prepare(
      `SELECT r2_key FROM materialized_notes
       WHERE generation_id = ? AND path = ?`,
    )
      .bind(published.generationId, "Projects/Alpha.md")
      .first<{ r2_key: string }>();
    expect(stored?.r2_key).not.toContain("Projects");
    expect(stored?.r2_key).not.toContain("Alpha");
  });

  it("continues a large projection in bounded durable batches before atomic publication", async () => {
    const vaultId = await createActiveVault("Batched vault");
    const update = createVaultUpdate(
      Array.from({ length: 33 }, (_, index) => ({
        content: `note ${index}`,
        fileId: `note-${index}`,
        path: `Notes/${String(index).padStart(2, "0")}.md`,
      })),
    );
    const document = new Y.Doc();
    Y.applyUpdate(document, new Uint8Array(update));
    const stateVector = Y.encodeStateVector(document);
    let job = await createMaterializationJob(env.DB, env.VAULT_STORAGE, {
      now: 1,
      requestId: crypto.randomUUID(),
      snapshot: extractMaterializedSnapshot(document),
      sourceStateVectorSha256: await sha256HexBytes(stateVector),
      vaultId,
    });
    document.destroy();
    expect(job.processedNoteCount).toBe(0);

    expect(
      await continueNextMaterializationJob(
        env.DB,
        env.VAULT_STORAGE,
        vaultId,
        2,
      ),
    ).toEqual({ hasMore: true });
    job = materializationJobSchema.parse(
      await readMaterializationJob(env.DB, vaultId, job.jobId),
    );
    expect(job).toMatchObject({
      processedNoteCount: 16,
      status: "running",
      totalNoteCount: 33,
    });
    expect(
      (
        await env.DB.prepare(
          `SELECT generation_id FROM current_materializations
           WHERE vault_id = ?`,
        )
          .bind(vaultId)
          .first<{ generation_id: string }>()
      )?.generation_id,
    ).toBeUndefined();

    expect(
      await continueNextMaterializationJob(
        env.DB,
        env.VAULT_STORAGE,
        vaultId,
        3,
      ),
    ).toEqual({ hasMore: true });
    job = materializationJobSchema.parse(
      await readMaterializationJob(env.DB, vaultId, job.jobId),
    );
    expect(job).toMatchObject({
      processedNoteCount: 32,
      status: "running",
      totalNoteCount: 33,
    });
    expect(
      await continueNextMaterializationJob(
        env.DB,
        env.VAULT_STORAGE,
        vaultId,
        4,
      ),
    ).toEqual({ hasMore: false });
    job = materializationJobSchema.parse(
      await readMaterializationJob(env.DB, vaultId, job.jobId),
    );
    expect(job).toMatchObject({
      processedNoteCount: 33,
      status: "completed",
      totalNoteCount: 33,
    });
    expect(job.generation?.noteCount).toBe(33);
  });

  it("leaves a previous generation current when a later snapshot has an unsafe path", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    const vault = env.VAULTS.getByName(vaultId);
    await vault.applyUpdate(
      createVaultUpdate([
        { content: "known good", fileId: "good-id", path: "Good.md" },
      ]),
    );
    const firstResult = await completeMaterialization(vaultId, session);
    const first = materializationGenerationSchema.parse(
      firstResult.job?.generation,
    );

    await vault.applyUpdate(
      createVaultUpdate([
        {
          content: "must stay private",
          fileId: "bad-id",
          path: ".obsidian/plugins/secret.md",
        },
      ]),
    );
    const denied = await publishThroughApi(vaultId, session);
    const error = apiErrorSchema.parse(await denied.json());
    expect(denied.status).toBe(409);
    expect(error.error.code).toBe("vault_path_invalid");

    const current = currentMaterializationResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/materialization`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    const notes = materializedNotesResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/notes`, {
          body: JSON.stringify({ cursor: null }),
          headers: {
            Cookie: session.cookie,
            "Content-Type": "application/json",
          },
          method: "POST",
        })
      ).json(),
    );
    expect(current.generation?.generationId).toBe(first.generationId);
    expect(notes.notes.map((note) => note.path)).toEqual(["Good.md"]);
  });

  it("never publishes a generation after a partial R2 write failure", async () => {
    const vaultId = await createActiveVault("R2 failure vault");
    const snapshot: MaterializedSnapshot = {
      notes: [
        {
          byteLength: 3,
          content: "one",
          fileId: "one-id",
          modifiedAt: 1,
          path: "One.md",
          pathKey: "one.md",
          title: "One",
        },
        {
          byteLength: 3,
          content: "two",
          fileId: "two-id",
          modifiedAt: 2,
          path: "Two.md",
          pathKey: "two.md",
          title: "Two",
        },
      ],
      schemaVersion: 3,
      totalBytes: 6,
    };
    let writes = 0;
    const failingWriter = {
      head(key: string) {
        return env.VAULT_STORAGE.head(key);
      },
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutOptions,
      ) {
        writes += 1;
        if (writes === 2) throw new Error("synthetic R2 failure");
        return env.VAULT_STORAGE.put(key, value, options);
      },
    };

    await expect(
      publishMaterialization(env.DB, failingWriter, {
        now: Math.floor(Date.now() / 1_000),
        requestId: crypto.randomUUID(),
        snapshot,
        sourceStateVectorSha256: "a".repeat(64),
        vaultId,
      }),
    ).rejects.toBeInstanceOf(MaterializationPublishError);
    expect(writes).toBeGreaterThan(0);

    const current = await env.DB.prepare(
      "SELECT generation_id FROM current_materializations WHERE vault_id = ?",
    )
      .bind(vaultId)
      .first<{ generation_id: string }>();
    const failed = await env.DB.prepare(
      `SELECT status FROM materialization_generations WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ status: string }>();
    expect(current).toBeNull();
    expect(failed?.status).toBe("failed");
  });

  it("does not materialize a revoked vault", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "revoked", fileId: "note-id", path: "Note.md" },
      ]),
    );
    await env.DB.prepare("UPDATE vaults SET status = 'revoked' WHERE id = ?")
      .bind(vaultId)
      .run();

    const response = await publishThroughApi(vaultId, session);
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "materialization_unavailable",
    );
  });
});
