import {
  snapshotRetentionPolicySchema,
  type SnapshotRetentionPolicy,
} from "@owd/contracts";

const RETENTION_DELETE_BATCH_SIZE = 4;
const GC_BATCH_SIZE = 24;
const GC_GRACE_SECONDS = 24 * 60 * 60;
const FAILED_SNAPSHOT_BATCH_SIZE = 4;

type RetentionRow = {
  enabled: number;
  keep_ready_count: number;
  max_retained_ciphertext_bytes: number | null;
  updated_at: number;
};

type ReadySnapshotRow = {
  id: string;
  integrity_status: "degraded" | "pending" | "verified";
  manifest_ciphertext_bytes: number;
  pinned: number;
};

async function retainedCiphertextBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
        COALESCE((
          SELECT SUM(manifest_ciphertext_bytes) FROM workspace_snapshots
          WHERE status = 'ready'
        ), 0) + COALESCE((
          SELECT SUM(ciphertext_bytes) FROM snapshot_objects
          WHERE status = 'ready' AND EXISTS (
            SELECT 1 FROM snapshot_entries
            WHERE recovery_object_id = snapshot_objects.id
          )
        ), 0) + COALESCE((
          SELECT SUM(encrypted_bytes) FROM snapshot_intelligence_items
          WHERE status = 'ready'
        ), 0) AS total`,
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function readPolicyRow(db: D1Database): Promise<RetentionRow> {
  const row = await db
    .prepare(
      `SELECT enabled, keep_ready_count, max_retained_ciphertext_bytes,
        updated_at
       FROM snapshot_retention_policy WHERE id = 1`,
    )
    .first<RetentionRow>();
  if (row === null) throw new Error("snapshot_retention_unavailable");
  return row;
}

export async function readSnapshotRetentionPolicy(
  db: D1Database,
): Promise<SnapshotRetentionPolicy> {
  const [row, counts, latestKnownGood, currentRetained] = await Promise.all([
    readPolicyRow(db),
    db
      .prepare(
        `SELECT COUNT(*) AS ready_count,
          COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0)
            AS pinned_count
         FROM workspace_snapshots WHERE status = 'ready'`,
      )
      .first<{ pinned_count: number; ready_count: number }>(),
    db
      .prepare(
        `SELECT id FROM workspace_snapshots
         WHERE status = 'ready' AND integrity_status = 'verified'
         ORDER BY capture_started_at DESC, id DESC LIMIT 1`,
      )
      .first<{ id: string }>(),
    retainedCiphertextBytes(db),
  ]);
  const latestAlreadyPinned =
    latestKnownGood === null
      ? false
      : (
          await db
            .prepare(`SELECT pinned FROM workspace_snapshots WHERE id = ?`)
            .bind(latestKnownGood.id)
            .first<{ pinned: number }>()
        )?.pinned === 1;
  return snapshotRetentionPolicySchema.parse({
    currentRetainedCiphertextBytes: currentRetained,
    enabled: row.enabled === 1,
    keepReadyCount: row.keep_ready_count,
    maxRetainedCiphertextBytes: row.max_retained_ciphertext_bytes,
    protectedSnapshotCount:
      (counts?.pinned_count ?? 0) +
      (latestKnownGood === null || latestAlreadyPinned ? 0 : 1),
    readySnapshotCount: counts?.ready_count ?? 0,
    updatedAt: row.updated_at,
  });
}

export async function updateSnapshotRetentionPolicy(
  db: D1Database,
  input: {
    enabled: boolean;
    keepReadyCount: number;
    maxRetainedCiphertextBytes: number | null;
    now: number;
    requestId: string;
  },
): Promise<SnapshotRetentionPolicy> {
  await db.batch([
    db
      .prepare(
        `UPDATE snapshot_retention_policy
         SET enabled = ?, keep_ready_count = ?,
           max_retained_ciphertext_bytes = ?, updated_at = ?
         WHERE id = 1`,
      )
      .bind(
        input.enabled ? 1 : 0,
        input.keepReadyCount,
        input.maxRetainedCiphertextBytes,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'snapshot.retention_updated', ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now),
  ]);
  return readSnapshotRetentionPolicy(db);
}

async function removableCiphertextBytes(
  db: D1Database,
  snapshotId: string,
  manifestBytes: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(o.ciphertext_bytes), 0) +
        COALESCE((
          SELECT SUM(i.encrypted_bytes)
          FROM snapshot_intelligence_items i
          WHERE i.snapshot_id = ? AND i.status = 'ready'
        ), 0) AS object_bytes
       FROM snapshot_objects o
       WHERE EXISTS (
         SELECT 1 FROM snapshot_entries e
         WHERE e.snapshot_id = ? AND e.recovery_object_id = o.id
       ) AND NOT EXISTS (
         SELECT 1 FROM snapshot_entries other
         WHERE other.snapshot_id != ? AND other.recovery_object_id = o.id
       )`,
    )
    .bind(snapshotId, snapshotId, snapshotId)
    .first<{ object_bytes: number }>();
  return manifestBytes + (row?.object_bytes ?? 0);
}

async function queueSnapshotDeletion(
  db: D1Database,
  snapshotId: string,
  now: number,
  requestId: string,
): Promise<boolean> {
  const snapshot = await db
    .prepare(
      `SELECT manifest_object_key FROM workspace_snapshots
       WHERE id = ? AND status = 'ready' AND pinned = 0
         AND id != COALESCE((
           SELECT id FROM workspace_snapshots
           WHERE status = 'ready' AND integrity_status = 'verified'
           ORDER BY capture_started_at DESC, id DESC LIMIT 1
         ), '')`,
    )
    .bind(snapshotId)
    .first<{ manifest_object_key: string }>();
  if (snapshot === null) return false;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         VALUES (?, ?)`,
      )
      .bind(snapshot.manifest_object_key, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         SELECT DISTINCT o.object_key, ?
         FROM snapshot_objects o
         JOIN snapshot_entries e ON e.recovery_object_id = o.id
         WHERE e.snapshot_id = ? AND NOT EXISTS (
           SELECT 1 FROM snapshot_entries other
           WHERE other.snapshot_id != ? AND other.recovery_object_id = o.id
         )`,
      )
      .bind(now, snapshotId, snapshotId),
    db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         SELECT encrypted_object_key, ?
         FROM snapshot_intelligence_items
         WHERE snapshot_id = ? AND encrypted_object_key IS NOT NULL`,
      )
      .bind(now, snapshotId),
  ]);
  const deleted = await db
    .prepare(
      `DELETE FROM workspace_snapshots
       WHERE id = ? AND status = 'ready' AND pinned = 0
         AND id != COALESCE((
           SELECT id FROM workspace_snapshots
           WHERE status = 'ready' AND integrity_status = 'verified'
           ORDER BY capture_started_at DESC, id DESC LIMIT 1
         ), '')
       RETURNING id`,
    )
    .bind(snapshotId)
    .first<{ id: string }>();
  if (deleted?.id !== snapshotId) return false;
  await db.batch([
    db.prepare(
      `DELETE FROM snapshot_objects
       WHERE object_key IN (SELECT object_key FROM snapshot_gc_objects)
         AND NOT EXISTS (
           SELECT 1 FROM snapshot_entries e
           WHERE e.recovery_object_id = snapshot_objects.id
         )`,
    ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'snapshot.retention_deleted', ?, ?)`,
      )
      .bind(crypto.randomUUID(), requestId, now),
  ]);
  return true;
}

export async function enforceSnapshotRetention(
  db: D1Database,
  input: { now: number; requestId: string },
): Promise<number> {
  const policy = await readPolicyRow(db);
  if (policy.enabled !== 1) return 0;
  const ready = await db
    .prepare(
      `SELECT id, integrity_status, manifest_ciphertext_bytes, pinned
       FROM workspace_snapshots WHERE status = 'ready'
       ORDER BY capture_started_at DESC, id DESC`,
    )
    .all<ReadySnapshotRow>();
  const latestKnownGood = ready.results.find(
    (snapshot) => snapshot.integrity_status === "verified",
  );
  const protectedIds = new Set(
    ready.results
      .filter((snapshot) => snapshot.pinned === 1)
      .map((snapshot) => snapshot.id),
  );
  if (latestKnownGood !== undefined) protectedIds.add(latestKnownGood.id);

  const selected: ReadySnapshotRow[] = [];
  const selectedIds = new Set<string>();
  for (const snapshot of ready.results
    .slice(policy.keep_ready_count)
    .reverse()) {
    if (!protectedIds.has(snapshot.id)) {
      selected.push(snapshot);
      selectedIds.add(snapshot.id);
    }
  }

  let projectedBytes = await retainedCiphertextBytes(db);
  for (const snapshot of selected) {
    projectedBytes -= await removableCiphertextBytes(
      db,
      snapshot.id,
      snapshot.manifest_ciphertext_bytes,
    );
  }
  if (
    policy.max_retained_ciphertext_bytes !== null &&
    projectedBytes > policy.max_retained_ciphertext_bytes
  ) {
    const oldestFirst = [...ready.results].reverse();
    for (const snapshot of oldestFirst) {
      if (
        projectedBytes <= policy.max_retained_ciphertext_bytes ||
        ready.results.length - selected.length <= 2
      ) {
        break;
      }
      if (protectedIds.has(snapshot.id) || selectedIds.has(snapshot.id))
        continue;
      selected.push(snapshot);
      selectedIds.add(snapshot.id);
      projectedBytes -= await removableCiphertextBytes(
        db,
        snapshot.id,
        snapshot.manifest_ciphertext_bytes,
      );
    }
  }

  let deleted = 0;
  for (const snapshot of selected.slice(0, RETENTION_DELETE_BATCH_SIZE)) {
    if (
      await queueSnapshotDeletion(db, snapshot.id, input.now, input.requestId)
    ) {
      deleted += 1;
    }
  }
  return deleted;
}

export async function queueFailedSnapshotCleanup(
  db: D1Database,
  now: number,
): Promise<number> {
  const failed = await db
    .prepare(
      `SELECT id, completed_at FROM workspace_snapshots
       WHERE status = 'failed' AND completed_at IS NOT NULL
         AND capture_completed_at IS NULL
         AND completed_at <= ?
       ORDER BY completed_at, id LIMIT ?`,
    )
    .bind(now - GC_GRACE_SECONDS, FAILED_SNAPSHOT_BATCH_SIZE)
    .all<{ completed_at: number; id: string }>();
  for (const snapshot of failed.results) {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           SELECT manifest_object_key, ? FROM workspace_snapshots
           WHERE id = ? AND manifest_object_key IS NOT NULL`,
        )
        .bind(now, snapshot.id),
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           VALUES (?, ?)`,
        )
        .bind(`snapshots/${snapshot.id}/manifest.age`, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           SELECT DISTINCT object.object_key, ?
           FROM snapshot_objects object
           LEFT JOIN snapshot_entries entry
             ON entry.recovery_object_id = object.id
           WHERE object.created_by_snapshot_id = ?
              OR entry.snapshot_id = ?`,
        )
        .bind(now, snapshot.id, snapshot.id),
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           SELECT COALESCE(
             encrypted_object_key,
             'snapshots/' || snapshot_id || '/intelligence/' ||
               portable_object_id || '.age'
           ), ?
           FROM snapshot_intelligence_items WHERE snapshot_id = ?`,
        )
        .bind(now, snapshot.id),
      db
        .prepare(`DELETE FROM snapshot_entries WHERE snapshot_id = ?`)
        .bind(snapshot.id),
      db
        .prepare(
          `DELETE FROM snapshot_intelligence_selections
           WHERE snapshot_id = ?`,
        )
        .bind(snapshot.id),
      db
        .prepare(
          `UPDATE snapshot_vaults SET generation_id = NULL
           WHERE snapshot_id = ?`,
        )
        .bind(snapshot.id),
      db
        .prepare(
          `UPDATE workspace_snapshots
           SET capture_completed_at = completed_at,
             manifest_object_key = NULL, manifest_ciphertext_bytes = NULL,
             manifest_object_etag = NULL, manifest_object_version = NULL
           WHERE id = ? AND status = 'failed'`,
        )
        .bind(snapshot.id),
      db.prepare(
        `DELETE FROM snapshot_objects
         WHERE object_key IN (
           SELECT object_key FROM snapshot_gc_objects
         ) AND NOT EXISTS (
           SELECT 1 FROM snapshot_entries
           WHERE recovery_object_id = snapshot_objects.id
         )`,
      ),
    ]);
  }
  return failed.results.length;
}

export async function runSnapshotGarbageCollection(
  db: D1Database,
  storage: R2Bucket,
  input: { limit?: number; now: number },
): Promise<number> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? GC_BATCH_SIZE, GC_BATCH_SIZE),
  );
  const queued = await db
    .prepare(
      `SELECT object_key FROM snapshot_gc_objects
       WHERE queued_at <= ?
       ORDER BY queued_at, object_key LIMIT ?`,
    )
    .bind(input.now - GC_GRACE_SECONDS, limit)
    .all<{ object_key: string }>();
  for (const object of queued.results) {
    const referenced = await db
      .prepare(
        `SELECT 1 AS referenced
         WHERE EXISTS (
           SELECT 1 FROM workspace_snapshots
           WHERE manifest_object_key = ?
         ) OR EXISTS (
           SELECT 1 FROM snapshot_objects object
           JOIN snapshot_entries entry
             ON entry.recovery_object_id = object.id
           WHERE object.object_key = ?
         ) OR EXISTS (
           SELECT 1 FROM snapshot_intelligence_items
           WHERE encrypted_object_key = ?
         )`,
      )
      .bind(object.object_key, object.object_key, object.object_key)
      .first<{ referenced: number }>();
    if (referenced?.referenced === 1) {
      await db
        .prepare(`DELETE FROM snapshot_gc_objects WHERE object_key = ?`)
        .bind(object.object_key)
        .run();
      continue;
    }
    try {
      await storage.delete(object.object_key);
      if ((await storage.head(object.object_key)) !== null) {
        throw new Error("snapshot_gc_object_remains");
      }
      await db
        .prepare(`DELETE FROM snapshot_gc_objects WHERE object_key = ?`)
        .bind(object.object_key)
        .run();
    } catch {
      await db
        .prepare(
          `UPDATE snapshot_gc_objects
           SET attempts = attempts + 1, last_attempt_at = ?
           WHERE object_key = ?`,
        )
        .bind(input.now, object.object_key)
        .run();
    }
  }
  const remaining = await db
    .prepare(`SELECT COUNT(*) AS count FROM snapshot_gc_objects`)
    .first<{ count: number }>();
  return remaining?.count ?? 0;
}
