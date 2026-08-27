import {
  createFolderSource,
  type FolderSource,
} from "@mdevolved/folder-adapter";
import {
  reconcileFolder,
  type FolderReconciliationResult,
  type MarkdownRemotePort,
} from "@mdevolved/yaos-core";
import type { CredentialCustodyPort } from "@mdevolved/yaos-core";

export interface SyncText {
  toString(): string;
  delete(index: number, length: number): void;
  insert(index: number, value: string): void;
  transact?(fn: () => void): void;
}

/** Structural adapter keeps the CRDT engine injectable and provider-neutral. */
export interface VaultSyncLike {
  getActiveMarkdownPaths(): readonly string[];
  getTextForPath(path: string): SyncText | null;
  ensureFile(path: string, contents: string, device?: string): SyncText | null;
  markInitialized?(): void;
  writeMarkdownText?(path: string, contents: string, device?: string): boolean;
  isMarkdownTombstoned?(path: string): boolean;
  waitForLocalPersistence?(): Promise<boolean>;
  waitForProviderSync?(): Promise<boolean>;
  initializeServerAckTracking?(
    settings: unknown,
    clientVersion: string,
    options: { localYjsPersistenceLoaded: boolean },
  ): Promise<void>;
  readonly connected?: boolean;
  readonly providerSynced?: boolean;
  readonly serverAppliedLocalState?: boolean | null;
  destroy?(): Promise<void> | void;
  getStateVector?(): Uint8Array;
}

export interface VaultSyncRuntimeOptions {
  sourceRoot: string;
  custody: CredentialCustodyPort;
  vault: VaultSyncLike;
  stateDirectory?: string;
  clientVersion?: string;
  syncSchemaVersion?: number;
  deviceName?: string;
  now?: () => number;
  maxFileBytes?: number;
  watch?: boolean;
  onStatus?: (status: SyncRuntimeStatus) => void;
}

export type SyncRuntimeStatus =
  "starting" | "running" | "syncing" | "offline" | "error" | "stopped";

export interface SyncRuntime {
  readonly source: FolderSource;
  readonly remote: MarkdownRemotePort;
  start(): Promise<SyncRuntimeStatus>;
  getStateVector(): Uint8Array | null;
  syncOnce(): Promise<FolderReconciliationResult>;
  stop(): Promise<void>;
}

function textContents(text: SyncText): string {
  return text.toString();
}

function replaceText(text: SyncText, contents: string): void {
  const replace = () => {
    const current = text.toString();
    if (current.length > 0) text.delete(0, current.length);
    if (contents.length > 0) text.insert(0, contents);
  };
  if (text.transact) text.transact(replace);
  else replace();
}

export function createVaultSyncRemote(
  vault: VaultSyncLike,
  deviceName?: string,
): MarkdownRemotePort {
  return {
    listPaths: () => [...vault.getActiveMarkdownPaths()],
    read: (path) => {
      const text = vault.getTextForPath(path);
      return text === null ? null : textContents(text);
    },
    write: (path, contents) => {
      if (vault.writeMarkdownText) {
        if (!vault.writeMarkdownText(path, contents, deviceName)) {
          throw new Error(`remote_write_rejected:${path}`);
        }
        return;
      }
      const text =
        vault.getTextForPath(path) ??
        vault.ensureFile(path, contents, deviceName);
      if (text === null) throw new Error(`remote_write_rejected:${path}`);
      if (textContents(text) !== contents) replaceText(text, contents);
    },
    isTombstoned: (path) => vault.isMarkdownTombstoned?.(path) ?? false,
    confirmDurable: async () => {
      const isApplied = (): boolean =>
        Reflect.get(vault, "serverAppliedLocalState") === true;
      if (isApplied()) return true;
      if (vault.connected === false || vault.providerSynced === false)
        return false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (isApplied()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return isApplied();
    },
  };
}

export async function createSyncRuntime(
  options: VaultSyncRuntimeOptions,
): Promise<SyncRuntime> {
  const source = await createFolderSource({
    root: options.sourceRoot,
    credentials: options.custody,
    ...(options.stateDirectory === undefined
      ? {}
      : { stateDirectory: options.stateDirectory }),
    clientVersion: options.clientVersion,
    syncSchemaVersion: options.syncSchemaVersion,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const remote = createVaultSyncRemote(options.vault, options.deviceName);
  let unwatch: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;
  const emit = (status: SyncRuntimeStatus) => options.onStatus?.(status);
  const installWatcher = (): void => {
    if (options.watch === false || unwatch !== undefined) return;
    unwatch = source.watch(() => {
      if (pending !== undefined) return;
      pending = runtime
        .syncOnce()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          pending = undefined;
        });
    });
  };
  const runtime: SyncRuntime = {
    source,
    remote,
    getStateVector(): Uint8Array | null {
      return options.vault.getStateVector?.() ?? null;
    },
    async start(): Promise<SyncRuntimeStatus> {
      if (stopped) throw new Error("sync_runtime_stopped");
      emit("starting");
      const status = await source.core.start();
      if (status !== "running") {
        emit(
          status === "expired" || status === "revoked" ? "error" : "offline",
        );
        return "offline";
      }
      if (options.vault.waitForLocalPersistence)
        await options.vault.waitForLocalPersistence();
      const providerReady = options.vault.waitForProviderSync
        ? await options.vault.waitForProviderSync()
        : options.vault.connected !== false &&
          options.vault.providerSynced !== false;
      try {
        await runtime.syncOnce();
      } catch (error) {
        installWatcher();
        if (
          error instanceof Error &&
          error.message === "remote_receipt_unconfirmed"
        ) {
          emit("offline");
          return "offline";
        }
        throw error;
      }
      installWatcher();
      if (!providerReady) {
        emit("offline");
        return "offline";
      }
      emit("running");
      return "running";
    },
    async syncOnce(): Promise<FolderReconciliationResult> {
      if (stopped) throw new Error("sync_runtime_stopped");
      emit("syncing");
      try {
        options.vault.markInitialized?.();
        const result = await reconcileFolder(
          source.core,
          source.state,
          remote,
          {
            maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
            ...(options.now === undefined ? {} : { now: options.now }),
          },
        );
        emit("running");
        return result;
      } catch (error) {
        emit(
          error instanceof Error &&
            error.message === "remote_receipt_unconfirmed"
            ? "offline"
            : "error",
        );
        throw error;
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unwatch?.();
      await source.close();
      await options.vault.destroy?.();
      emit("stopped");
    },
  };
  return runtime;
}
