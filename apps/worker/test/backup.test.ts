import {
  OWD_BACKUP_MAGIC,
  apiErrorSchema,
  backupArchiveManifestSchema,
  backupArtifactSchema,
  backupListResponseSchema,
  backupRecipientStatusSchema,
  materializationGenerationSchema,
  materializationJobSchema,
  materializedNotesResponseSchema,
  restoreApplyResponseSchema,
  restoreJobSchema,
  type BackupArchiveManifest,
} from "@owd/contracts";
import {
  Decrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import worker from "../src/index";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import { ensureBackupSchema } from "../src/backup-store";
import { ensureMaterializationSchema } from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { ensureSnapshotSchema } from "../src/snapshot-store";
import {
  cleanupExpiredRestores,
  createRestoreJob,
  readRestoreJob,
  readUsableRestoreMaterialization,
  stageRestoreNote,
} from "../src/restore-store";
import { sha256Hex } from "../src/security";
import { applyRestoredContentAuthorizationMigration } from "./migration-fixture";

const ORIGIN = "https://owd.test";
const decoder = new TextDecoder("utf-8", { fatal: true });

type OwnerSession = { cookie: string; csrf: string };

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function resetStorage(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await ensureBackupSchema(env.DB);
  await ensureAgentAccessSchema(env.DB);
  await applyRestoredContentAuthorizationMigration(env.DB);
  await ensureSnapshotSchema(env.DB);
  await env.DB.exec(`
    DELETE FROM snapshot_archives;
    DELETE FROM snapshot_entries;
    DELETE FROM snapshot_vaults;
    DELETE FROM workspace_snapshots;
    DELETE FROM agent_grant_restore_sources;
    DELETE FROM agent_grants;
    DELETE FROM restored_note_lineage;
    DELETE FROM restore_entries;
    DELETE FROM restore_jobs;
    DELETE FROM backup_artifacts;
    DELETE FROM backup_recipients;
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
  let cursor: string | undefined;
  do {
    const page = await env.VAULT_STORAGE.list({ cursor });
    if (page.objects.length > 0) {
      await env.VAULT_STORAGE.delete(page.objects.map(({ key }) => key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function createOwnerSession(): Promise<OwnerSession> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: `backup-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `backup-owner-${crypto.randomUUID()}`,
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

function ownerHeaders(
  session: OwnerSession,
  json = false,
): Record<string, string> {
  return {
    Cookie: session.cookie,
    Origin: ORIGIN,
    "X-OWD-CSRF": session.csrf,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function createActiveVault(displayName = "Recovery vault") {
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

function createVaultUpdate(
  notes: Array<{ content: string; fileId: string; path: string }>,
): ArrayBuffer {
  const document = new Y.Doc();
  document.getMap("sys").set("schemaVersion", 3);
  for (const [index, note] of notes.entries()) {
    const metadata = new Y.Map<unknown>();
    metadata.set("path", note.path);
    metadata.set("mtime", index + 1);
    document.getMap("meta").set(note.fileId, metadata);
    const text = new Y.Text();
    text.insert(0, note.content);
    document.getMap<Y.Text>("idToText").set(note.fileId, text);
  }
  const update = Y.encodeStateAsUpdate(document);
  const copy = new Uint8Array(update.byteLength);
  copy.set(update);
  document.destroy();
  return copy.buffer;
}

async function publishSnapshot(vaultId: string, session: OwnerSession) {
  const response = await fetchWorker(
    `${ORIGIN}/api/vaults/${vaultId}/materializations`,
    { headers: ownerHeaders(session), method: "POST" },
  );
  expect([200, 202]).toContain(response.status);
  let job = materializationJobSchema.parse(await response.json());
  for (
    let step = 0;
    step < 300 && (job.status === "queued" || job.status === "running");
    step += 1
  ) {
    // Miniflare may deliver the scheduled alarm itself before this helper
    // reaches it. Job status, not ownership of the timer race, is authoritative.
    await runDurableObjectAlarm(env.VAULTS.getByName(vaultId));
    const status = await fetchWorker(
      `${ORIGIN}/api/vaults/${vaultId}/materializations/${job.jobId}`,
      { headers: { Cookie: session.cookie } },
    );
    expect(status.status).toBe(200);
    job = materializationJobSchema.parse(await status.json());
  }
  expect(job.status).toBe("completed");
  return materializationGenerationSchema.parse(job.generation);
}

async function configureRecipient(session: OwnerSession, recipient: string) {
  return fetchWorker(`${ORIGIN}/api/backups/recovery-recipient`, {
    body: JSON.stringify({ recipient }),
    headers: ownerHeaders(session, true),
    method: "PUT",
  });
}

async function requestBackup(
  session: OwnerSession,
  vaultId: string,
  recipientFingerprint = "0".repeat(64),
): Promise<Response> {
  return fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/backups`, {
    body: JSON.stringify({ recipientFingerprint }),
    headers: ownerHeaders(session, true),
    method: "POST",
  });
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function parsePlaintext(value: Uint8Array) {
  const firstLineEnd = value.indexOf(10);
  const secondLineEnd = value.indexOf(10, firstLineEnd + 1);
  const magic = decoder.decode(value.subarray(0, firstLineEnd + 1));
  const manifest = backupArchiveManifestSchema.parse(
    JSON.parse(decoder.decode(value.subarray(firstLineEnd + 1, secondLineEnd))),
  );
  const notes = new Map<string, string>();
  let offset = secondLineEnd + 1;
  for (const note of manifest.notes) {
    const end = offset + note.byteLength;
    notes.set(note.path, decoder.decode(value.subarray(offset, end)));
    offset = end;
  }
  return { magic, manifest, notes, offset };
}

beforeEach(async () => {
  await resetStorage();
});

describe("age-encrypted backups", () => {
  it("accepts only a public X25519 recipient and never stores the identity", async () => {
    const session = await createOwnerSession();
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);

    const rejected = await configureRecipient(session, identity);
    expect(rejected.status).toBe(400);
    expect(apiErrorSchema.parse(await rejected.json()).error.code).toBe(
      "backup_recipient_invalid",
    );

    const configured = await configureRecipient(session, recipient);
    expect(configured.status).toBe(200);
    const status = backupRecipientStatusSchema.parse(await configured.json());
    expect(status).toMatchObject({ configured: true, recipient });

    const stored = await env.DB.prepare(
      `SELECT recipient, fingerprint FROM backup_recipients WHERE id = 1`,
    ).first<{ fingerprint: string; recipient: string }>();
    expect(stored?.recipient).toBe(recipient);
    expect(JSON.stringify(stored)).not.toContain(identity);
  });

  it("binds backup creation to the verified key and blocks rotation during encryption", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault("Recipient-bound vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "bound", fileId: "bound", path: "Bound.md" },
      ]),
    );
    const generation = await publishSnapshot(vaultId, session);
    const firstRecipient = await identityToRecipient(
      await generateX25519Identity(),
    );
    const secondRecipient = await identityToRecipient(
      await generateX25519Identity(),
    );
    const firstFingerprint = await sha256Hex(firstRecipient);
    const secondFingerprint = await sha256Hex(secondRecipient);
    expect((await configureRecipient(session, firstRecipient)).status).toBe(
      200,
    );

    const mismatched = await requestBackup(session, vaultId, secondFingerprint);
    expect(mismatched.status).toBe(409);
    expect(apiErrorSchema.parse(await mismatched.json()).error.code).toBe(
      "backup_recipient_changed",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM backup_artifacts",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await env.DB.prepare(
      `INSERT INTO backup_artifacts (
        id, vault_id, generation_id, format_version, status, object_key,
        recipient_fingerprint, note_count, plaintext_bytes, created_at
      ) VALUES (?, ?, ?, 'owd-backup-v1', 'creating', ?, ?, 1, 5, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        vaultId,
        generation.generationId,
        `backups/${crypto.randomUUID()}/vault.age`,
        firstFingerprint,
        Math.floor(Date.now() / 1_000),
      )
      .run();

    const rotated = await configureRecipient(session, secondRecipient);
    expect(rotated.status).toBe(409);
    expect(apiErrorSchema.parse(await rotated.json()).error.code).toBe(
      "backup_recipient_in_use",
    );
    expect(
      await env.DB.prepare(
        "SELECT fingerprint FROM backup_recipients WHERE id = 1",
      ).first<{ fingerprint: string }>(),
    ).toEqual({ fingerprint: firstFingerprint });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE event_type = 'backup.recipient_configured'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("streams, publishes, downloads, and decrypts one coherent artifact", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault("Disposable recovery vault");
    const source = [
      {
        content: "# Alpha\nA private note.",
        fileId: "alpha",
        path: "Projects/Alpha.md",
      },
      {
        content: "Beta is still private.",
        fileId: "beta",
        path: "βeta.md",
      },
    ];
    await env.VAULTS.getByName(vaultId).applyUpdate(createVaultUpdate(source));
    const generation = await publishSnapshot(vaultId, session);
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    expect((await configureRecipient(session, recipient)).status).toBe(200);

    const createdResponse = await requestBackup(
      session,
      vaultId,
      await sha256Hex(recipient),
    );
    expect(createdResponse.status).toBe(201);
    const created = backupArtifactSchema.parse(await createdResponse.json());
    expect(created).toMatchObject({
      generationId: generation.generationId,
      noteCount: 2,
      vaultId,
    });

    const row = await env.DB.prepare(
      `SELECT object_key, status FROM backup_artifacts WHERE id = ?`,
    )
      .bind(created.backupId)
      .first<{ object_key: string; status: string }>();
    expect(row?.status).toBe("ready");
    expect(row?.object_key).not.toContain(vaultId);
    expect(row?.object_key).not.toContain("Alpha");

    const list = backupListResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/backups`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    expect(list.backups).toEqual([created]);

    const download = await fetchWorker(
      `${ORIGIN}/api/backups/${created.backupId}/download`,
      { headers: { Cookie: session.cookie } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toContain(".age");
    const ciphertext = new Uint8Array(await download.arrayBuffer());
    expect(ciphertext.byteLength).toBe(created.ciphertextBytes);
    expect(decoder.decode(ciphertext.subarray(0, 10))).not.toContain("Alpha");

    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await readAll(
      await decrypter.decrypt(
        new Blob([ciphertext]).stream() as ReadableStream<Uint8Array>,
      ),
    );
    const parsed = parsePlaintext(plaintext);
    expect(parsed.magic).toBe(OWD_BACKUP_MAGIC);
    expect(parsed.offset).toBe(plaintext.byteLength);
    expect(parsed.manifest).toMatchObject({
      backupId: created.backupId,
      generation,
      includedSections: ["notes"],
      vaultName: "Disposable recovery vault",
    });
    expect(parsed.notes).toEqual(
      new Map(source.map(({ content, path }) => [path, content])),
    );

    await env.DB.prepare("UPDATE vaults SET status = 'revoked' WHERE id = ?")
      .bind(vaultId)
      .run();
    const retainedList = backupListResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/backups`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    expect(retainedList.backups).toEqual([created]);
    expect(
      (
        await fetchWorker(
          `${ORIGIN}/api/backups/${created.backupId}/download`,
          { headers: { Cookie: session.cookie } },
        )
      ).status,
    ).toBe(200);

    const wrongIdentity = await generateX25519Identity();
    const wrongDecrypter = new Decrypter();
    wrongDecrypter.addIdentity(wrongIdentity);
    await expect(
      wrongDecrypter.decrypt(
        new Blob([ciphertext]).stream() as ReadableStream<Uint8Array>,
      ),
    ).rejects.toThrow();
  });

  it("refuses a stale source until the durable refresh is complete", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault("Fresh backup vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "first", fileId: "first", path: "First.md" },
      ]),
    );
    const previous = await publishSnapshot(vaultId, session);
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    expect((await configureRecipient(session, recipient)).status).toBe(200);
    const recipientFingerprint = await sha256Hex(recipient);

    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "second", fileId: "second", path: "Second.md" },
      ]),
    );
    const pending = await requestBackup(session, vaultId, recipientFingerprint);
    expect(pending.status).toBe(409);
    expect(apiErrorSchema.parse(await pending.json()).error.code).toBe(
      "backup_source_refresh_pending",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM backup_artifacts",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const fresh = await publishSnapshot(vaultId, session);
    expect(fresh.generationId).not.toBe(previous.generationId);
    expect(fresh.noteCount).toBe(2);
    const created = backupArtifactSchema.parse(
      await (
        await requestBackup(session, vaultId, recipientFingerprint)
      ).json(),
    );
    expect(created.generationId).toBe(fresh.generationId);
    expect(created.noteCount).toBe(2);
  });

  it("fails closed without a key or coherent source and preserves a known-good backup", async () => {
    const session = await createOwnerSession();
    const vaultId = await createActiveVault();

    const noSnapshot = await requestBackup(session, vaultId);
    expect(noSnapshot.status).toBe(409);

    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "known good", fileId: "good", path: "Good.md" },
      ]),
    );
    await publishSnapshot(vaultId, session);
    const missingRecipient = await requestBackup(session, vaultId);
    expect(missingRecipient.status).toBe(409);
    expect(apiErrorSchema.parse(await missingRecipient.json()).error.code).toBe(
      "backup_recipient_missing",
    );

    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    expect((await configureRecipient(session, recipient)).status).toBe(200);
    const recipientFingerprint = await sha256Hex(recipient);
    const first = backupArtifactSchema.parse(
      await (
        await requestBackup(session, vaultId, recipientFingerprint)
      ).json(),
    );

    const source = await env.DB.prepare(
      `SELECT r2_key FROM materialized_notes WHERE vault_id = ? LIMIT 1`,
    )
      .bind(vaultId)
      .first<{ r2_key: string }>();
    expect(source).not.toBeNull();
    await env.VAULT_STORAGE.delete(source!.r2_key);

    const failed = await requestBackup(session, vaultId, recipientFingerprint);
    expect(failed.status).toBe(409);
    expect(apiErrorSchema.parse(await failed.json()).error.code).toBe(
      "backup_source_unavailable",
    );
    const list = backupListResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${vaultId}/backups`, {
          headers: { Cookie: session.cookie },
        })
      ).json(),
    );
    expect(list.backups).toEqual([first]);
  });

  it("stages, previews, confirms, resumes, and verifies a non-destructive overlay restore", async () => {
    const session = await createOwnerSession();
    const sourceVaultId = await createActiveVault("Source recovery vault");
    const targetVaultId = await createActiveVault("Exact target vault");
    const source = Array.from({ length: 23 }, (_, index) => ({
      content: `# Restored ${index}\nsource-${index}`,
      fileId: `source-${index}`,
      path: `Notes/Note-${String(index).padStart(2, "0")}.md`,
    }));
    await env.VAULTS.getByName(sourceVaultId).applyUpdate(
      createVaultUpdate(source),
    );
    await publishSnapshot(sourceVaultId, session);
    await env.VAULTS.getByName(targetVaultId).applyUpdate(
      createVaultUpdate([
        source[0]!,
        {
          content: "old target content",
          fileId: "target-changed",
          path: source[1]!.path,
        },
        {
          content: "must not be deleted",
          fileId: "target-only",
          path: "Current-only.md",
        },
      ]),
    );
    await publishSnapshot(targetVaultId, session);

    const sourceBoundaryBase = {
      version: 1,
      root: ".",
      pathPolicy: "mdevolved-markdown-v1",
      sourceKind: "folder",
      capabilities: ["markdown", "watch"],
    } as const;
    const sourceBoundarySha256 = await sha256Hex(
      JSON.stringify(sourceBoundaryBase),
    );
    const portableDeviceId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO source_devices (
        id, vault_id, display_name, root_fingerprint_sha256,
        boundary_json, boundary_sha256, client_version,
        sync_schema_version, enrollment_idempotency_key,
        enrollment_request_sha256, enrollment_grant_sha256,
        enrollment_origin_sha256, enrolled_at
      ) VALUES (?, ?, 'Disposable recovery device', ?, ?, ?,
        'mdevolved-cli-alpha.1', 1, ?, ?, ?, ?, ?)`,
    )
      .bind(
        portableDeviceId,
        sourceVaultId,
        "b".repeat(64),
        JSON.stringify({
          ...sourceBoundaryBase,
          boundarySha256: sourceBoundarySha256,
        }),
        sourceBoundarySha256,
        crypto.randomUUID(),
        "c".repeat(64),
        "d".repeat(64),
        "e".repeat(64),
        Math.floor(Date.now() / 1_000),
      )
      .run();

    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    expect((await configureRecipient(session, recipient)).status).toBe(200);
    const backup = backupArtifactSchema.parse(
      await (
        await requestBackup(session, sourceVaultId, await sha256Hex(recipient))
      ).json(),
    );
    const download = await fetchWorker(
      `${ORIGIN}/api/backups/${backup.backupId}/download`,
      { headers: { Cookie: session.cookie } },
    );
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await readAll(
      await decrypter.decrypt(
        new Blob([
          await download.arrayBuffer(),
        ]).stream() as ReadableStream<Uint8Array>,
      ),
    );
    const archive = parsePlaintext(plaintext);
    expect(archive.manifest.sourceDevices).toEqual([
      expect.objectContaining({
        authorityRestored: false,
        connectionRestored: false,
        credentialRestored: false,
        deviceId: portableDeviceId,
        restoreDisposition: "quarantined",
      }),
    ]);

    const unsafeManifest = structuredClone(archive.manifest);
    unsafeManifest.notes[0]!.path = ".obsidian/plugins/secret.md";
    const unsafe = await fetchWorker(
      `${ORIGIN}/api/vaults/${targetVaultId}/restores`,
      {
        body: JSON.stringify({ manifest: unsafeManifest }),
        headers: ownerHeaders(session, true),
        method: "POST",
      },
    );
    expect(unsafe.status).toBe(400);
    expect(apiErrorSchema.parse(await unsafe.json()).error.code).toBe(
      "restore_archive_invalid",
    );

    const oversizedManifest = structuredClone(archive.manifest);
    oversizedManifest.notes = Array.from({ length: 33 }, (_, index) => ({
      byteLength: 1024 * 1024,
      contentSha256: "a".repeat(64),
      modifiedAt: 1,
      path: `Oversized/Note-${String(index).padStart(2, "0")}.md`,
    }));
    oversizedManifest.generation.noteCount = oversizedManifest.notes.length;
    oversizedManifest.generation.totalBytes = 33 * 1024 * 1024;
    const oversized = await fetchWorker(
      `${ORIGIN}/api/vaults/${targetVaultId}/restores`,
      {
        body: JSON.stringify({ manifest: oversizedManifest }),
        headers: ownerHeaders(session, true),
        method: "POST",
      },
    );
    expect(oversized.status).toBe(400);
    expect(apiErrorSchema.parse(await oversized.json()).error.code).toBe(
      "restore_archive_invalid",
    );

    let job = restoreJobSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${targetVaultId}/restores`, {
          body: JSON.stringify({ manifest: archive.manifest }),
          headers: ownerHeaders(session, true),
          method: "POST",
        })
      ).json(),
    );
    expect(job).toMatchObject({
      sourceVaultId,
      status: "staging",
      targetVaultId,
      uploadedNoteCount: 0,
    });
    const quarantinedDevice = await env.DB.prepare(
      `SELECT restore_id, target_vault_id, authority_restored,
        credential_restored, connection_restored, body_json
       FROM quarantined_source_devices WHERE restore_id = ?`,
    )
      .bind(job.restoreId)
      .first<{
        authority_restored: number;
        body_json: string;
        connection_restored: number;
        credential_restored: number;
        restore_id: string;
        target_vault_id: string;
      }>();
    expect(quarantinedDevice).toMatchObject({
      authority_restored: 0,
      connection_restored: 0,
      credential_restored: 0,
      restore_id: job.restoreId,
      target_vault_id: targetVaultId,
    });
    expect(JSON.parse(quarantinedDevice?.body_json ?? "{}")).toMatchObject({
      deviceId: portableDeviceId,
      restoreDisposition: "quarantined",
    });
    const targetAuthority = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM vault_credentials WHERE vault_id = ?) AS credentials,
        (SELECT COUNT(*) FROM agent_grants WHERE vault_id = ?) AS grants`,
    )
      .bind(targetVaultId, targetVaultId)
      .first<{ credentials: number; grants: number }>();
    expect(targetAuthority).toEqual({ credentials: 0, grants: 0 });

    for (const note of archive.manifest.notes) {
      const response = await fetchWorker(
        `${ORIGIN}/api/restores/${job.restoreId}/note`,
        {
          body: JSON.stringify({
            content: archive.notes.get(note.path),
            path: note.path,
          }),
          headers: ownerHeaders(session, true),
          method: "PUT",
        },
      );
      expect(response.status).toBe(200);
      job = restoreJobSchema.parse(await response.json());
    }
    expect(job.uploadedNoteCount).toBe(23);

    const previewResponse = await fetchWorker(
      `${ORIGIN}/api/restores/${job.restoreId}/complete`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(previewResponse.status).toBe(200);
    job = restoreJobSchema.parse(await previewResponse.json());
    expect(job).toMatchObject({
      addedCount: 21,
      changedCount: 1,
      status: "preview",
      unchangedCount: 1,
    });

    const wrongTarget = await fetchWorker(
      `${ORIGIN}/api/restores/${job.restoreId}/confirm`,
      {
        body: JSON.stringify({ vaultName: "Source recovery vault" }),
        headers: ownerHeaders(session, true),
        method: "POST",
      },
    );
    expect(wrongTarget.status).toBe(409);
    expect(apiErrorSchema.parse(await wrongTarget.json()).error.code).toBe(
      "restore_target_mismatch",
    );

    const confirmed = await fetchWorker(
      `${ORIGIN}/api/restores/${job.restoreId}/confirm`,
      {
        body: JSON.stringify({ vaultName: "Exact target vault" }),
        headers: ownerHeaders(session, true),
        method: "POST",
      },
    );
    expect(confirmed.status).toBe(200);
    job = restoreJobSchema.parse(await confirmed.json());
    expect(job.status).toBe("applying");

    const interruptedEntry = await env.DB.prepare(
      `SELECT path, content_sha256, target_content_sha256, modified_at
       FROM restore_entries
       WHERE restore_id = ? AND path_key = ? AND status = 'staged'`,
    )
      .bind(job.restoreId, source[1]!.path.toLocaleLowerCase())
      .first<{
        content_sha256: string;
        modified_at: number | null;
        path: string;
        target_content_sha256: string | null;
      }>();
    expect(interruptedEntry).not.toBeNull();
    const interruptedWrite = await env.VAULTS.getByName(
      targetVaultId,
    ).restoreMarkdownNote(
      targetVaultId,
      {
        content: source[1]!.content,
        contentSha256: interruptedEntry!.content_sha256,
        expectedTargetContentSha256: interruptedEntry!.target_content_sha256,
        modifiedAt: interruptedEntry!.modified_at,
        path: interruptedEntry!.path,
      },
      Date.now(),
    );
    expect(interruptedWrite.ok).toBe(true);

    // Simulate an interruption after the canonical write but before the D1
    // entry records progress. The ordinary apply route must accept the desired
    // content idempotently and finish the same restore.

    const firstBatch = restoreApplyResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/restores/${job.restoreId}/apply`, {
          headers: ownerHeaders(session),
          method: "POST",
        })
      ).json(),
    );
    expect(firstBatch).toMatchObject({
      complete: false,
      job: { appliedNoteCount: 20, status: "applying" },
    });
    let secondBatch = restoreApplyResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/restores/${job.restoreId}/apply`, {
          headers: ownerHeaders(session),
          method: "POST",
        })
      ).json(),
    );
    expect(secondBatch).toMatchObject({
      complete: false,
      job: { appliedNoteCount: 23, status: "applying" },
    });
    expect(secondBatch.job.materializationJobId).not.toBeNull();
    for (let step = 0; step < 300 && !secondBatch.complete; step += 1) {
      if (secondBatch.job.materializationJobId !== null) {
        await runDurableObjectAlarm(env.VAULTS.getByName(targetVaultId));
      }
      secondBatch = restoreApplyResponseSchema.parse(
        await (
          await fetchWorker(`${ORIGIN}/api/restores/${job.restoreId}/apply`, {
            headers: ownerHeaders(session),
            method: "POST",
          })
        ).json(),
      );
    }
    expect(secondBatch.complete).toBe(true);
    expect(secondBatch.job).toMatchObject({
      appliedNoteCount: 23,
      materializationJobId: null,
      status: "applied",
    });
    expect(secondBatch.job.verifiedGenerationId).not.toBeNull();

    const retried = restoreApplyResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/restores/${job.restoreId}/apply`, {
          headers: ownerHeaders(session),
          method: "POST",
        })
      ).json(),
    );
    expect(retried).toEqual(secondBatch);

    const targetNotes = materializedNotesResponseSchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/vaults/${targetVaultId}/notes`, {
          body: JSON.stringify({ cursor: null }),
          headers: {
            "Content-Type": "application/json",
            Cookie: session.cookie,
          },
          method: "POST",
        })
      ).json(),
    );
    expect(targetNotes.notes).toHaveLength(24);
    expect(
      targetNotes.notes.some(({ path }) => path === "Current-only.md"),
    ).toBe(true);
    const restored = await fetchWorker(
      `${ORIGIN}/api/vaults/${targetVaultId}/note`,
      {
        body: JSON.stringify({ path: source[1]!.path }),
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
        },
        method: "POST",
      },
    );
    expect(await restored.text()).toBe(source[1]!.content);
    const currentOnly = await fetchWorker(
      `${ORIGIN}/api/vaults/${targetVaultId}/note`,
      {
        body: JSON.stringify({ path: "Current-only.md" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookie,
        },
        method: "POST",
      },
    );
    expect(await currentOnly.text()).toBe("must not be deleted");

    const lineageBeforeCleanup = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM restored_note_lineage
       WHERE restore_id = ?`,
    )
      .bind(job.restoreId)
      .first<{ count: number }>();
    expect(lineageBeforeCleanup?.count).toBe(23);
    const restoreTimestamps = await env.DB.prepare(
      `SELECT created_at FROM restore_jobs WHERE id = ?`,
    )
      .bind(job.restoreId)
      .first<{ created_at: number }>();
    expect(restoreTimestamps).not.toBeNull();
    const cleanupNow = restoreTimestamps!.created_at + 2;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE restore_jobs SET expires_at = ? WHERE id = ?`,
      ).bind(cleanupNow - 1, job.restoreId),
      env.DB.prepare(
        `UPDATE restore_cleanup_state SET last_run_at = 0 WHERE id = 1`,
      ),
    ]);
    await cleanupExpiredRestores(env.DB, env.VAULT_STORAGE, cleanupNow);
    const cleanupCounts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM restore_entries WHERE restore_id = ?) AS entries,
        (SELECT COUNT(*) FROM restored_note_lineage
          WHERE restore_id = ?) AS lineage`,
    )
      .bind(job.restoreId, job.restoreId)
      .first<{ entries: number; lineage: number }>();
    expect(cleanupCounts).toEqual({ entries: 0, lineage: 23 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM quarantined_source_devices
         WHERE restore_id = ?`,
      )
        .bind(job.restoreId)
        .first<number>("count"),
    ).toBe(1);

    const stagedObjects = await env.VAULT_STORAGE.list({
      prefix: `restores/${job.restoreId}/`,
    });
    expect(stagedObjects.objects).toHaveLength(0);
  }, 15_000);

  it("releases failed library jobs and expires abandoned plaintext staging", async () => {
    const session = await createOwnerSession();
    const targetVaultId = await createActiveVault("Expiring target");
    await env.VAULTS.getByName(targetVaultId).applyUpdate(
      createVaultUpdate([
        { content: "current", fileId: "current", path: "Current.md" },
      ]),
    );
    const generation = await publishSnapshot(targetVaultId, session);
    const materializationJob = await env.DB.prepare(
      `SELECT id FROM materialization_jobs WHERE generation_id = ?`,
    )
      .bind(generation.generationId)
      .first<{ id: string }>();
    expect(materializationJob).not.toBeNull();
    const content = "temporary staged plaintext";
    const byteLength = new TextEncoder().encode(content).byteLength;
    const manifest: BackupArchiveManifest = {
      backupId: crypto.randomUUID(),
      createdAt: 1,
      excludedSections: [
        "oauth",
        "sessions",
        "pairing-codes",
        "agent-grants",
        "pending-agent-proposals",
        "unknown-obsidian-plugin-data",
      ],
      format: "owd-backup-v1",
      generation: {
        completedAt: 1,
        createdAt: 1,
        generationId: crypto.randomUUID(),
        noteCount: 1,
        sourceStateVectorSha256: "a".repeat(64),
        totalBytes: byteLength,
        vaultId: crypto.randomUUID(),
      },
      includedSections: ["notes"],
      notes: [
        {
          byteLength,
          contentSha256: await sha256Hex(content),
          modifiedAt: 1,
          path: "Temporary.md",
        },
      ],
      reservedSections: [
        "attachments",
        "obsidian-allowlist",
        "accepted-memory",
        "skills",
        "provenance",
        "policy",
      ],
      vaultName: "Expired source",
    };
    const now = Math.floor(Date.now() / 1_000);
    const job = await createRestoreJob(env.DB, {
      manifest,
      now,
      requestId: crypto.randomUUID(),
      targetVaultId,
    });
    await stageRestoreNote(env.DB, env.VAULT_STORAGE, {
      content,
      now,
      path: "Temporary.md",
      restoreId: job.restoreId,
    });
    expect(
      (
        await env.VAULT_STORAGE.list({
          prefix: `restores/${job.restoreId}/`,
        })
      ).objects,
    ).toHaveLength(1);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE materialization_jobs
         SET status = 'failed', failure_code = 'materialization_unavailable',
           completed_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(now, now, materializationJob!.id),
      env.DB.prepare(
        `UPDATE restore_jobs SET materialization_job_id = ? WHERE id = ?`,
      ).bind(materializationJob!.id, job.restoreId),
    ]);
    const restoreWithFailedJob = await readRestoreJob(env.DB, job.restoreId);
    expect(restoreWithFailedJob).not.toBeNull();
    expect(
      await readUsableRestoreMaterialization(env.DB, restoreWithFailedJob!),
    ).toBeNull();
    expect(
      (await readRestoreJob(env.DB, job.restoreId))?.materializationJobId,
    ).toBeNull();

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE restore_jobs
         SET expires_at = ?, materialization_job_id = ? WHERE id = ?`,
      ).bind(now + 1, materializationJob!.id, job.restoreId),
      env.DB.prepare(
        `UPDATE restore_cleanup_state SET last_run_at = 0 WHERE id = 1`,
      ),
    ]);
    await cleanupExpiredRestores(env.DB, env.VAULT_STORAGE, now + 2);

    const expired = await env.DB.prepare(
      `SELECT status, failure_code, materialization_job_id
       FROM restore_jobs WHERE id = ?`,
    )
      .bind(job.restoreId)
      .first<{
        failure_code: string;
        materialization_job_id: string | null;
        status: string;
      }>();
    expect(expired).toEqual({
      failure_code: "restore_expired",
      materialization_job_id: null,
      status: "failed",
    });
    expect(
      (
        await env.VAULT_STORAGE.list({
          prefix: `restores/${job.restoreId}/`,
        })
      ).objects,
    ).toHaveLength(0);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM restore_entries WHERE restore_id = ?`,
      )
        .bind(job.restoreId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });
});
