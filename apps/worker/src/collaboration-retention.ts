const GC_BATCH_SIZE = 64;
const GC_GRACE_SECONDS = 60;
const R2_DELETE_CONCURRENCY = 6;

export async function queueCollaborationObjectCleanup(
  db: D1Database,
  objectKeys: string[],
  now: number,
): Promise<void> {
  const keys = [...new Set(objectKeys)];
  if (keys.length === 0) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO collaboration_gc_objects (
        object_key, queued_at
      )
      SELECT
        json_extract(item.value, '$.objectKey'),
        json_extract(item.value, '$.queuedAt')
      FROM json_each(?) AS item`,
    )
    .bind(
      JSON.stringify(keys.map((objectKey) => ({ objectKey, queuedAt: now }))),
    )
    .run();
}

export async function runCollaborationGarbageCollection(
  db: D1Database,
  storage: R2Bucket,
  now: number,
): Promise<number> {
  const queued = await db
    .prepare(
      `SELECT queue.object_key,
        CASE WHEN
          EXISTS (
            SELECT 1 FROM collaboration_records records
            WHERE records.body_object_key = queue.object_key
          )
          OR EXISTS (
            SELECT 1 FROM collaboration_content_objects objects
            WHERE objects.object_key = queue.object_key
          )
        THEN 1 ELSE 0 END AS referenced
       FROM collaboration_gc_objects queue
       WHERE queue.queued_at <= ?
       ORDER BY queue.queued_at, queue.object_key LIMIT ?`,
    )
    .bind(now - GC_GRACE_SECONDS, GC_BATCH_SIZE)
    .all<{ object_key: string; referenced: number }>();
  const completedKeys = queued.results
    .filter((object) => object.referenced === 1)
    .map((object) => object.object_key);
  const failures: string[] = [];
  const pending = queued.results.filter((object) => object.referenced !== 1);
  for (let index = 0; index < pending.length; index += R2_DELETE_CONCURRENCY) {
    const outcomes = await Promise.all(
      pending
        .slice(index, index + R2_DELETE_CONCURRENCY)
        .map(async (object) => {
          try {
            await storage.delete(object.object_key);
            if ((await storage.head(object.object_key)) !== null) {
              throw new Error("collaboration_gc_object_remains");
            }
            return { key: object.object_key, succeeded: true };
          } catch {
            return { key: object.object_key, succeeded: false };
          }
        }),
    );
    for (const outcome of outcomes) {
      (outcome.succeeded ? completedKeys : failures).push(outcome.key);
    }
  }
  const mutations: D1PreparedStatement[] = [];
  if (completedKeys.length > 0) {
    mutations.push(
      db
        .prepare(
          `DELETE FROM collaboration_gc_objects
           WHERE object_key IN (
             SELECT value FROM json_each(?) WHERE type = 'text'
           )`,
        )
        .bind(JSON.stringify(completedKeys)),
    );
  }
  if (failures.length > 0) {
    mutations.push(
      db
        .prepare(
          `UPDATE collaboration_gc_objects
           SET attempts = attempts + 1, last_attempt_at = ?
           WHERE object_key IN (
             SELECT value FROM json_each(?) WHERE type = 'text'
           )`,
        )
        .bind(now, JSON.stringify(failures)),
    );
  }
  if (mutations.length > 0) await db.batch(mutations);
  const remaining = await db
    .prepare(`SELECT COUNT(*) AS count FROM collaboration_gc_objects`)
    .first<{ count: number }>();
  return remaining?.count ?? 0;
}
