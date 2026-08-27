import materializationMigration from "../../../migrations/0005_materialized_generations.sql";
import type {
  MaterializationGeneration,
  MaterializedNoteSummary,
  MaterializedSearchResult,
  RestoredSource,
} from "@mdevolved/contracts";
import { restoredSourceSchema } from "@mdevolved/contracts";
import type {
  MaterializationFailureCode,
  MaterializedSnapshot,
  MaterializedSnapshotNote,
} from "./materialization-snapshot";
import type { AgentVisibility } from "./agent-visibility";

const encoder = new TextEncoder();
const PROJECTION_BATCH_NOTE_COUNT = 25;
const OBJECT_WRITE_CONCURRENCY = 6;
// D1 caps a string value at 2,000,000 bytes. Keep 10% headroom while
// collapsing an arbitrary path set into one bound JSON parameter.
const D1_JSON_ARRAY_PARAMETER_BYTES = 1_800_000;

type ImmutableObjectWriter = {
  head(key: string): Promise<{
    checksums: R2Checksums;
    etag: string;
    size: number;
  } | null>;
  put(
    key: string,
    value: ArrayBuffer | string,
    options?: R2PutOptions,
  ): Promise<{
    checksums: R2Checksums;
    etag: string;
    size: number;
  } | null>;
};

type GenerationRow = {
  completed_at: number;
  created_at: number;
  id: string;
  note_count: number;
  source_state_vector_sha256: string;
  total_bytes: number;
  vault_id: string;
};

export type MaterializedNoteRow = {
  agent_private: number;
  byte_length: number;
  content_sha256: string;
  modified_at: number | null;
  path: string;
  path_key: string;
  r2_key: string;
  title: string;
};

type NoteRow = MaterializedNoteRow;

export type BackupMaterializedNote = {
  byteLength: number;
  contentSha256: string;
  modifiedAt: number | null;
  path: string;
  pathKey: string;
  r2Key: string;
};

type SearchRow = NoteRow & { snippet: string };

type AgentNoteRow = NoteRow & { restored_sources_json: string };
type AgentSearchRow = AgentNoteRow & { snippet: string };

export type AgentMaterializedNoteSummary = MaterializedNoteSummary & {
  restoredFrom: RestoredSource[];
};

export type AgentMaterializedSearchResult = MaterializedSearchResult & {
  restoredFrom: RestoredSource[];
};

export type PreparedNote = MaterializedSnapshotNote & {
  agentPrivate: boolean;
  contentSha256: string;
  r2Key: string;
};

export class MaterializationPublishError extends Error {
  readonly code: MaterializationFailureCode | "materialization_unavailable";

  constructor(
    code: MaterializationFailureCode | "materialization_unavailable",
  ) {
    super(code);
    this.name = "MaterializationPublishError";
    this.code = code;
  }
}

function jsonStringArrayParameters(values: string[]): string[] {
  const parameters: string[] = [];
  let chunk: string[] = [];
  let chunkBytes = 2;
  for (const value of values) {
    const encodedBytes = encoder.encode(JSON.stringify(value)).byteLength;
    if (encodedBytes + 2 > D1_JSON_ARRAY_PARAMETER_BYTES) {
      throw new Error("materialized_note_path_too_large");
    }
    const nextBytes = chunkBytes + encodedBytes + (chunk.length === 0 ? 0 : 1);
    if (chunk.length > 0 && nextBytes > D1_JSON_ARRAY_PARAMETER_BYTES) {
      parameters.push(JSON.stringify(chunk));
      chunk = [];
      chunkBytes = 2;
    }
    chunk.push(value);
    chunkBytes += encodedBytes + (chunk.length === 1 ? 0 : 1);
  }
  if (chunk.length > 0) parameters.push(JSON.stringify(chunk));
  return parameters;
}

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function ensureMaterializationSchema(
  db: D1Database,
): Promise<void> {
  const objects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'materialization_generations',
         'materialization_generations_vault_idx',
         'current_materializations',
         'materialized_notes',
         'materialized_notes_browse_idx',
         'materialized_note_search'
       )`,
    )
    .first<{ count: number }>();

  if (objects?.count !== 6) {
    await db.exec(executableMigration(materializationMigration));
  }
  const agentPrivateColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('materialized_notes')
       WHERE name = 'agent_private'`,
    )
    .first<{ count: number }>();
  if (agentPrivateColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE materialized_notes
         ADD COLUMN agent_private INTEGER NOT NULL DEFAULT 0
         CHECK (agent_private IN (0, 1))`,
      )
      .run();
  }

  const jobObjects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'materialization_jobs',
         'materialization_jobs_vault_status_idx',
         'materialization_jobs_active_source_idx',
         'materialization_gc_objects',
         'materialization_gc_objects_queue_idx'
       )`,
    )
    .first<{ count: number }>();
  if (jobObjects?.count !== 5) {
    await db.exec(
      executableMigration(`CREATE TABLE IF NOT EXISTS materialization_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        generation_id TEXT NOT NULL UNIQUE,
        vault_id TEXT NOT NULL,
        source_state_vector_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'failed')
        ),
        staging_object_key TEXT NOT NULL UNIQUE,
        staging_object_bytes INTEGER NOT NULL,
        next_offset INTEGER NOT NULL DEFAULT 0,
        processed_note_count INTEGER NOT NULL DEFAULT 0,
        total_note_count INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        failure_code TEXT,
        FOREIGN KEY (generation_id)
          REFERENCES materialization_generations (id) ON DELETE CASCADE,
        FOREIGN KEY (vault_id) REFERENCES vaults (id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS materialization_jobs_vault_status_idx
        ON materialization_jobs (vault_id, status, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS materialization_jobs_active_source_idx
        ON materialization_jobs (vault_id, source_state_vector_sha256)
        WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS materialization_gc_objects (
        object_key TEXT PRIMARY KEY NOT NULL,
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS materialization_gc_objects_queue_idx
        ON materialization_gc_objects (queued_at, object_key);`),
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256(value: Uint8Array): Promise<{
  bytes: ArrayBuffer;
  hex: string;
}> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(value).buffer,
  );
  return { bytes: digest, hex: bytesToHex(new Uint8Array(digest)) };
}

function generationFromRow(row: GenerationRow): MaterializationGeneration {
  return {
    completedAt: row.completed_at,
    createdAt: row.created_at,
    generationId: row.id,
    noteCount: row.note_count,
    sourceStateVectorSha256: row.source_state_vector_sha256,
    totalBytes: row.total_bytes,
    vaultId: row.vault_id,
  };
}

export async function prepareNotes(
  vaultId: string,
  notes: MaterializedSnapshotNote[],
): Promise<PreparedNote[]> {
  return Promise.all(
    notes.map(async (note) => {
      const digest = await sha256(encoder.encode(note.content));
      return {
        ...note,
        agentPrivate: isAgentPrivateMarkdown(note.content),
        contentSha256: digest.hex,
        r2Key: `vaults/${vaultId}/library/objects/sha256/${digest.hex}.md`,
      };
    }),
  );
}

export function isAgentPrivateMarkdown(content: string): boolean {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return false;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return false;
  const frontmatter = normalized.slice(4, end);
  return (
    /^private:\s*true\s*$/imu.test(frontmatter) ||
    /^\s*-?\s*private\s*$/imu.test(frontmatter) ||
    /^tags:\s*\[[^\]\r\n]*\bprivate\b[^\]\r\n]*\]\s*$/imu.test(frontmatter)
  );
}

function objectMatchesContent(
  object: { checksums: R2Checksums; size: number } | null,
  byteLength: number,
  contentSha256: string,
): boolean {
  return (
    object !== null &&
    object.size === byteLength &&
    object.checksums.sha256 !== undefined &&
    bytesToHex(new Uint8Array(object.checksums.sha256)) === contentSha256
  );
}

async function putVerifiedContentObject(
  writer: ImmutableObjectWriter,
  key: string,
  value: Uint8Array,
  contentSha256: string,
  options: R2PutOptions,
): Promise<void> {
  const existing = await writer.head(key);
  if (objectMatchesContent(existing, value.byteLength, contentSha256)) return;

  const object = await writer.put(key, new Uint8Array(value).buffer, {
    ...options,
    onlyIf:
      existing === null
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: existing.etag },
  });
  if (
    !objectMatchesContent(
      object ?? (await writer.head(key)),
      value.byteLength,
      contentSha256,
    )
  ) {
    throw new MaterializationPublishError("materialization_unavailable");
  }
}

export async function putImmutableManifest(
  writer: ImmutableObjectWriter,
  key: string,
  value: string,
  options: R2PutOptions,
): Promise<void> {
  const encoded = encoder.encode(value);
  const expectedSha256 = await sha256(encoded);
  const existing = await writer.head(key);
  if (objectMatchesContent(existing, encoded.byteLength, expectedSha256.hex)) {
    return;
  }
  const object = await writer.put(key, value, {
    ...options,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (
    !objectMatchesContent(
      object ?? (await writer.head(key)),
      encoded.byteLength,
      expectedSha256.hex,
    )
  ) {
    throw new MaterializationPublishError("materialization_unavailable");
  }
}

export async function writeNoteObjects(
  writer: ImmutableObjectWriter,
  prepared: PreparedNote[],
): Promise<void> {
  const unique = new Map(prepared.map((note) => [note.contentSha256, note]));
  const notes = [...unique.values()];

  for (let index = 0; index < notes.length; index += OBJECT_WRITE_CONCURRENCY) {
    const results = await Promise.allSettled(
      notes.slice(index, index + OBJECT_WRITE_CONCURRENCY).map(async (note) => {
        const encoded = encoder.encode(note.content);
        const checksum = await crypto.subtle.digest("SHA-256", encoded);
        await putVerifiedContentObject(
          writer,
          note.r2Key,
          encoded,
          note.contentSha256,
          {
            customMetadata: {
              sha256: note.contentSha256,
            },
            httpMetadata: {
              cacheControl: "private, max-age=31536000, immutable",
              contentType: "text/markdown; charset=utf-8",
            },
            sha256: checksum,
          },
        );
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new MaterializationPublishError("materialization_unavailable");
    }
  }
}

export function projectionStatements(
  db: D1Database,
  generationId: string,
  vaultId: string,
  notes: PreparedNote[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const note of notes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO materialized_notes (
            generation_id, vault_id, path, path_key, title, r2_key,
            content_sha256, byte_length, modified_at, agent_private
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(generation_id, path_key) DO UPDATE SET
            path = excluded.path,
            title = excluded.title,
            r2_key = excluded.r2_key,
            content_sha256 = excluded.content_sha256,
            byte_length = excluded.byte_length,
            modified_at = excluded.modified_at,
            agent_private = excluded.agent_private`,
        )
        .bind(
          generationId,
          vaultId,
          note.path,
          note.pathKey,
          note.title,
          note.r2Key,
          note.contentSha256,
          note.byteLength,
          note.modifiedAt,
          note.agentPrivate ? 1 : 0,
        ),
      db
        .prepare(
          `DELETE FROM materialized_note_search
           WHERE generation_id = ? AND path_key = ?`,
        )
        .bind(generationId, note.pathKey),
      db
        .prepare(
          `INSERT INTO materialized_note_search (
            generation_id, vault_id, path_key, path, title, body
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          generationId,
          vaultId,
          note.pathKey,
          note.path,
          note.title,
          note.content,
        ),
    );
  }
  return statements;
}

async function stageProjectionRows(
  db: D1Database,
  generationId: string,
  vaultId: string,
  notes: PreparedNote[],
): Promise<void> {
  for (
    let index = 0;
    index < notes.length;
    index += PROJECTION_BATCH_NOTE_COUNT
  ) {
    const statements = projectionStatements(
      db,
      generationId,
      vaultId,
      notes.slice(index, index + PROJECTION_BATCH_NOTE_COUNT),
    );
    await db.batch(statements);
  }
}

async function markFailed(
  db: D1Database,
  generationId: string,
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
      .bind(code, now, generationId),
    db
      .prepare(
        `UPDATE vault_sync_states
         SET library_stale = 1, last_error_code = ?, last_error_at = ?,
           updated_at = ?
         WHERE vault_id = (
           SELECT vault_id FROM materialization_generations WHERE id = ?
         )`,
      )
      .bind(code, now, now, generationId),
  ]);
}

export async function publishMaterialization(
  db: D1Database,
  writer: ImmutableObjectWriter,
  input: {
    now: number;
    requestId: string;
    snapshot: MaterializedSnapshot;
    sourceStateVectorSha256: string;
    vaultId: string;
  },
): Promise<MaterializationGeneration> {
  const generationId = crypto.randomUUID();
  const manifestKey = `vaults/${input.vaultId}/generations/${generationId}/manifest.json`;
  let staged = false;

  try {
    const inserted = await db
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
      )
      .first<{ id: string }>();
    if (inserted?.id !== generationId) {
      throw new MaterializationPublishError("materialization_unavailable");
    }
    staged = true;

    const prepared = await prepareNotes(input.vaultId, input.snapshot.notes);
    await writeNoteObjects(writer, prepared);

    const manifest = JSON.stringify({
      format: "owd-materialization-v1",
      generationId,
      noteCount: prepared.length,
      notes: prepared.map((note) => ({
        byteLength: note.byteLength,
        contentSha256: note.contentSha256,
        modifiedAt: note.modifiedAt,
        path: note.path,
      })),
      schemaVersion: input.snapshot.schemaVersion,
      sourceStateVectorSha256: input.sourceStateVectorSha256,
      totalBytes: input.snapshot.totalBytes,
      vaultId: input.vaultId,
    });
    const manifestDigest = await sha256(encoder.encode(manifest));
    await putImmutableManifest(writer, manifestKey, manifest, {
      customMetadata: { generation: generationId, sha256: manifestDigest.hex },
      httpMetadata: {
        cacheControl: "private, max-age=31536000, immutable",
        contentType: "application/json; charset=utf-8",
      },
      sha256: manifestDigest.bytes,
    });

    await stageProjectionRows(db, generationId, input.vaultId, prepared);
    const [noteCount, searchCount] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM materialized_notes
           WHERE generation_id = ?`,
        )
        .bind(generationId)
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM materialized_note_search
           WHERE generation_id = ?`,
        )
        .bind(generationId)
        .first<{ count: number }>(),
    ]);
    if (
      noteCount?.count !== prepared.length ||
      searchCount?.count !== prepared.length
    ) {
      throw new MaterializationPublishError("materialization_unavailable");
    }

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
        .bind(manifestDigest.hex, input.now, generationId),
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
        .bind(input.now, generationId),
      db
        .prepare(
          `INSERT INTO audit_events (id, event_type, request_id, created_at)
           SELECT ?, 'vault.materialized', ?, ?
           FROM materialization_generations
           WHERE id = ? AND status = 'published'`,
        )
        .bind(crypto.randomUUID(), input.requestId, input.now, generationId),
      db
        .prepare(
          `DELETE FROM materialized_note_search
           WHERE vault_id = ? AND generation_id != ?`,
        )
        .bind(input.vaultId, generationId),
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
        .bind(input.sourceStateVectorSha256, input.now, input.vaultId),
    ]);
    if (published[0]?.results[0]?.id !== generationId) {
      throw new MaterializationPublishError("materialization_unavailable");
    }

    return {
      completedAt: input.now,
      createdAt: input.now,
      generationId,
      noteCount: prepared.length,
      sourceStateVectorSha256: input.sourceStateVectorSha256,
      totalBytes: input.snapshot.totalBytes,
      vaultId: input.vaultId,
    };
  } catch (error) {
    if (staged) {
      await markFailed(
        db,
        generationId,
        error instanceof MaterializationPublishError
          ? error.code
          : "materialization_unavailable",
        input.now,
      );
    }
    if (error instanceof MaterializationPublishError) throw error;
    throw new MaterializationPublishError("materialization_unavailable");
  }
}

export async function readCurrentMaterialization(
  db: D1Database,
  vaultId: string,
): Promise<MaterializationGeneration | null> {
  const row = await db
    .prepare(
      `SELECT g.id, g.vault_id, g.source_state_vector_sha256,
        g.note_count, g.total_bytes, g.created_at, g.completed_at
       FROM current_materializations current
       JOIN materialization_generations g ON g.id = current.generation_id
       JOIN vaults v ON v.id = current.vault_id
       WHERE current.vault_id = ? AND g.status = 'published'
         AND g.completed_at IS NOT NULL AND v.status = 'active'`,
    )
    .bind(vaultId)
    .first<GenerationRow>();

  return row === null ? null : generationFromRow(row);
}

/**
 * Agent and recovery workflows may use a generation only when it represents
 * the exact latest durable Yjs state confirmed by the paired plugin.
 */
export async function readUsableMaterialization(
  db: D1Database,
  vaultId: string,
): Promise<MaterializationGeneration | null> {
  return (await readUsableMaterializations(db, [vaultId])).get(vaultId) ?? null;
}

/**
 * Resolves usable generations for an arbitrary bounded vault set with
 * fixed-shape statements. JSON expansion avoids one concurrent D1 query per
 * Knowledge Space member.
 */
export async function readUsableMaterializations(
  db: D1Database,
  vaultIds: string[],
): Promise<Map<string, MaterializationGeneration>> {
  const uniqueVaultIds = [...new Set(vaultIds)];
  if (uniqueVaultIds.length === 0) return new Map();
  const generations = new Map<string, MaterializationGeneration>();
  for (const vaultIdsJson of jsonStringArrayParameters(uniqueVaultIds)) {
    const rows = await db
      .prepare(
        `SELECT g.id, g.vault_id, g.source_state_vector_sha256,
          g.note_count, g.total_bytes, g.created_at, g.completed_at
         FROM current_materializations current
         JOIN materialization_generations g ON g.id = current.generation_id
         JOIN vaults v ON v.id = current.vault_id
         JOIN vault_sync_states sync ON sync.vault_id = current.vault_id
         WHERE current.vault_id IN (
             SELECT value FROM json_each(?) WHERE type = 'text'
           )
           AND g.status = 'published'
           AND g.completed_at IS NOT NULL AND v.status = 'active'
           AND sync.initial_sync_at IS NOT NULL
           AND sync.library_stale = 0
           AND sync.current_state_vector_sha256 =
             g.source_state_vector_sha256
         ORDER BY g.vault_id`,
      )
      .bind(vaultIdsJson)
      .all<GenerationRow>();
    for (const row of rows.results) {
      generations.set(row.vault_id, generationFromRow(row));
    }
  }
  return generations;
}

function noteFromRow(row: NoteRow): MaterializedNoteSummary {
  return {
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
    modifiedAt: row.modified_at,
    path: row.path,
    title: row.title,
  };
}

function restoredSourcesFromRow(row: AgentNoteRow): RestoredSource[] {
  return restoredSourceSchema
    .array()
    .max(64)
    .parse(JSON.parse(row.restored_sources_json) as unknown);
}

function agentNoteFromRow(row: AgentNoteRow): AgentMaterializedNoteSummary {
  return {
    ...noteFromRow(row),
    restoredFrom: restoredSourcesFromRow(row),
  };
}

const restoredSourcesSelect = `(
  SELECT json_group_array(json_object(
    'appliedAt', jobs.applied_at,
    'noteCount', jobs.expected_note_count,
    'restoreId', jobs.id,
    'sourceVaultId', jobs.source_vault_id,
    'sourceVaultName', jobs.source_vault_name,
    'targetVaultId', jobs.target_vault_id
  ))
  FROM restored_note_lineage lineage
  JOIN restore_jobs jobs ON jobs.id = lineage.restore_id
  JOIN agent_grant_restore_sources approvals
    ON approvals.restore_id = jobs.id AND approvals.grant_id = ?
  WHERE jobs.target_vault_id = notes.vault_id
    AND jobs.status = 'applied' AND lineage.path_key = notes.path_key
) AS restored_sources_json`;

const noUnapprovedRestoredContent = `NOT EXISTS (
  SELECT 1
  FROM restored_note_lineage blocked_lineage
  JOIN restore_jobs blocked_jobs
    ON blocked_jobs.id = blocked_lineage.restore_id
  LEFT JOIN agent_grant_restore_sources blocked_approvals
    ON blocked_approvals.restore_id = blocked_jobs.id
   AND blocked_approvals.grant_id = ?
  WHERE blocked_jobs.target_vault_id = notes.vault_id
    AND blocked_jobs.status = 'applied'
    AND blocked_lineage.path_key = notes.path_key
    AND blocked_approvals.restore_id IS NULL
)`;

export async function listMaterializedNotes(
  db: D1Database,
  generationId: string,
  vaultId: string,
  afterPathKey: string | null,
  limit: number,
): Promise<{ notes: MaterializedNoteSummary[]; nextPathKey: string | null }> {
  const result = await db
    .prepare(
      `SELECT path, path_key, title, r2_key, content_sha256, byte_length,
        modified_at, agent_private
       FROM materialized_notes
       WHERE generation_id = ? AND vault_id = ? AND path_key > ?
       ORDER BY path_key LIMIT ?`,
    )
    .bind(generationId, vaultId, afterPathKey ?? "", limit + 1)
    .all<NoteRow>();
  const visible = result.results.slice(0, limit);
  const last = visible.at(-1);

  return {
    notes: visible.map(noteFromRow),
    nextPathKey:
      result.results.length > limit && last !== undefined
        ? last.path_key
        : null,
  };
}

export async function readMaterializedNote(
  db: D1Database,
  generationId: string,
  vaultId: string,
  pathKey: string,
): Promise<NoteRow | null> {
  return db
    .prepare(
      `SELECT path, path_key, title, r2_key, content_sha256, byte_length,
        modified_at, agent_private
       FROM materialized_notes
       WHERE generation_id = ? AND vault_id = ? AND path_key = ?`,
    )
    .bind(generationId, vaultId, pathKey)
    .first<NoteRow>();
}

/**
 * Reads every requested note with fixed-shape D1 statements. JSON expansion
 * keeps each statement at three bound parameters even when discovery combines
 * citations from many Projects.
 */
export async function readMaterializedNotes(
  db: D1Database,
  input: {
    generationId: string;
    pathKeys: string[];
    vaultId: string;
  },
): Promise<Map<string, MaterializedNoteRow>> {
  const pathKeys = [...new Set(input.pathKeys)];
  if (pathKeys.length === 0) return new Map();
  const notes = new Map<string, MaterializedNoteRow>();
  for (const pathKeysJson of jsonStringArrayParameters(pathKeys)) {
    const rows = await db
      .prepare(
        `SELECT path, path_key, title, r2_key, content_sha256, byte_length,
          modified_at, agent_private
         FROM materialized_notes
         WHERE generation_id = ? AND vault_id = ?
           AND path_key IN (
             SELECT value FROM json_each(?) WHERE type = 'text'
           )
         ORDER BY path_key`,
      )
      .bind(input.generationId, input.vaultId, pathKeysJson)
      .all<NoteRow>();
    for (const row of rows.results) notes.set(row.path_key, row);
  }
  return notes;
}

export async function listMaterializedNotesForBackup(
  db: D1Database,
  generationId: string,
  vaultId: string,
): Promise<BackupMaterializedNote[]> {
  const result = await db
    .prepare(
      `SELECT path, path_key, title, r2_key, content_sha256, byte_length,
        modified_at, agent_private
       FROM materialized_notes
       WHERE generation_id = ? AND vault_id = ?
       ORDER BY path_key`,
    )
    .bind(generationId, vaultId)
    .all<NoteRow>();

  return result.results.map((row) => ({
    byteLength: row.byte_length,
    contentSha256: row.content_sha256,
    modifiedAt: row.modified_at,
    path: row.path,
    pathKey: row.path_key,
    r2Key: row.r2_key,
  }));
}

export async function searchMaterializedNotes(
  db: D1Database,
  generationId: string,
  vaultId: string,
  ftsQuery: string,
  limit: number,
): Promise<MaterializedSearchResult[]> {
  const result = await db
    .prepare(
      `SELECT notes.path, notes.path_key, notes.title, notes.r2_key,
        notes.content_sha256, notes.byte_length, notes.modified_at,
        notes.agent_private,
        snippet(materialized_note_search, 5, '', '', ' … ', 24) AS snippet
       FROM materialized_note_search
       JOIN materialized_notes notes
         ON notes.generation_id = materialized_note_search.generation_id
        AND notes.path_key = materialized_note_search.path_key
       WHERE materialized_note_search MATCH ?
         AND materialized_note_search.generation_id = ?
         AND materialized_note_search.vault_id = ?
       ORDER BY bm25(materialized_note_search), notes.path_key
       LIMIT ?`,
    )
    .bind(ftsQuery, generationId, vaultId, limit)
    .all<SearchRow>();

  return result.results.map((row) => ({
    ...noteFromRow(row),
    snippet: row.snippet.slice(0, 4_096),
  }));
}

function escapeLikePrefix(prefix: string): string {
  return `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function scopedPathClause(
  column: string,
  pathKeyPrefixes: string[],
): { clause: string; values: string[] } {
  if (pathKeyPrefixes.length === 0) return { clause: "1 = 1", values: [] };
  return {
    clause: `(${pathKeyPrefixes.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    values: pathKeyPrefixes.map(escapeLikePrefix),
  };
}

function escapeLikeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function excludedFileNameClause(
  column: string,
  fileNames: string[],
): { clause: string; values: string[] } {
  if (fileNames.length === 0) return { clause: "1 = 1", values: [] };
  return {
    clause: fileNames
      .map(() => `(${column} != ? AND ${column} NOT LIKE ? ESCAPE '\\')`)
      .join(" AND "),
    values: fileNames.flatMap((fileName) => [
      fileName,
      `%/${escapeLikeValue(fileName)}`,
    ]),
  };
}

export async function searchScopedMaterializedNotes(
  db: D1Database,
  input: {
    ftsQuery: string;
    generationId: string;
    grantId: string;
    limit: number;
    pathKeyPrefixes: string[];
    vaultId: string;
    visibility?: {
      denyAll: boolean;
      excludePrivate: boolean;
      neverExposeFileNames: string[];
    };
  },
): Promise<AgentMaterializedSearchResult[]> {
  const scope =
    input.visibility?.denyAll === true
      ? { clause: "0 = 1", values: [] }
      : scopedPathClause("notes.path_key", input.pathKeyPrefixes);
  const excludedFileNames = excludedFileNameClause(
    "notes.path_key",
    input.visibility?.neverExposeFileNames ?? [],
  );
  const result = await db
    .prepare(
      `SELECT notes.path, notes.path_key, notes.title, notes.r2_key,
        notes.content_sha256, notes.byte_length, notes.modified_at,
        notes.agent_private,
        snippet(materialized_note_search, 5, '', '', ' … ', 24) AS snippet,
        ${restoredSourcesSelect}
       FROM materialized_note_search
       JOIN materialized_notes notes
         ON notes.generation_id = materialized_note_search.generation_id
        AND notes.path_key = materialized_note_search.path_key
       WHERE materialized_note_search MATCH ?
         AND materialized_note_search.generation_id = ?
         AND materialized_note_search.vault_id = ?
         AND ${scope.clause}
         AND (? = 0 OR notes.agent_private = 0)
         AND ${excludedFileNames.clause}
         AND ${noUnapprovedRestoredContent}
       ORDER BY bm25(materialized_note_search), notes.path_key
       LIMIT ?`,
    )
    .bind(
      input.grantId,
      input.ftsQuery,
      input.generationId,
      input.vaultId,
      ...scope.values,
      input.visibility?.excludePrivate === true ? 1 : 0,
      ...excludedFileNames.values,
      input.grantId,
      input.limit,
    )
    .all<AgentSearchRow>();

  return result.results.map((row) => ({
    ...agentNoteFromRow(row),
    snippet: row.snippet.slice(0, 4_096),
  }));
}

export async function listRecentMaterializedNotes(
  db: D1Database,
  input: {
    generationId: string;
    grantId: string;
    limit: number;
    pathKeyPrefixes: string[];
    vaultId: string;
    visibility?: {
      denyAll: boolean;
      excludePrivate: boolean;
      neverExposeFileNames: string[];
    };
  },
): Promise<AgentMaterializedNoteSummary[]> {
  const scope =
    input.visibility?.denyAll === true
      ? { clause: "0 = 1", values: [] }
      : scopedPathClause("notes.path_key", input.pathKeyPrefixes);
  const excludedFileNames = excludedFileNameClause(
    "notes.path_key",
    input.visibility?.neverExposeFileNames ?? [],
  );
  const result = await db
    .prepare(
      `SELECT notes.path, notes.path_key, notes.title, notes.r2_key,
        notes.content_sha256, notes.byte_length, notes.modified_at,
        notes.agent_private,
        ${restoredSourcesSelect}
       FROM materialized_notes notes
       WHERE notes.generation_id = ? AND notes.vault_id = ?
         AND ${scope.clause}
         AND (? = 0 OR notes.agent_private = 0)
         AND ${excludedFileNames.clause}
         AND ${noUnapprovedRestoredContent}
       ORDER BY COALESCE(modified_at, 0) DESC, path_key
       LIMIT ?`,
    )
    .bind(
      input.grantId,
      input.generationId,
      input.vaultId,
      ...scope.values,
      input.visibility?.excludePrivate === true ? 1 : 0,
      ...excludedFileNames.values,
      input.grantId,
      input.limit,
    )
    .all<AgentNoteRow>();

  return result.results.map(agentNoteFromRow);
}

export async function readMaterializedNoteRestoreAccess(
  db: D1Database,
  input: {
    grantId: string;
    pathKey: string;
    vaultId: string;
  },
): Promise<{ allowed: boolean; restoredFrom: RestoredSource[] }> {
  return (
    await readMaterializedNoteRestoreAccessBatch(db, {
      grantId: input.grantId,
      pathKeys: [input.pathKey],
      vaultId: input.vaultId,
    })
  ).get(input.pathKey)!;
}

/**
 * Resolves restored-source consent with fixed-shape D1 statements. Paths
 * without restored lineage are present and allowed.
 */
export async function readMaterializedNoteRestoreAccessBatch(
  db: D1Database,
  input: {
    grantId: string;
    pathKeys: string[];
    vaultId: string;
  },
): Promise<Map<string, { allowed: boolean; restoredFrom: RestoredSource[] }>> {
  const pathKeys = [...new Set(input.pathKeys)];
  if (pathKeys.length === 0) return new Map();
  const grouped = new Map<
    string,
    {
      allowed: boolean;
      restoredFrom: RestoredSource[];
    }
  >(pathKeys.map((pathKey) => [pathKey, { allowed: true, restoredFrom: [] }]));
  for (const pathKeysJson of jsonStringArrayParameters(pathKeys)) {
    const rows = await db
      .prepare(
        `SELECT lineage.path_key, jobs.id AS restore_id, jobs.target_vault_id,
          jobs.source_vault_id, jobs.source_vault_name, jobs.applied_at,
          jobs.expected_note_count AS note_count,
          approvals.restore_id AS approved_restore_id
         FROM restored_note_lineage lineage
         JOIN restore_jobs jobs ON jobs.id = lineage.restore_id
         LEFT JOIN agent_grant_restore_sources approvals
           ON approvals.restore_id = jobs.id AND approvals.grant_id = ?
         WHERE jobs.target_vault_id = ? AND jobs.status = 'applied'
           AND lineage.path_key IN (
             SELECT value FROM json_each(?) WHERE type = 'text'
           )
         ORDER BY lineage.path_key, jobs.applied_at, jobs.id`,
      )
      .bind(input.grantId, input.vaultId, pathKeysJson)
      .all<{
        applied_at: number;
        approved_restore_id: string | null;
        note_count: number;
        path_key: string;
        restore_id: string;
        source_vault_id: string;
        source_vault_name: string;
        target_vault_id: string;
      }>();
    for (const row of rows.results) {
      const access = grouped.get(row.path_key)!;
      if (row.approved_restore_id === null) {
        access.allowed = false;
        access.restoredFrom = [];
        continue;
      }
      if (!access.allowed) continue;
      access.restoredFrom.push(
        restoredSourceSchema.parse({
          appliedAt: row.applied_at,
          noteCount: row.note_count,
          restoreId: row.restore_id,
          sourceVaultId: row.source_vault_id,
          sourceVaultName: row.source_vault_name,
          targetVaultId: row.target_vault_id,
        }),
      );
    }
  }
  return grouped;
}

export async function agentMayUseCurrentMaterializedPath(
  db: D1Database,
  input: {
    grantId: string;
    pathKey: string;
    visibility?: AgentVisibility;
    vaultId: string;
  },
): Promise<boolean> {
  return (
    await agentMayUseCurrentMaterializedPaths(db, {
      grantId: input.grantId,
      pathKeys: [input.pathKey],
      visibility: input.visibility,
      vaultId: input.vaultId,
    })
  ).get(input.pathKey)!;
}

/**
 * Checks current-library presence and restored-source consent for a complete
 * path set with three fixed-shape D1 statements instead of one or two
 * statements per path.
 */
export async function agentMayUseCurrentMaterializedPaths(
  db: D1Database,
  input: {
    grantId: string;
    pathKeys: string[];
    visibility?: AgentVisibility;
    vaultId: string;
  },
): Promise<Map<string, boolean>> {
  const pathKeys = [...new Set(input.pathKeys)];
  if (pathKeys.length === 0) return new Map();
  const generation = await readUsableMaterialization(db, input.vaultId);
  if (generation === null) {
    return new Map(pathKeys.map((pathKey) => [pathKey, false]));
  }
  const notes = await readMaterializedNotes(db, {
    generationId: generation.generationId,
    pathKeys,
    vaultId: input.vaultId,
  });
  const restoreAccess = await readMaterializedNoteRestoreAccessBatch(db, {
    grantId: input.grantId,
    pathKeys,
    vaultId: input.vaultId,
  });
  return new Map(
    pathKeys.map((pathKey) => {
      const note = notes.get(pathKey);
      return [
        pathKey,
        note !== undefined &&
          (input.visibility === undefined ||
            visibilityAllowsMaterializedNote(
              input.visibility,
              pathKey,
              note,
            )) &&
          restoreAccess.get(pathKey)?.allowed === true,
      ];
    }),
  );
}

function visibilityAllowsMaterializedNote(
  visibility: AgentVisibility,
  pathKey: string,
  note: MaterializedNoteRow,
): boolean {
  if (visibility.denyAll) return false;
  if (visibility.excludePrivate && note.agent_private === 1) return false;
  const fileName = pathKey.slice(pathKey.lastIndexOf("/") + 1);
  if (visibility.neverExposeFileNames.includes(fileName)) return false;
  return (
    visibility.pathKeyPrefixes.length === 0 ||
    visibility.pathKeyPrefixes.some((prefix) => pathKey.startsWith(prefix))
  );
}
