import {
  materializationJobSchema,
  type MaterializationGeneration,
  type MaterializationJob,
} from "@mdevolved/contracts";
import {
  MAX_MATERIALIZED_NOTE_BYTES,
  MaterializationSnapshotError,
  type MaterializedSnapshot,
  type MaterializedSnapshotNote,
} from "./materialization-snapshot";
import {
  MaterializationPublishError,
  prepareNotes,
  projectionStatements,
  putImmutableManifest,
  sha256,
  writeNoteObjects,
} from "./materialization-store";
import { validateMarkdownVaultPath } from "./vault-path";

const FRAME_PREFIX_BYTES = 8;
const MAX_FRAME_METADATA_BYTES = 16 * 1024;
const JOB_NOTE_BATCH_SIZE = 16;
const MAX_JOB_ATTEMPTS = 6;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type JobRow = {
  attempt_count: number;
  completed_at: number | null;
  created_at: number;
  failure_code: string | null;
  generation_completed_at: number | null;
  generation_created_at: number;
  generation_id: string;
  id: string;
  manifest_key: string;
  next_offset: number;
  note_count: number;
  processed_note_count: number;
  request_id: string;
  schema_version: number;
  source_state_vector_sha256: string;
  staging_object_bytes: number;
  staging_object_key: string;
  status: MaterializationJob["status"];
  total_bytes: number;
  total_note_count: number;
  updated_at: number;
  vault_id: string;
};

type StagedMetadata = Omit<MaterializedSnapshotNote, "content">;

function generationFromJobRow(row: JobRow): MaterializationGeneration | null {
  if (row.status !== "completed" || row.generation_completed_at === null) {
    return null;
  }
  return {
    completedAt: row.generation_completed_at,
    createdAt: row.generation_created_at,
    generationId: row.generation_id,
    noteCount: row.note_count,
    sourceStateVectorSha256: row.source_state_vector_sha256,
    totalBytes: row.total_bytes,
    vaultId: row.vault_id,
  };
}

function jobFromRow(row: JobRow): MaterializationJob {
  return materializationJobSchema.parse({
    failureCode: row.failure_code,
    generation: generationFromJobRow(row),
    jobId: row.id,
    processedNoteCount: row.processed_note_count,
    status: row.status,
    totalNoteCount: row.total_note_count,
    vaultId: row.vault_id,
  });
}

const JOB_SELECT = `
  job.id, job.generation_id, job.vault_id,
  job.source_state_vector_sha256, job.status, job.staging_object_key,
  job.staging_object_bytes, job.next_offset, job.processed_note_count,
  job.total_note_count, job.schema_version, job.request_id,
  job.attempt_count, job.created_at, job.updated_at, job.completed_at,
  job.failure_code, generation.note_count, generation.total_bytes,
  generation.manifest_key, generation.created_at AS generation_created_at,
  generation.completed_at AS generation_completed_at`;

async function readJobRow(
  db: D1Database,
  jobId: string,
): Promise<JobRow | null> {
  return db
    .prepare(
      `SELECT ${JOB_SELECT}
       FROM materialization_jobs job
       JOIN materialization_generations generation
         ON generation.id = job.generation_id
       WHERE job.id = ?`,
    )
    .bind(jobId)
    .first<JobRow>();
}

export async function readMaterializationJob(
  db: D1Database,
  vaultId: string,
  jobId: string,
): Promise<MaterializationJob | null> {
  const row = await readJobRow(db, jobId);
  if (row !== null) {
    return row.vault_id === vaultId ? jobFromRow(row) : null;
  }
  const generation = await db
    .prepare(
      `SELECT id, vault_id, source_state_vector_sha256, note_count,
        total_bytes, created_at, completed_at
       FROM materialization_generations
       WHERE id = ? AND vault_id = ? AND status = 'published'
         AND completed_at IS NOT NULL`,
    )
    .bind(jobId, vaultId)
    .first<{
      completed_at: number;
      created_at: number;
      id: string;
      note_count: number;
      source_state_vector_sha256: string;
      total_bytes: number;
      vault_id: string;
    }>();
  if (generation === null) return null;
  return materializationJobSchema.parse({
    failureCode: null,
    generation: {
      completedAt: generation.completed_at,
      createdAt: generation.created_at,
      generationId: generation.id,
      noteCount: generation.note_count,
      sourceStateVectorSha256: generation.source_state_vector_sha256,
      totalBytes: generation.total_bytes,
      vaultId: generation.vault_id,
    },
    jobId: generation.id,
    processedNoteCount: generation.note_count,
    status: "completed",
    totalNoteCount: generation.note_count,
    vaultId: generation.vault_id,
  });
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function blobBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function stagedSnapshot(snapshot: MaterializedSnapshot): Blob {
  const parts: BlobPart[] = [];
  for (const note of snapshot.notes) {
    const metadata = encoder.encode(
      JSON.stringify({
        byteLength: note.byteLength,
        fileId: note.fileId,
        modifiedAt: note.modifiedAt,
        path: note.path,
        pathKey: note.pathKey,
        title: note.title,
      } satisfies StagedMetadata),
    );
    const content = encoder.encode(note.content);
    parts.push(
      blobBuffer(uint32(metadata.byteLength)),
      blobBuffer(uint32(content.byteLength)),
    );
    parts.push(blobBuffer(metadata), blobBuffer(content));
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

async function currentGenerationForSource(
  db: D1Database,
  vaultId: string,
  sourceStateVectorSha256: string,
): Promise<MaterializationJob | null> {
  const row = await db
    .prepare(
      `SELECT generation.id
       FROM current_materializations current
       JOIN materialization_generations generation
         ON generation.id = current.generation_id
       WHERE current.vault_id = ?
         AND generation.status = 'published'
         AND generation.source_state_vector_sha256 = ?`,
    )
    .bind(vaultId, sourceStateVectorSha256)
    .first<{ id: string }>();
  return row === null ? null : readMaterializationJob(db, vaultId, row.id);
}

export async function createMaterializationJob(
  db: D1Database,
  storage: R2Bucket,
  input: {
    now: number;
    requestId: string;
    snapshot: MaterializedSnapshot;
    sourceStateVectorSha256: string;
    vaultId: string;
  },
): Promise<MaterializationJob> {
  const current = await currentGenerationForSource(
    db,
    input.vaultId,
    input.sourceStateVectorSha256,
  );
  if (current !== null) return current;

  const active = await db
    .prepare(
      `SELECT id FROM materialization_jobs
       WHERE vault_id = ? AND source_state_vector_sha256 = ?
         AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.vaultId, input.sourceStateVectorSha256)
    .first<{ id: string }>();
  if (active !== null) {
    const existing = await readMaterializationJob(db, input.vaultId, active.id);
    if (existing !== null) return existing;
  }

  const jobId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const stagingObjectKey = `vaults/${input.vaultId}/materialization-staging/${jobId}.bin`;
  const manifestKey = `vaults/${input.vaultId}/generations/${generationId}/manifest.json`;
  const staged = stagedSnapshot(input.snapshot);
  const stored = await storage.put(stagingObjectKey, staged, {
    customMetadata: {
      job: jobId,
      purpose: "materialization-staging",
    },
    httpMetadata: {
      cacheControl: "private, no-store",
      contentType: "application/octet-stream",
    },
  });
  if (stored === null || stored.size !== staged.size) {
    throw new MaterializationPublishError("materialization_unavailable");
  }

  try {
    const results = await db.batch<{ id: string }>([
      db
        .prepare(
          `INSERT OR IGNORE INTO materialization_gc_objects (
            object_key, queued_at
          )
          SELECT staging_object_key, ?
          FROM materialization_jobs
          WHERE vault_id = ? AND status = 'queued'`,
        )
        .bind(input.now, input.vaultId),
      db
        .prepare(
          `UPDATE materialization_generations
           SET status = 'failed', failure_code = 'superseded',
             completed_at = ?
           WHERE id IN (
             SELECT generation_id FROM materialization_jobs
             WHERE vault_id = ? AND status = 'queued'
           ) AND status = 'staging'`,
        )
        .bind(input.now, input.vaultId),
      db
        .prepare(
          `UPDATE materialization_jobs
           SET status = 'failed', failure_code = 'superseded',
             completed_at = ?, updated_at = ?
           WHERE vault_id = ? AND status = 'queued'`,
        )
        .bind(input.now, input.now, input.vaultId),
      db
        .prepare(
          `INSERT INTO materialization_generations (
            id, vault_id, source_state_vector_sha256, status, note_count,
            total_bytes, manifest_key, created_at
          )
          SELECT ?, id, ?, 'staging', ?, ?, ?, ?
          FROM vaults WHERE id = ? AND status = 'active'
          RETURNING id`,
        )
        .bind(
          generationId,
          input.sourceStateVectorSha256,
          input.snapshot.notes.length,
          input.snapshot.totalBytes,
          manifestKey,
          input.now,
          input.vaultId,
        ),
      db
        .prepare(
          `INSERT INTO materialization_jobs (
            id, generation_id, vault_id, source_state_vector_sha256, status,
            staging_object_key, staging_object_bytes, next_offset,
            processed_note_count, total_note_count, schema_version, request_id,
            created_at, updated_at
          )
          SELECT ?, ?, vault_id, source_state_vector_sha256, 'queued',
            ?, ?, 0, 0, note_count, ?, ?, ?, ?
          FROM materialization_generations
          WHERE id = ? AND status = 'staging'
          RETURNING id`,
        )
        .bind(
          jobId,
          generationId,
          stagingObjectKey,
          staged.size,
          input.snapshot.schemaVersion,
          input.requestId,
          input.now,
          input.now,
          generationId,
        ),
    ]);
    if (
      results[3]?.results[0]?.id !== generationId ||
      results[4]?.results[0]?.id !== jobId
    ) {
      throw new MaterializationPublishError("materialization_unavailable");
    }
  } catch (error) {
    await storage.delete(stagingObjectKey).catch(() => undefined);
    if (error instanceof MaterializationPublishError) throw error;
    throw new MaterializationPublishError("materialization_unavailable");
  }

  const created = await readMaterializationJob(db, input.vaultId, jobId);
  if (created === null) {
    throw new MaterializationPublishError("materialization_unavailable");
  }
  return created;
}

async function readExactRange(
  storage: R2Bucket,
  key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const object = await storage.get(key, { range: { length, offset } });
  if (object === null) {
    throw new MaterializationPublishError("snapshot_invalid");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) {
    throw new MaterializationPublishError("snapshot_invalid");
  }
  return bytes;
}

async function readStagedNote(
  storage: R2Bucket,
  job: JobRow,
  offset: number,
): Promise<{ nextOffset: number; note: MaterializedSnapshotNote }> {
  if (offset + FRAME_PREFIX_BYTES > job.staging_object_bytes) {
    throw new MaterializationPublishError("snapshot_invalid");
  }
  const prefix = await readExactRange(
    storage,
    job.staging_object_key,
    offset,
    FRAME_PREFIX_BYTES,
  );
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  const metadataLength = view.getUint32(0, false);
  const contentLength = view.getUint32(4, false);
  if (
    metadataLength === 0 ||
    metadataLength > MAX_FRAME_METADATA_BYTES ||
    contentLength > MAX_MATERIALIZED_NOTE_BYTES ||
    offset + FRAME_PREFIX_BYTES + metadataLength + contentLength >
      job.staging_object_bytes
  ) {
    throw new MaterializationPublishError("snapshot_invalid");
  }
  const frame = await readExactRange(
    storage,
    job.staging_object_key,
    offset + FRAME_PREFIX_BYTES,
    metadataLength + contentLength,
  );
  try {
    const metadata = JSON.parse(
      decoder.decode(frame.subarray(0, metadataLength)),
    ) as Partial<StagedMetadata>;
    const contentBytes = frame.subarray(metadataLength);
    const content = decoder.decode(contentBytes);
    if (
      typeof metadata.path !== "string" ||
      typeof metadata.fileId !== "string" ||
      metadata.fileId.length === 0 ||
      metadata.byteLength !== contentLength ||
      (metadata.modifiedAt !== null &&
        (typeof metadata.modifiedAt !== "number" ||
          !Number.isFinite(metadata.modifiedAt)))
    ) {
      throw new Error("invalid");
    }
    const path = validateMarkdownVaultPath(metadata.path);
    return {
      nextOffset: offset + FRAME_PREFIX_BYTES + metadataLength + contentLength,
      note: {
        ...path,
        byteLength: contentLength,
        content,
        fileId: metadata.fileId,
        modifiedAt: metadata.modifiedAt,
      },
    };
  } catch {
    throw new MaterializationPublishError("snapshot_invalid");
  }
}

async function finalizeJob(
  db: D1Database,
  storage: R2Bucket,
  job: JobRow,
  now: number,
): Promise<void> {
  const notes = await db
    .prepare(
      `SELECT path, path_key, title, content_sha256, byte_length, modified_at
       FROM materialized_notes
       WHERE generation_id = ? AND vault_id = ?
       ORDER BY path_key`,
    )
    .bind(job.generation_id, job.vault_id)
    .all<{
      byte_length: number;
      content_sha256: string;
      modified_at: number | null;
      path: string;
      path_key: string;
      title: string;
    }>();
  const projectedBytes = notes.results.reduce(
    (total, note) => total + note.byte_length,
    0,
  );
  if (
    notes.results.length !== job.total_note_count ||
    projectedBytes !== job.total_bytes
  ) {
    throw new MaterializationPublishError("materialization_unavailable");
  }
  const manifest = JSON.stringify({
    format: "owd-materialization-v1",
    generationId: job.generation_id,
    noteCount: notes.results.length,
    notes: notes.results.map((note) => ({
      byteLength: note.byte_length,
      contentSha256: note.content_sha256,
      modifiedAt: note.modified_at,
      path: note.path,
    })),
    schemaVersion: job.schema_version,
    sourceStateVectorSha256: job.source_state_vector_sha256,
    totalBytes: job.total_bytes,
    vaultId: job.vault_id,
  });
  const manifestDigest = await sha256(encoder.encode(manifest));
  await putImmutableManifest(storage, job.manifest_key, manifest, {
    customMetadata: {
      generation: job.generation_id,
      sha256: manifestDigest.hex,
    },
    httpMetadata: {
      cacheControl: "private, max-age=31536000, immutable",
      contentType: "application/json; charset=utf-8",
    },
    sha256: manifestDigest.bytes,
  });
  const published = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE materialization_generations
         SET status = 'published', manifest_sha256 = ?, completed_at = ?
         WHERE id = ? AND status = 'staging'
           AND EXISTS (
             SELECT 1 FROM vaults
             WHERE id = materialization_generations.vault_id
               AND status = 'active'
           )
         RETURNING id`,
      )
      .bind(manifestDigest.hex, now, job.generation_id),
    db
      .prepare(
        `INSERT INTO current_materializations (
          vault_id, generation_id, updated_at
        )
        SELECT vault_id, id, ? FROM materialization_generations
        WHERE id = ? AND status = 'published'
        ON CONFLICT(vault_id) DO UPDATE SET
          generation_id = excluded.generation_id,
          updated_at = excluded.updated_at`,
      )
      .bind(now, job.generation_id),
    db
      .prepare(
        `UPDATE materialization_jobs
         SET status = 'completed', processed_note_count = total_note_count,
           completed_at = ?, updated_at = ?, attempt_count = 0
         WHERE id = ? AND status = 'running'
         RETURNING id`,
      )
      .bind(now, now, job.id),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.materialized', ?, ?
         FROM materialization_jobs
         WHERE id = ? AND status = 'completed'`,
      )
      .bind(crypto.randomUUID(), job.request_id, now, job.id),
    db
      .prepare(
        `DELETE FROM materialized_note_search
         WHERE vault_id = ? AND generation_id != ?`,
      )
      .bind(job.vault_id, job.generation_id),
    db
      .prepare(
        `UPDATE vault_sync_states
         SET library_stale = CASE
               WHEN current_state_vector_sha256 = ? THEN 0 ELSE 1
             END,
             last_error_code = NULL,
             last_error_at = NULL,
             updated_at = ?
         WHERE vault_id = ?`,
      )
      .bind(job.source_state_vector_sha256, now, job.vault_id),
  ]);
  if (
    published[0]?.results[0]?.id !== job.generation_id ||
    published[2]?.results[0]?.id !== job.id
  ) {
    const current = await readJobRow(db, job.id);
    if (current?.status !== "completed") {
      throw new MaterializationPublishError("materialization_unavailable");
    }
  }
  try {
    await storage.delete(job.staging_object_key);
  } catch {
    await db
      .prepare(
        `INSERT OR IGNORE INTO materialization_gc_objects (
          object_key, queued_at
        ) VALUES (?, ?)`,
      )
      .bind(job.staging_object_key, now)
      .run();
  }
}

async function failJob(
  db: D1Database,
  job: JobRow,
  code: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE materialization_generations
         SET status = 'failed', failure_code = ?, completed_at = ?
         WHERE id = ? AND status = 'staging'`,
      )
      .bind(code, now, job.generation_id),
    db
      .prepare(
        `UPDATE materialization_jobs
         SET status = 'failed', failure_code = ?, completed_at = ?,
           updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .bind(code, now, now, job.id),
    db
      .prepare(
        `INSERT OR IGNORE INTO materialization_gc_objects (
          object_key, queued_at
        ) VALUES (?, ?)`,
      )
      .bind(job.staging_object_key, now),
    db
      .prepare(
        `UPDATE vault_sync_states
         SET library_stale = 1, last_error_code = ?, last_error_at = ?,
           updated_at = ?
         WHERE vault_id = ?`,
      )
      .bind(code, now, now, job.vault_id),
  ]);
}

async function hasActiveJobs(
  db: D1Database,
  vaultId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM materialization_jobs
       WHERE vault_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    )
    .bind(vaultId)
    .first<{ id: string }>();
  return row !== null;
}

export async function continueNextMaterializationJob(
  db: D1Database,
  storage: R2Bucket,
  vaultId: string,
  now: number,
): Promise<{ hasMore: boolean }> {
  const claimed = await db
    .prepare(
      `UPDATE materialization_jobs
       SET status = 'running', updated_at = ?
       WHERE id = (
         SELECT id FROM materialization_jobs
         WHERE vault_id = ? AND status IN ('running', 'queued')
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at
         LIMIT 1
       )
       RETURNING id`,
    )
    .bind(now, vaultId)
    .first<{ id: string }>();
  if (claimed === null) return { hasMore: false };
  const job = await readJobRow(db, claimed.id);
  if (job === null) return { hasMore: await hasActiveJobs(db, vaultId) };

  try {
    let offset = job.next_offset;
    const notes: MaterializedSnapshotNote[] = [];
    const remaining = job.total_note_count - job.processed_note_count;
    const batchSize = Math.min(JOB_NOTE_BATCH_SIZE, remaining);
    for (let index = 0; index < batchSize; index += 1) {
      const staged = await readStagedNote(storage, job, offset);
      notes.push(staged.note);
      offset = staged.nextOffset;
    }
    if (notes.length > 0) {
      const prepared = await prepareNotes(vaultId, notes);
      await writeNoteObjects(storage, prepared);
      const processed = job.processed_note_count + notes.length;
      await db.batch([
        ...projectionStatements(db, job.generation_id, vaultId, prepared),
        db
          .prepare(
            `UPDATE materialization_jobs
             SET next_offset = ?, processed_note_count = ?, updated_at = ?,
               attempt_count = 0
             WHERE id = ? AND status = 'running'`,
          )
          .bind(offset, processed, now, job.id),
      ]);
      job.next_offset = offset;
      job.processed_note_count = processed;
    }
    if (job.processed_note_count === job.total_note_count) {
      if (job.next_offset !== job.staging_object_bytes) {
        throw new MaterializationPublishError("snapshot_invalid");
      }
      await finalizeJob(db, storage, job, now);
    }
  } catch (error) {
    const code =
      error instanceof MaterializationPublishError ||
      error instanceof MaterializationSnapshotError
        ? error.code
        : "materialization_unavailable";
    const attempt = await db
      .prepare(
        `UPDATE materialization_jobs
         SET attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND status = 'running'
         RETURNING attempt_count`,
      )
      .bind(now, job.id)
      .first<{ attempt_count: number }>();
    const permanent = code !== "materialization_unavailable";
    if (
      permanent ||
      (attempt?.attempt_count ?? MAX_JOB_ATTEMPTS) >= MAX_JOB_ATTEMPTS
    ) {
      await failJob(db, job, code, now);
      return { hasMore: await hasActiveJobs(db, vaultId) };
    }
    throw error;
  }

  return { hasMore: await hasActiveJobs(db, vaultId) };
}
