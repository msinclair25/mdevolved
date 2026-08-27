import snapshotMigration from "../../../migrations/0008_snapshot_recovery.sql";
import snapshotArchiveMigration from "../../../migrations/0009_snapshot_archiving.sql";
import {
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_LOGICAL_BYTES,
  APPROVED_INTELLIGENCE_CAPABILITY,
  BASE_SNAPSHOT_REQUIRED_CAPABILITIES,
  COMPOUNDING_SNAPSHOT_CAPABILITY,
  MDEVOLVED_SNAPSHOT_EXPORT_MAGIC,
  MDEVOLVED_SNAPSHOT_FORMAT,
  OWD_SNAPSHOT_EXPORT_MAGIC,
  OWD_SNAPSHOT_FORMAT,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  portableSourceDescriptorSchema,
  portableSourceDeviceSchema,
  snapshotExportIndexSchema,
  snapshotManifestSchema,
  snapshotSectionSchema,
  type MaterializationGeneration,
  type PortableSourceDescriptor,
  type PortableSourceDevice,
  type SnapshotEstimate,
  type SnapshotExportIndex,
  type SnapshotManifest,
  type SnapshotSection,
  type SnapshotSummary,
  type SourceDescriptor,
} from "@mdevolved/contracts";
import { Encrypter } from "age-encryption";
import {
  listMaterializedNotesForBackup,
  type BackupMaterializedNote,
} from "./materialization-store";
import { readBackupRecipient } from "./backup-store";
import {
  buildCollaborationSnapshotManifest,
  estimateCollaborationSnapshot,
  readCollaborationSnapshotSummary,
  stageCollaborationSnapshot,
  type IntelligenceSelection,
} from "./collaboration-snapshot";

const encoder = new TextEncoder();
const SNAPSHOT_OBJECT_BATCH_SIZE = 20;
const SNAPSHOT_REPAIR_BATCH_SIZE = 24;
const D1_WRITE_BATCH_SIZE = 40;
const MAX_SNAPSHOTS = 100;

const REQUIRED_CAPABILITIES = [...BASE_SNAPSHOT_REQUIRED_CAPABILITIES];
const OPTIONAL_CAPABILITIES = [
  "owd.snapshot.attachments-v1",
  "owd.snapshot.obsidian-allowlist-v1",
];
const INCLUDED_SECTIONS: SnapshotSection[] = ["notes"];
const UNAVAILABLE_SECTIONS: SnapshotSection[] = [
  "attachments",
  "obsidian-allowlist",
];

type SnapshotRow = {
  archived_at: number | null;
  capture_completed_at: number | null;
  capture_started_at: number;
  changed_item_count: number;
  completed_at: number | null;
  created_at: number;
  failure_code: string | null;
  format_version: typeof OWD_SNAPSHOT_FORMAT;
  id: string;
  included_sections: string;
  integrity_status: "degraded" | "pending" | "verified";
  item_count: number;
  logical_bytes: number;
  manifest_ciphertext_bytes: number | null;
  manifest_object_etag: string | null;
  manifest_object_key: string | null;
  manifest_object_version: string | null;
  manifest_portable_object_id: string;
  newly_stored_bytes: number;
  pinned: number;
  portable_format_version:
    typeof MDEVOLVED_SNAPSHOT_FORMAT | typeof OWD_SNAPSHOT_FORMAT;
  portable_snapshot_id: string;
  processed_object_count: number;
  recipient_fingerprint: string;
  scope: SnapshotSummary["scope"];
  status: SnapshotSummary["status"];
  total_object_count: number;
  unavailable_sections: string;
  verified_at: number | null;
};

type SnapshotVaultRow = {
  generation_completed_at: number | null;
  generation_created_at: number | null;
  generation_id: string | null;
  item_count: number;
  logical_bytes: number;
  ordinal: number;
  snapshot_id: string;
  snapshot_vault_id: string;
  source_state_vector_sha256: string | null;
  source_descriptor_json: string | null;
  source_devices_json: string | null;
  source_vault_id: string | null;
  source_vault_name: string;
};

type SnapshotEntryRow = {
  byte_length: number;
  content_sha256: string;
  modified_at: number | null;
  object_ciphertext_bytes: number | null;
  object_etag: string | null;
  object_key: string | null;
  object_version: string | null;
  path: string;
  path_key: string;
  portable_object_id: string;
  recovery_object_id: string | null;
  section: SnapshotSection;
  snapshot_id: string;
  snapshot_vault_id: string;
  source_r2_key: string | null;
};

type SnapshotObjectRow = {
  ciphertext_bytes: number;
  content_sha256: string;
  id: string;
  object_etag: string;
  object_key: string;
  object_version: string;
  plaintext_bytes: number;
  recipient_fingerprint: string;
  section: SnapshotSection;
  verified_at: number;
};

type PendingObjectRow = {
  byte_length: number;
  content_sha256: string;
  portable_object_id: string;
  section: SnapshotSection;
  source_r2_key: string | null;
};

type PendingIntelligenceRow = {
  byte_length: number;
  content_sha256: string;
  item_id: string;
  portable_object_id: string;
  source_object_key: string;
};

type SnapshotRepairContentCandidate = PendingObjectRow & {
  kind: "vault-content";
  object_ciphertext_bytes: number;
  object_etag: string;
  object_key: string;
  object_version: string;
  recovery_object_id: string;
};

type SnapshotRepairIntelligenceCandidate = PendingIntelligenceRow & {
  encrypted_bytes: number;
  encrypted_object_key: string;
  kind: "intelligence";
  object_etag: string;
  object_version: string;
};

type SnapshotRepairCandidate =
  SnapshotRepairContentCandidate | SnapshotRepairIntelligenceCandidate;

type CaptureEntry = BackupMaterializedNote & {
  portableObjectId: string;
  section: "notes";
  snapshotVaultId: string;
  sourceVaultId: string;
};

type CapturePlan = {
  entries: CaptureEntry[];
  logicalBytes: number;
  objects: Map<
    string,
    {
      byteLength: number;
      portableObjectId: string;
      section: SnapshotSection;
    }
  >;
  vaults: Array<{
    generation: MaterializationGeneration;
    logicalBytes: number;
    notes: BackupMaterializedNote[];
    snapshotVaultId: string;
    sourceDescriptor?: SourceDescriptor;
    sourceDevices: PortableSourceDevice[];
    vaultName: string;
  }>;
};

export type SnapshotCaptureSource = {
  generation: MaterializationGeneration;
  sourceDescriptor?: SourceDescriptor;
  sourceDevices?: PortableSourceDevice[];
  vaultName: string;
};

export type PortableSnapshotPart = {
  ciphertextBytes: number;
  objectEtag: string;
  objectKey: string;
  objectVersion: string;
  portableObjectId: string;
  role: "content" | "manifest";
};

export class SnapshotError extends Error {
  readonly code:
    | "snapshot_in_progress"
    | "snapshot_invalid"
    | "snapshot_not_found"
    | "snapshot_recipient_changed"
    | "snapshot_recipient_missing"
    | "snapshot_repair_unavailable"
    | "snapshot_source_refresh_pending"
    | "snapshot_source_unavailable"
    | "snapshot_state_invalid"
    | "snapshot_too_large"
    | "snapshot_unavailable";

  constructor(code: SnapshotError["code"]) {
    super(code);
    this.name = "SnapshotError";
    this.code = code;
  }
}

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function ensureSnapshotSchema(db: D1Database): Promise<void> {
  const objects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'workspace_snapshots',
         'workspace_snapshots_timeline_idx',
         'workspace_snapshots_one_build_idx',
         'snapshot_vaults',
         'snapshot_vaults_source_idx',
         'snapshot_objects',
         'snapshot_objects_reuse_idx',
         'snapshot_entries',
         'snapshot_entries_object_idx',
         'snapshot_entries_pending_idx',
         'snapshot_retention_policy',
         'snapshot_gc_objects',
         'snapshot_gc_objects_queue_idx',
         'snapshot_archives'
       )`,
    )
    .first<{ count: number }>();
  if (objects?.count !== 14) {
    await db.exec(executableMigration(snapshotMigration));
    await db.exec(executableMigration(snapshotArchiveMigration));
  }
  const portableFormatColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('workspace_snapshots')
       WHERE name = 'portable_format_version'`,
    )
    .first<{ count: number }>();
  if (portableFormatColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE workspace_snapshots
         ADD COLUMN portable_format_version TEXT NOT NULL
         DEFAULT 'owd-snapshot-v2'
         CHECK (portable_format_version IN (
           'owd-snapshot-v2', 'mdevolved-snapshot-v3'
         ))`,
      )
      .run();
  }
  const descriptorColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('snapshot_vaults')
       WHERE name = 'source_descriptor_json'`,
    )
    .first<{ count: number }>();
  if (descriptorColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE snapshot_vaults ADD COLUMN source_descriptor_json TEXT
         CHECK (source_descriptor_json IS NULL OR json_valid(source_descriptor_json))`,
      )
      .run();
  }
  const devicesColumn = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_table_info('snapshot_vaults')
       WHERE name = 'source_devices_json'`,
    )
    .first<{ count: number }>();
  if (devicesColumn?.count !== 1) {
    await db
      .prepare(
        `ALTER TABLE snapshot_vaults ADD COLUMN source_devices_json TEXT
         CHECK (source_devices_json IS NULL OR json_valid(source_devices_json))`,
      )
      .run();
  }
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseSections(value: string): SnapshotSection[] {
  return snapshotSectionSchema.array().parse(JSON.parse(value) as unknown);
}

function objectIdentity(
  section: SnapshotSection,
  contentSha256: string,
  byteLength: number,
): string {
  return `${section}:${contentSha256}:${byteLength}`;
}

async function buildCapturePlan(
  db: D1Database,
  sources: SnapshotCaptureSource[],
): Promise<CapturePlan> {
  const entries: CaptureEntry[] = [];
  const objects = new Map<
    string,
    {
      byteLength: number;
      portableObjectId: string;
      section: SnapshotSection;
    }
  >();
  const vaults: CapturePlan["vaults"] = [];
  let logicalBytes = 0;

  for (const source of sources) {
    const notes = await listMaterializedNotesForBackup(
      db,
      source.generation.generationId,
      source.generation.vaultId,
    );
    const noteBytes = notes.reduce((total, note) => total + note.byteLength, 0);
    if (
      notes.length !== source.generation.noteCount ||
      noteBytes !== source.generation.totalBytes
    ) {
      throw new SnapshotError("snapshot_source_unavailable");
    }
    const snapshotVaultId = crypto.randomUUID();
    for (const note of notes) {
      const identity = objectIdentity(
        "notes",
        note.contentSha256,
        note.byteLength,
      );
      let object = objects.get(identity);
      if (object === undefined) {
        object = {
          byteLength: note.byteLength,
          portableObjectId: crypto.randomUUID(),
          section: "notes",
        };
        objects.set(identity, object);
      }
      entries.push({
        ...note,
        portableObjectId: object.portableObjectId,
        section: "notes",
        snapshotVaultId,
        sourceVaultId: source.generation.vaultId,
      });
    }
    logicalBytes += noteBytes;
    vaults.push({
      generation: source.generation,
      logicalBytes: noteBytes,
      notes,
      snapshotVaultId,
      ...(source.sourceDescriptor === undefined
        ? {}
        : { sourceDescriptor: source.sourceDescriptor }),
      sourceDevices: source.sourceDevices ?? [],
      vaultName: source.vaultName,
    });
  }

  if (
    entries.length > MAX_SNAPSHOT_ITEMS ||
    logicalBytes > MAX_SNAPSHOT_LOGICAL_BYTES
  ) {
    throw new SnapshotError("snapshot_too_large");
  }
  return { entries, logicalBytes, objects, vaults };
}

async function readRetainedCiphertextBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
        COALESCE((
          SELECT SUM(ciphertext_bytes) FROM snapshot_objects
          WHERE id IN (
            SELECT DISTINCT e.recovery_object_id
            FROM snapshot_entries e
            JOIN workspace_snapshots s ON s.id = e.snapshot_id
            WHERE s.status = 'ready' AND e.recovery_object_id IS NOT NULL
          )
        ), 0) +
        COALESCE((
          SELECT SUM(manifest_ciphertext_bytes) FROM workspace_snapshots
          WHERE status = 'ready'
        ), 0) +
        COALESCE((
          SELECT SUM(i.encrypted_bytes)
          FROM snapshot_intelligence_items i
          JOIN workspace_snapshots s ON s.id = i.snapshot_id
          WHERE s.status = 'ready' AND i.status = 'ready'
        ), 0) AS total`,
    )
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function reusableObjectsByIdentity(
  db: D1Database,
  recipientFingerprint: string,
): Promise<Map<string, SnapshotObjectRow>> {
  const rows = await db
    .prepare(
      `SELECT id, section, recipient_fingerprint, content_sha256,
        plaintext_bytes, ciphertext_bytes, object_key, object_etag,
        object_version, verified_at
       FROM snapshot_objects
       WHERE recipient_fingerprint = ? AND status = 'ready'
         AND ciphertext_bytes IS NOT NULL AND object_etag IS NOT NULL
         AND object_version IS NOT NULL AND verified_at IS NOT NULL
       ORDER BY verified_at DESC`,
    )
    .bind(recipientFingerprint)
    .all<SnapshotObjectRow>();
  const objects = new Map<string, SnapshotObjectRow>();
  for (const row of rows.results) {
    const identity = objectIdentity(
      row.section,
      row.content_sha256,
      row.plaintext_bytes,
    );
    if (!objects.has(identity)) objects.set(identity, row);
  }
  return objects;
}

export async function estimateWorkspaceSnapshot(
  db: D1Database,
  sources: SnapshotCaptureSource[],
  scope: "all-active" | "selected",
  intelligenceSelection: IntelligenceSelection = "approved",
): Promise<SnapshotEstimate> {
  const recipient = await readBackupRecipient(db);
  if (recipient.fingerprint === null) {
    throw new SnapshotError("snapshot_recipient_missing");
  }
  const plan = await buildCapturePlan(db, sources);
  const reusable = await reusableObjectsByIdentity(db, recipient.fingerprint);
  let reusableObjectCount = 0;
  let projectedNewPlaintextBytes = 0;
  for (const [identity, object] of plan.objects) {
    if (reusable.has(identity)) reusableObjectCount += 1;
    else projectedNewPlaintextBytes += object.byteLength;
  }
  return {
    currentRetainedCiphertextBytes: await readRetainedCiphertextBytes(db),
    intelligence: await estimateCollaborationSnapshot(
      db,
      intelligenceSelection,
    ),
    itemCount: plan.entries.length,
    logicalBytes: plan.logicalBytes,
    projectedNewPlaintextBytes,
    reusableObjectCount,
    scope,
    vaultCount: plan.vaults.length,
  };
}

async function changedItemCount(
  db: D1Database,
  plan: CapturePlan,
): Promise<number> {
  const previous = await db
    .prepare(
      `SELECT id FROM workspace_snapshots
       WHERE status = 'ready' ORDER BY capture_started_at DESC LIMIT 1`,
    )
    .first<{ id: string }>();
  if (previous === null) return plan.entries.length;

  const previousRows = await db
    .prepare(
      `SELECT v.source_vault_id, e.section, e.path_key, e.content_sha256
       FROM snapshot_entries e
       JOIN snapshot_vaults v
         ON v.snapshot_id = e.snapshot_id
        AND v.snapshot_vault_id = e.snapshot_vault_id
       WHERE e.snapshot_id = ?`,
    )
    .bind(previous.id)
    .all<{
      content_sha256: string;
      path_key: string;
      section: SnapshotSection;
      source_vault_id: string | null;
    }>();
  const sourceIds = new Set(
    plan.vaults.map((vault) => vault.generation.vaultId),
  );
  const previousEntries = new Map<string, string>();
  for (const entry of previousRows.results) {
    if (
      entry.source_vault_id !== null &&
      sourceIds.has(entry.source_vault_id)
    ) {
      previousEntries.set(
        `${entry.source_vault_id}:${entry.section}:${entry.path_key}`,
        entry.content_sha256,
      );
    }
  }
  let changed = 0;
  for (const entry of plan.entries) {
    const key = `${entry.sourceVaultId}:${entry.section}:${entry.pathKey}`;
    if (previousEntries.get(key) !== entry.contentSha256) changed += 1;
    previousEntries.delete(key);
  }
  return changed + previousEntries.size;
}

async function markSnapshotFailed(
  db: D1Database,
  snapshotId: string,
  code: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE workspace_snapshots
       SET status = 'failed', failure_code = ?, completed_at = ?
       WHERE id = ? AND status IN ('creating', 'importing')`,
    )
    .bind(code, now, snapshotId)
    .run();
}

export async function startWorkspaceSnapshot(
  db: D1Database,
  input: {
    captureStartedAt: number;
    intelligenceSelection?: IntelligenceSelection;
    now: number;
    requestId: string;
    scope: "all-active" | "selected";
    sources: SnapshotCaptureSource[];
  },
): Promise<SnapshotSummary> {
  const recipient = await readBackupRecipient(db);
  if (recipient.fingerprint === null || recipient.recipient === null) {
    throw new SnapshotError("snapshot_recipient_missing");
  }
  const inProgress = await db
    .prepare(
      `SELECT id FROM workspace_snapshots
       WHERE status IN ('creating', 'importing') LIMIT 1`,
    )
    .first<{ id: string }>();
  if (inProgress !== null) {
    throw new SnapshotError("snapshot_in_progress");
  }

  const plan = await buildCapturePlan(db, input.sources);
  const snapshotId = crypto.randomUUID();
  const portableSnapshotId = crypto.randomUUID();
  const manifestPortableObjectId = crypto.randomUUID();
  let staged = false;
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO workspace_snapshots (
          id, portable_snapshot_id, format_version, portable_format_version,
          origin, scope, status,
          recipient_fingerprint,
          capture_started_at, vault_count, item_count, logical_bytes,
          changed_item_count, total_object_count, included_sections,
          unavailable_sections, manifest_portable_object_id, created_at
        )
        SELECT ?, ?, ?, ?, 'created', ?, 'creating', recipient.fingerprint,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM backup_recipients recipient
        WHERE recipient.id = 1 AND recipient.fingerprint = ?
          AND NOT EXISTS (
            SELECT 1 FROM workspace_snapshots
            WHERE status IN ('creating', 'importing')
          )
        RETURNING id`,
      )
      .bind(
        snapshotId,
        portableSnapshotId,
        OWD_SNAPSHOT_FORMAT,
        MDEVOLVED_SNAPSHOT_FORMAT,
        input.scope,
        input.captureStartedAt,
        plan.vaults.length,
        plan.entries.length,
        plan.logicalBytes,
        await changedItemCount(db, plan),
        plan.objects.size,
        JSON.stringify(INCLUDED_SECTIONS),
        JSON.stringify(UNAVAILABLE_SECTIONS),
        manifestPortableObjectId,
        input.now,
        recipient.fingerprint,
      )
      .first<{ id: string }>();
    if (inserted?.id !== snapshotId) {
      const active = await db
        .prepare(
          `SELECT id FROM workspace_snapshots
           WHERE status IN ('creating', 'importing') LIMIT 1`,
        )
        .first<{ id: string }>();
      throw new SnapshotError(
        active === null ? "snapshot_recipient_changed" : "snapshot_in_progress",
      );
    }
    staged = true;

    for (const [ordinal, vault] of plan.vaults.entries()) {
      const inserted = await db
        .prepare(
          `INSERT INTO snapshot_vaults (
            snapshot_id, snapshot_vault_id, source_vault_id,
            source_vault_name, generation_id, source_state_vector_sha256,
            generation_created_at, generation_completed_at, item_count,
            logical_bytes, ordinal, source_descriptor_json,
            source_devices_json
          )
          SELECT ?, ?, v.id, ?, g.id, g.source_state_vector_sha256,
            g.created_at, g.completed_at, ?, ?, ?, ?, ?
          FROM vaults v
          JOIN materialization_generations g ON g.vault_id = v.id
          WHERE v.id = ? AND v.status = 'active' AND g.id = ?
            AND g.status = 'published' AND g.completed_at IS NOT NULL
          RETURNING snapshot_vault_id`,
        )
        .bind(
          snapshotId,
          vault.snapshotVaultId,
          vault.vaultName,
          vault.notes.length,
          vault.logicalBytes,
          ordinal,
          vault.sourceDescriptor === undefined
            ? null
            : JSON.stringify(vault.sourceDescriptor),
          JSON.stringify(vault.sourceDevices),
          vault.generation.vaultId,
          vault.generation.generationId,
        )
        .first<{ snapshot_vault_id: string }>();
      if (inserted?.snapshot_vault_id !== vault.snapshotVaultId) {
        throw new SnapshotError("snapshot_source_unavailable");
      }
    }

    for (
      let index = 0;
      index < plan.entries.length;
      index += D1_WRITE_BATCH_SIZE
    ) {
      await db.batch(
        plan.entries.slice(index, index + D1_WRITE_BATCH_SIZE).map((entry) =>
          db
            .prepare(
              `INSERT INTO snapshot_entries (
                snapshot_id, snapshot_vault_id, section, path, path_key,
                content_sha256, byte_length, modified_at,
                portable_object_id, source_r2_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              snapshotId,
              entry.snapshotVaultId,
              entry.section,
              entry.path,
              entry.pathKey,
              entry.contentSha256,
              entry.byteLength,
              entry.modifiedAt,
              entry.portableObjectId,
              entry.r2Key,
            ),
        ),
      );
    }
    await stageCollaborationSnapshot(db, {
      now: input.now,
      selection: input.intelligenceSelection ?? "approved",
      snapshotId,
    });
    await db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'snapshot.capture_started', ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now)
      .run();
    const summary = await readWorkspaceSnapshot(db, snapshotId);
    if (summary === null) throw new SnapshotError("snapshot_unavailable");
    return summary;
  } catch (error) {
    if (staged) {
      await markSnapshotFailed(
        db,
        snapshotId,
        error instanceof SnapshotError ? error.code : "snapshot_unavailable",
        input.now,
      );
    }
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("snapshot_unavailable");
  }
}

async function vaultRowsForSnapshots(
  db: D1Database,
  snapshotIds: string[],
): Promise<Map<string, SnapshotVaultRow[]>> {
  const grouped = new Map<string, SnapshotVaultRow[]>();
  if (snapshotIds.length === 0) return grouped;
  const placeholders = snapshotIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT snapshot_id, snapshot_vault_id, source_vault_id,
        source_vault_name, generation_id, source_state_vector_sha256,
        generation_created_at, generation_completed_at, item_count,
        logical_bytes, ordinal, source_descriptor_json, source_devices_json
       FROM snapshot_vaults WHERE snapshot_id IN (${placeholders})
       ORDER BY snapshot_id, ordinal`,
    )
    .bind(...snapshotIds)
    .all<SnapshotVaultRow>();
  for (const row of result.results) {
    const rows = grouped.get(row.snapshot_id) ?? [];
    rows.push(row);
    grouped.set(row.snapshot_id, rows);
  }
  return grouped;
}

async function summaryFromRow(
  db: D1Database,
  row: SnapshotRow,
  vaults: SnapshotVaultRow[],
): Promise<SnapshotSummary> {
  return {
    archivedAt: row.archived_at,
    captureCompletedAt: row.capture_completed_at,
    captureStartedAt: row.capture_started_at,
    changedItemCount: row.changed_item_count,
    createdAt: row.created_at,
    failureCode: row.failure_code,
    format: row.portable_format_version,
    includedSections: parseSections(row.included_sections),
    intelligence: await readCollaborationSnapshotSummary(db, row.id),
    integrityStatus: row.integrity_status,
    itemCount: row.item_count,
    logicalBytes: row.logical_bytes,
    newlyStoredBytes: row.newly_stored_bytes,
    pinned: row.pinned === 1,
    processedObjectCount: row.processed_object_count,
    recipientFingerprint: row.recipient_fingerprint,
    encryption: "age-x25519",
    scope: row.scope,
    snapshotId: row.id,
    status: row.status,
    totalObjectCount: row.total_object_count,
    unavailableSections: parseSections(row.unavailable_sections),
    vaults: vaults.map((vault) => ({
      generationId: vault.generation_id,
      itemCount: vault.item_count,
      logicalBytes: vault.logical_bytes,
      snapshotVaultId: vault.snapshot_vault_id,
      sourceVaultId: vault.source_vault_id,
      vaultName: vault.source_vault_name,
    })),
    verifiedAt: row.verified_at,
  };
}

const SNAPSHOT_ROW_SELECT = `
  id, portable_snapshot_id, format_version, portable_format_version,
  scope, status, recipient_fingerprint,
  (SELECT archived_at FROM snapshot_archives
   WHERE snapshot_id = workspace_snapshots.id) AS archived_at,
  capture_started_at, capture_completed_at, item_count, logical_bytes,
  changed_item_count, processed_object_count, total_object_count,
  newly_stored_bytes, included_sections, unavailable_sections,
  integrity_status, failure_code,
  manifest_portable_object_id, manifest_object_key,
  manifest_ciphertext_bytes, manifest_object_etag, manifest_object_version,
  pinned, created_at, completed_at, verified_at`;

export async function readWorkspaceSnapshot(
  db: D1Database,
  snapshotId: string,
): Promise<SnapshotSummary | null> {
  const row = await db
    .prepare(
      `SELECT ${SNAPSHOT_ROW_SELECT}
       FROM workspace_snapshots WHERE id = ?`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (row === null) return null;
  const grouped = await vaultRowsForSnapshots(db, [snapshotId]);
  return summaryFromRow(db, row, grouped.get(snapshotId) ?? []);
}

export async function listWorkspaceSnapshots(
  db: D1Database,
): Promise<SnapshotSummary[]> {
  const rows = await db
    .prepare(
      `SELECT ${SNAPSHOT_ROW_SELECT}
       FROM workspace_snapshots
       ORDER BY capture_started_at DESC LIMIT ?`,
    )
    .bind(MAX_SNAPSHOTS)
    .all<SnapshotRow>();
  const grouped = await vaultRowsForSnapshots(
    db,
    rows.results.map((row) => row.id),
  );
  return Promise.all(
    rows.results.map((row) =>
      summaryFromRow(db, row, grouped.get(row.id) ?? []),
    ),
  );
}

function storedObjectMatches(
  object: R2Object | null,
  expected: {
    ciphertextBytes: number;
    etag: string;
    version: string;
  },
): boolean {
  return (
    object !== null &&
    object.size === expected.ciphertextBytes &&
    object.etag === expected.etag &&
    object.version === expected.version
  );
}

async function findReusableObject(
  db: D1Database,
  storage: R2Bucket,
  input: {
    byteLength: number;
    contentSha256: string;
    recipientFingerprint: string;
    section: SnapshotSection;
  },
): Promise<SnapshotObjectRow | null> {
  const result = await db
    .prepare(
      `SELECT id, section, recipient_fingerprint, content_sha256,
        plaintext_bytes, ciphertext_bytes, object_key, object_etag,
        object_version, verified_at
       FROM snapshot_objects
       WHERE status = 'ready' AND recipient_fingerprint = ?
         AND section = ? AND content_sha256 = ? AND plaintext_bytes = ?
         AND ciphertext_bytes IS NOT NULL AND object_etag IS NOT NULL
         AND object_version IS NOT NULL AND verified_at IS NOT NULL
       ORDER BY verified_at DESC LIMIT 5`,
    )
    .bind(
      input.recipientFingerprint,
      input.section,
      input.contentSha256,
      input.byteLength,
    )
    .all<SnapshotObjectRow>();
  for (const row of result.results) {
    if (
      storedObjectMatches(await storage.head(row.object_key), {
        ciphertextBytes: row.ciphertext_bytes,
        etag: row.object_etag,
        version: row.object_version,
      })
    ) {
      return row;
    }
    await db
      .prepare(
        `UPDATE snapshot_objects
         SET status = 'failed', failure_code = 'ciphertext_missing'
         WHERE id = ? AND status = 'ready'`,
      )
      .bind(row.id)
      .run();
  }
  return null;
}

async function encryptObjectToR2(
  storage: R2Bucket,
  input: {
    objectKey: string;
    plaintext: ReadableStream<Uint8Array>;
    plaintextBytes: number;
    recipient: string;
    customMetadata: Record<string, string>;
  },
): Promise<R2Object> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(input.recipient);
  const encrypted = await encrypter.encrypt(input.plaintext);
  const ciphertextBytes = encrypted.size(input.plaintextBytes);
  const fixedLength = new FixedLengthStream(ciphertextBytes);
  const [pipeResult, putResult] = await Promise.allSettled([
    encrypted.pipeTo(fixedLength.writable),
    storage.put(input.objectKey, fixedLength.readable, {
      customMetadata: input.customMetadata,
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "application/octet-stream",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    }),
  ]);
  if (pipeResult.status === "rejected") throw pipeResult.reason;
  if (putResult.status === "rejected") throw putResult.reason;
  const written = putResult.value;
  if (written === null || written.size !== ciphertextBytes) {
    throw new SnapshotError("snapshot_unavailable");
  }
  const verified = await storage.head(input.objectKey);
  if (
    !storedObjectMatches(verified, {
      ciphertextBytes,
      etag: written.etag,
      version: written.version,
    })
  ) {
    throw new SnapshotError("snapshot_unavailable");
  }
  return written;
}

async function processPendingIntelligence(
  db: D1Database,
  storage: R2Bucket,
  input: {
    format: typeof MDEVOLVED_SNAPSHOT_FORMAT | typeof OWD_SNAPSHOT_FORMAT;
    now: number;
    recipient: string;
    recipientFingerprint: string;
    snapshotId: string;
  },
): Promise<number> {
  const pending = await db
    .prepare(
      `SELECT item_id, portable_object_id, source_object_key,
        content_sha256, byte_length
       FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'pending'
       ORDER BY portable_object_id LIMIT ?`,
    )
    .bind(input.snapshotId, SNAPSHOT_OBJECT_BATCH_SIZE)
    .all<PendingIntelligenceRow>();
  for (const item of pending.results) {
    const source = await storage.get(item.source_object_key);
    if (
      source === null ||
      source.size !== item.byte_length ||
      (source.customMetadata?.sha256 ??
        source.customMetadata?.contentSha256) !== item.content_sha256 ||
      (source.checksums.sha256 !== undefined &&
        bytesToHex(source.checksums.sha256) !== item.content_sha256)
    ) {
      throw new SnapshotError("snapshot_source_unavailable");
    }
    const objectKey =
      `snapshots/${input.snapshotId}/intelligence/` +
      `${item.portable_object_id}.age`;
    const written = await encryptObjectToR2(storage, {
      customMetadata: {
        format: input.format,
        plaintextSha256: item.content_sha256,
        recipient: input.recipientFingerprint,
        role: "intelligence",
      },
      objectKey,
      plaintext: source.body,
      plaintextBytes: item.byte_length,
      recipient: input.recipient,
    });
    const updated = await db
      .prepare(
        `UPDATE snapshot_intelligence_items
         SET encrypted_object_key = ?, encrypted_bytes = ?, object_etag = ?,
           object_version = ?, status = 'ready'
         WHERE snapshot_id = ? AND item_id = ? AND status = 'pending'
         RETURNING item_id`,
      )
      .bind(
        objectKey,
        written.size,
        written.etag,
        written.version,
        input.snapshotId,
        item.item_id,
      )
      .first<{ item_id: string }>();
    if (updated?.item_id !== item.item_id) {
      throw new SnapshotError("snapshot_state_invalid");
    }
  }
  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status != 'ready'`,
    )
    .bind(input.snapshotId)
    .first<{ count: number }>();
  return remaining?.count ?? 0;
}

async function createRecoveryObject(
  db: D1Database,
  storage: R2Bucket,
  input: {
    byteLength: number;
    contentSha256: string;
    format: typeof MDEVOLVED_SNAPSHOT_FORMAT | typeof OWD_SNAPSHOT_FORMAT;
    now: number;
    recipient: string;
    recipientFingerprint: string;
    section: SnapshotSection;
    snapshotId: string;
    sourceR2Key: string;
  },
): Promise<SnapshotObjectRow> {
  const source = await storage.get(input.sourceR2Key);
  if (
    source === null ||
    source.size !== input.byteLength ||
    source.checksums.sha256 === undefined ||
    bytesToHex(source.checksums.sha256) !== input.contentSha256
  ) {
    throw new SnapshotError("snapshot_source_unavailable");
  }
  const objectId = crypto.randomUUID();
  const objectKey = `snapshots/objects/${input.recipientFingerprint}/${crypto.randomUUID()}.age`;
  await db
    .prepare(
      `INSERT INTO snapshot_objects (
        id, status, section, recipient_fingerprint, content_sha256,
        plaintext_bytes, object_key, created_by_snapshot_id, created_at
      ) VALUES (?, 'creating', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      objectId,
      input.section,
      input.recipientFingerprint,
      input.contentSha256,
      input.byteLength,
      objectKey,
      input.snapshotId,
      input.now,
    )
    .run();
  try {
    const written = await encryptObjectToR2(storage, {
      customMetadata: {
        format: input.format,
        plaintextSha256: input.contentSha256,
        recipient: input.recipientFingerprint,
        section: input.section,
      },
      objectKey,
      plaintext: source.body,
      plaintextBytes: input.byteLength,
      recipient: input.recipient,
    });
    const completed = await db
      .prepare(
        `UPDATE snapshot_objects
         SET status = 'ready', ciphertext_bytes = ?, object_etag = ?,
           object_version = ?, verified_at = ?
         WHERE id = ? AND status = 'creating'
         RETURNING id`,
      )
      .bind(written.size, written.etag, written.version, input.now, objectId)
      .first<{ id: string }>();
    if (completed?.id !== objectId) {
      throw new SnapshotError("snapshot_unavailable");
    }
    return {
      ciphertext_bytes: written.size,
      content_sha256: input.contentSha256,
      id: objectId,
      object_etag: written.etag,
      object_key: objectKey,
      object_version: written.version,
      plaintext_bytes: input.byteLength,
      recipient_fingerprint: input.recipientFingerprint,
      section: input.section,
      verified_at: input.now,
    };
  } catch (error) {
    await db
      .prepare(
        `UPDATE snapshot_objects
         SET status = 'failed', failure_code = 'encryption_failed'
         WHERE id = ? AND status = 'creating'`,
      )
      .bind(objectId)
      .run();
    throw error;
  }
}

async function snapshotEntries(
  db: D1Database,
  snapshotId: string,
): Promise<SnapshotEntryRow[]> {
  const result = await db
    .prepare(
      `SELECT e.snapshot_id, e.snapshot_vault_id, e.section, e.path,
        e.path_key, e.content_sha256, e.byte_length, e.modified_at,
        e.portable_object_id, e.recovery_object_id, e.source_r2_key,
        o.ciphertext_bytes AS object_ciphertext_bytes,
        o.object_key, o.object_etag, o.object_version
       FROM snapshot_entries e
       LEFT JOIN snapshot_objects o ON o.id = e.recovery_object_id
       WHERE e.snapshot_id = ?
       ORDER BY e.snapshot_vault_id, e.section, e.path_key`,
    )
    .bind(snapshotId)
    .all<SnapshotEntryRow>();
  return result.results;
}

async function buildWorkspaceSnapshotManifest(
  db: D1Database,
  row: SnapshotRow,
  snapshotId: string,
  captureCompletedAt: number,
): Promise<SnapshotManifest> {
  const vaultRows = (await vaultRowsForSnapshots(db, [snapshotId])).get(
    snapshotId,
  );
  if (vaultRows === undefined || vaultRows.length === 0) {
    throw new SnapshotError("snapshot_invalid");
  }
  const entries = await snapshotEntries(db, snapshotId);
  if (
    entries.length !== row.item_count ||
    entries.some(
      (entry) =>
        entry.recovery_object_id === null ||
        entry.object_ciphertext_bytes === null ||
        entry.object_key === null ||
        entry.object_etag === null ||
        entry.object_version === null,
    )
  ) {
    throw new SnapshotError("snapshot_state_invalid");
  }
  const objects = new Map<
    string,
    {
      byteLength: number;
      contentSha256: string;
      portableObjectId: string;
      section: SnapshotSection;
    }
  >();
  for (const entry of entries) {
    objects.set(entry.portable_object_id, {
      byteLength: entry.byte_length,
      contentSha256: entry.content_sha256,
      portableObjectId: entry.portable_object_id,
      section: entry.section,
    });
  }
  const intelligence = await buildCollaborationSnapshotManifest(db, snapshotId);
  const portableDescriptor = (
    value: string | null,
  ): PortableSourceDescriptor | undefined => {
    if (value === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new SnapshotError("snapshot_state_invalid");
    }
    const descriptor = portableSourceDescriptorSchema.safeParse({
      ...(typeof parsed === "object" && parsed !== null ? parsed : {}),
      restoreDisposition: "quarantined",
      authorityRestored: false,
    });
    if (!descriptor.success) throw new SnapshotError("snapshot_state_invalid");
    return descriptor.data;
  };
  return snapshotManifestSchema.parse({
    captureCompletedAt,
    captureStartedAt: row.capture_started_at,
    excludedSecuritySections: [
      "oauth",
      "sessions",
      "passkeys",
      "pairing-secrets",
      "agent-grants",
      "pending-agent-proposals",
      "harness-context",
      "unknown-obsidian-plugin-data",
    ],
    format: row.portable_format_version,
    includedSections: parseSections(row.included_sections),
    intelligence,
    logicalBytes: row.logical_bytes,
    objects: [...objects.values()].sort((left, right) =>
      left.portableObjectId.localeCompare(right.portableObjectId),
    ),
    optionalCapabilities: OPTIONAL_CAPABILITIES,
    recipientFingerprint: row.recipient_fingerprint,
    requiredCapabilities: [
      ...REQUIRED_CAPABILITIES,
      ...intelligence.requiredCapabilities,
    ],
    reservedSections: [
      "accepted-handoffs",
      "durable-knowledge",
      "skills",
      "evaluations",
      "provenance",
      "policy",
    ],
    scope: row.scope,
    snapshotId: row.portable_snapshot_id,
    unavailableSections: parseSections(row.unavailable_sections),
    vaults: vaultRows.map((vault) => {
      const descriptor = portableDescriptor(vault.source_descriptor_json);
      let devices: PortableSourceDevice[];
      try {
        const parsed = JSON.parse(vault.source_devices_json ?? "[]") as unknown;
        devices = Array.isArray(parsed)
          ? parsed.map((device) =>
              portableSourceDeviceSchema.parse({
                ...(typeof device === "object" && device !== null
                  ? device
                  : {}),
                authorityRestored: false,
                connectionRestored: false,
                credentialRestored: false,
                restoreDisposition: "quarantined",
              }),
            )
          : [];
      } catch {
        throw new SnapshotError("snapshot_state_invalid");
      }
      return {
        entries: entries
          .filter(
            (entry) => entry.snapshot_vault_id === vault.snapshot_vault_id,
          )
          .map((entry) => ({
            byteLength: entry.byte_length,
            contentSha256: entry.content_sha256,
            modifiedAt: entry.modified_at,
            path: entry.path,
            portableObjectId: entry.portable_object_id,
            section: entry.section,
          })),
        snapshotVaultId: vault.snapshot_vault_id,
        sourceVaultId: vault.source_vault_id,
        ...(descriptor === undefined ? {} : { sourceDescriptor: descriptor }),
        ...(devices.length === 0 ? {} : { sourceDevices: devices }),
        sourceGeneration:
          vault.generation_id === null ||
          vault.source_state_vector_sha256 === null ||
          vault.generation_created_at === null ||
          vault.generation_completed_at === null
            ? null
            : {
                completedAt: vault.generation_completed_at,
                createdAt: vault.generation_created_at,
                generationId: vault.snapshot_vault_id,
                noteCount: vault.item_count,
                sourceStateVectorSha256: vault.source_state_vector_sha256,
                totalBytes: vault.logical_bytes,
              },
        vaultName: vault.source_vault_name,
      };
    }),
  });
}

async function finalizeWorkspaceSnapshot(
  db: D1Database,
  storage: R2Bucket,
  snapshotId: string,
  now: number,
  requestId: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT ${SNAPSHOT_ROW_SELECT}
       FROM workspace_snapshots WHERE id = ? AND status = 'creating'`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (row === null) throw new SnapshotError("snapshot_state_invalid");
  const manifest = await buildWorkspaceSnapshotManifest(
    db,
    row,
    snapshotId,
    now,
  );
  const recipient = await readBackupRecipient(db);
  if (
    recipient.recipient === null ||
    recipient.fingerprint !== row.recipient_fingerprint
  ) {
    await markSnapshotFailed(db, snapshotId, "snapshot_recipient_changed", now);
    throw new SnapshotError("snapshot_recipient_changed");
  }
  const plaintext = encoder.encode(JSON.stringify(manifest));
  const objectKey = `snapshots/${snapshotId}/manifest.age`;
  const written = await encryptObjectToR2(storage, {
    customMetadata: {
      format: row.portable_format_version,
      recipient: row.recipient_fingerprint,
      role: "manifest",
    },
    objectKey,
    plaintext: new Blob([plaintext]).stream(),
    plaintextBytes: plaintext.byteLength,
    recipient: recipient.recipient,
  });
  const contentNewBytes = await db
    .prepare(
      `SELECT COALESCE(SUM(ciphertext_bytes), 0) AS total
       FROM snapshot_objects
       WHERE created_by_snapshot_id = ? AND status = 'ready'`,
    )
    .bind(snapshotId)
    .first<{ total: number }>();
  const completed = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE workspace_snapshots
         SET status = 'ready', capture_completed_at = ?, completed_at = ?,
           verified_at = ?, integrity_status = 'verified', manifest_object_key = ?,
           manifest_ciphertext_bytes = ?, manifest_object_etag = ?,
           manifest_object_version = ?,
           newly_stored_bytes = ?
         WHERE id = ? AND status = 'creating'
           AND processed_object_count = total_object_count
         RETURNING id`,
      )
      .bind(
        now,
        now,
        now,
        objectKey,
        written.size,
        written.etag,
        written.version,
        (contentNewBytes?.total ?? 0) + written.size,
        snapshotId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'snapshot.created', ?, ?)`,
      )
      .bind(crypto.randomUUID(), requestId, now),
  ]);
  if (completed[0]?.results[0]?.id !== snapshotId) {
    throw new SnapshotError("snapshot_unavailable");
  }
}

export async function continueWorkspaceSnapshot(
  db: D1Database,
  storage: R2Bucket,
  input: { now: number; requestId: string; snapshotId: string },
): Promise<SnapshotSummary> {
  const existing = await db
    .prepare(
      `SELECT status, recipient_fingerprint, portable_format_version
       FROM workspace_snapshots
       WHERE id = ?`,
    )
    .bind(input.snapshotId)
    .first<{
      portable_format_version:
        typeof MDEVOLVED_SNAPSHOT_FORMAT | typeof OWD_SNAPSHOT_FORMAT;
      recipient_fingerprint: string;
      status: SnapshotSummary["status"];
    }>();
  if (existing === null) throw new SnapshotError("snapshot_not_found");
  if (existing.status === "ready") {
    const ready = await readWorkspaceSnapshot(db, input.snapshotId);
    if (ready === null) throw new SnapshotError("snapshot_not_found");
    return ready;
  }
  if (existing.status !== "creating") {
    throw new SnapshotError("snapshot_state_invalid");
  }
  const recipient = await readBackupRecipient(db);
  if (
    recipient.recipient === null ||
    recipient.fingerprint !== existing.recipient_fingerprint
  ) {
    await markSnapshotFailed(
      db,
      input.snapshotId,
      "snapshot_recipient_changed",
      input.now,
    );
    throw new SnapshotError("snapshot_recipient_changed");
  }

  const pending = await db
    .prepare(
      `SELECT portable_object_id, section, content_sha256,
        MAX(byte_length) AS byte_length, MIN(source_r2_key) AS source_r2_key
       FROM snapshot_entries
       WHERE snapshot_id = ? AND recovery_object_id IS NULL
       GROUP BY portable_object_id, section, content_sha256
       ORDER BY portable_object_id LIMIT ?`,
    )
    .bind(input.snapshotId, SNAPSHOT_OBJECT_BATCH_SIZE)
    .all<PendingObjectRow>();

  for (const item of pending.results) {
    let object = await findReusableObject(db, storage, {
      byteLength: item.byte_length,
      contentSha256: item.content_sha256,
      recipientFingerprint: existing.recipient_fingerprint,
      section: item.section,
    });
    if (object === null) {
      if (item.source_r2_key === null) {
        throw new SnapshotError("snapshot_source_unavailable");
      }
      object = await createRecoveryObject(db, storage, {
        byteLength: item.byte_length,
        contentSha256: item.content_sha256,
        format: existing.portable_format_version,
        now: input.now,
        recipient: recipient.recipient,
        recipientFingerprint: existing.recipient_fingerprint,
        section: item.section,
        snapshotId: input.snapshotId,
        sourceR2Key: item.source_r2_key,
      });
    }
    await db
      .prepare(
        `UPDATE snapshot_entries SET recovery_object_id = ?
         WHERE snapshot_id = ? AND portable_object_id = ?
           AND recovery_object_id IS NULL`,
      )
      .bind(object.id, input.snapshotId, item.portable_object_id)
      .run();
  }
  const pendingIntelligenceCount = await processPendingIntelligence(
    db,
    storage,
    {
      format: existing.portable_format_version,
      now: input.now,
      recipient: recipient.recipient,
      recipientFingerprint: existing.recipient_fingerprint,
      snapshotId: input.snapshotId,
    },
  );

  const counts = await db
    .prepare(
      `SELECT
        COUNT(DISTINCT portable_object_id) AS total,
        COUNT(DISTINCT CASE WHEN recovery_object_id IS NOT NULL
          THEN portable_object_id END) AS processed
       FROM snapshot_entries WHERE snapshot_id = ?`,
    )
    .bind(input.snapshotId)
    .first<{ processed: number; total: number }>();
  await db
    .prepare(
      `UPDATE workspace_snapshots
       SET processed_object_count = ?
       WHERE id = ? AND status = 'creating'`,
    )
    .bind(counts?.processed ?? 0, input.snapshotId)
    .run();
  if (
    (counts?.processed ?? 0) === (counts?.total ?? -1) &&
    pendingIntelligenceCount === 0
  ) {
    await finalizeWorkspaceSnapshot(
      db,
      storage,
      input.snapshotId,
      input.now,
      input.requestId,
    );
  }
  const summary = await readWorkspaceSnapshot(db, input.snapshotId);
  if (summary === null) throw new SnapshotError("snapshot_not_found");
  return summary;
}

export async function cancelWorkspaceSnapshot(
  db: D1Database,
  input: { now: number; requestId: string; snapshotId: string },
): Promise<SnapshotSummary> {
  const cancelled = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE workspace_snapshots
         SET status = 'failed', failure_code = 'snapshot_cancelled',
           completed_at = ?
         WHERE id = ? AND status IN ('creating', 'importing')
         RETURNING id`,
      )
      .bind(input.now, input.snapshotId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'snapshot.cancelled', ?, ?
         FROM workspace_snapshots
         WHERE id = ? AND status = 'failed'
           AND failure_code = 'snapshot_cancelled' AND changes() = 1`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now, input.snapshotId),
  ]);
  if (cancelled[0]?.results[0]?.id !== input.snapshotId) {
    const exists = await db
      .prepare(`SELECT id FROM workspace_snapshots WHERE id = ?`)
      .bind(input.snapshotId)
      .first<{ id: string }>();
    throw new SnapshotError(
      exists === null ? "snapshot_not_found" : "snapshot_state_invalid",
    );
  }
  const summary = await readWorkspaceSnapshot(db, input.snapshotId);
  if (summary === null) throw new SnapshotError("snapshot_not_found");
  return summary;
}

export async function setWorkspaceSnapshotPinned(
  db: D1Database,
  input: {
    now: number;
    pinned: boolean;
    requestId: string;
    snapshotId: string;
  },
): Promise<SnapshotSummary> {
  const updated = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE workspace_snapshots SET pinned = ?
         WHERE id = ? AND status = 'ready' RETURNING id`,
      )
      .bind(input.pinned ? 1 : 0, input.snapshotId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, ?, ?, ? FROM workspace_snapshots
         WHERE id = ? AND status = 'ready' AND pinned = ?`,
      )
      .bind(
        crypto.randomUUID(),
        input.pinned ? "snapshot.pinned" : "snapshot.unpinned",
        input.requestId,
        input.now,
        input.snapshotId,
        input.pinned ? 1 : 0,
      ),
  ]);
  if (updated[0]?.results[0]?.id !== input.snapshotId) {
    throw new SnapshotError("snapshot_not_found");
  }
  const summary = await readWorkspaceSnapshot(db, input.snapshotId);
  if (summary === null) throw new SnapshotError("snapshot_not_found");
  return summary;
}

export async function setWorkspaceSnapshotArchived(
  db: D1Database,
  input: {
    archived: boolean;
    now: number;
    requestId: string;
    snapshotId: string;
  },
): Promise<SnapshotSummary> {
  const snapshot = await db
    .prepare(
      `SELECT id FROM workspace_snapshots
       WHERE id = ? AND status IN ('ready', 'failed')`,
    )
    .bind(input.snapshotId)
    .first<{ id: string }>();
  if (snapshot === null) throw new SnapshotError("snapshot_not_found");

  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, ?, ?, ? FROM workspace_snapshots
         WHERE id = ? AND status IN ('ready', 'failed')
           AND (
             (? = 1 AND NOT EXISTS (
               SELECT 1 FROM snapshot_archives WHERE snapshot_id = ?
             ))
             OR (? = 0 AND EXISTS (
               SELECT 1 FROM snapshot_archives WHERE snapshot_id = ?
             ))
           )`,
      )
      .bind(
        crypto.randomUUID(),
        input.archived ? "snapshot.archived" : "snapshot.unarchived",
        input.requestId,
        input.now,
        input.snapshotId,
        input.archived ? 1 : 0,
        input.snapshotId,
        input.archived ? 1 : 0,
        input.snapshotId,
      ),
    input.archived
      ? db
          .prepare(
            `INSERT OR IGNORE INTO snapshot_archives (
               snapshot_id, archived_at
             ) VALUES (?, ?)`,
          )
          .bind(input.snapshotId, input.now)
      : db
          .prepare(`DELETE FROM snapshot_archives WHERE snapshot_id = ?`)
          .bind(input.snapshotId),
  ]);
  const summary = await readWorkspaceSnapshot(db, input.snapshotId);
  if (summary === null) throw new SnapshotError("snapshot_not_found");
  return summary;
}

export async function buildPortableSnapshotExport(
  db: D1Database,
  snapshotId: string,
): Promise<{
  index: SnapshotExportIndex;
  parts: PortableSnapshotPart[];
  prefix: Uint8Array;
  totalBytes: number;
}> {
  const row = await db
    .prepare(
      `SELECT ${SNAPSHOT_ROW_SELECT}
       FROM workspace_snapshots
       WHERE id = ? AND status = 'ready' AND integrity_status = 'verified'`,
    )
    .bind(snapshotId)
    .first<SnapshotRow>();
  if (
    row === null ||
    row.manifest_object_key === null ||
    row.manifest_ciphertext_bytes === null ||
    row.manifest_object_etag === null ||
    row.manifest_object_version === null
  ) {
    throw new SnapshotError("snapshot_not_found");
  }
  const entries = await snapshotEntries(db, snapshotId);
  const unique = new Map<string, SnapshotEntryRow>();
  for (const entry of entries) {
    if (
      entry.object_ciphertext_bytes === null ||
      entry.object_key === null ||
      entry.object_etag === null ||
      entry.object_version === null
    ) {
      throw new SnapshotError("snapshot_unavailable");
    }
    unique.set(entry.portable_object_id, entry);
  }
  const intelligenceRows = await db
    .prepare(
      `SELECT portable_object_id, encrypted_bytes, encrypted_object_key,
        object_etag, object_version
       FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'ready'
       ORDER BY portable_object_id`,
    )
    .bind(snapshotId)
    .all<{
      encrypted_bytes: number;
      encrypted_object_key: string;
      object_etag: string;
      object_version: string;
      portable_object_id: string;
    }>();
  const intelligence = await readCollaborationSnapshotSummary(db, snapshotId);
  const profileSelection = await db
    .prepare(
      `SELECT included FROM snapshot_working_profile_selections
       WHERE snapshot_id = ?`,
    )
    .bind(snapshotId)
    .first<{ included: number }>();
  const compoundingSelection = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'ready'
         AND json_extract(descriptor_json, '$.recordType') IN (
           'checkpoint-observation', 'draft-version', 'draft-accepted',
           'draft-ignored', 'draft-deleted'
         )`,
    )
    .bind(snapshotId)
    .first<{ count: number }>();
  const parts: PortableSnapshotPart[] = [
    {
      ciphertextBytes: row.manifest_ciphertext_bytes,
      objectEtag: row.manifest_object_etag,
      objectKey: row.manifest_object_key,
      objectVersion: row.manifest_object_version,
      portableObjectId: row.manifest_portable_object_id,
      role: "manifest",
    },
    ...[...unique.values()]
      .sort((left, right) =>
        left.portable_object_id.localeCompare(right.portable_object_id),
      )
      .map((entry): PortableSnapshotPart => ({
        ciphertextBytes: entry.object_ciphertext_bytes ?? 0,
        objectEtag: entry.object_etag ?? "",
        objectKey: entry.object_key ?? "",
        objectVersion: entry.object_version ?? "",
        portableObjectId: entry.portable_object_id,
        role: "content",
      })),
    ...intelligenceRows.results.map((item): PortableSnapshotPart => ({
      ciphertextBytes: item.encrypted_bytes,
      objectEtag: item.object_etag,
      objectKey: item.encrypted_object_key,
      objectVersion: item.object_version,
      portableObjectId: item.portable_object_id,
      role: "content",
    })),
  ];
  const index = snapshotExportIndexSchema.parse({
    format: row.portable_format_version,
    intelligenceSelection: intelligence.selection,
    optionalCapabilities: OPTIONAL_CAPABILITIES,
    parts: parts.map((part) => ({
      ciphertextBytes: part.ciphertextBytes,
      portableObjectId: part.portableObjectId,
      role: part.role,
    })),
    requiredCapabilities: [
      ...REQUIRED_CAPABILITIES,
      ...(intelligence.selection === "none"
        ? []
        : intelligence.selection === "approved"
          ? [APPROVED_INTELLIGENCE_CAPABILITY]
          : [
              APPROVED_INTELLIGENCE_CAPABILITY,
              QUARANTINED_INTELLIGENCE_CAPABILITY,
            ]),
      ...(profileSelection?.included === 1
        ? [WORKING_PROFILE_SNAPSHOT_CAPABILITY]
        : []),
      ...(compoundingSelection?.count !== undefined &&
      compoundingSelection.count > 0
        ? [COMPOUNDING_SNAPSHOT_CAPABILITY]
        : []),
    ],
    snapshotId: row.portable_snapshot_id,
  });
  const prefix = encoder.encode(
    `${
      row.portable_format_version === MDEVOLVED_SNAPSHOT_FORMAT
        ? MDEVOLVED_SNAPSHOT_EXPORT_MAGIC
        : OWD_SNAPSHOT_EXPORT_MAGIC
    }${JSON.stringify(index)}\n`,
  );
  return {
    index,
    parts,
    prefix,
    totalBytes:
      prefix.byteLength +
      parts.reduce((total, part) => total + part.ciphertextBytes, 0),
  };
}

export function createPortableSnapshotStream(
  storage: R2Bucket,
  prefix: Uint8Array,
  parts: PortableSnapshotPart[],
): ReadableStream<Uint8Array> {
  let prefixPending = true;
  let partIndex = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (prefixPending) {
          prefixPending = false;
          controller.enqueue(prefix);
          return;
        }
        while (partIndex < parts.length) {
          const part = parts[partIndex];
          if (part === undefined) break;
          if (currentReader === null) {
            const object = await storage.get(part.objectKey);
            if (
              object === null ||
              !storedObjectMatches(object, {
                ciphertextBytes: part.ciphertextBytes,
                etag: part.objectEtag,
                version: part.objectVersion,
              })
            ) {
              throw new SnapshotError("snapshot_unavailable");
            }
            currentReader = object.body.getReader();
          }
          const chunk = await currentReader.read();
          if (chunk.done) {
            currentReader.releaseLock();
            currentReader = null;
            partIndex += 1;
            continue;
          }
          controller.enqueue(chunk.value);
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await currentReader?.cancel(reason);
    },
  });
}

async function repairWorkspaceSnapshotManifest(
  db: D1Database,
  storage: R2Bucket,
  input: {
    now: number;
    recipient: string;
    row: SnapshotRow;
    snapshotId: string;
  },
): Promise<void> {
  const existingValid =
    input.row.manifest_object_key !== null &&
    input.row.manifest_ciphertext_bytes !== null &&
    input.row.manifest_object_etag !== null &&
    input.row.manifest_object_version !== null &&
    storedObjectMatches(await storage.head(input.row.manifest_object_key), {
      ciphertextBytes: input.row.manifest_ciphertext_bytes,
      etag: input.row.manifest_object_etag,
      version: input.row.manifest_object_version,
    });
  if (existingValid) return;
  if (input.row.capture_completed_at === null) {
    throw new SnapshotError("snapshot_invalid");
  }
  await db
    .prepare(
      `UPDATE workspace_snapshots SET integrity_status = 'degraded'
       WHERE id = ? AND status = 'ready'`,
    )
    .bind(input.snapshotId)
    .run();
  const manifest = await buildWorkspaceSnapshotManifest(
    db,
    input.row,
    input.snapshotId,
    input.row.capture_completed_at,
  );
  const plaintext = encoder.encode(JSON.stringify(manifest));
  const replacementKey = `snapshots/${input.snapshotId}/manifests/${crypto.randomUUID()}.age`;
  const written = await encryptObjectToR2(storage, {
    customMetadata: {
      format: input.row.portable_format_version,
      recipient: input.row.recipient_fingerprint,
      role: "manifest",
    },
    objectKey: replacementKey,
    plaintext: new Blob([plaintext]).stream(),
    plaintextBytes: plaintext.byteLength,
    recipient: input.recipient,
  });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE workspace_snapshots
         SET manifest_object_key = ?, manifest_ciphertext_bytes = ?,
           manifest_object_etag = ?, manifest_object_version = ?,
           newly_stored_bytes = newly_stored_bytes + ?
         WHERE id = ? AND status = 'ready'
         RETURNING id`,
      )
      .bind(
        replacementKey,
        written.size,
        written.etag,
        written.version,
        written.size,
        input.snapshotId,
      ),
  ];
  if (input.row.manifest_object_key !== null) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           VALUES (?, ?)`,
        )
        .bind(input.row.manifest_object_key, input.now),
    );
  }
  const updated = await db.batch<{ id: string }>(statements);
  if (updated[0]?.results[0]?.id !== input.snapshotId) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         VALUES (?, ?)`,
      )
      .bind(replacementKey, input.now)
      .run();
    throw new SnapshotError("snapshot_unavailable");
  }
}

async function repairSnapshotIntelligenceObject(
  db: D1Database,
  storage: R2Bucket,
  input: {
    candidate: SnapshotRepairIntelligenceCandidate;
    format: typeof MDEVOLVED_SNAPSHOT_FORMAT | typeof OWD_SNAPSHOT_FORMAT;
    now: number;
    recipient: string;
    recipientFingerprint: string;
    snapshotId: string;
  },
): Promise<void> {
  const source = await storage.get(input.candidate.source_object_key);
  if (
    source === null ||
    source.size !== input.candidate.byte_length ||
    (source.customMetadata?.sha256 ?? source.customMetadata?.contentSha256) !==
      input.candidate.content_sha256 ||
    (source.checksums.sha256 !== undefined &&
      bytesToHex(source.checksums.sha256) !== input.candidate.content_sha256)
  ) {
    throw new SnapshotError("snapshot_repair_unavailable");
  }
  const replacementKey =
    `snapshots/${input.snapshotId}/intelligence/` +
    `${input.candidate.portable_object_id}-${crypto.randomUUID()}.age`;
  const replacement = await encryptObjectToR2(storage, {
    customMetadata: {
      format: input.format,
      plaintextSha256: input.candidate.content_sha256,
      recipient: input.recipientFingerprint,
      role: "intelligence",
    },
    objectKey: replacementKey,
    plaintext: source.body,
    plaintextBytes: input.candidate.byte_length,
    recipient: input.recipient,
  });
  const updated = await db.batch<{ item_id: string }>([
    db
      .prepare(
        `UPDATE snapshot_intelligence_items
         SET encrypted_object_key = ?, encrypted_bytes = ?, object_etag = ?,
           object_version = ?
         WHERE snapshot_id = ? AND item_id = ? AND status = 'ready'
           AND encrypted_object_key = ?
         RETURNING item_id`,
      )
      .bind(
        replacementKey,
        replacement.size,
        replacement.etag,
        replacement.version,
        input.snapshotId,
        input.candidate.item_id,
        input.candidate.encrypted_object_key,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         VALUES (?, ?)`,
      )
      .bind(input.candidate.encrypted_object_key, input.now),
    db
      .prepare(
        `UPDATE workspace_snapshots
         SET newly_stored_bytes = newly_stored_bytes + ?
         WHERE id = ? AND status = 'ready'`,
      )
      .bind(replacement.size, input.snapshotId),
  ]);
  if (updated[0]?.results[0]?.item_id !== input.candidate.item_id) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
         VALUES (?, ?)`,
      )
      .bind(replacementKey, input.now)
      .run();
    throw new SnapshotError("snapshot_unavailable");
  }
}

export async function repairWorkspaceSnapshot(
  db: D1Database,
  storage: R2Bucket,
  input: {
    afterPortableObjectId: string | null;
    now: number;
    snapshotId: string;
  },
): Promise<{ nextPortableObjectId: string | null; summary: SnapshotSummary }> {
  const snapshot = await db
    .prepare(
      `SELECT ${SNAPSHOT_ROW_SELECT} FROM workspace_snapshots
       WHERE id = ? AND status = 'ready'`,
    )
    .bind(input.snapshotId)
    .first<SnapshotRow>();
  if (snapshot === null) throw new SnapshotError("snapshot_not_found");
  const recipient = await readBackupRecipient(db);
  if (
    recipient.recipient === null ||
    recipient.fingerprint !== snapshot.recipient_fingerprint
  ) {
    throw new SnapshotError("snapshot_recipient_missing");
  }
  await repairWorkspaceSnapshotManifest(db, storage, {
    now: input.now,
    recipient: recipient.recipient,
    row: snapshot,
    snapshotId: input.snapshotId,
  });
  const contentCandidates = await db
    .prepare(
      `SELECT e.portable_object_id, e.section, e.content_sha256,
        MAX(e.byte_length) AS byte_length,
        MIN(e.source_r2_key) AS source_r2_key,
        MIN(o.id) AS recovery_object_id,
        MAX(o.ciphertext_bytes) AS object_ciphertext_bytes,
        MIN(o.object_key) AS object_key,
        MIN(o.object_etag) AS object_etag,
        MIN(o.object_version) AS object_version
       FROM snapshot_entries e
       JOIN snapshot_objects o ON o.id = e.recovery_object_id
       WHERE e.snapshot_id = ? AND e.portable_object_id > ?
       GROUP BY e.portable_object_id, e.section, e.content_sha256
       ORDER BY e.portable_object_id LIMIT ?`,
    )
    .bind(
      input.snapshotId,
      input.afterPortableObjectId ?? "",
      SNAPSHOT_REPAIR_BATCH_SIZE + 1,
    )
    .all<Omit<SnapshotRepairContentCandidate, "kind">>();
  const intelligenceCandidates = await db
    .prepare(
      `SELECT item_id, portable_object_id, source_object_key,
        content_sha256, byte_length, encrypted_object_key, encrypted_bytes,
        object_etag, object_version
       FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'ready' AND portable_object_id > ?
       ORDER BY portable_object_id LIMIT ?`,
    )
    .bind(
      input.snapshotId,
      input.afterPortableObjectId ?? "",
      SNAPSHOT_REPAIR_BATCH_SIZE + 1,
    )
    .all<Omit<SnapshotRepairIntelligenceCandidate, "kind">>();
  const candidates: SnapshotRepairCandidate[] = [
    ...contentCandidates.results.map((candidate) => ({
      ...candidate,
      kind: "vault-content" as const,
    })),
    ...intelligenceCandidates.results.map((candidate) => ({
      ...candidate,
      kind: "intelligence" as const,
    })),
  ].sort((left, right) =>
    left.portable_object_id.localeCompare(right.portable_object_id),
  );
  const batch = candidates.slice(0, SNAPSHOT_REPAIR_BATCH_SIZE);
  for (const candidate of batch) {
    if (candidate.kind === "intelligence") {
      const valid = storedObjectMatches(
        await storage.head(candidate.encrypted_object_key),
        {
          ciphertextBytes: candidate.encrypted_bytes,
          etag: candidate.object_etag,
          version: candidate.object_version,
        },
      );
      if (valid) continue;
      await db
        .prepare(
          `UPDATE workspace_snapshots SET integrity_status = 'degraded'
           WHERE id = ? AND status = 'ready'`,
        )
        .bind(input.snapshotId)
        .run();
      await repairSnapshotIntelligenceObject(db, storage, {
        candidate,
        format: snapshot.portable_format_version,
        now: input.now,
        recipient: recipient.recipient,
        recipientFingerprint: snapshot.recipient_fingerprint,
        snapshotId: input.snapshotId,
      });
      continue;
    }
    const valid = storedObjectMatches(
      await storage.head(candidate.object_key),
      {
        ciphertextBytes: candidate.object_ciphertext_bytes,
        etag: candidate.object_etag,
        version: candidate.object_version,
      },
    );
    if (valid) {
      await db
        .prepare(`UPDATE snapshot_objects SET verified_at = ? WHERE id = ?`)
        .bind(input.now, candidate.recovery_object_id)
        .run();
      continue;
    }
    await db
      .prepare(
        `UPDATE workspace_snapshots SET integrity_status = 'degraded'
         WHERE id = ? AND status = 'ready'`,
      )
      .bind(input.snapshotId)
      .run();
    if (candidate.source_r2_key === null) {
      throw new SnapshotError("snapshot_repair_unavailable");
    }
    const replacement = await createRecoveryObject(db, storage, {
      byteLength: candidate.byte_length,
      contentSha256: candidate.content_sha256,
      format: snapshot.portable_format_version,
      now: input.now,
      recipient: recipient.recipient,
      recipientFingerprint: snapshot.recipient_fingerprint,
      section: candidate.section,
      snapshotId: input.snapshotId,
      sourceR2Key: candidate.source_r2_key,
    });
    await db.batch([
      db
        .prepare(
          `UPDATE snapshot_entries SET recovery_object_id = ?
           WHERE recovery_object_id = ?`,
        )
        .bind(replacement.id, candidate.recovery_object_id),
      db
        .prepare(
          `INSERT OR IGNORE INTO snapshot_gc_objects (object_key, queued_at)
           VALUES (?, ?)`,
        )
        .bind(candidate.object_key, input.now),
      db
        .prepare(`DELETE FROM snapshot_objects WHERE id = ?`)
        .bind(candidate.recovery_object_id),
      db
        .prepare(
          `UPDATE workspace_snapshots
           SET newly_stored_bytes = newly_stored_bytes + ?
           WHERE id = ?`,
        )
        .bind(replacement.ciphertext_bytes, input.snapshotId),
    ]);
  }
  const nextPortableObjectId =
    candidates.length > SNAPSHOT_REPAIR_BATCH_SIZE
      ? (batch.at(-1)?.portable_object_id ?? null)
      : null;
  if (nextPortableObjectId === null) {
    await db
      .prepare(
        `UPDATE workspace_snapshots
         SET verified_at = ?, integrity_status = 'verified'
         WHERE id = ? AND status = 'ready'`,
      )
      .bind(input.now, input.snapshotId)
      .run();
  }
  const summary = await readWorkspaceSnapshot(db, input.snapshotId);
  if (summary === null) throw new SnapshotError("snapshot_not_found");
  return { nextPortableObjectId, summary };
}
