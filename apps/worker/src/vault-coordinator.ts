import {
  markdownNoteWriteRequestSchema,
  restoreMarkdownNoteRequestSchema,
  vaultIdSchema,
  type LiveMarkdownNote,
  type MaterializationJob,
} from "@owd/contracts";
import {
  ChunkedDocStore,
  PersistenceCoordinator,
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  SERVER_VERSION,
  isStateVectorGe,
  isUpdateBearingSyncMessage,
  trySendSvEcho,
  trySendSvEchoStateVector,
  type PersistenceHealth,
  type SaveResult,
} from "@owd/yaos-core";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import {
  MaterializationSnapshotError,
  extractMaterializedSnapshot,
  type MaterializationFailureCode,
} from "./materialization-snapshot";
import { MaterializationPublishError } from "./materialization-store";
import {
  continueNextMaterializationJob,
  createMaterializationJob,
} from "./materialization-job";
import { randomToken, sha256Hex, sha256HexBytes } from "./security";
import {
  VaultContentError,
  applyMarkdownNoteRestore,
  applyMarkdownNoteWrite,
  readSnapshotNote,
  type StableSnapshotNote,
  type VaultContentFailureCode,
} from "./vault-content";
import { validateMarkdownVaultPath } from "./vault-path";

export interface VaultHealth {
  ready: true;
  protocol: "yaos-yjs";
  serverVersion: string;
  schemaVersion: number | null;
  supportedSchemaVersions: {
    min: number;
    max: number;
  };
  persistence: PersistenceHealth;
}

export interface VaultReceipt {
  durable: true;
  stateVector: ArrayBuffer;
}

export type VaultMaterializationJobResult =
  | { job: MaterializationJob; ok: true }
  | {
      code: MaterializationFailureCode | "materialization_unavailable";
      ok: false;
    };

export type VaultLiveNoteResult =
  | { note: LiveMarkdownNote; ok: true }
  | { code: VaultContentFailureCode; ok: false };

export type VaultMarkdownWriteResult =
  | {
      durable: true;
      note: LiveMarkdownNote;
      ok: true;
      operation: "created" | "updated";
    }
  | { code: VaultContentFailureCode; ok: false };

export type VaultRestoreWriteResult =
  | {
      durable: true;
      ok: true;
      operation: "created" | "unchanged" | "updated";
    }
  | { code: VaultContentFailureCode; ok: false };

type StableLiveNote = StableSnapshotNote & {
  contentVersion: string;
  stateVector: Uint8Array;
};

type AutomaticMaterializationState = {
  current_state_vector_sha256: string | null;
  generation_state_vector_sha256: string | null;
  initial_sync_at: number | null;
  last_error_code: string | null;
  library_stale: number;
};

const AUTOMATIC_MATERIALIZATION_DEBOUNCE_MS = 2_000;
const AUTOMATIC_MATERIALIZATION_RETRY_BASE_MS = 60_000;
const AUTOMATIC_MATERIALIZATION_RETRY_MAX_MS = 15 * 60_000;
const AUTOMATIC_MATERIALIZATION_RETRY_LIMIT = 6;
const AUTOMATIC_MATERIALIZATION_RETRY_STORAGE_KEY =
  "automatic-materialization-retry-count";
const MATERIALIZATION_CONTINUATION_DELAY_MS = 100;

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readClientSchemaVersion(request: Request): number | null {
  const url = new URL(request.url);
  const raw =
    url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema");
  if (raw === null || raw.trim() === "") return SERVER_MIN_SCHEMA_VERSION;

  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

function rejectSchema(
  connection: Connection,
  reason:
    | "invalid_client_schema"
    | "unsupported_client_schema"
    | "client_schema_older_than_room"
    | "unsupported_room_schema",
  clientSchemaVersion: number | null,
  roomSchemaVersion: number | null,
): void {
  const payload = JSON.stringify({
    type: "error",
    code: "update_required",
    reason,
    clientSchemaVersion,
    roomSchemaVersion,
    supportedSchemaVersions: {
      min: SERVER_MIN_SCHEMA_VERSION,
      max: SERVER_MAX_SCHEMA_VERSION,
    },
  });
  connection.send(payload);
  connection.send(`__YPS:${payload}`);
  connection.close(1008, "Update required");
}

/**
 * One instance is one vault. The existing v1 SQLite namespace is retained, so
 * enabling YAOS does not require a Durable Object class migration.
 */
export class VaultCoordinator extends YServer {
  static override options = {
    hibernate: true,
  };

  private documentLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private store: ChunkedDocStore | null = null;
  private persistence: PersistenceCoordinator | null = null;
  private materializationTail: Promise<void> = Promise.resolve();

  override async onLoad(): Promise<void> {
    await this.ensureDocumentLoaded();
  }

  override async onSave(): Promise<void> {
    const result = await this.persistCurrentDocument();
    if (!result.success) {
      throw new Error("Vault state could not be persisted.");
    }
  }

  override async onConnect(
    connection: Connection,
    context: ConnectionContext,
  ): Promise<void> {
    await this.ensureDocumentLoaded();
    const clientSchemaVersion = readClientSchemaVersion(context.request);
    const roomSchemaVersion = this.readSchemaVersion();

    if (clientSchemaVersion === null) {
      rejectSchema(
        connection,
        "invalid_client_schema",
        null,
        roomSchemaVersion,
      );
      return;
    }
    if (
      clientSchemaVersion < SERVER_MIN_SCHEMA_VERSION ||
      clientSchemaVersion > SERVER_MAX_SCHEMA_VERSION
    ) {
      rejectSchema(
        connection,
        "unsupported_client_schema",
        clientSchemaVersion,
        roomSchemaVersion,
      );
      return;
    }
    if (
      roomSchemaVersion !== null &&
      (roomSchemaVersion < SERVER_MIN_SCHEMA_VERSION ||
        roomSchemaVersion > SERVER_MAX_SCHEMA_VERSION)
    ) {
      rejectSchema(
        connection,
        "unsupported_room_schema",
        clientSchemaVersion,
        roomSchemaVersion,
      );
      return;
    }
    if (roomSchemaVersion !== null && clientSchemaVersion < roomSchemaVersion) {
      rejectSchema(
        connection,
        "client_schema_older_than_room",
        clientSchemaVersion,
        roomSchemaVersion,
      );
      return;
    }

    await super.onConnect(connection, context);
    trySendSvEcho(connection, this.document, "baseline");
  }

  /**
   * y-partyserver broadcasts applied state immediately. MDevolved sends YAOS's
   * state-vector receipt only after the corresponding state is durable.
   */
  override async onMessage(
    connection: Connection,
    message: WSMessage,
  ): Promise<void> {
    const updateBearing = isUpdateBearingSyncMessage(message);

    super.handleMessage(connection, message);

    if (!updateBearing) return;

    const result = await this.persistCurrentDocument();
    if (!result.success) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "vault.persistence.failed",
          method: result.method,
        }),
      );
      connection.close(1011, "Vault persistence unavailable");
      return;
    }

    trySendSvEchoStateVector(
      connection,
      this.requirePersistedStateVector(),
      "postApply",
    );
  }

  async health(): Promise<VaultHealth> {
    await this.ensureDocumentLoaded();
    const schemaVersion = this.readSchemaVersion();

    return {
      ready: true,
      protocol: "yaos-yjs",
      serverVersion: SERVER_VERSION,
      schemaVersion,
      supportedSchemaVersions: {
        min: SERVER_MIN_SCHEMA_VERSION,
        max: SERVER_MAX_SCHEMA_VERSION,
      },
      persistence: { ...this.getPersistence().health },
    };
  }

  /** Synthetic-client and future application RPC; never exposed as an API. */
  async applyUpdate(update: ArrayBuffer): Promise<VaultReceipt> {
    await this.ensureDocumentLoaded();
    Y.applyUpdate(this.document, new Uint8Array(update));

    const result = await this.persistCurrentDocument();
    if (!result.success) {
      throw new Error("Vault state could not be persisted.");
    }

    return {
      durable: true,
      stateVector: copyToArrayBuffer(this.requirePersistedStateVector()),
    };
  }

  async exportState(): Promise<ArrayBuffer> {
    await this.ensureDocumentLoaded();
    return copyToArrayBuffer(Y.encodeStateAsUpdate(this.document));
  }

  async includesStateVector(candidate: ArrayBuffer): Promise<boolean> {
    await this.ensureDocumentLoaded();
    return isStateVectorGe(
      Y.encodeStateVector(this.document),
      new Uint8Array(candidate),
    );
  }

  async currentStateVector(): Promise<ArrayBuffer> {
    await this.ensureDocumentLoaded();
    const result = await this.persistCurrentDocument();
    if (!result.success) {
      throw new Error("Vault state could not be persisted.");
    }
    return copyToArrayBuffer(this.requirePersistedStateVector());
  }

  async queueMaterialization(
    vaultId: string,
    requestId: string,
    now: number,
  ): Promise<VaultMaterializationJobResult> {
    const scheduled = this.materializationTail.then(() =>
      this.runQueuedMaterialization(vaultId, requestId, now),
    );
    this.materializationTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  override async onAlarm(): Promise<void> {
    const vaultId = this.ctx.id.name;
    if (vaultId === undefined) {
      throw new Error("Named vault Durable Object required.");
    }
    try {
      const result = await continueNextMaterializationJob(
        this.env.DB,
        this.env.VAULT_STORAGE,
        vaultId,
        Math.floor(Date.now() / 1_000),
      );
      if (result.hasMore) {
        await this.ctx.storage.setAlarm(
          Date.now() + MATERIALIZATION_CONTINUATION_DELAY_MS,
        );
        return;
      }

      const state = await this.readAutomaticMaterializationState(vaultId);
      if (
        state === null ||
        state.initial_sync_at === null ||
        state.current_state_vector_sha256 === null ||
        state.library_stale !== 1
      ) {
        await this.clearAutomaticMaterializationRetry();
        return;
      }
      if (
        state.generation_state_vector_sha256 ===
        state.current_state_vector_sha256
      ) {
        await this.markCurrentLibraryReady(
          vaultId,
          state.current_state_vector_sha256,
        );
        await this.clearAutomaticMaterializationRetry();
        return;
      }
      if (state.last_error_code !== null) {
        if (state.last_error_code === "materialization_unavailable") {
          if (await this.scheduleAutomaticMaterializationRetry(vaultId, true)) {
            return;
          }
        }
        return;
      }

      const materialization = await this.queueMaterialization(
        vaultId,
        crypto.randomUUID(),
        Math.floor(Date.now() / 1_000),
      );
      if (!materialization.ok) {
        if (
          materialization.code === "materialization_unavailable" &&
          (await this.scheduleAutomaticMaterializationRetry(vaultId, false))
        ) {
          return;
        }
        await this.recordAutomaticMaterializationFailure(
          vaultId,
          materialization.code,
        );
        return;
      }

      if (
        materialization.job.status === "completed" &&
        materialization.job.generation !== null
      ) {
        await this.markCurrentLibraryReady(
          vaultId,
          materialization.job.generation.sourceStateVectorSha256,
        );
        await this.clearAutomaticMaterializationRetry();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "UnknownError",
          event: "vault.materialization_alarm_failed",
          level: "error",
          vaultId,
        }),
      );
      await this.ctx.storage.setAlarm(
        Date.now() + AUTOMATIC_MATERIALIZATION_RETRY_BASE_MS,
      );
    }
  }

  async readMarkdownNote(
    vaultIdInput: unknown,
    pathInput: unknown,
  ): Promise<VaultLiveNoteResult> {
    const vaultId = vaultIdSchema.safeParse(vaultIdInput);
    if (!vaultId.success || typeof pathInput !== "string") {
      return { code: "vault_path_invalid", ok: false };
    }

    try {
      await this.prepareNamedVault(vaultId.data);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const stable = await this.captureStableLiveNote(pathInput);
        if (!(await this.isVaultActive(vaultId.data))) {
          return { code: "vault_not_active", ok: false };
        }
        if (
          !bytesEqual(stable.stateVector, Y.encodeStateVector(this.document))
        ) {
          continue;
        }
        return {
          note: {
            content: stable.note.content,
            contentVersion: stable.contentVersion,
            modifiedAt: stable.note.modifiedAt,
            path: stable.note.path,
          },
          ok: true,
        };
      }
      return { code: "vault_busy", ok: false };
    } catch (error) {
      return this.vaultContentFailure(error);
    }
  }

  async writeMarkdownNote(
    vaultIdInput: unknown,
    requestInput: unknown,
    nowInput: unknown,
  ): Promise<VaultMarkdownWriteResult> {
    const vaultId = vaultIdSchema.safeParse(vaultIdInput);
    const request = markdownNoteWriteRequestSchema.safeParse(requestInput);
    if (
      !vaultId.success ||
      !request.success ||
      typeof nowInput !== "number" ||
      !Number.isSafeInteger(nowInput) ||
      nowInput < 0
    ) {
      return { code: "vault_path_invalid", ok: false };
    }

    try {
      await this.prepareNamedVault(vaultId.data);
      if (this.readSchemaVersion() !== 3) {
        return { code: "snapshot_schema_unsupported", ok: false };
      }

      if (request.data.expectedVersion === null) {
        // Match the pinned YAOS client's 12-byte base64url file identity.
        const fileId = randomToken(12);
        const contentVersion = await this.markdownNoteVersion(
          fileId,
          request.data.path,
          request.data.content,
        );
        if (!(await this.isVaultActive(vaultId.data))) {
          return { code: "vault_not_active", ok: false };
        }
        if (this.readSchemaVersion() !== 3) {
          return { code: "snapshot_schema_unsupported", ok: false };
        }
        const mutation = applyMarkdownNoteWrite(
          this.document,
          request.data,
          null,
          nowInput,
          { contentVersion, fileId },
        );
        return this.persistMarkdownMutation(mutation);
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const stable = await this.captureStableLiveNote(request.data.path);
        const contentVersion = await this.markdownNoteVersion(
          stable.note.fileId,
          stable.note.path,
          request.data.content,
        );
        if (!(await this.isVaultActive(vaultId.data))) {
          return { code: "vault_not_active", ok: false };
        }
        if (
          !bytesEqual(stable.stateVector, Y.encodeStateVector(this.document))
        ) {
          continue;
        }
        if (stable.contentVersion !== request.data.expectedVersion) {
          return { code: "note_stale", ok: false };
        }
        const mutation = applyMarkdownNoteWrite(
          this.document,
          request.data,
          stable,
          nowInput,
          { contentVersion, fileId: stable.note.fileId },
        );
        return this.persistMarkdownMutation(mutation);
      }
      return { code: "vault_busy", ok: false };
    } catch (error) {
      if (
        error instanceof VaultContentError &&
        error.code === "note_not_found" &&
        request.success &&
        request.data.expectedVersion !== null
      ) {
        return { code: "note_stale", ok: false };
      }
      return this.vaultContentFailure(error);
    }
  }

  async restoreMarkdownNote(
    vaultIdInput: unknown,
    requestInput: unknown,
    nowInput: unknown,
  ): Promise<VaultRestoreWriteResult> {
    const vaultId = vaultIdSchema.safeParse(vaultIdInput);
    const request = restoreMarkdownNoteRequestSchema.safeParse(requestInput);
    if (
      !vaultId.success ||
      !request.success ||
      typeof nowInput !== "number" ||
      !Number.isSafeInteger(nowInput) ||
      nowInput < 0
    ) {
      return { code: "vault_path_invalid", ok: false };
    }

    try {
      await this.prepareNamedVault(vaultId.data);
      if (this.readSchemaVersion() !== 3) {
        return { code: "snapshot_schema_unsupported", ok: false };
      }
      if (
        (await sha256Hex(request.data.content)) !== request.data.contentSha256
      ) {
        return { code: "snapshot_invalid", ok: false };
      }
      const requestedPath = validateMarkdownVaultPath(request.data.path);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const stateVector = Y.encodeStateVector(this.document);
        const snapshot = extractMaterializedSnapshot(this.document);
        const note =
          snapshot.notes.find(
            (candidate) => candidate.pathKey === requestedPath.pathKey,
          ) ?? null;
        const currentContentSha256 =
          note === null ? null : await sha256Hex(note.content);
        if (
          currentContentSha256 !== request.data.contentSha256 &&
          currentContentSha256 !== request.data.expectedTargetContentSha256
        ) {
          return { code: "note_stale", ok: false };
        }
        const fileId = note?.fileId ?? randomToken(12);
        const contentVersion = await this.markdownNoteVersion(
          fileId,
          requestedPath.path,
          request.data.content,
        );
        if (!(await this.isVaultActive(vaultId.data))) {
          return { code: "vault_not_active", ok: false };
        }
        if (!bytesEqual(stateVector, Y.encodeStateVector(this.document))) {
          continue;
        }
        const mutation = applyMarkdownNoteRestore(
          this.document,
          request.data,
          note === null ? null : { note, snapshot },
          nowInput,
          { contentVersion, fileId },
        );
        const persisted = await this.persistCurrentDocument();
        if (!persisted.success) {
          return { code: "vault_persistence_unavailable", ok: false };
        }
        return { durable: true, ok: true, operation: mutation.operation };
      }
      return { code: "vault_busy", ok: false };
    } catch (error) {
      return this.vaultContentFailure(error);
    }
  }

  private async runQueuedMaterialization(
    vaultId: string,
    requestId: string,
    now: number,
  ): Promise<VaultMaterializationJobResult> {
    await this.setName(vaultId);
    await this.ensureDocumentLoaded();
    if (this.name !== vaultId) {
      return { code: "materialization_unavailable", ok: false };
    }
    const persistedSnapshot = await this.capturePersistedSnapshot();
    if (persistedSnapshot === null) {
      return { code: "materialization_unavailable", ok: false };
    }
    const { snapshotUpdate, stateVector } = persistedSnapshot;
    const snapshotDocument = new Y.Doc();
    try {
      Y.applyUpdate(snapshotDocument, snapshotUpdate);
      const snapshot = extractMaterializedSnapshot(snapshotDocument);
      const job = await createMaterializationJob(
        this.env.DB,
        this.env.VAULT_STORAGE,
        {
          now,
          requestId,
          snapshot,
          sourceStateVectorSha256: await sha256HexBytes(stateVector),
          vaultId,
        },
      );
      if (job.status === "queued" || job.status === "running") {
        await this.ctx.storage.setAlarm(
          Date.now() + MATERIALIZATION_CONTINUATION_DELAY_MS,
        );
      }
      return { job, ok: true };
    } catch (error) {
      if (
        error instanceof MaterializationSnapshotError ||
        error instanceof MaterializationPublishError
      ) {
        return { code: error.code, ok: false };
      }
      return { code: "materialization_unavailable", ok: false };
    } finally {
      snapshotDocument.destroy();
    }
  }

  async disconnectAll(): Promise<number> {
    let disconnected = 0;
    for (const connection of this.getConnections()) {
      connection.close(1008, "Vault credential revoked");
      disconnected += 1;
    }
    return disconnected;
  }

  private async prepareNamedVault(vaultId: string): Promise<void> {
    await this.setName(vaultId);
    await this.ensureDocumentLoaded();
    if (this.name !== vaultId) {
      throw new VaultContentError("vault_not_active");
    }
  }

  private async isVaultActive(vaultId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT id FROM vaults WHERE id = ? AND status = 'active'`,
    )
      .bind(vaultId)
      .first<{ id: string }>();
    return row?.id === vaultId;
  }

  private async captureStableLiveNote(path: string): Promise<StableLiveNote> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stateVector = Y.encodeStateVector(this.document);
      const current = readSnapshotNote(this.document, path);
      const contentVersion = await this.markdownNoteVersion(
        current.note.fileId,
        current.note.path,
        current.note.content,
      );
      if (bytesEqual(stateVector, Y.encodeStateVector(this.document))) {
        return { ...current, contentVersion, stateVector };
      }
    }
    throw new VaultContentError("vault_busy");
  }

  private markdownNoteVersion(
    fileId: string,
    path: string,
    content: string,
  ): Promise<string> {
    return sha256Hex(JSON.stringify([fileId, path, content]));
  }

  private async persistMarkdownMutation(
    mutation: ReturnType<typeof applyMarkdownNoteWrite>,
  ): Promise<VaultMarkdownWriteResult> {
    const persisted = await this.persistCurrentDocument();
    if (!persisted.success) {
      return { code: "vault_persistence_unavailable", ok: false };
    }
    return { ...mutation, durable: true, ok: true };
  }

  private vaultContentFailure(error: unknown): {
    code: VaultContentFailureCode;
    ok: false;
  } {
    if (error instanceof VaultContentError) {
      return { code: error.code, ok: false };
    }
    throw error;
  }

  private async ensureDocumentLoaded(): Promise<void> {
    if (this.documentLoaded) return;

    if (this.loadPromise === null) {
      this.loadPromise = this.loadDocument();
    }

    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  private async loadDocument(): Promise<void> {
    const state = await this.getStore().loadState();

    if (state.checkpoint !== null) {
      Y.applyUpdate(this.document, state.checkpoint);
    }
    for (const update of state.journalUpdates) {
      Y.applyUpdate(this.document, update);
    }

    const stateVector =
      state.checkpointStateVector !== null && state.journalUpdates.length === 0
        ? state.checkpointStateVector
        : Y.encodeStateVector(this.document);

    const persistence = this.getPersistence();
    persistence.setInitialStateVector(stateVector);
    persistence.health.journalEntryCount = state.journalStats.entryCount;
    persistence.health.journalBytes = state.journalStats.totalBytes;
    this.documentLoaded = true;
  }

  private async persistCurrentDocument(): Promise<SaveResult> {
    await this.ensureDocumentLoaded();
    const result = await this.getPersistence().enqueueSave();
    if (result.success) {
      await this.recordPersistedState();
    }
    return result;
  }

  private async recordPersistedState(): Promise<void> {
    const vaultId = this.ctx.id.name;
    if (vaultId === undefined) return;
    const now = Math.floor(Date.now() / 1_000);
    const stateVectorSha256 = await sha256HexBytes(
      this.requirePersistedStateVector(),
    );
    const previous = await this.env.DB.prepare(
      `SELECT current_state_vector_sha256
       FROM vault_sync_states
       WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ current_state_vector_sha256: string | null }>();
    const stateChanged =
      previous?.current_state_vector_sha256 !== stateVectorSha256;
    await this.env.DB.prepare(
      `INSERT INTO vault_sync_states (
        vault_id, current_state_vector_sha256, last_sync_at,
        library_stale, updated_at
      )
      SELECT id, ?, ?, 1, ?
      FROM vaults
      WHERE id = ? AND status = 'active'
      ON CONFLICT(vault_id) DO UPDATE SET
        current_state_vector_sha256 = excluded.current_state_vector_sha256,
        last_sync_at = CASE
          WHEN vault_sync_states.current_state_vector_sha256 IS NULL
            OR vault_sync_states.current_state_vector_sha256
              != excluded.current_state_vector_sha256
          THEN excluded.last_sync_at
          ELSE vault_sync_states.last_sync_at
        END,
        library_stale = CASE
          WHEN vault_sync_states.current_state_vector_sha256 IS NULL
            OR vault_sync_states.current_state_vector_sha256
              != excluded.current_state_vector_sha256
          THEN 1
          ELSE vault_sync_states.library_stale
        END,
        last_error_code = CASE
          WHEN vault_sync_states.current_state_vector_sha256 IS NULL
            OR vault_sync_states.current_state_vector_sha256
              != excluded.current_state_vector_sha256
          THEN NULL
          ELSE vault_sync_states.last_error_code
        END,
        last_error_at = CASE
          WHEN vault_sync_states.current_state_vector_sha256 IS NULL
            OR vault_sync_states.current_state_vector_sha256
              != excluded.current_state_vector_sha256
          THEN NULL
          ELSE vault_sync_states.last_error_at
        END,
        updated_at = CASE
          WHEN vault_sync_states.current_state_vector_sha256 IS NULL
            OR vault_sync_states.current_state_vector_sha256
              != excluded.current_state_vector_sha256
          THEN excluded.updated_at
          ELSE vault_sync_states.updated_at
        END`,
    )
      .bind(stateVectorSha256, now, now, vaultId)
      .run();
    if (stateChanged) {
      await this.clearAutomaticMaterializationRetry();
    }
    const state = await this.env.DB.prepare(
      `SELECT sync.initial_sync_at, sync.last_error_code, sync.library_stale
       FROM vault_sync_states sync
       JOIN vaults vault ON vault.id = sync.vault_id
       WHERE sync.vault_id = ? AND vault.status = 'active'`,
    )
      .bind(vaultId)
      .first<{
        initial_sync_at: number | null;
        last_error_code: string | null;
        library_stale: number;
      }>();
    if (
      state?.initial_sync_at !== null &&
      state?.initial_sync_at !== undefined &&
      state.library_stale === 1 &&
      state.last_error_code === null
    ) {
      await this.ctx.storage.setAlarm(
        Date.now() + AUTOMATIC_MATERIALIZATION_DEBOUNCE_MS,
      );
    }
  }

  private async readAutomaticMaterializationState(
    vaultId: string,
  ): Promise<AutomaticMaterializationState | null> {
    return this.env.DB.prepare(
      `SELECT sync.current_state_vector_sha256,
        generation.source_state_vector_sha256
          AS generation_state_vector_sha256,
        sync.initial_sync_at, sync.last_error_code, sync.library_stale
       FROM vaults vault
       JOIN vault_sync_states sync ON sync.vault_id = vault.id
       LEFT JOIN current_materializations current
         ON current.vault_id = vault.id
       LEFT JOIN materialization_generations generation
         ON generation.id = current.generation_id
           AND generation.status = 'published'
       WHERE vault.id = ? AND vault.status = 'active'`,
    )
      .bind(vaultId)
      .first<AutomaticMaterializationState>();
  }

  private async markCurrentLibraryReady(
    vaultId: string,
    stateVectorSha256: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE vault_sync_states
       SET library_stale = 0, last_error_code = NULL, last_error_at = NULL,
         updated_at = ?
       WHERE vault_id = ? AND current_state_vector_sha256 = ?
         AND EXISTS (
           SELECT 1
           FROM current_materializations current
           JOIN materialization_generations generation
             ON generation.id = current.generation_id
           WHERE current.vault_id = vault_sync_states.vault_id
             AND generation.status = 'published'
             AND generation.source_state_vector_sha256 = ?
         )`,
    )
      .bind(
        Math.floor(Date.now() / 1_000),
        vaultId,
        stateVectorSha256,
        stateVectorSha256,
      )
      .run();
  }

  private async recordAutomaticMaterializationFailure(
    vaultId: string,
    code: MaterializationFailureCode | "materialization_unavailable",
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    await this.env.DB.prepare(
      `UPDATE vault_sync_states
       SET library_stale = 1, last_error_code = ?, last_error_at = ?,
         updated_at = ?
       WHERE vault_id = ?`,
    )
      .bind(code, now, now, vaultId)
      .run();
  }

  private async scheduleAutomaticMaterializationRetry(
    vaultId: string,
    clearPersistedError: boolean,
  ): Promise<boolean> {
    const previous =
      (await this.ctx.storage.get<number>(
        AUTOMATIC_MATERIALIZATION_RETRY_STORAGE_KEY,
      )) ?? 0;
    const attempt = previous + 1;
    if (attempt >= AUTOMATIC_MATERIALIZATION_RETRY_LIMIT) {
      await this.clearAutomaticMaterializationRetry();
      if (!clearPersistedError) {
        await this.recordAutomaticMaterializationFailure(
          vaultId,
          "materialization_unavailable",
        );
      }
      return false;
    }
    await this.ctx.storage.put(
      AUTOMATIC_MATERIALIZATION_RETRY_STORAGE_KEY,
      attempt,
    );
    if (clearPersistedError) {
      await this.env.DB.prepare(
        `UPDATE vault_sync_states
         SET last_error_code = NULL, last_error_at = NULL, updated_at = ?
         WHERE vault_id = ? AND last_error_code = 'materialization_unavailable'`,
      )
        .bind(Math.floor(Date.now() / 1_000), vaultId)
        .run();
    }
    const delay = Math.min(
      AUTOMATIC_MATERIALIZATION_RETRY_BASE_MS * 2 ** (attempt - 1),
      AUTOMATIC_MATERIALIZATION_RETRY_MAX_MS,
    );
    await this.ctx.storage.setAlarm(Date.now() + delay);
    return true;
  }

  private async clearAutomaticMaterializationRetry(): Promise<void> {
    await this.ctx.storage.delete(AUTOMATIC_MATERIALIZATION_RETRY_STORAGE_KEY);
  }

  private async capturePersistedSnapshot(): Promise<{
    snapshotUpdate: Uint8Array;
    stateVector: Uint8Array;
  } | null> {
    // An incoming sync event can advance the in-memory document while a save
    // awaits storage. Retry until one synchronous read exactly matches the
    // persisted state vector; fail closed under sustained write pressure.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await this.persistCurrentDocument();
      if (!result.success) return null;

      const stateVector = Y.encodeStateVector(this.document);
      if (bytesEqual(stateVector, this.requirePersistedStateVector())) {
        return {
          snapshotUpdate: Y.encodeStateAsUpdate(this.document),
          stateVector,
        };
      }
    }
    return null;
  }

  private getStore(): ChunkedDocStore {
    this.store ??= new ChunkedDocStore(this.ctx.storage);
    return this.store;
  }

  private getPersistence(): PersistenceCoordinator {
    this.persistence ??= new PersistenceCoordinator(
      this.document,
      this.getStore(),
    );
    return this.persistence;
  }

  private requirePersistedStateVector(): Uint8Array {
    const stateVector = this.getPersistence().getLastPersistedStateVector();
    if (stateVector === null) {
      throw new Error("Vault persistence state is unavailable.");
    }
    return stateVector;
  }

  private readSchemaVersion(): number | null {
    const value = this.document.getMap("sys").get("schemaVersion");
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  }
}
