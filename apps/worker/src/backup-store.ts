import backupMigration from "../../../migrations/0007_encrypted_backups.sql";
import {
  OWD_BACKUP_FORMAT,
  OWD_BACKUP_MAGIC,
  backupArchiveManifestSchema,
  type BackupArchiveManifest,
  type BackupArtifact,
  type BackupRecipientStatus,
  type MaterializationGeneration,
  type PortableSourceDevice,
} from "@owd/contracts";
import { Encrypter } from "age-encryption";
import {
  listMaterializedNotesForBackup,
  type BackupMaterializedNote,
} from "./materialization-store";
import { sha256Hex } from "./security";

const encoder = new TextEncoder();
const MAX_BACKUPS_PER_VAULT = 100;
const SOURCE_VERIFY_CONCURRENCY = 16;

type RecipientRow = {
  fingerprint: string;
  recipient: string;
  updated_at: number;
};

type BackupRow = {
  ciphertext_bytes: number;
  completed_at: number;
  created_at: number;
  format_version: "owd-backup-v1";
  generation_id: string;
  id: string;
  note_count: number;
  object_etag: string;
  object_key: string;
  object_version: string;
  recipient_fingerprint: string;
  vault_id: string;
  verified_at: number;
};

export type ReadyBackupObject = BackupArtifact & {
  objectEtag: string;
  objectKey: string;
  objectVersion: string;
};

export class BackupError extends Error {
  readonly code:
    | "backup_recipient_changed"
    | "backup_recipient_in_use"
    | "backup_recipient_missing"
    | "backup_source_invalid"
    | "backup_source_unavailable"
    | "backup_unavailable";

  constructor(code: BackupError["code"]) {
    super(code);
    this.name = "BackupError";
    this.code = code;
  }
}

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function ensureBackupSchema(db: D1Database): Promise<void> {
  const objects = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE name IN (
         'backup_recipients',
         'backup_artifacts',
         'backup_artifacts_vault_idx',
         'backup_artifacts_status_idx',
         'restore_jobs',
         'restore_jobs_vault_idx',
         'restore_entries',
         'restore_entries_status_idx',
         'restore_cleanup_state'
       )`,
    )
    .first<{ count: number }>();

  if (objects?.count !== 9) {
    await db.exec(executableMigration(backupMigration));
  }

  // Browser/unit fixtures bootstrap subsystem schemas directly instead of
  // replaying Wrangler's migration journal. Keep those fixtures aligned with
  // the additive 0012 migration without making production request paths
  // responsible for schema changes.
  const restoreColumns = await db
    .prepare(`PRAGMA table_info(restore_jobs)`)
    .all<{ name: string }>();
  if (
    !restoreColumns.results.some(
      ({ name }) => name === "materialization_job_id",
    )
  ) {
    await db.exec(
      executableMigration(
        `ALTER TABLE restore_jobs ADD COLUMN materialization_job_id TEXT
         REFERENCES materialization_jobs (id) ON DELETE RESTRICT`,
      ),
    );
  }
}

function artifactFromRow(row: BackupRow): BackupArtifact {
  return {
    backupId: row.id,
    ciphertextBytes: row.ciphertext_bytes,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    format: row.format_version,
    generationId: row.generation_id,
    noteCount: row.note_count,
    recipientFingerprint: row.recipient_fingerprint,
    vaultId: row.vault_id,
    verifiedAt: row.verified_at,
  };
}

export async function readBackupRecipient(
  db: D1Database,
): Promise<BackupRecipientStatus> {
  const row = await db
    .prepare(
      `SELECT recipient, fingerprint, updated_at
       FROM backup_recipients WHERE id = 1`,
    )
    .first<RecipientRow>();

  return row === null
    ? {
        configured: false,
        fingerprint: null,
        recipient: null,
        updatedAt: null,
      }
    : {
        configured: true,
        fingerprint: row.fingerprint,
        recipient: row.recipient,
        updatedAt: row.updated_at,
      };
}

export async function saveBackupRecipient(
  db: D1Database,
  input: { now: number; recipient: string; requestId: string },
): Promise<BackupRecipientStatus> {
  // Constructing an encrypter validates the bech32 checksum and native X25519
  // recipient before any configuration is committed.
  const encrypter = new Encrypter();
  try {
    encrypter.addRecipient(input.recipient);
  } catch {
    throw new BackupError("backup_source_invalid");
  }
  const fingerprint = await sha256Hex(input.recipient);

  const auditId = crypto.randomUUID();
  const saved = await db.batch<{ fingerprint?: string; id?: string }>([
    db
      .prepare(
        `INSERT INTO backup_recipients (
          id, recipient, fingerprint, created_at, updated_at
        )
        SELECT 1, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM workspace_snapshots
          WHERE status IN ('creating', 'importing')
            AND recipient_fingerprint != ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM backup_artifacts
            WHERE status = 'creating'
              AND recipient_fingerprint != ?
          )
        ON CONFLICT(id) DO UPDATE SET
          recipient = excluded.recipient,
          fingerprint = excluded.fingerprint,
          updated_at = excluded.updated_at
        WHERE backup_recipients.fingerprint = excluded.fingerprint
          OR (
            NOT EXISTS (
              SELECT 1 FROM workspace_snapshots
              WHERE status IN ('creating', 'importing')
                AND recipient_fingerprint != excluded.fingerprint
            )
            AND NOT EXISTS (
              SELECT 1 FROM backup_artifacts
              WHERE status = 'creating'
                AND recipient_fingerprint != excluded.fingerprint
            )
          )
        RETURNING fingerprint`,
      )
      .bind(
        input.recipient,
        fingerprint,
        input.now,
        input.now,
        fingerprint,
        fingerprint,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'backup.recipient_configured', ?, ?
         FROM backup_recipients
         WHERE id = 1 AND fingerprint = ? AND updated_at = ?
         RETURNING id`,
      )
      .bind(auditId, input.requestId, input.now, fingerprint, input.now),
  ]);
  if (
    saved[0]?.results[0]?.fingerprint !== fingerprint ||
    saved[1]?.results[0]?.id !== auditId
  ) {
    throw new BackupError("backup_recipient_in_use");
  }

  return {
    configured: true,
    fingerprint,
    recipient: input.recipient,
    updatedAt: input.now,
  };
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function verifyBackupSourceObjects(
  storage: R2Bucket,
  notes: BackupMaterializedNote[],
): Promise<void> {
  for (
    let index = 0;
    index < notes.length;
    index += SOURCE_VERIFY_CONCURRENCY
  ) {
    const verified = await Promise.all(
      notes
        .slice(index, index + SOURCE_VERIFY_CONCURRENCY)
        .map(async (note) => {
          const object = await storage.head(note.r2Key);
          return (
            object !== null &&
            object.size === note.byteLength &&
            object.checksums.sha256 !== undefined &&
            bytesToHex(object.checksums.sha256) === note.contentSha256
          );
        }),
    );
    if (verified.some((valid) => !valid)) {
      throw new BackupError("backup_source_unavailable");
    }
  }
}

function createPlaintextStream(
  storage: R2Bucket,
  prefix: Uint8Array,
  notes: BackupMaterializedNote[],
): ReadableStream<Uint8Array> {
  let prefixPending = true;
  let noteIndex = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (prefixPending) {
          prefixPending = false;
          controller.enqueue(prefix);
          return;
        }

        while (noteIndex < notes.length) {
          const note = notes[noteIndex];
          if (note === undefined) break;

          if (currentReader === null) {
            const object = await storage.get(note.r2Key);
            if (
              object === null ||
              object.size !== note.byteLength ||
              object.checksums.sha256 === undefined ||
              bytesToHex(object.checksums.sha256) !== note.contentSha256
            ) {
              throw new BackupError("backup_source_unavailable");
            }
            currentReader = object.body.getReader();
          }

          const chunk = await currentReader.read();
          if (chunk.done) {
            currentReader.releaseLock();
            currentReader = null;
            noteIndex += 1;
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

async function markBackupFailed(
  db: D1Database,
  backupId: string,
  now: number,
  code: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE backup_artifacts
       SET status = 'failed', failure_code = ?, completed_at = ?
       WHERE id = ? AND status = 'creating'`,
    )
    .bind(code, now, backupId)
    .run();
}

export async function createEncryptedBackup(
  db: D1Database,
  storage: R2Bucket,
  input: {
    expectedRecipientFingerprint: string;
    generation: MaterializationGeneration;
    now: number;
    requestId: string;
    sourceDevices: PortableSourceDevice[];
    vaultName: string;
  },
): Promise<BackupArtifact> {
  const recipient = await readBackupRecipient(db);
  if (
    !recipient.configured ||
    recipient.recipient === null ||
    recipient.fingerprint === null
  ) {
    throw new BackupError("backup_recipient_missing");
  }
  if (recipient.fingerprint !== input.expectedRecipientFingerprint) {
    throw new BackupError("backup_recipient_changed");
  }

  const notes = await listMaterializedNotesForBackup(
    db,
    input.generation.generationId,
    input.generation.vaultId,
  );
  if (
    notes.length !== input.generation.noteCount ||
    notes.reduce((total, note) => total + note.byteLength, 0) !==
      input.generation.totalBytes
  ) {
    throw new BackupError("backup_source_unavailable");
  }
  await verifyBackupSourceObjects(storage, notes);

  const backupId = crypto.randomUUID();
  const manifest: BackupArchiveManifest = backupArchiveManifestSchema.parse({
    backupId,
    createdAt: input.now,
    excludedSections: [
      "oauth",
      "sessions",
      "pairing-codes",
      "agent-grants",
      "pending-agent-proposals",
      "unknown-obsidian-plugin-data",
    ],
    format: OWD_BACKUP_FORMAT,
    generation: input.generation,
    includedSections: ["notes"],
    notes: notes.map((note) => ({
      byteLength: note.byteLength,
      contentSha256: note.contentSha256,
      modifiedAt: note.modifiedAt,
      path: note.path,
    })),
    sourceDevices: input.sourceDevices,
    reservedSections: [
      "attachments",
      "obsidian-allowlist",
      "accepted-memory",
      "skills",
      "provenance",
      "policy",
    ],
    vaultName: input.vaultName,
  });
  const prefix = encoder.encode(
    `${OWD_BACKUP_MAGIC}${JSON.stringify(manifest)}\n`,
  );
  const plaintextBytes = prefix.byteLength + input.generation.totalBytes;
  const objectKey = `backups/${backupId}/vault.age`;
  let staged = false;

  try {
    const inserted = await db
      .prepare(
        `INSERT INTO backup_artifacts (
          id, vault_id, generation_id, format_version, status, object_key,
          recipient_fingerprint, note_count, plaintext_bytes, created_at
        )
        SELECT ?, v.id, g.id, ?, 'creating', ?, ?, ?, ?, ?
        FROM vaults v
        JOIN materialization_generations g ON g.vault_id = v.id
        JOIN current_materializations current ON current.generation_id = g.id
        WHERE v.id = ? AND v.status = 'active' AND g.id = ?
          AND g.status = 'published'
          AND EXISTS (
            SELECT 1 FROM backup_recipients current_recipient
            WHERE current_recipient.id = 1
              AND current_recipient.fingerprint = ?
          )
        RETURNING id`,
      )
      .bind(
        backupId,
        OWD_BACKUP_FORMAT,
        objectKey,
        recipient.fingerprint,
        notes.length,
        plaintextBytes,
        input.now,
        input.generation.vaultId,
        input.generation.generationId,
        input.expectedRecipientFingerprint,
      )
      .first<{ id: string }>();
    if (inserted?.id !== backupId) {
      throw new BackupError("backup_source_unavailable");
    }
    staged = true;

    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient.recipient);
    const encrypted = await encrypter.encrypt(
      createPlaintextStream(storage, prefix, notes),
    );
    const expectedCiphertextBytes = encrypted.size(plaintextBytes);
    const fixedLength = new FixedLengthStream(expectedCiphertextBytes);
    const [pipeResult, putResult] = await Promise.allSettled([
      encrypted.pipeTo(fixedLength.writable),
      storage.put(objectKey, fixedLength.readable, {
        customMetadata: {
          format: OWD_BACKUP_FORMAT,
          recipient: recipient.fingerprint,
        },
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
    if (written === null || written.size !== expectedCiphertextBytes) {
      throw new BackupError("backup_unavailable");
    }
    const verified = await storage.head(objectKey);
    if (
      verified === null ||
      verified.size !== expectedCiphertextBytes ||
      verified.etag !== written.etag ||
      verified.version !== written.version
    ) {
      throw new BackupError("backup_unavailable");
    }

    const completed = await db.batch<{ id: string }>([
      db
        .prepare(
          `UPDATE backup_artifacts
           SET status = 'ready', ciphertext_bytes = ?, object_etag = ?,
             object_version = ?, completed_at = ?, verified_at = ?
           WHERE id = ? AND status = 'creating'
           RETURNING id`,
        )
        .bind(
          verified.size,
          verified.etag,
          verified.version,
          input.now,
          input.now,
          backupId,
        ),
      db
        .prepare(
          `INSERT INTO audit_events (id, event_type, request_id, created_at)
           VALUES (?, 'backup.created', ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.requestId, input.now),
    ]);
    if (completed[0]?.results[0]?.id !== backupId) {
      throw new BackupError("backup_unavailable");
    }

    return {
      backupId,
      ciphertextBytes: verified.size,
      completedAt: input.now,
      createdAt: input.now,
      format: OWD_BACKUP_FORMAT,
      generationId: input.generation.generationId,
      noteCount: notes.length,
      recipientFingerprint: recipient.fingerprint,
      vaultId: input.generation.vaultId,
      verifiedAt: input.now,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "backup.creation.failed",
        backupId,
        code: error instanceof BackupError ? error.code : "backup_unavailable",
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    if (staged) {
      await markBackupFailed(
        db,
        backupId,
        input.now,
        error instanceof BackupError ? error.code : "backup_unavailable",
      );
    }
    if (error instanceof BackupError) throw error;
    throw new BackupError("backup_unavailable");
  }
}

export async function listReadyBackups(
  db: D1Database,
  vaultId: string,
): Promise<BackupArtifact[]> {
  const result = await db
    .prepare(
      `SELECT b.id, b.vault_id, b.generation_id, b.format_version,
        b.object_key, b.object_etag, b.object_version,
        b.recipient_fingerprint, b.note_count, b.ciphertext_bytes,
        b.created_at, b.completed_at, b.verified_at
       FROM backup_artifacts b
       JOIN vaults v ON v.id = b.vault_id
       WHERE b.vault_id = ? AND b.status = 'ready'
         AND b.ciphertext_bytes IS NOT NULL
         AND b.completed_at IS NOT NULL AND b.verified_at IS NOT NULL
         AND b.object_etag IS NOT NULL AND b.object_version IS NOT NULL
       ORDER BY b.created_at DESC LIMIT ?`,
    )
    .bind(vaultId, MAX_BACKUPS_PER_VAULT)
    .all<BackupRow>();

  return result.results.map(artifactFromRow);
}

export async function readReadyBackup(
  db: D1Database,
  backupId: string,
): Promise<ReadyBackupObject | null> {
  const row = await db
    .prepare(
      `SELECT b.id, b.vault_id, b.generation_id, b.format_version,
        b.object_key, b.object_etag, b.object_version,
        b.recipient_fingerprint, b.note_count, b.ciphertext_bytes,
        b.created_at, b.completed_at, b.verified_at
       FROM backup_artifacts b
       JOIN vaults v ON v.id = b.vault_id
       WHERE b.id = ? AND b.status = 'ready'
         AND b.ciphertext_bytes IS NOT NULL
         AND b.completed_at IS NOT NULL AND b.verified_at IS NOT NULL
         AND b.object_etag IS NOT NULL AND b.object_version IS NOT NULL
       `,
    )
    .bind(backupId)
    .first<BackupRow>();

  return row === null
    ? null
    : {
        ...artifactFromRow(row),
        objectEtag: row.object_etag,
        objectKey: row.object_key,
        objectVersion: row.object_version,
      };
}
