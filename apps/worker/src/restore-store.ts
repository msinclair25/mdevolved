import {
  type BackupArchiveManifest,
  type MaterializationJob,
  type RestoreJob,
  type RestoreMarkdownNoteRequest,
} from "@mdevolved/contracts";
import { readMaterializationJob } from "./materialization-job";
import { sha256Hex } from "./security";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ENTRY_BATCH_SIZE = 40;
const APPLY_BATCH_SIZE = 20;
const RESTORE_EXPIRY_SECONDS = 24 * 60 * 60;
const RESTORE_CLEANUP_INTERVAL_SECONDS = 60 * 60;

type RestoreJobRow = {
  added_count: number | null;
  applied_note_count: number;
  changed_count: number | null;
  created_at: number;
  expected_bytes: number;
  expected_note_count: number;
  expires_at: number;
  id: string;
  materialization_job_id: string | null;
  source_backup_id: string;
  source_vault_id: string;
  source_vault_name: string;
  status: RestoreJob["status"];
  target_vault_id: string;
  unchanged_count: number | null;
  updated_at: number;
  uploaded_bytes: number;
  uploaded_note_count: number;
  verified_generation_id: string | null;
};

type RestoreEntryRow = {
  byte_length: number;
  content_sha256: string;
  modified_at: number | null;
  path: string;
  path_key: string;
  staging_key: string;
  status: "applied" | "pending" | "staged";
  target_content_sha256: string | null;
};

export class RestoreError extends Error {
  readonly code:
    | "restore_archive_invalid"
    | "restore_incomplete"
    | "restore_not_found"
    | "restore_state_invalid"
    | "restore_target_changed"
    | "restore_target_mismatch"
    | "restore_unavailable";

  constructor(code: RestoreError["code"]) {
    super(code);
    this.name = "RestoreError";
    this.code = code;
  }
}

function jobFromRow(row: RestoreJobRow): RestoreJob {
  return {
    addedCount: row.added_count,
    appliedNoteCount: row.applied_note_count,
    changedCount: row.changed_count,
    createdAt: row.created_at,
    expectedBytes: row.expected_bytes,
    expectedNoteCount: row.expected_note_count,
    expiresAt: row.expires_at,
    restoreId: row.id,
    materializationJobId: row.materialization_job_id,
    sourceBackupId: row.source_backup_id,
    sourceVaultId: row.source_vault_id,
    sourceVaultName: row.source_vault_name,
    status: row.status,
    targetVaultId: row.target_vault_id,
    unchangedCount: row.unchanged_count,
    updatedAt: row.updated_at,
    uploadedBytes: row.uploaded_bytes,
    uploadedNoteCount: row.uploaded_note_count,
    verifiedGenerationId: row.verified_generation_id,
  };
}

export async function readRestoreJob(
  db: D1Database,
  restoreId: string,
): Promise<RestoreJob | null> {
  const row = await db
    .prepare(
      `SELECT id, target_vault_id, source_backup_id, source_vault_id,
        source_vault_name, status, expected_note_count, expected_bytes,
        uploaded_note_count, uploaded_bytes, added_count, changed_count,
        unchanged_count, applied_note_count, created_at, updated_at, expires_at,
        verified_generation_id, materialization_job_id
       FROM restore_jobs WHERE id = ?`,
    )
    .bind(restoreId)
    .first<RestoreJobRow>();
  return row === null ? null : jobFromRow(row);
}

export async function readUsableRestoreMaterialization(
  db: D1Database,
  job: RestoreJob,
): Promise<MaterializationJob | null> {
  if (job.materializationJobId === null) return null;
  const materialization = await readMaterializationJob(
    db,
    job.targetVaultId,
    job.materializationJobId,
  );
  if (materialization !== null && materialization.status !== "failed") {
    return materialization;
  }
  await db
    .prepare(
      `UPDATE restore_jobs SET materialization_job_id = NULL
       WHERE id = ? AND materialization_job_id = ?
         AND status IN ('staging', 'applying')`,
    )
    .bind(job.restoreId, job.materializationJobId)
    .run();
  return null;
}

function validatedManifestEntries(manifest: BackupArchiveManifest) {
  const entries: Array<{
    byteLength: number;
    contentSha256: string;
    modifiedAt: number | null;
    path: string;
    pathKey: string;
  }> = [];
  let previousPathKey: string | null = null;
  try {
    for (const note of manifest.notes) {
      const path = validateMarkdownVaultPath(note.path);
      if (
        previousPathKey !== null &&
        path.pathKey.localeCompare(previousPathKey) <= 0
      ) {
        throw new RestoreError("restore_archive_invalid");
      }
      previousPathKey = path.pathKey;
      entries.push({ ...note, path: path.path, pathKey: path.pathKey });
    }
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new RestoreError("restore_archive_invalid");
    }
    throw error;
  }
  return entries;
}

export async function createRestoreJob(
  db: D1Database,
  input: {
    manifest: BackupArchiveManifest;
    now: number;
    requestId: string;
    targetVaultId: string;
  },
): Promise<RestoreJob> {
  const entries = validatedManifestEntries(input.manifest);
  const restoreId = crypto.randomUUID();
  const expectedBytes = entries.reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  let staged = false;
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO restore_jobs (
          id, target_vault_id, source_backup_id, source_vault_id,
          source_vault_name, source_generation_id, status,
          expected_note_count, expected_bytes, created_at, updated_at
          , expires_at
        )
        SELECT ?, id, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?
        FROM vaults WHERE id = ? AND status = 'active'
        RETURNING id`,
      )
      .bind(
        restoreId,
        input.manifest.backupId,
        input.manifest.generation.vaultId,
        input.manifest.vaultName,
        input.manifest.generation.generationId,
        entries.length,
        expectedBytes,
        input.now,
        input.now,
        input.now + RESTORE_EXPIRY_SECONDS,
        input.targetVaultId,
      )
      .first<{ id: string }>();
    if (inserted?.id !== restoreId) {
      throw new RestoreError("restore_target_mismatch");
    }
    staged = true;

    for (let index = 0; index < entries.length; index += ENTRY_BATCH_SIZE) {
      await db.batch(
        entries.slice(index, index + ENTRY_BATCH_SIZE).map((entry) =>
          db
            .prepare(
              `INSERT INTO restore_entries (
                restore_id, path, path_key, content_sha256, byte_length,
                modified_at, staging_key, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            )
            .bind(
              restoreId,
              entry.path,
              entry.pathKey,
              entry.contentSha256,
              entry.byteLength,
              entry.modifiedAt,
              `restores/${restoreId}/notes/${crypto.randomUUID()}.md`,
            ),
        ),
      );
    }
    for (const device of input.manifest.sourceDevices ?? []) {
      const bodyJson = JSON.stringify(device);
      await db
        .prepare(
          `INSERT INTO quarantined_source_devices (
            portable_id, restore_id, target_vault_id, source_vault_id,
            body_json, body_sha256, restored_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          restoreId,
          input.targetVaultId,
          input.manifest.generation.vaultId,
          bodyJson,
          await sha256Hex(bodyJson),
          input.now,
        )
        .run();
    }
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'restore.staging_created', ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now)
      .run();
    const job = await readRestoreJob(db, restoreId);
    if (job === null) throw new RestoreError("restore_unavailable");
    return job;
  } catch (error) {
    if (staged) {
      await db
        .prepare(
          `UPDATE restore_jobs
           SET status = 'failed', failure_code = 'restore_unavailable',
             updated_at = ?
           WHERE id = ? AND status = 'staging'`,
        )
        .bind(input.now, restoreId)
        .run();
    }
    if (error instanceof RestoreError) throw error;
    throw new RestoreError("restore_unavailable");
  }
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function stageRestoreNote(
  db: D1Database,
  storage: R2Bucket,
  input: { content: string; now: number; path: string; restoreId: string },
): Promise<RestoreJob> {
  let pathKey: string;
  try {
    pathKey = validateMarkdownVaultPath(input.path).pathKey;
  } catch {
    throw new RestoreError("restore_archive_invalid");
  }
  const entry = await db
    .prepare(
      `SELECT e.path, e.path_key, e.content_sha256, e.byte_length,
        e.modified_at, e.staging_key, e.status, e.target_content_sha256
       FROM restore_entries e
       JOIN restore_jobs j ON j.id = e.restore_id
       WHERE e.restore_id = ? AND e.path_key = ? AND j.status = 'staging'
         AND j.expires_at > ?`,
    )
    .bind(input.restoreId, pathKey, input.now)
    .first<RestoreEntryRow>();
  if (entry === null || entry.path !== input.path) {
    throw new RestoreError("restore_archive_invalid");
  }
  const contentBytes = encoder.encode(input.content);
  const contentSha256 = await sha256Hex(input.content);
  if (
    contentBytes.byteLength !== entry.byte_length ||
    contentSha256 !== entry.content_sha256
  ) {
    throw new RestoreError("restore_archive_invalid");
  }

  if (entry.status === "pending") {
    const checksum = await crypto.subtle.digest("SHA-256", contentBytes);
    const written = await storage.put(entry.staging_key, contentBytes.buffer, {
      customMetadata: { sha256: contentSha256 },
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "text/markdown; charset=utf-8",
      },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: checksum,
    });
    if (written === null) {
      const existing = await storage.head(entry.staging_key);
      if (
        existing === null ||
        existing.size !== entry.byte_length ||
        existing.checksums.sha256 === undefined ||
        bytesToHex(existing.checksums.sha256) !== entry.content_sha256
      ) {
        throw new RestoreError("restore_unavailable");
      }
    }
    await db
      .prepare(
        `UPDATE restore_entries
         SET status = 'staged', staged_at = ?
         WHERE restore_id = ? AND path_key = ? AND status = 'pending'`,
      )
      .bind(input.now, input.restoreId, pathKey)
      .run();
  }

  await db
    .prepare(
      `UPDATE restore_jobs SET
        uploaded_note_count = (
          SELECT COUNT(*) FROM restore_entries
          WHERE restore_id = ? AND status IN ('staged', 'applied')
        ),
        uploaded_bytes = COALESCE((
          SELECT SUM(byte_length) FROM restore_entries
          WHERE restore_id = ? AND status IN ('staged', 'applied')
        ), 0),
        updated_at = ?
       WHERE id = ? AND status = 'staging'`,
    )
    .bind(input.restoreId, input.restoreId, input.now, input.restoreId)
    .run();
  const job = await readRestoreJob(db, input.restoreId);
  if (job === null) throw new RestoreError("restore_not_found");
  return job;
}

export async function completeRestorePreview(
  db: D1Database,
  input: { generationId: string; now: number; restoreId: string },
): Promise<RestoreJob> {
  const job = await readRestoreJob(db, input.restoreId);
  if (job === null) throw new RestoreError("restore_not_found");
  if (job.status !== "staging") {
    if (job.status === "preview") return job;
    throw new RestoreError("restore_state_invalid");
  }
  if (job.expiresAt <= input.now) {
    throw new RestoreError("restore_state_invalid");
  }
  if (
    job.uploadedNoteCount !== job.expectedNoteCount ||
    job.uploadedBytes !== job.expectedBytes
  ) {
    throw new RestoreError("restore_incomplete");
  }
  const result = await db
    .prepare(
      `SELECT e.path, e.path_key, e.content_sha256, e.byte_length,
        e.modified_at, e.staging_key, e.status,
        n.content_sha256 AS target_content_sha256
       FROM restore_entries e
       LEFT JOIN materialized_notes n
         ON n.generation_id = ?
        AND n.vault_id = ?
        AND n.path_key = e.path_key
       WHERE e.restore_id = ? AND e.status = 'staged'
       ORDER BY e.path_key`,
    )
    .bind(input.generationId, job.targetVaultId, input.restoreId)
    .all<RestoreEntryRow>();
  if (result.results.length !== job.expectedNoteCount) {
    throw new RestoreError("restore_incomplete");
  }
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const entry of result.results) {
    if (entry.target_content_sha256 === null) added += 1;
    else if (entry.target_content_sha256 === entry.content_sha256)
      unchanged += 1;
    else changed += 1;
  }
  for (
    let index = 0;
    index < result.results.length;
    index += ENTRY_BATCH_SIZE
  ) {
    await db.batch(
      result.results.slice(index, index + ENTRY_BATCH_SIZE).map((entry) =>
        db
          .prepare(
            `UPDATE restore_entries SET target_content_sha256 = ?
             WHERE restore_id = ? AND path_key = ? AND status = 'staged'`,
          )
          .bind(entry.target_content_sha256, input.restoreId, entry.path_key),
      ),
    );
  }
  await db
    .prepare(
      `UPDATE restore_jobs
       SET status = 'preview', added_count = ?, changed_count = ?,
         unchanged_count = ?, updated_at = ?
       WHERE id = ? AND status = 'staging'`,
    )
    .bind(added, changed, unchanged, input.now, input.restoreId)
    .run();
  const preview = await readRestoreJob(db, input.restoreId);
  if (preview === null) throw new RestoreError("restore_not_found");
  return preview;
}

export async function confirmRestore(
  db: D1Database,
  input: {
    now: number;
    requestId: string;
    restoreId: string;
    vaultName: string;
  },
): Promise<RestoreJob> {
  const updated = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE restore_jobs
         SET status = 'applying', confirmed_at = ?, updated_at = ?,
           materialization_job_id = NULL
         WHERE id = ? AND status = 'preview'
           AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM vaults v
             WHERE v.id = restore_jobs.target_vault_id
               AND v.status = 'active' AND v.display_name = ?
           )
         RETURNING id`,
      )
      .bind(input.now, input.now, input.restoreId, input.now, input.vaultName),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'restore.confirmed', ?, ?
         FROM restore_jobs WHERE id = ? AND status = 'applying'`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.restoreId),
  ]);
  if (updated[0]?.results[0]?.id !== input.restoreId) {
    throw new RestoreError("restore_target_mismatch");
  }
  const job = await readRestoreJob(db, input.restoreId);
  if (job === null) throw new RestoreError("restore_not_found");
  return job;
}

async function markRestoreFailed(
  db: D1Database,
  restoreId: string,
  now: number,
  code: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE restore_jobs
       SET status = 'failed', failure_code = ?, updated_at = ?
       WHERE id = ? AND status = 'applying'`,
    )
    .bind(code, now, restoreId)
    .run();
}

export async function applyRestoreBatch(
  db: D1Database,
  storage: R2Bucket,
  vaults: Env["VAULTS"],
  input: { now: number; requestId: string; restoreId: string },
): Promise<{ complete: boolean; job: RestoreJob }> {
  let job = await readRestoreJob(db, input.restoreId);
  if (job === null) throw new RestoreError("restore_not_found");
  if (job.status === "applied") return { complete: true, job };
  if (job.status !== "applying") {
    throw new RestoreError("restore_state_invalid");
  }
  if (job.expiresAt <= input.now) {
    throw new RestoreError("restore_state_invalid");
  }
  const entries = await db
    .prepare(
      `SELECT path, path_key, content_sha256, byte_length, modified_at,
        staging_key, status, target_content_sha256
       FROM restore_entries
       WHERE restore_id = ? AND status = 'staged'
       ORDER BY path_key LIMIT ?`,
    )
    .bind(input.restoreId, APPLY_BATCH_SIZE)
    .all<RestoreEntryRow>();

  for (const entry of entries.results) {
    const object = await storage.get(entry.staging_key);
    if (
      object === null ||
      object.size !== entry.byte_length ||
      object.checksums.sha256 === undefined ||
      bytesToHex(object.checksums.sha256) !== entry.content_sha256
    ) {
      throw new RestoreError("restore_unavailable");
    }
    let content: string;
    try {
      content = decoder.decode(await object.arrayBuffer());
    } catch {
      throw new RestoreError("restore_archive_invalid");
    }
    const request: RestoreMarkdownNoteRequest = {
      content,
      contentSha256: entry.content_sha256,
      expectedTargetContentSha256: entry.target_content_sha256,
      modifiedAt: entry.modified_at,
      path: entry.path,
    };
    const applied = await vaults
      .getByName(job.targetVaultId)
      .restoreMarkdownNote(job.targetVaultId, request, input.now * 1_000);
    if (!applied.ok) {
      if (applied.code === "note_stale") {
        await markRestoreFailed(
          db,
          input.restoreId,
          input.now,
          "restore_target_changed",
        );
        throw new RestoreError("restore_target_changed");
      }
      throw new RestoreError("restore_unavailable");
    }
    const recorded = await db.batch<{ path_key: string }>([
      db
        .prepare(
          `UPDATE restore_entries
           SET status = 'applied', applied_at = ?
           WHERE restore_id = ? AND path_key = ? AND status = 'staged'
           RETURNING path_key`,
        )
        .bind(input.now, input.restoreId, entry.path_key),
      db
        .prepare(
          `INSERT OR IGNORE INTO restored_note_lineage (
            restore_id, target_vault_id, path_key, recorded_at
          )
          SELECT jobs.id, jobs.target_vault_id, entries.path_key, ?
          FROM restore_jobs jobs
          JOIN restore_entries entries ON entries.restore_id = jobs.id
          WHERE jobs.id = ? AND entries.path_key = ?
            AND jobs.status = 'applying' AND entries.status = 'applied'`,
        )
        .bind(input.now, input.restoreId, entry.path_key),
    ]);
    if (recorded[0]?.results[0]?.path_key !== entry.path_key) {
      throw new RestoreError("restore_unavailable");
    }
    try {
      await storage.delete(entry.staging_key);
    } catch (error) {
      // The durable write and D1 progress record are authoritative. A failed
      // best-effort deletion must not make the restore non-resumable; the
      // expiry cleanup retries every recorded staging key.
      console.error(
        JSON.stringify({
          level: "error",
          event: "restore.staging_delete.failed",
          restoreId: input.restoreId,
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }

  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM restore_entries
       WHERE restore_id = ? AND status != 'applied'`,
    )
    .bind(input.restoreId)
    .first<{ count: number }>();
  const appliedCount = job.expectedNoteCount - (remaining?.count ?? 0);
  await db
    .prepare(
      `UPDATE restore_jobs SET applied_note_count = ?, updated_at = ?
       WHERE id = ? AND status = 'applying'`,
    )
    .bind(appliedCount, input.now, input.restoreId)
    .run();

  if ((remaining?.count ?? 0) > 0) {
    job = await readRestoreJob(db, input.restoreId);
    if (job === null) throw new RestoreError("restore_not_found");
    return { complete: false, job };
  }

  let materialization = await readUsableRestoreMaterialization(db, job);
  if (materialization === null) {
    const queued = await vaults
      .getByName(job.targetVaultId)
      .queueMaterialization(job.targetVaultId, input.requestId, input.now);
    if (!queued.ok) throw new RestoreError("restore_unavailable");
    materialization = queued.job;
    if (
      materialization.status === "queued" ||
      materialization.status === "running"
    ) {
      await db
        .prepare(
          `UPDATE restore_jobs
           SET materialization_job_id = ?, updated_at = ?
           WHERE id = ? AND status = 'applying'
             AND materialization_job_id IS NULL`,
        )
        .bind(materialization.jobId, input.now, input.restoreId)
        .run();
    }
    job = await readRestoreJob(db, input.restoreId);
    if (job === null) throw new RestoreError("restore_not_found");
  }
  if (
    materialization.status === "queued" ||
    materialization.status === "running"
  ) {
    return { complete: false, job };
  }
  if (
    materialization.status !== "completed" ||
    materialization.generation === null
  ) {
    throw new RestoreError("restore_unavailable");
  }
  const completed = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE restore_jobs
         SET status = 'applied', applied_note_count = expected_note_count,
           applied_at = ?, updated_at = ?, verified_generation_id = ?,
           materialization_job_id = NULL
         WHERE id = ? AND status = 'applying'
         RETURNING id`,
      )
      .bind(
        input.now,
        input.now,
        materialization.generation.generationId,
        input.restoreId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'restore.applied', ?, ?
         FROM restore_jobs WHERE id = ? AND status = 'applied'`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.restoreId),
  ]);
  if (completed[0]?.results[0]?.id !== input.restoreId) {
    throw new RestoreError("restore_unavailable");
  }
  job = await readRestoreJob(db, input.restoreId);
  if (job === null) throw new RestoreError("restore_not_found");
  return { complete: true, job };
}

export async function cleanupExpiredRestores(
  db: D1Database,
  storage: R2Bucket,
  now: number,
): Promise<void> {
  const claimed = await db
    .prepare(
      `UPDATE restore_cleanup_state SET last_run_at = ?
       WHERE id = 1 AND last_run_at <= ?
       RETURNING id`,
    )
    .bind(now, now - RESTORE_CLEANUP_INTERVAL_SECONDS)
    .first<{ id: number }>();
  if (claimed?.id !== 1) return;

  const expired = await db
    .prepare(
      `SELECT j.id, j.status FROM restore_jobs j
       WHERE j.expires_at <= ?
         AND EXISTS (
           SELECT 1 FROM restore_entries e WHERE e.restore_id = j.id
         )
       ORDER BY j.expires_at LIMIT 5`,
    )
    .bind(now)
    .all<{ id: string; status: RestoreJob["status"] }>();
  for (const job of expired.results) {
    const keys = await db
      .prepare(
        `SELECT staging_key FROM restore_entries
         WHERE restore_id = ?`,
      )
      .bind(job.id)
      .all<{ staging_key: string }>();
    for (let index = 0; index < keys.results.length; index += 1_000) {
      await storage.delete(
        keys.results
          .slice(index, index + 1_000)
          .map(({ staging_key }) => staging_key),
      );
    }
    if (
      job.status === "staging" ||
      job.status === "preview" ||
      job.status === "applying"
    ) {
      await db.batch([
        db
          .prepare(
            `UPDATE restore_jobs
             SET status = 'failed', failure_code = 'restore_expired',
               updated_at = ?, materialization_job_id = NULL
             WHERE id = ? AND status IN ('staging', 'preview', 'applying')`,
          )
          .bind(now, job.id),
        db
          .prepare(
            `INSERT INTO audit_events (id, event_type, request_id, created_at)
             VALUES (?, 'restore.expired', ?, ?)`,
          )
          .bind(crypto.randomUUID(), crypto.randomUUID(), now),
      ]);
    } else if (job.status === "failed") {
      await db
        .prepare(
          `UPDATE restore_jobs
           SET materialization_job_id = NULL, updated_at = ?
           WHERE id = ? AND status = 'failed'
             AND materialization_job_id IS NOT NULL`,
        )
        .bind(now, job.id)
        .run();
    }
    await db
      .prepare(`DELETE FROM restore_entries WHERE restore_id = ?`)
      .bind(job.id)
      .run();
  }
}
