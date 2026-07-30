import {
  apiErrorSchema,
  liveMarkdownNoteSchema,
  markdownNoteWriteResponseSchema,
} from "@owd/contracts";
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import worker from "../src/index";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import { ensureMaterializationSchema } from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { sha256Hex } from "../src/security";

const ORIGIN = "https://owd.test";

type OwnerSession = { cookie: string; csrf: string };

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function resetDatabase(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await env.DB.exec(`
    DELETE FROM materialized_note_search;
    DELETE FROM current_materializations;
    DELETE FROM materialized_notes;
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
      credentialId: `content-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `content-owner-${crypto.randomUUID()}`,
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

async function createActiveVault(): Promise<string> {
  const vaultId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    `INSERT INTO vaults (
      id, display_name, status, created_at, paired_at
    ) VALUES (?, 'Disposable content vault', 'active', ?, ?)`,
  )
    .bind(vaultId, now, now)
    .run();
  return vaultId;
}

function createVaultUpdate(
  notes: Array<{ content: string; fileId: string; path: string }>,
  schemaVersion = 3,
): ArrayBuffer {
  const document = new Y.Doc();
  document.getMap("sys").set("schemaVersion", schemaVersion);
  for (const [index, note] of notes.entries()) {
    const metadata = new Y.Map<unknown>();
    metadata.set("path", note.path);
    metadata.set("mtime", index + 1);
    document.getMap("meta").set(note.fileId, metadata);
    const text = new Y.Text();
    if (note.content.length > 0) text.insert(0, note.content);
    document.getMap<Y.Text>("idToText").set(note.fileId, text);
  }
  const update = Y.encodeStateAsUpdate(document);
  const copied = new Uint8Array(update.byteLength);
  copied.set(update);
  document.destroy();
  return copied.buffer;
}

async function seedVault(
  vaultId: string,
  notes: Array<{ content: string; fileId: string; path: string }>,
  schemaVersion = 3,
): Promise<void> {
  await env.VAULTS.getByName(vaultId).applyUpdate(
    createVaultUpdate(notes, schemaVersion),
  );
}

async function finishMaterialization(vaultId: string): Promise<void> {
  const vault = env.VAULTS.getByName(vaultId);
  for (let step = 0; step < 300; step += 1) {
    // Miniflare may claim the alarm between this helper's calls. The D1
    // invariant, not ownership of that timer race, proves publication.
    await runDurableObjectAlarm(vault);
    const state = await env.DB.prepare(
      `SELECT sync.current_state_vector_sha256, sync.library_stale,
        generation.source_state_vector_sha256,
        EXISTS (
          SELECT 1 FROM materialization_jobs job
          WHERE job.vault_id = sync.vault_id
            AND job.status IN ('queued', 'running')
        ) AS has_active_job
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
        has_active_job: number;
        library_stale: number;
        source_state_vector_sha256: string;
      }>();
    if (
      state !== null &&
      state.current_state_vector_sha256 === state.source_state_vector_sha256 &&
      state.library_stale === 0 &&
      state.has_active_job === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Materialization alarm did not settle.");
}

async function readLive(vaultId: string, session: OwnerSession, path: string) {
  const response = await fetchWorker(
    `${ORIGIN}/api/vaults/${vaultId}/live-note`,
    {
      body: JSON.stringify({ path }),
      headers: {
        Cookie: session.cookie,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  return {
    note:
      response.status === 200
        ? liveMarkdownNoteSchema.parse(await response.json())
        : null,
    response,
  };
}

async function writeLive(
  vaultId: string,
  session: OwnerSession,
  body: unknown,
  origin = ORIGIN,
): Promise<Response> {
  return fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/live-note`, {
    body: JSON.stringify(body),
    headers: {
      ...ownerHeaders(session, origin),
      "Content-Type": "application/json",
    },
    method: "PUT",
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("version-gated live Markdown editing", () => {
  it("requires the owner session, exact origin, and CSRF", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, [
      { content: "before", fileId: "note-1", path: "Safe.md" },
    ]);
    const expectedVersion = await sha256Hex("before");

    const anonymousRead = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/live-note`,
      {
        body: JSON.stringify({ path: "Safe.md" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    const missingCsrf = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/live-note`,
      {
        body: JSON.stringify({
          content: "after",
          expectedVersion,
          path: "Safe.md",
        }),
        headers: {
          Cookie: session.cookie,
          Origin: ORIGIN,
          "Content-Type": "application/json",
        },
        method: "PUT",
      },
    );
    const crossOrigin = await writeLive(
      vaultId,
      session,
      { content: "after", expectedVersion, path: "Safe.md" },
      "https://evil.test",
    );

    expect(anonymousRead.status).toBe(401);
    expect(missingCsrf.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
  });

  it("persists an acknowledged edit across eviction and rejects a stale retry", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, [
      { content: "before", fileId: "note-1", path: "Round trip.md" },
    ]);
    const opened = await readLive(vaultId, session, "Round trip.md");
    if (opened.note === null) throw new Error("Live note did not load.");

    const savedResponse = await writeLive(vaultId, session, {
      content: "after from web",
      expectedVersion: opened.note.contentVersion,
      path: opened.note.path,
    });
    expect(savedResponse.status).toBe(200);
    const saved = markdownNoteWriteResponseSchema.parse(
      await savedResponse.json(),
    );
    expect(saved).toMatchObject({
      durable: true,
      operation: "updated",
      projectionScheduled: true,
      note: { content: "after from web", path: "Round trip.md" },
    });
    await finishMaterialization(vaultId);
    const projected = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/note`,
      {
        body: JSON.stringify({ path: "Round trip.md" }),
        headers: {
          Cookie: session.cookie,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(projected.status).toBe(200);
    expect(await projected.text()).toBe("after from web");

    const staleResponse = await writeLive(vaultId, session, {
      content: "stale overwrite",
      expectedVersion: opened.note.contentVersion,
      path: opened.note.path,
    });
    expect(staleResponse.status).toBe(409);
    expect(apiErrorSchema.parse(await staleResponse.json()).error.code).toBe(
      "note_stale",
    );

    const vault = env.VAULTS.getByName(vaultId);
    await evictDurableObject(vault);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(await vault.exportState()));
    expect(reloaded.getMap<Y.Text>("idToText").get("note-1")?.toString()).toBe(
      "after from web",
    );
    reloaded.destroy();
  });

  it("round-trips a web edit through an Obsidian-compatible Yjs update", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, [
      { content: "seed", fileId: "note-1", path: "Roundtrip.md" },
    ]);
    const opened = await readLive(vaultId, session, "Roundtrip.md");
    if (opened.note === null) throw new Error("Live note did not load.");
    const webSave = await writeLive(vaultId, session, {
      content: "web",
      expectedVersion: opened.note.contentVersion,
      path: opened.note.path,
    });
    expect(webSave.status).toBe(200);

    const vault = env.VAULTS.getByName(vaultId);
    const client = new Y.Doc();
    Y.applyUpdate(client, new Uint8Array(await vault.exportState()));
    const clientBaseline = Y.encodeStateVector(client);
    client.getMap<Y.Text>("idToText").get("note-1")?.insert(3, " + obsidian");
    const clientDelta = Y.encodeStateAsUpdate(client, clientBaseline);
    const copied = new Uint8Array(clientDelta.byteLength);
    copied.set(clientDelta);
    await vault.applyUpdate(copied.buffer);
    client.destroy();

    await evictDurableObject(vault);
    const roundTripped = await readLive(vaultId, session, "Roundtrip.md");
    expect(roundTripped.response.status).toBe(200);
    expect(roundTripped.note?.content).toBe("web + obsidian");
  });

  it("rejects an old editor after the same path and text gain a new file identity", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, [
      { content: "same text", fileId: "old-id", path: "Identity.md" },
    ]);
    const opened = await readLive(vaultId, session, "Identity.md");
    if (opened.note === null) throw new Error("Live note did not load.");

    const vault = env.VAULTS.getByName(vaultId);
    const client = new Y.Doc();
    Y.applyUpdate(client, new Uint8Array(await vault.exportState()));
    const baseline = Y.encodeStateVector(client);
    client.transact(() => {
      const oldMetadata = client.getMap("meta").get("old-id");
      if (!(oldMetadata instanceof Y.Map)) {
        throw new Error("Missing old metadata.");
      }
      oldMetadata.set("deletedAt", Date.now());
      const newMetadata = new Y.Map<unknown>();
      newMetadata.set("path", "Identity.md");
      newMetadata.set("mtime", Date.now() + 1);
      client.getMap("meta").set("new-id", newMetadata);
      const newText = new Y.Text();
      newText.insert(0, "same text");
      client.getMap<Y.Text>("idToText").set("new-id", newText);
    });
    const replacement = Y.encodeStateAsUpdate(client, baseline);
    const copied = new Uint8Array(replacement.byteLength);
    copied.set(replacement);
    client.destroy();
    await vault.applyUpdate(copied.buffer);

    const stale = await writeLive(vaultId, session, {
      content: "must not replace the new identity",
      expectedVersion: opened.note.contentVersion,
      path: "Identity.md",
    });
    expect(stale.status).toBe(409);
    expect(apiErrorSchema.parse(await stale.json()).error.code).toBe(
      "note_stale",
    );
  });

  it("creates only an absent safe path and never revives a tombstone", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, []);

    const createdResponse = await writeLive(vaultId, session, {
      content: "# New",
      expectedVersion: null,
      path: "Inbox/New.md",
    });
    expect(createdResponse.status).toBe(201);
    const created = markdownNoteWriteResponseSchema.parse(
      await createdResponse.json(),
    );
    expect(created).toMatchObject({
      operation: "created",
      note: { path: "Inbox/New.md" },
    });

    const duplicate = await writeLive(vaultId, session, {
      content: "must not replace",
      expectedVersion: null,
      path: "inbox/new.md",
    });
    expect(duplicate.status).toBe(409);
    expect(apiErrorSchema.parse(await duplicate.json()).error.code).toBe(
      "note_exists",
    );

    const updated = await writeLive(vaultId, session, {
      content: "# New\n\nEdited again",
      expectedVersion: created.note.contentVersion,
      path: created.note.path,
    });
    expect(updated.status).toBe(200);

    const tombstonedVaultId = await createActiveVault();
    const tombstoned = new Y.Doc();
    tombstoned.getMap("sys").set("schemaVersion", 3);
    const deleted = new Y.Map<unknown>();
    deleted.set("path", "Deleted.md");
    deleted.set("deletedAt", Date.now());
    tombstoned.getMap("meta").set("deleted-id", deleted);
    const tombstoneUpdate = Y.encodeStateAsUpdate(tombstoned);
    const copied = new Uint8Array(tombstoneUpdate.byteLength);
    copied.set(tombstoneUpdate);
    tombstoned.destroy();
    await env.VAULTS.getByName(tombstonedVaultId).applyUpdate(copied.buffer);

    const revive = await writeLive(tombstonedVaultId, session, {
      content: "must stay deleted",
      expectedVersion: null,
      path: "Deleted.md",
    });
    expect(revive.status).toBe(409);
    expect(apiErrorSchema.parse(await revive.json()).error.code).toBe(
      "note_tombstoned",
    );
  });

  it("rejects configuration paths and older writable schemas", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, []);
    const configWrite = await writeLive(vaultId, session, {
      content: "unsafe",
      expectedVersion: null,
      path: ".obsidian/plugins.json.md",
    });
    expect(configWrite.status).toBe(400);

    const legacyVaultId = await createActiveVault();
    await seedVault(
      legacyVaultId,
      [{ content: "legacy", fileId: "legacy-id", path: "Legacy.md" }],
      2,
    );
    const legacyWrite = await writeLive(legacyVaultId, session, {
      content: "not written",
      expectedVersion: await sha256Hex("legacy"),
      path: "Legacy.md",
    });
    expect(legacyWrite.status).toBe(426);
  });

  it("does not acknowledge a write when Durable Object persistence fails", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();
    await seedVault(vaultId, [
      { content: "before", fileId: "note-1", path: "Uncertain.md" },
    ]);
    const opened = await readLive(vaultId, session, "Uncertain.md");
    if (opened.note === null) throw new Error("Live note did not load.");
    const vault = env.VAULTS.getByName(vaultId);
    await runInDurableObject(vault, async (_instance, state) => {
      await state.storage.put("document:journal:meta", { invalid: true });
    });

    const response = await writeLive(vaultId, session, {
      content: "not acknowledged",
      expectedVersion: opened.note.contentVersion,
      path: "Uncertain.md",
    });
    expect(response.status).toBe(503);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "vault_persistence_unavailable",
    );
  });
});
