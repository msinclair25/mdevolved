const GC_BATCH_SIZE = 64;
const GC_GRACE_SECONDS = 60;
const R2_DELETE_CONCURRENCY = 6;
const ELASTIC_RETENTION_BATCH_SIZE = 64;
const OPERATIONAL_RETENTION_BATCH_SIZE = 64;

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

export async function runElasticRetention(
  db: D1Database,
  now: number,
): Promise<number> {
  const candidates = await db
    .prepare(
      `SELECT record.elastic_record_id, record.record_type,
        record.body_object_key
       FROM project_elastic_records record
       LEFT JOIN project_runs run ON run.run_id = record.run_id
       WHERE record.retain_until <= ?
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_intelligence_items item
           WHERE item.source_object_key = record.body_object_key
             AND item.status IN ('pending', 'ready')
         )
         AND NOT EXISTS (
           SELECT 1 FROM collaboration_restore_items item
           WHERE item.content_sha256 = record.content_sha256
         )
         AND (
           record.restore_state = 'quarantined'
           OR (
             record.record_type IN ('delta', 'budget-entry', 'observation', 'orca')
             AND run.status IN ('completed', 'aborted', 'restored-inert')
             AND NOT EXISTS (
               SELECT 1 FROM project_exceptions exception
               WHERE exception.project_id = record.project_id
                 AND (exception.run_id = record.run_id OR exception.run_id IS NULL)
                 AND exception.status IN ('open', 'blocking')
             )
           )
         )
       ORDER BY record.retain_until, record.elastic_record_id LIMIT ?`,
    )
    .bind(now, ELASTIC_RETENTION_BATCH_SIZE)
    .all<{
      body_object_key: string;
      elastic_record_id: string;
      record_type: "budget-entry" | "delta" | "observation" | "orca";
    }>();
  if (candidates.results.length === 0) return 0;
  const idsByType = (recordType: string) =>
    candidates.results
      .filter((candidate) => candidate.record_type === recordType)
      .map((candidate) => candidate.elastic_record_id);
  const statements: D1PreparedStatement[] = [];
  const projectionDeletes: Array<[string, string, string]> = [
    ["delta", "project_run_deltas", "delta_id"],
    ["budget-entry", "project_run_budget_entries", "elastic_record_id"],
    ["observation", "project_run_observations", "elastic_record_id"],
    ["orca", "project_orca_projections", "elastic_record_id"],
  ];
  for (const [recordType, table, column] of projectionDeletes) {
    const ids = idsByType(recordType);
    if (ids.length > 0) {
      statements.push(
        db
          .prepare(
            `DELETE FROM ${table} WHERE ${column} IN (
              SELECT value FROM json_each(?) WHERE type = 'text'
            )`,
          )
          .bind(JSON.stringify(ids)),
      );
    }
  }
  if (idsByType("budget-entry").length > 0) {
    statements.push(
      db.prepare(
        `DELETE FROM project_run_budget_versions
         WHERE budget_version > 0 AND NOT EXISTS (
           SELECT 1 FROM project_run_budget_entries entry
           WHERE entry.budget_id = project_run_budget_versions.budget_id
             AND entry.budget_version = project_run_budget_versions.budget_version
         )`,
      ),
    );
  }
  statements.push(
    db
      .prepare(
        `DELETE FROM project_elastic_records
         WHERE elastic_record_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         )`,
      )
      .bind(
        JSON.stringify(
          candidates.results.map((candidate) => candidate.elastic_record_id),
        ),
      ),
  );
  await db.batch(statements);
  await queueCollaborationObjectCleanup(
    db,
    candidates.results.map((candidate) => candidate.body_object_key),
    now,
  );
  return candidates.results.length;
}

export async function runOperationalRetention(
  db: D1Database,
  now: number,
): Promise<number> {
  const candidates = await db
    .prepare(
      `SELECT record.operational_record_id, record.body_object_key
       FROM project_operational_records record
       WHERE record.record_type = 'evidence' AND record.retain_until <= ?
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_intelligence_items item
           WHERE item.source_object_key = record.body_object_key
             AND item.status IN ('pending', 'ready')
         )
         AND NOT EXISTS (
           SELECT 1 FROM collaboration_restore_items item
           WHERE item.content_sha256 = record.content_sha256
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_operational_dependencies dependency
           WHERE dependency.dependency_id = record.operational_record_id
         )
         AND (
           record.restore_state = 'quarantined'
           OR (
             NOT EXISTS (
               SELECT 1 FROM project_operational_requests request
               WHERE request.operational_record_id = record.operational_record_id
                 AND request.status IN ('pending', 'acknowledged')
             )
             AND NOT EXISTS (
             SELECT 1 FROM project_operational_integrity_reports report
             WHERE report.operational_record_id = record.operational_record_id
               AND (
                 report.evidence_id = (
                   SELECT latest.evidence_id
                   FROM project_operational_integrity_reports latest
                   WHERE latest.project_id = report.project_id
                   ORDER BY latest.measured_at DESC, latest.evidence_id DESC
                   LIMIT 1
                 )
                 OR report.evidence_id = (
                   SELECT latest_good.evidence_id
                   FROM project_operational_integrity_reports latest_good
                   WHERE latest_good.project_id = report.project_id
                     AND latest_good.status = 'ok'
                     AND latest_good.coverage = 'complete'
                   ORDER BY latest_good.measured_at DESC,
                     latest_good.evidence_id DESC LIMIT 1
                 )
               )
             )
           )
         )
       ORDER BY record.retain_until, record.operational_record_id LIMIT ?`,
    )
    .bind(now, OPERATIONAL_RETENTION_BATCH_SIZE)
    .all<{ body_object_key: string; operational_record_id: string }>();
  if (candidates.results.length === 0) return 0;
  const ids = candidates.results.map(
    (candidate) => candidate.operational_record_id,
  );
  const encodedIds = JSON.stringify(ids);
  await db.batch([
    db
      .prepare(
        `DELETE FROM project_operational_requests
         WHERE operational_record_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         ) AND status IN ('completed', 'failed')`,
      )
      .bind(encodedIds),
    db
      .prepare(
        `DELETE FROM project_operational_integrity_reports
         WHERE operational_record_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         )`,
      )
      .bind(encodedIds),
    db
      .prepare(
        `DELETE FROM project_operational_dependencies
         WHERE operational_record_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         )`,
      )
      .bind(encodedIds),
    db
      .prepare(
        `DELETE FROM project_operational_records
         WHERE operational_record_id IN (
           SELECT value FROM json_each(?) WHERE type = 'text'
         )`,
      )
      .bind(encodedIds),
  ]);
  await queueCollaborationObjectCleanup(
    db,
    candidates.results.map((candidate) => candidate.body_object_key),
    now,
  );
  return candidates.results.length;
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
          OR EXISTS (
            SELECT 1 FROM project_continuity_points continuity
            WHERE continuity.body_object_key = queue.object_key
          )
          OR EXISTS (
            SELECT 1 FROM project_operation_records operation
            WHERE operation.body_object_key = queue.object_key
          )
          OR EXISTS (
            SELECT 1 FROM project_elastic_records elastic
            WHERE elastic.body_object_key = queue.object_key
          )
          OR EXISTS (
            SELECT 1 FROM project_operational_records operational
            WHERE operational.body_object_key = queue.object_key
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
