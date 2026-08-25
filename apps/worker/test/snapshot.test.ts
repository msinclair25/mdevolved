import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  OWD_SNAPSHOT_EXPORT_MAGIC,
  MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  apiErrorSchema,
  materializationJobSchema,
  snapshotIntelligenceManifestSchema,
  snapshotExportIndexSchema,
  snapshotListResponseSchema,
  snapshotManifestSchema,
  snapshotSummarySchema,
  sourceDescriptorSchema,
  type SnapshotManifest,
  type SnapshotSummary,
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
import { encodeBase64Url, sha256Hex } from "../src/security";
import {
  applyCollaborationRestore,
  createCollaborationRestore,
  stageCollaborationRestoreItem,
} from "../src/collaboration-restore";
import {
  importAgentSkill,
  saveWorkingPreference,
} from "../src/working-profile-service";
import {
  enforceSnapshotRetention,
  queueFailedSnapshotCleanup,
  runSnapshotGarbageCollection,
} from "../src/snapshot-retention";
import {
  buildPortableSnapshotExport,
  ensureSnapshotSchema,
} from "../src/snapshot-store";
import {
  applyContinuityR1Migration,
  applyElasticActorPlaneR3Migration,
  applyHandsOffLeadR2Migration,
  applyPolicyAutopilotR4Migration,
  applyPhase9aCollaborationMigration,
  applyRestoredContentAuthorizationMigration,
  executableMigration,
  workingProfileSkillsMigrationEntry,
} from "./migration-fixture";

const ORIGIN = "https://owd.test";

type OwnerSession = { cookie: string; csrf: string };

async function inspectPortableSnapshot(
  file: Blob,
  identity: string,
  onEntry?: (input: {
    bytes: Uint8Array;
    path: string;
    vaultName: string;
  }) => void,
  onWorkingProfileEntry?: (input: {
    bytes: Uint8Array;
    portableObjectId: string;
  }) => void,
): Promise<SnapshotManifest> {
  const prefix = new Uint8Array(
    await file.slice(0, 2 * 1024 * 1024).arrayBuffer(),
  );
  const firstLineEnd = prefix.indexOf(10);
  const secondLineEnd = prefix.indexOf(10, firstLineEnd + 1);
  const index = snapshotExportIndexSchema.parse(
    JSON.parse(
      new TextDecoder().decode(prefix.slice(firstLineEnd + 1, secondLineEnd)),
    ) as unknown,
  );
  let offset = secondLineEnd + 1;
  const parts = new Map<string, { blob: Blob; role: "content" | "manifest" }>();
  for (const part of index.parts) {
    parts.set(part.portableObjectId, {
      blob: file.slice(offset, offset + part.ciphertextBytes),
      role: part.role,
    });
    offset += part.ciphertextBytes;
  }
  expect(offset).toBe(file.size);
  async function decrypt(blob: Blob): Promise<Uint8Array> {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    return new Uint8Array(
      await new Response(await decrypter.decrypt(blob.stream())).arrayBuffer(),
    );
  }
  const manifestPart = parts.get(index.parts[0]?.portableObjectId ?? "");
  expect(manifestPart?.role).toBe("manifest");
  const manifest = snapshotManifestSchema.parse(
    JSON.parse(
      new TextDecoder().decode(await decrypt(manifestPart?.blob ?? new Blob())),
    ) as unknown,
  );
  const objectById = new Map(
    manifest.objects.map((object) => [object.portableObjectId, object]),
  );
  for (const vault of manifest.vaults) {
    for (const entry of vault.entries) {
      const object = objectById.get(entry.portableObjectId);
      const part = parts.get(entry.portableObjectId);
      expect(object).toMatchObject({
        byteLength: entry.byteLength,
        contentSha256: entry.contentSha256,
      });
      expect(part?.role).toBe("content");
      onEntry?.({
        bytes: await decrypt(part?.blob ?? new Blob()),
        path: entry.path,
        vaultName: vault.vaultName,
      });
    }
  }
  for (const record of manifest.intelligence?.workingProfile?.records ?? []) {
    const part = parts.get(record.portableObjectId);
    expect(part?.role).toBe("content");
    onWorkingProfileEntry?.({
      bytes: await decrypt(part?.blob ?? new Blob()),
      portableObjectId: record.portableObjectId,
    });
  }
  return manifest;
}

function portableSkillFiles() {
  const encode = (value: string) => {
    let binary = "";
    for (const byte of new TextEncoder().encode(value)) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  };
  return [
    {
      contentBase64: encode(
        "---\nname: encrypted-profile-check\ndescription: Verify portable recovery.\n---\n\nRemain inert.",
      ),
      path: "SKILL.md",
    },
  ];
}

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
  await ensureSnapshotSchema(env.DB);
  await applyPhase9aCollaborationMigration(env.DB);
  await applyRestoredContentAuthorizationMigration(env.DB);
  await applyContinuityR1Migration(env.DB);
  await applyHandsOffLeadR2Migration(env.DB);
  await applyElasticActorPlaneR3Migration(env.DB);
  await applyPolicyAutopilotR4Migration(env.DB);
  await env.DB.exec(
    executableMigration(workingProfileSkillsMigrationEntry.source),
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM working_profile_mutation_receipts"),
    env.DB.prepare("DELETE FROM project_skill_attachments"),
    env.DB.prepare("DELETE FROM working_preferences"),
    env.DB.prepare("DELETE FROM agent_skills"),
    env.DB.prepare("DELETE FROM working_profile_records"),
    env.DB.prepare("DELETE FROM snapshot_intelligence_items"),
    env.DB.prepare("DELETE FROM snapshot_intelligence_selections"),
    env.DB.prepare("DELETE FROM snapshot_entries"),
    env.DB.prepare("DELETE FROM snapshot_objects"),
    env.DB.prepare("DELETE FROM snapshot_vaults"),
    env.DB.prepare("DELETE FROM workspace_snapshots"),
    env.DB.prepare("DELETE FROM snapshot_gc_objects"),
    env.DB.prepare(
      `UPDATE snapshot_retention_policy
       SET enabled = 0, keep_ready_count = 5,
         max_retained_ciphertext_bytes = NULL, updated_at = 0
       WHERE id = 1`,
    ),
    env.DB.prepare("DELETE FROM agent_grant_restore_sources"),
    env.DB.prepare("DELETE FROM agent_grants"),
    env.DB.prepare("DELETE FROM restored_note_lineage"),
    env.DB.prepare("DELETE FROM restore_entries"),
    env.DB.prepare("DELETE FROM restore_jobs"),
    env.DB.prepare("DELETE FROM backup_artifacts"),
    env.DB.prepare("DELETE FROM backup_recipients"),
    env.DB.prepare("DELETE FROM materialized_note_search"),
    env.DB.prepare("DELETE FROM current_materializations"),
    env.DB.prepare("DELETE FROM materialized_notes"),
    env.DB.prepare("DELETE FROM materialization_jobs"),
    env.DB.prepare("DELETE FROM materialization_gc_objects"),
    env.DB.prepare("DELETE FROM materialization_generations"),
    env.DB.prepare("DELETE FROM vault_credentials"),
    env.DB.prepare("DELETE FROM pairing_grant_origins"),
    env.DB.prepare("DELETE FROM pairing_grants"),
    env.DB.prepare("DELETE FROM vaults"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM auth_challenges"),
    env.DB.prepare("DELETE FROM auth_rate_limits"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM owners"),
  ]);
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
      credentialId: `snapshot-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `snapshot-owner-${crypto.randomUUID()}`,
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

async function createActiveVault(displayName: string): Promise<string> {
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

async function configureRecoveryRecipient(
  session: OwnerSession,
): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const response = await fetchWorker(
    `${ORIGIN}/api/backups/recovery-recipient`,
    {
      body: JSON.stringify({ recipient }),
      headers: ownerHeaders(session, true),
      method: "PUT",
    },
  );
  expect(response.status).toBe(200);
  return { identity, recipient };
}

async function refreshVaultMaterialization(
  session: OwnerSession,
  vaultId: string,
): Promise<void> {
  const queued = await fetchWorker(
    `${ORIGIN}/api/vaults/${vaultId}/materializations`,
    { headers: ownerHeaders(session), method: "POST" },
  );
  expect([200, 202]).toContain(queued.status);
  let job = materializationJobSchema.parse(await queued.json());
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
    job = materializationJobSchema.parse(await status.json());
  }
  expect(job.status).toBe("completed");
}

async function createSnapshot(
  session: OwnerSession,
  body: Record<string, unknown> = {},
): Promise<SnapshotSummary> {
  const requestedVaultIds =
    Array.isArray(body.vaultIds) &&
    body.vaultIds.every((value) => typeof value === "string")
      ? (body.vaultIds as string[])
      : (
          await env.DB.prepare(
            `SELECT id FROM vaults WHERE status = 'active' ORDER BY id`,
          ).all<{ id: string }>()
        ).results.map((row) => row.id);
  for (const vaultId of requestedVaultIds) {
    await refreshVaultMaterialization(session, vaultId);
  }
  const started = await fetchWorker(`${ORIGIN}/api/snapshots`, {
    body: JSON.stringify(body),
    headers: ownerHeaders(session, true),
    method: "POST",
  });
  expect(started.status).toBe(201);
  let snapshot = snapshotSummarySchema.parse(await started.json());
  for (let step = 0; step < 100 && snapshot.status === "creating"; step += 1) {
    const continued = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/continue`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(continued.status).toBe(200);
    snapshot = snapshotSummarySchema.parse(await continued.json());
  }
  expect(snapshot.status).toBe("ready");
  return snapshot;
}

beforeEach(async () => {
  await resetStorage();
});

describe("workspace snapshots", () => {
  it("encrypts, exports, decrypts, and restores live working-profile records without authority", async () => {
    const session = await createOwnerSession();
    const { identity } = await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Working profile source");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        {
          content: "Synthetic working-profile recovery source",
          fileId: "profile-source",
          path: "Profile.md",
        },
      ]),
    );
    await saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: `encrypted-preference-${crypto.randomUUID()}`,
      key: "package-manager",
      projectId: null,
      sourceLabel: "Synthetic owner",
      sourceUrl: null,
      value: "pnpm",
    });
    await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: portableSkillFiles(),
      idempotencyKey: `encrypted-skill-${crypto.randomUUID()}`,
    });

    const snapshot = await createSnapshot(session, {
      intelligenceSelection: "none",
    });
    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(200);
    const profileBodies = new Map<string, Uint8Array>();
    const portableManifest = await inspectPortableSnapshot(
      await download.blob(),
      identity,
      undefined,
      ({ bytes, portableObjectId }) => {
        profileBodies.set(portableObjectId, bytes);
      },
    );
    const intelligence = snapshotIntelligenceManifestSchema.parse(
      portableManifest.intelligence,
    );
    expect(portableManifest.requiredCapabilities).toContain(
      WORKING_PROFILE_SNAPSHOT_CAPABILITY,
    );
    expect(
      new Set(
        intelligence.workingProfile?.records.map((record) => record.recordType),
      ),
    ).toEqual(new Set(["preference-version", "skill-version"]));
    expect(profileBodies.size).toBe(2);

    await resetStorage();
    let restore = await createCollaborationRestore(
      env.DB,
      { manifest: intelligence },
      snapshot.createdAt + 1,
    );
    for (const descriptor of intelligence.workingProfile?.records ?? []) {
      const bytes = profileBodies.get(descriptor.portableObjectId);
      if (bytes === undefined) throw new Error("Profile ciphertext missing.");
      restore = await stageCollaborationRestoreItem(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        {
          bytesBase64Url: encodeBase64Url(bytes),
          portableObjectId: descriptor.portableObjectId,
        },
      );
    }
    expect(restore.status).toBe("preview");
    await expect(
      applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        snapshot.createdAt + 2,
      ),
    ).resolves.toMatchObject({ grantCount: 0, status: "applied" });
    const restored = await env.DB.prepare(
      `SELECT record_type, restore_state, restored_authority_allowed
       FROM working_profile_records ORDER BY record_type`,
    ).all<{
      record_type: string;
      restore_state: string;
      restored_authority_allowed: number;
    }>();
    expect(restored.results).toEqual([
      {
        record_type: "preference-version",
        restore_state: "quarantined",
        restored_authority_allowed: 0,
      },
      {
        record_type: "skill-version",
        restore_state: "quarantined",
        restored_authority_allowed: 0,
      },
    ]);
    for (const table of [
      "working_preferences",
      "agent_skills",
      "project_skill_attachments",
      "agent_grants",
    ]) {
      expect(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
  });

  it("requires an owner session and CSRF proof at snapshot boundaries", async () => {
    const session = await createOwnerSession();
    const timeline = await fetchWorker(`${ORIGIN}/api/snapshots`);
    expect(timeline.status).toBe(401);
    expect(apiErrorSchema.parse(await timeline.json()).error.code).toBe(
      "authentication_required",
    );

    const mutation = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({}),
      headers: {
        Cookie: session.cookie,
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      method: "POST",
    });
    expect(mutation.status).toBe(403);
    expect(apiErrorSchema.parse(await mutation.json()).error.code).toBe(
      "csrf_denied",
    );

    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/10000000-0000-4000-8000-000000000001/download`,
    );
    expect(download.status).toBe(401);
  });

  it("never captures a stale library generation from a direct snapshot request", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Freshness guard vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "fresh", fileId: "fresh", path: "Fresh.md" },
      ]),
    );

    const pending = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({ vaultIds: [vaultId] }),
      headers: ownerHeaders(session, true),
      method: "POST",
    });
    expect(pending.status).toBe(409);
    expect(apiErrorSchema.parse(await pending.json()).error.code).toBe(
      "snapshot_source_refresh_pending",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workspace_snapshots",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await refreshVaultMaterialization(session, vaultId);
    const fresh = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({ vaultIds: [vaultId] }),
      headers: ownerHeaders(session, true),
      method: "POST",
    });
    expect(fresh.status).toBe(201);
    expect(snapshotSummarySchema.parse(await fresh.json()).status).toBe(
      "creating",
    );
  });

  it("blocks recovery-key rotation until an incomplete snapshot is cancelled", async () => {
    const session = await createOwnerSession();
    const firstRecovery = await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Rotation guard vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "guarded", fileId: "guarded", path: "Guarded.md" },
      ]),
    );
    await refreshVaultMaterialization(session, vaultId);
    const startedResponse = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({ vaultIds: [vaultId] }),
      headers: ownerHeaders(session, true),
      method: "POST",
    });
    expect(startedResponse.status).toBe(201);
    const started = snapshotSummarySchema.parse(await startedResponse.json());
    expect(started.status).toBe("creating");

    const nextIdentity = await generateX25519Identity();
    const nextRecipient = await identityToRecipient(nextIdentity);
    const auditCountBeforeBlocked = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE event_type = 'backup.recipient_configured'`,
    ).first<{ count: number }>();
    const blocked = await fetchWorker(
      `${ORIGIN}/api/backups/recovery-recipient`,
      {
        body: JSON.stringify({ recipient: nextRecipient }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(blocked.status).toBe(409);
    expect(apiErrorSchema.parse(await blocked.json()).error.code).toBe(
      "backup_recipient_in_use",
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE event_type = 'backup.recipient_configured'`,
      ).first<{ count: number }>(),
    ).toEqual(auditCountBeforeBlocked);
    const idempotent = await fetchWorker(
      `${ORIGIN}/api/backups/recovery-recipient`,
      {
        body: JSON.stringify({ recipient: firstRecovery.recipient }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(idempotent.status).toBe(200);

    const cancelledResponse = await fetchWorker(
      `${ORIGIN}/api/snapshots/${started.snapshotId}/cancel`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(cancelledResponse.status).toBe(200);
    const cancelled = snapshotSummarySchema.parse(
      await cancelledResponse.json(),
    );
    expect(cancelled).toMatchObject({
      failureCode: "snapshot_cancelled",
      status: "failed",
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE event_type = 'snapshot.cancelled'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const repeatedCancel = await fetchWorker(
      `${ORIGIN}/api/snapshots/${started.snapshotId}/cancel`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(repeatedCancel.status).toBe(409);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE event_type = 'snapshot.cancelled'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const rotated = await fetchWorker(
      `${ORIGIN}/api/backups/recovery-recipient`,
      {
        body: JSON.stringify({ recipient: nextRecipient }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(rotated.status).toBe(200);
  });

  it("reclaims cancelled snapshot references only after both cleanup grace periods", async () => {
    const session = await createOwnerSession();
    const recovery = await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Cancelled cleanup vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "cleanup", fileId: "cleanup", path: "Cleanup.md" },
      ]),
    );
    await refreshVaultMaterialization(session, vaultId);
    const started = snapshotSummarySchema.parse(
      await (
        await fetchWorker(`${ORIGIN}/api/snapshots`, {
          body: JSON.stringify({ vaultIds: [vaultId] }),
          headers: ownerHeaders(session, true),
          method: "POST",
        })
      ).json(),
    );
    const objectId = crypto.randomUUID();
    const objectKey = `snapshots/objects/${await sha256Hex(recovery.recipient)}/${crypto.randomUUID()}.age`;
    await env.VAULT_STORAGE.put(objectKey, "x");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO snapshot_objects (
            id, status, section, recipient_fingerprint, content_sha256,
            plaintext_bytes, ciphertext_bytes, object_key, object_etag,
            object_version, created_by_snapshot_id, created_at, verified_at
          ) VALUES (?, 'ready', 'notes', ?, ?, 1, 1, ?, 'etag', 'version',
            ?, ?, ?)`,
      ).bind(
        objectId,
        await sha256Hex(recovery.recipient),
        "e".repeat(64),
        objectKey,
        started.snapshotId,
        started.createdAt,
        started.createdAt,
      ),
      env.DB.prepare(
        `UPDATE snapshot_entries SET recovery_object_id = ?
           WHERE snapshot_id = ?`,
      ).bind(objectId, started.snapshotId),
    ]);
    const cancelled = snapshotSummarySchema.parse(
      await (
        await fetchWorker(
          `${ORIGIN}/api/snapshots/${started.snapshotId}/cancel`,
          { headers: ownerHeaders(session), method: "POST" },
        )
      ).json(),
    );
    const failedAt = await env.DB.prepare(
      `SELECT completed_at FROM workspace_snapshots WHERE id = ?`,
    )
      .bind(started.snapshotId)
      .first<{ completed_at: number }>();
    expect(failedAt).not.toBeNull();

    expect(
      await queueFailedSnapshotCleanup(
        env.DB,
        failedAt!.completed_at + 24 * 60 * 60 - 1,
      ),
    ).toBe(0);
    const queuedAt = failedAt!.completed_at + 24 * 60 * 60;
    expect(await queueFailedSnapshotCleanup(env.DB, queuedAt)).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM snapshot_entries
           WHERE snapshot_id = ?`,
      )
        .bind(started.snapshotId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(await env.VAULT_STORAGE.head(objectKey)).not.toBeNull();
    expect(
      await runSnapshotGarbageCollection(env.DB, env.VAULT_STORAGE, {
        now: queuedAt + 24 * 60 * 60,
      }),
    ).toBe(0);
    expect(await env.VAULT_STORAGE.head(objectKey)).toBeNull();
    expect(
      await queueFailedSnapshotCleanup(env.DB, queuedAt + 2 * 24 * 60 * 60),
    ).toBe(0);
    expect(cancelled.status).toBe("failed");
  });

  it("expires abandoned restore staging and retries deletion through bounded GC", async () => {
    const restoreId = crypto.randomUUID();
    const portableObjectId = crypto.randomUUID();
    const objectKey = `collaboration/restores/${restoreId}/${portableObjectId}`;
    const createdAt = 100;
    await env.VAULT_STORAGE.put(objectKey, "staged");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO collaboration_restore_jobs (
          id, status, manifest_json, expected_item_count, staged_item_count,
          created_at
        ) VALUES (?, 'staging', '{}', 1, 1, ?)`,
      ).bind(restoreId, createdAt),
      env.DB.prepare(
        `INSERT INTO collaboration_restore_items (
          restore_id, item_id, portable_object_id, object_key,
          content_sha256, byte_length
        ) VALUES (?, ?, ?, ?, ?, 6)`,
      ).bind(
        restoreId,
        crypto.randomUUID(),
        portableObjectId,
        objectKey,
        "a".repeat(64),
      ),
    ]);
    const grace = 24 * 60 * 60;
    await queueFailedSnapshotCleanup(env.DB, createdAt + grace - 1);
    expect(
      await env.DB.prepare(
        `SELECT object_key FROM collaboration_restore_items
         WHERE restore_id = ?`,
      )
        .bind(restoreId)
        .first(),
    ).not.toBeNull();
    await queueFailedSnapshotCleanup(env.DB, createdAt + grace);
    expect(
      await env.DB.prepare(
        `SELECT status, failure_code FROM collaboration_restore_jobs
         WHERE id = ?`,
      )
        .bind(restoreId)
        .first(),
    ).toEqual({ failure_code: "restore_expired", status: "failed" });
    expect(
      await env.DB.prepare(
        `SELECT object_key FROM collaboration_restore_items
         WHERE restore_id = ?`,
      )
        .bind(restoreId)
        .first(),
    ).toBeNull();
    expect(
      await runSnapshotGarbageCollection(env.DB, env.VAULT_STORAGE, {
        now: createdAt + 2 * grace,
      }),
    ).toBe(0);
    expect(await env.VAULT_STORAGE.head(objectKey)).toBeNull();

    const sharedKey = `working-profile/${crypto.randomUUID()}.json`;
    const sharedRecordId = crypto.randomUUID();
    await env.VAULT_STORAGE.put(sharedKey, "{}");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO working_profile_records (
          record_id, record_type, portable_object_id, preference_id,
          dependencies_json, body_object_key, content_sha256, byte_length,
          created_at, restored_at, restore_state, restored_authority_allowed
        ) VALUES (?, 'preference-version', ?, ?, '[]', ?, ?, 2, 1, 1,
          'quarantined', 0)`,
      ).bind(
        sharedRecordId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        sharedKey,
        "b".repeat(64),
      ),
      env.DB.prepare(
        `INSERT INTO snapshot_gc_objects (object_key, queued_at)
         VALUES (?, ?)`,
      ).bind(sharedKey, createdAt),
    ]);
    expect(
      await runSnapshotGarbageCollection(env.DB, env.VAULT_STORAGE, {
        now: createdAt + grace,
      }),
    ).toBe(0);
    expect(await env.VAULT_STORAGE.head(sharedKey)).not.toBeNull();
  });

  it("rejects an oversized working-profile restore before creating staging", async () => {
    const profileManifest = (count: number, evidenceCount = 0) =>
      snapshotIntelligenceManifestSchema.parse({
        approved:
          evidenceCount === 0
            ? null
            : {
                classification: "approved",
                evidenceObjectCount: evidenceCount,
                evidenceObjects: Array.from({ length: evidenceCount }, () => ({
                  byteLength: 1,
                  classification: "approved",
                  contentSha256: "b".repeat(64),
                  evidenceObjectId: crypto.randomUUID(),
                  portableObjectId: crypto.randomUUID(),
                  restoreDisposition: "restore-evidence-only",
                })),
                logicalBytes: evidenceCount,
                newlyStoredBytes: evidenceCount,
                recordCount: 0,
                records: [],
              },
        excludedAuthority: [
          "oauth-access-tokens",
          "oauth-refresh-tokens",
          "oauth-authorization-codes",
          "oauth-protocol-storage",
          "sessions",
          "passkeys",
          "pairing-secrets",
          "vault-credentials",
          "live-agent-grants",
          "recovery-private-keys",
          "harness-context",
          "provider-credentials",
          "runtime-caches",
        ],
        format: "owd-snapshot-intelligence-v1",
        requiredCapabilities: [
          ...(evidenceCount === 0 ? [] : [APPROVED_INTELLIGENCE_CAPABILITY]),
          WORKING_PROFILE_SNAPSHOT_CAPABILITY,
        ],
        schemaVersion: 1,
        selection: evidenceCount === 0 ? "none" : "approved",
        unvetted: null,
        workingProfile: {
          logicalBytes: count,
          newlyStoredBytes: count,
          recordCount: count,
          records: Array.from({ length: count }, () => ({
            byteLength: 1,
            contentSha256: "a".repeat(64),
            createdAt: 1,
            dependencies: [],
            portableObjectId: crypto.randomUUID(),
            preferenceId: crypto.randomUUID(),
            projectId: null,
            recordId: crypto.randomUUID(),
            recordType: "preference-version",
            restoreDisposition: "restore-quarantined",
            skillId: null,
          })),
        },
      });

    const restoreCountBefore =
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM collaboration_restore_jobs",
        ).first<{ count: number }>()
      )?.count ?? 0;
    const accepted = await createCollaborationRestore(
      env.DB,
      { manifest: profileManifest(MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS) },
      1,
    );
    expect(accepted).toMatchObject({
      expectedItemCount: MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS,
      status: "staging",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_restore_jobs",
      ).first<{ count: number }>(),
    ).toEqual({ count: restoreCountBefore + 1 });

    await expect(
      createCollaborationRestore(
        env.DB,
        {
          manifest: profileManifest(MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS + 1),
        },
        2,
      ),
    ).rejects.toMatchObject({ code: "submission_too_large" });
    await expect(
      createCollaborationRestore(
        env.DB,
        {
          manifest: profileManifest(1, MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS),
        },
        3,
      ),
    ).rejects.toMatchObject({ code: "submission_too_large" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM collaboration_restore_jobs",
      ).first<{ count: number }>(),
    ).toEqual({ count: restoreCountBefore + 1 });
  });

  it("permanently fails a legacy in-progress snapshot after recipient mismatch", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Mismatch vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "mismatch", fileId: "mismatch", path: "Mismatch.md" },
      ]),
    );
    await refreshVaultMaterialization(session, vaultId);
    const startedResponse = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({ vaultIds: [vaultId] }),
      headers: ownerHeaders(session, true),
      method: "POST",
    });
    const started = snapshotSummarySchema.parse(await startedResponse.json());
    const nextIdentity = await generateX25519Identity();
    const nextRecipient = await identityToRecipient(nextIdentity);
    await env.DB.prepare(
      `UPDATE backup_recipients
       SET recipient = ?, fingerprint = ?, updated_at = updated_at + 1
       WHERE id = 1`,
    )
      .bind(nextRecipient, await sha256Hex(nextRecipient))
      .run();

    const continued = await fetchWorker(
      `${ORIGIN}/api/snapshots/${started.snapshotId}/continue`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(continued.status).toBe(409);
    expect(apiErrorSchema.parse(await continued.json()).error.code).toBe(
      "snapshot_recipient_changed",
    );
    const status = await fetchWorker(
      `${ORIGIN}/api/snapshots/${started.snapshotId}`,
      { headers: { Cookie: session.cookie } },
    );
    expect(snapshotSummarySchema.parse(await status.json())).toMatchObject({
      failureCode: "snapshot_recipient_changed",
      status: "failed",
    });
  });

  it("archives and returns a ready snapshot without changing recovery data", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Archive source");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        {
          content: "retained recovery content",
          fileId: "archive-note",
          path: "Archive.md",
        },
      ]),
    );
    const snapshot = await createSnapshot(session);
    expect(snapshot.archivedAt).toBeNull();

    const anonymous = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/archive`,
      {
        body: JSON.stringify({ archived: true }),
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        method: "PUT",
      },
    );
    expect(anonymous.status).toBe(401);

    const missingCsrf = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/archive`,
      {
        body: JSON.stringify({ archived: true }),
        headers: {
          Cookie: session.cookie,
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        method: "PUT",
      },
    );
    expect(missingCsrf.status).toBe(403);

    const archivedResponse = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/archive`,
      {
        body: JSON.stringify({ archived: true }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(archivedResponse.status).toBe(200);
    const archived = snapshotSummarySchema.parse(await archivedResponse.json());
    expect(archived.archivedAt).not.toBeNull();

    const timeline = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      headers: ownerHeaders(session),
    });
    const listed = snapshotListResponseSchema.parse(await timeline.json());
    expect(listed.snapshots[0]?.archivedAt).toBe(archived.archivedAt);

    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(200);

    const repeatedArchive = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/archive`,
      {
        body: JSON.stringify({ archived: true }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(repeatedArchive.status).toBe(200);
    expect(
      snapshotSummarySchema.parse(await repeatedArchive.json()).archivedAt,
    ).toBe(archived.archivedAt);

    const returnedResponse = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/archive`,
      {
        body: JSON.stringify({ archived: false }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(returnedResponse.status).toBe(200);
    expect(
      snapshotSummarySchema.parse(await returnedResponse.json()).archivedAt,
    ).toBeNull();

    const audit = await env.DB.prepare(
      `SELECT event_type, COUNT(*) AS count FROM audit_events
       WHERE event_type IN ('snapshot.archived', 'snapshot.unarchived')
       GROUP BY event_type ORDER BY event_type`,
    ).all<{ count: number; event_type: string }>();
    expect(audit.results).toEqual([
      { count: 1, event_type: "snapshot.archived" },
      { count: 1, event_type: "snapshot.unarchived" },
    ]);
  });

  it("publishes a logically complete multi-vault graph and reuses ciphertext incrementally", async () => {
    const session = await createOwnerSession();
    const { identity } = await configureRecoveryRecipient(session);
    const firstVault = await createActiveVault("First vault");
    const secondVault = await createActiveVault("Second vault");
    const folderDescriptor = sourceDescriptorSchema.parse({
      sourceKind: "folder",
      label: "First folder",
      capabilities: ["markdown", "watch"],
      clientVersion: "mdevolved-cli-alpha.1",
      syncSchemaVersion: 1,
      descriptorVersion: 1,
      provenance: {
        pairedAt: 1,
        descriptorSha256: "a".repeat(64),
      },
    });
    await env.DB.prepare(
      "UPDATE vaults SET source_descriptor_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify(folderDescriptor), firstVault)
      .run();
    await Promise.all([
      env.VAULTS.getByName(firstVault).applyUpdate(
        createVaultUpdate([
          { content: "shared", fileId: "first-note", path: "First.md" },
        ]),
      ),
      env.VAULTS.getByName(secondVault).applyUpdate(
        createVaultUpdate([
          { content: "shared", fileId: "second-note", path: "Second.md" },
        ]),
      ),
    ]);

    const first = await createSnapshot(session);
    expect(first.scope).toBe("all-active");
    expect(first.vaults).toHaveLength(2);
    expect(first.itemCount).toBe(2);
    expect(first.totalObjectCount).toBe(1);
    expect(first.processedObjectCount).toBe(1);
    expect(first.changedItemCount).toBe(2);
    expect(first.integrityStatus).toBe("verified");
    expect(first.includedSections).toEqual(["notes"]);
    expect(first.unavailableSections).toEqual([
      "attachments",
      "obsidian-allowlist",
    ]);

    const objectCountAfterFirst = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM snapshot_objects WHERE status = 'ready'",
    ).first<{ count: number }>();
    expect(objectCountAfterFirst?.count).toBe(1);

    const second = await createSnapshot(session);
    expect(second.changedItemCount).toBe(0);
    expect(second.newlyStoredBytes).toBeGreaterThan(0);
    expect(second.newlyStoredBytes).toBeLessThan(first.newlyStoredBytes);
    const objectCountAfterSecond = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM snapshot_objects WHERE status = 'ready'",
    ).first<{ count: number }>();
    expect(objectCountAfterSecond?.count).toBe(1);
    const boundedSearchRows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM materialized_note_search`,
    ).first<{ count: number }>();
    expect(boundedSearchRows?.count).toBe(2);

    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${first.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(200);
    const file = await download.blob();
    expect(await file.slice(0, OWD_SNAPSHOT_EXPORT_MAGIC.length).text()).toBe(
      OWD_SNAPSHOT_EXPORT_MAGIC,
    );
    const restored = new Map<string, string>();
    const inspected = await inspectPortableSnapshot(
      file,
      identity,
      ({ bytes, path, vaultName }) => {
        restored.set(`${vaultName}:${path}`, new TextDecoder().decode(bytes));
      },
    );
    expect(inspected.vaults).toHaveLength(2);
    expect(inspected.snapshotId).not.toBe(first.snapshotId);
    for (const portableVault of inspected.vaults) {
      expect(portableVault.sourceVaultId).toBe(
        portableVault.vaultName === "First vault" ? firstVault : secondVault,
      );
      expect(portableVault.sourceGeneration?.generationId).toBe(
        portableVault.snapshotVaultId,
      );
      expect(portableVault.sourceGeneration?.generationId).not.toBe(
        first.vaults.find(
          (vault) => vault.vaultName === portableVault.vaultName,
        )?.generationId,
      );
      if (portableVault.vaultName === "First vault") {
        expect(portableVault.sourceDescriptor).toEqual({
          ...folderDescriptor,
          restoreDisposition: "quarantined",
          authorityRestored: false,
        });
      } else {
        expect(portableVault.sourceDescriptor).toBeUndefined();
      }
    }
    expect(restored).toEqual(
      new Map([
        ["First vault:First.md", "shared"],
        ["Second vault:Second.md", "shared"],
      ]),
    );
    await env.DB.prepare(
      `DELETE FROM snapshot_working_profile_selections WHERE snapshot_id = ?`,
    )
      .bind(first.snapshotId)
      .run();
    expect(
      (await buildPortableSnapshotExport(env.DB, first.snapshotId)).index
        .requiredCapabilities,
    ).not.toContain(WORKING_PROFILE_SNAPSHOT_CAPABILITY);

    const timeline = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      headers: ownerHeaders(session),
    });
    expect(timeline.status).toBe(200);
    expect(
      snapshotListResponseSchema.parse(await timeline.json()).snapshots,
    ).toHaveLength(2);
  });

  it("repairs a missing shared ciphertext from the retained canonical library object", async () => {
    const session = await createOwnerSession();
    const { identity } = await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Repair vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "repair me", fileId: "repair-note", path: "Repair.md" },
      ]),
    );
    const snapshot = await createSnapshot(session);
    const before = await env.DB.prepare(
      `SELECT o.id, o.object_key
       FROM snapshot_objects o
       JOIN snapshot_entries e ON e.recovery_object_id = o.id
       WHERE e.snapshot_id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{ id: string; object_key: string }>();
    expect(before).not.toBeNull();
    await env.VAULT_STORAGE.delete(before?.object_key ?? "missing");

    const repaired = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/repair`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(repaired.status).toBe(200);
    const result = (await repaired.json()) as {
      nextPortableObjectId: string | null;
      summary: SnapshotSummary;
    };
    expect(result.nextPortableObjectId).toBeNull();
    expect(snapshotSummarySchema.parse(result.summary).integrityStatus).toBe(
      "verified",
    );
    const after = await env.DB.prepare(
      `SELECT o.id, o.object_key
       FROM snapshot_objects o
       JOIN snapshot_entries e ON e.recovery_object_id = o.id
       WHERE e.snapshot_id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{ id: string; object_key: string }>();
    expect(after?.id).not.toBe(before?.id);
    expect(
      await env.VAULT_STORAGE.head(after?.object_key ?? "missing"),
    ).not.toBeNull();

    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(200);
    const repairedManifest = await inspectPortableSnapshot(
      await download.blob(),
      identity,
    );
    expect(repairedManifest.snapshotId).not.toBe(snapshot.snapshotId);
  });

  it("rebuilds a missing encrypted manifest before reporting integrity verified", async () => {
    const session = await createOwnerSession();
    const { identity } = await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Manifest repair vault");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        {
          content: "manifest repair",
          fileId: "manifest-repair-note",
          path: "Manifest repair.md",
        },
      ]),
    );
    const snapshot = await createSnapshot(session);
    const before = await env.DB.prepare(
      `SELECT manifest_object_key, newly_stored_bytes, portable_snapshot_id
       FROM workspace_snapshots WHERE id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{
        manifest_object_key: string;
        newly_stored_bytes: number;
        portable_snapshot_id: string;
      }>();
    expect(before).not.toBeNull();
    await env.VAULT_STORAGE.delete(
      before?.manifest_object_key ?? "missing-manifest",
    );

    const repaired = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/repair`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(repaired.status).toBe(200);
    const result = (await repaired.json()) as {
      nextPortableObjectId: string | null;
      summary: SnapshotSummary;
    };
    expect(result.nextPortableObjectId).toBeNull();
    expect(snapshotSummarySchema.parse(result.summary).integrityStatus).toBe(
      "verified",
    );
    const after = await env.DB.prepare(
      `SELECT manifest_object_key, newly_stored_bytes
       FROM workspace_snapshots WHERE id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{
        manifest_object_key: string;
        newly_stored_bytes: number;
      }>();
    expect(after?.manifest_object_key).not.toBe(before?.manifest_object_key);
    expect(after?.newly_stored_bytes).toBeGreaterThan(
      before?.newly_stored_bytes ?? 0,
    );
    expect(
      await env.VAULT_STORAGE.head(
        after?.manifest_object_key ?? "missing-manifest",
      ),
    ).not.toBeNull();

    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(200);
    const repairedManifest = await inspectPortableSnapshot(
      await download.blob(),
      identity,
    );
    expect(repairedManifest.snapshotId).toBe(before?.portable_snapshot_id);
    expect(repairedManifest.snapshotId).not.toBe(snapshot.snapshotId);
  });

  it("marks integrity degraded and fails closed when both ciphertext and repair source are missing", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Irrecoverable fixture");
    await env.VAULTS.getByName(vaultId).applyUpdate(
      createVaultUpdate([
        { content: "bounded", fileId: "bounded-note", path: "Bounded.md" },
      ]),
    );
    const snapshot = await createSnapshot(session);
    const object = await env.DB.prepare(
      `SELECT o.object_key, e.source_r2_key
       FROM snapshot_entries e
       JOIN snapshot_objects o ON o.id = e.recovery_object_id
       WHERE e.snapshot_id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{ object_key: string; source_r2_key: string }>();
    expect(object).not.toBeNull();
    await env.VAULT_STORAGE.delete([
      object?.object_key ?? "missing-one",
      object?.source_r2_key ?? "missing-two",
    ]);

    const repair = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/repair`,
      { headers: ownerHeaders(session), method: "POST" },
    );
    expect(repair.status).toBe(409);
    expect(apiErrorSchema.parse(await repair.json()).error.code).toBe(
      "snapshot_source_unavailable",
    );
    const status = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}`,
      { headers: ownerHeaders(session) },
    );
    expect(
      snapshotSummarySchema.parse(await status.json()).integrityStatus,
    ).toBe("degraded");
    const download = await fetchWorker(
      `${ORIGIN}/api/snapshots/${snapshot.snapshotId}/download`,
      { headers: ownerHeaders(session) },
    );
    expect(download.status).toBe(404);
  });

  it("fails the complete all-active capture when one fixed member cannot publish a library", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const readyVault = await createActiveVault("Ready member");
    await createActiveVault("Unavailable member");
    await env.VAULTS.getByName(readyVault).applyUpdate(
      createVaultUpdate([
        { content: "ready", fileId: "ready-note", path: "Ready.md" },
      ]),
    );

    const response = await fetchWorker(`${ORIGIN}/api/snapshots`, {
      body: JSON.stringify({}),
      headers: ownerHeaders(session, true),
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "snapshot_source_unavailable",
    );
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("protects pinned and newest-known-good snapshots while garbage collection resumes in bounded batches", async () => {
    const session = await createOwnerSession();
    await configureRecoveryRecipient(session);
    const vaultId = await createActiveVault("Retention vault");
    const snapshots: SnapshotSummary[] = [];
    for (const [index, fileId] of ["a", "b", "c", "d"].entries()) {
      await env.VAULTS.getByName(vaultId).applyUpdate(
        createVaultUpdate([
          {
            content: `retention-${index}`,
            fileId,
            path: "Retention.md",
          },
        ]),
      );
      snapshots.push(await createSnapshot(session));
    }
    const pinned = snapshots[0];
    expect(pinned).toBeDefined();
    const pinResponse = await fetchWorker(
      `${ORIGIN}/api/snapshots/${pinned?.snapshotId ?? "missing"}/pin`,
      {
        body: JSON.stringify({ pinned: true }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(pinResponse.status).toBe(200);
    const policyResponse = await fetchWorker(
      `${ORIGIN}/api/snapshots/retention`,
      {
        body: JSON.stringify({
          enabled: true,
          keepReadyCount: 2,
          maxRetainedCiphertextBytes: null,
        }),
        headers: ownerHeaders(session, true),
        method: "PUT",
      },
    );
    expect(policyResponse.status).toBe(200);

    const newestKnownGood = await env.DB.prepare(
      `SELECT id FROM workspace_snapshots
       WHERE status = 'ready' AND integrity_status = 'verified'
       ORDER BY capture_started_at DESC, id DESC LIMIT 1`,
    ).first<{ id: string }>();
    expect(newestKnownGood).not.toBeNull();

    const deleted = await enforceSnapshotRetention(env.DB, {
      now: Math.floor(Date.now() / 1_000),
      requestId: crypto.randomUUID(),
    });
    expect(deleted).toBeGreaterThanOrEqual(1);
    const retained = await env.DB.prepare(
      `SELECT id, pinned FROM workspace_snapshots
       WHERE status = 'ready' ORDER BY capture_started_at DESC, id DESC`,
    ).all<{ id: string; pinned: number }>();
    expect(retained.results).toHaveLength(4 - deleted);
    expect(retained.results.length).toBeGreaterThanOrEqual(2);
    expect(
      retained.results.some(
        (snapshot) =>
          snapshot.id === pinned?.snapshotId && snapshot.pinned === 1,
      ),
    ).toBe(true);
    expect(
      retained.results.some((snapshot) => snapshot.id === newestKnownGood?.id),
    ).toBe(true);

    const queuedBefore = await env.DB.prepare(
      `SELECT object_key FROM snapshot_gc_objects ORDER BY object_key`,
    ).all<{ object_key: string }>();
    expect(queuedBefore.results.length).toBeGreaterThanOrEqual(2);
    const queuedAt = Math.floor(Date.now() / 1_000);
    const pendingDuringGrace = await runSnapshotGarbageCollection(
      env.DB,
      env.VAULT_STORAGE,
      { limit: 1, now: queuedAt },
    );
    expect(pendingDuringGrace).toBe(queuedBefore.results.length);
    let pending = pendingDuringGrace;
    for (let pass = 0; pass < 10 && pending > 0; pass += 1) {
      pending = await runSnapshotGarbageCollection(env.DB, env.VAULT_STORAGE, {
        limit: 1,
        now: queuedAt + 24 * 60 * 60 + 1,
      });
    }
    expect(pending).toBe(0);
    for (const queued of queuedBefore.results) {
      expect(await env.VAULT_STORAGE.head(queued.object_key)).toBeNull();
    }
  }, 15_000);
});
