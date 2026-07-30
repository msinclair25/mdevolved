import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import { ensureAuthSchema } from "../src/auth-store";
import { ensureBackupSchema } from "../src/backup-store";
import {
  queueObsoleteMaterializations,
  runMaterializationGarbageCollection,
} from "../src/materialization-retention";
import { ensureMaterializationSchema } from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { ensureSnapshotSchema } from "../src/snapshot-store";
import { applyRestoredContentAuthorizationMigration } from "./migration-fixture";

const GRACE_SECONDS = 24 * 60 * 60;

type SeededGeneration = {
  id: string;
  manifestKey: string;
  noteKey: string;
};

async function clearR2(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.VAULT_STORAGE.list({ cursor });
    if (page.objects.length > 0) {
      await env.VAULT_STORAGE.delete(page.objects.map(({ key }) => key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function resetStorage(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await ensureBackupSchema(env.DB);
  await ensureAgentAccessSchema(env.DB);
  await applyRestoredContentAuthorizationMigration(env.DB);
  await ensureSnapshotSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snapshot_archives"),
    env.DB.prepare("DELETE FROM snapshot_entries"),
    env.DB.prepare("DELETE FROM snapshot_objects"),
    env.DB.prepare("DELETE FROM snapshot_vaults"),
    env.DB.prepare("DELETE FROM workspace_snapshots"),
    env.DB.prepare("DELETE FROM snapshot_gc_objects"),
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
  await clearR2();
}

async function createVault(): Promise<string> {
  const vaultId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO vaults (
      id, display_name, status, created_at, paired_at
    ) VALUES (?, 'Retention vault', 'active', 1, 1)`,
  )
    .bind(vaultId)
    .run();
  return vaultId;
}

async function seedGeneration(input: {
  createdAt: number;
  id?: string;
  noteKey?: string;
  status: "failed" | "published" | "staging";
  vaultId: string;
}): Promise<SeededGeneration> {
  const id = input.id ?? crypto.randomUUID();
  const manifestKey = `retention/manifests/${id}.json`;
  const noteKey = input.noteKey ?? `retention/notes/${id}.md`;
  const content = `note-${id}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO materialization_generations (
          id, vault_id, source_state_vector_sha256, status, note_count,
          total_bytes, manifest_key, manifest_sha256, created_at, completed_at,
          failure_code
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.vaultId,
      id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      input.status,
      new TextEncoder().encode(content).byteLength,
      manifestKey,
      "a".repeat(64),
      input.createdAt,
      input.status === "staging" ? null : input.createdAt,
      input.status === "failed" ? "synthetic_failure" : null,
    ),
    env.DB.prepare(
      `INSERT INTO materialized_notes (
          generation_id, vault_id, path, path_key, title, r2_key,
          content_sha256, byte_length, modified_at
        ) VALUES (?, ?, ?, ?, 'Retention note', ?, ?, ?, ?)`,
    ).bind(
      id,
      input.vaultId,
      `${id}.md`,
      `${id}.md`,
      noteKey,
      "b".repeat(64),
      new TextEncoder().encode(content).byteLength,
      input.createdAt,
    ),
  ]);
  await Promise.all([
    env.VAULT_STORAGE.put(manifestKey, `{"generationId":"${id}"}`),
    env.VAULT_STORAGE.put(noteKey, content),
  ]);
  return { id, manifestKey, noteKey };
}

beforeEach(async () => {
  await resetStorage();
});

describe("materialization retention", () => {
  it("keeps current, two prior generations, and backup references through the GC grace period", async () => {
    const vaultId = await createVault();
    const now = 2_000_000;
    const base = now - GRACE_SECONDS - 1_000;
    const protectedBackup = await seedGeneration({
      createdAt: base,
      status: "published",
      vaultId,
    });
    const removable = await seedGeneration({
      createdAt: base + 1,
      status: "published",
      vaultId,
    });
    const priorTwo = await seedGeneration({
      createdAt: base + 2,
      status: "published",
      vaultId,
    });
    const priorOne = await seedGeneration({
      createdAt: base + 3,
      status: "published",
      vaultId,
    });
    const current = await seedGeneration({
      createdAt: base + 4,
      status: "published",
      vaultId,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO current_materializations (
            vault_id, generation_id, updated_at
          ) VALUES (?, ?, ?)`,
      ).bind(vaultId, current.id, now),
      env.DB.prepare(
        `INSERT INTO backup_artifacts (
            id, vault_id, generation_id, format_version, status, object_key,
            recipient_fingerprint, note_count, plaintext_bytes,
            ciphertext_bytes, object_etag, object_version, created_at,
            completed_at, verified_at
          ) VALUES (?, ?, ?, 'owd-backup-v1', 'ready', ?, ?, 1, 1, 1,
            'etag', 'version', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        vaultId,
        protectedBackup.id,
        `retention/backups/${crypto.randomUUID()}.age`,
        "c".repeat(64),
        base,
        base,
        base,
      ),
    ]);

    expect(await queueObsoleteMaterializations(env.DB, now)).toBe(1);
    const generations = await env.DB.prepare(
      `SELECT id FROM materialization_generations ORDER BY created_at`,
    ).all<{ id: string }>();
    expect(generations.results.map(({ id }) => id)).toEqual([
      protectedBackup.id,
      priorTwo.id,
      priorOne.id,
      current.id,
    ]);
    expect(await env.VAULT_STORAGE.head(removable.manifestKey)).not.toBeNull();
    expect(await env.VAULT_STORAGE.head(removable.noteKey)).not.toBeNull();

    expect(
      await runMaterializationGarbageCollection(
        env.DB,
        env.VAULT_STORAGE,
        now + GRACE_SECONDS - 1,
      ),
    ).toBe(2);
    expect(await env.VAULT_STORAGE.head(removable.manifestKey)).not.toBeNull();

    expect(
      await runMaterializationGarbageCollection(
        env.DB,
        env.VAULT_STORAGE,
        now + GRACE_SECONDS,
      ),
    ).toBe(0);
    expect(await env.VAULT_STORAGE.head(removable.manifestKey)).toBeNull();
    expect(await env.VAULT_STORAGE.head(removable.noteKey)).toBeNull();
    expect(await env.VAULT_STORAGE.head(current.manifestKey)).not.toBeNull();
  });

  it("protects active jobs and rechecks newly referenced objects before deletion", async () => {
    const vaultId = await createVault();
    const now = 3_000_000;
    const base = now - GRACE_SECONDS - 1_000;
    const active = await seedGeneration({
      createdAt: base,
      status: "staging",
      vaultId,
    });
    const removable = await seedGeneration({
      createdAt: base + 1,
      status: "failed",
      vaultId,
    });
    const stagingKey = `retention/staging/${crypto.randomUUID()}.bin`;
    await env.VAULT_STORAGE.put(stagingKey, "staged");
    await env.DB.prepare(
      `INSERT INTO materialization_jobs (
        id, generation_id, vault_id, source_state_vector_sha256, status,
        staging_object_key, staging_object_bytes, next_offset,
        processed_note_count, total_note_count, schema_version, request_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, 6, 0, 0, 1, 3, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        active.id,
        vaultId,
        "d".repeat(64),
        stagingKey,
        crypto.randomUUID(),
        base,
        base,
      )
      .run();

    expect(await queueObsoleteMaterializations(env.DB, now)).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT status FROM materialization_generations WHERE id = ?`,
      )
        .bind(active.id)
        .first<{ status: string }>(),
    ).toEqual({ status: "staging" });
    expect(await env.VAULT_STORAGE.head(stagingKey)).not.toBeNull();

    const replacement = await seedGeneration({
      createdAt: now,
      noteKey: removable.noteKey,
      status: "published",
      vaultId,
    });
    expect(
      await runMaterializationGarbageCollection(
        env.DB,
        env.VAULT_STORAGE,
        now + GRACE_SECONDS,
      ),
    ).toBe(0);
    expect(await env.VAULT_STORAGE.head(removable.manifestKey)).toBeNull();
    expect(await env.VAULT_STORAGE.head(removable.noteKey)).not.toBeNull();
    expect(
      await env.VAULT_STORAGE.head(replacement.manifestKey),
    ).not.toBeNull();
    expect(await env.VAULT_STORAGE.head(stagingKey)).not.toBeNull();
  });
});
