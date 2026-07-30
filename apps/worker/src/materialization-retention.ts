const GENERATION_GRACE_SECONDS = 24 * 60 * 60;
const OBJECT_GRACE_SECONDS = 24 * 60 * 60;
const GENERATION_BATCH_SIZE = 2;
const OBJECT_BATCH_SIZE = 48;

type GenerationCandidate = {
  id: string;
  manifest_key: string;
};

async function queueGenerationDeletion(
  db: D1Database,
  generation: GenerationCandidate,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO materialization_gc_objects (
          object_key, queued_at
        ) VALUES (?, ?)`,
      )
      .bind(generation.manifest_key, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO materialization_gc_objects (
          object_key, queued_at
        )
        SELECT DISTINCT note.r2_key, ?
        FROM materialized_notes note
        WHERE note.generation_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM materialized_notes other
            WHERE other.generation_id != ? AND other.r2_key = note.r2_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM snapshot_entries entry
            WHERE entry.source_r2_key = note.r2_key
          )`,
      )
      .bind(now, generation.id, generation.id),
    db
      .prepare(
        `DELETE FROM materialization_generations
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM current_materializations
             WHERE generation_id = materialization_generations.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM backup_artifacts
             WHERE generation_id = materialization_generations.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM snapshot_vaults
             WHERE generation_id = materialization_generations.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM restore_jobs
             WHERE verified_generation_id = materialization_generations.id
                OR materialization_job_id IN (
                  SELECT id FROM materialization_jobs
                  WHERE generation_id = materialization_generations.id
                )
           )
           AND NOT EXISTS (
             SELECT 1 FROM materialization_jobs
             WHERE generation_id = materialization_generations.id
               AND status IN ('queued', 'running')
           )`,
      )
      .bind(generation.id),
    db
      .prepare(
        `DELETE FROM materialized_note_search
         WHERE generation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM materialization_generations WHERE id = ?
           )`,
      )
      .bind(generation.id, generation.id),
  ]);
}

export async function queueObsoleteMaterializations(
  db: D1Database,
  now: number,
): Promise<number> {
  const candidates = await db
    .prepare(
      `WITH protected_published AS (
         SELECT id FROM (
           SELECT generation.id,
             ROW_NUMBER() OVER (
               PARTITION BY generation.vault_id
               ORDER BY generation.created_at DESC, generation.id DESC
             ) AS recency
           FROM materialization_generations generation
           WHERE generation.status = 'published'
             AND NOT EXISTS (
               SELECT 1 FROM current_materializations current
               WHERE current.generation_id = generation.id
             )
         )
         WHERE recency <= 2
       )
       SELECT generation.id, generation.manifest_key
       FROM materialization_generations generation
       WHERE generation.created_at <= ?
         AND (
           generation.status IN ('failed', 'staging')
           OR (
             generation.status = 'published'
             AND NOT EXISTS (
               SELECT 1 FROM protected_published protected
               WHERE protected.id = generation.id
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM current_materializations current
           WHERE current.generation_id = generation.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM backup_artifacts backup
           WHERE backup.generation_id = generation.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_vaults snapshot
           WHERE snapshot.generation_id = generation.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM restore_jobs restore
           WHERE restore.verified_generation_id = generation.id
             OR restore.materialization_job_id IN (
               SELECT id FROM materialization_jobs
               WHERE generation_id = generation.id
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM materialization_jobs job
           WHERE job.generation_id = generation.id
             AND job.status IN ('queued', 'running')
         )
       ORDER BY generation.created_at, generation.id
       LIMIT ?`,
    )
    .bind(now - GENERATION_GRACE_SECONDS, GENERATION_BATCH_SIZE)
    .all<GenerationCandidate>();

  for (const generation of candidates.results) {
    await queueGenerationDeletion(db, generation, now);
  }
  return candidates.results.length;
}

async function objectStillReferenced(
  db: D1Database,
  objectKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS referenced
       WHERE EXISTS (
         SELECT 1 FROM materialized_notes WHERE r2_key = ?
       ) OR EXISTS (
         SELECT 1 FROM snapshot_entries WHERE source_r2_key = ?
       ) OR EXISTS (
         SELECT 1 FROM materialization_generations WHERE manifest_key = ?
       ) OR EXISTS (
         SELECT 1 FROM materialization_jobs
         WHERE staging_object_key = ?
           AND status IN ('queued', 'running')
       )`,
    )
    .bind(objectKey, objectKey, objectKey, objectKey)
    .first<{ referenced: number }>();
  return row?.referenced === 1;
}

export async function runMaterializationGarbageCollection(
  db: D1Database,
  storage: R2Bucket,
  now: number,
): Promise<number> {
  const queued = await db
    .prepare(
      `SELECT object_key FROM materialization_gc_objects
       WHERE queued_at <= ?
       ORDER BY queued_at, object_key LIMIT ?`,
    )
    .bind(now - OBJECT_GRACE_SECONDS, OBJECT_BATCH_SIZE)
    .all<{ object_key: string }>();

  for (const object of queued.results) {
    if (await objectStillReferenced(db, object.object_key)) {
      await db
        .prepare(`DELETE FROM materialization_gc_objects WHERE object_key = ?`)
        .bind(object.object_key)
        .run();
      continue;
    }
    try {
      await storage.delete(object.object_key);
      if ((await storage.head(object.object_key)) !== null) {
        throw new Error("materialization_gc_object_remains");
      }
      await db
        .prepare(`DELETE FROM materialization_gc_objects WHERE object_key = ?`)
        .bind(object.object_key)
        .run();
    } catch {
      await db
        .prepare(
          `UPDATE materialization_gc_objects
           SET attempts = attempts + 1, last_attempt_at = ?
           WHERE object_key = ?`,
        )
        .bind(now, object.object_key)
        .run();
    }
  }

  const remaining = await db
    .prepare(`SELECT COUNT(*) AS count FROM materialization_gc_objects`)
    .first<{ count: number }>();
  return remaining?.count ?? 0;
}
