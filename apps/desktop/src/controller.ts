import type { SyncController, SyncStatus } from "./ipc.js";
import { basename } from "node:path";
import { createSourceDescriptor, type CredentialRecord } from "@owd/yaos-core";
import { folderSourceIdentity } from "@owd/folder-adapter";
import {
  CLIENT_VERSION,
  createFetchPairingTransport,
  createPortableVaultSync,
  createSyncRuntime,
  pairFolder,
  parsePairingLink,
  type PairingConnection,
  type SyncRuntime,
} from "mdevolved";
import type { ProtectedCredentialCustody } from "./custody.js";

export function initialStatus(): SyncStatus {
  return {
    phase: "unconfigured",
    pendingChanges: 0,
    canRetry: false,
    canRepair: false,
    revoked: false,
  };
}

export class MemorySyncController implements SyncController {
  private status: SyncStatus = initialStatus();
  private readonly listeners = new Set<(status: SyncStatus) => void>();

  getStatus(): SyncStatus {
    return this.status;
  }

  async selectFolder(folderPath: string): Promise<SyncStatus> {
    this.set({
      phase: "connecting",
      folderPath,
      canRetry: false,
      canRepair: false,
      revoked: false,
    });
    this.set({
      phase: "syncing",
      folderPath,
      message: "Publishing current folder",
      canRetry: true,
      canRepair: true,
    });
    this.set({
      phase: "ready",
      folderPath,
      message: "Up to date",
      canRetry: false,
      canRepair: true,
    });
    return this.status;
  }

  async retry(): Promise<SyncStatus> {
    if (!this.status.canRetry || this.status.revoked) return this.status;
    this.set({
      phase: "syncing",
      message: "Retrying",
      canRetry: true,
    });
    this.set({ phase: "ready", message: "Up to date", canRetry: false });
    return this.status;
  }

  async repair(): Promise<SyncStatus> {
    if (!this.status.canRepair || this.status.revoked) return this.status;
    this.set({
      phase: "repairing",
      message: "Repairing local index",
      canRetry: true,
    });
    this.set({ phase: "ready", message: "Repaired", canRetry: false });
    return this.status;
  }

  async revoke(): Promise<SyncStatus> {
    this.set({
      phase: "revoked",
      message: "Disconnected",
      canRetry: false,
      canRepair: false,
      revoked: true,
    });
    return this.status;
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}

interface StoredDesktopConnection {
  sourceId: string;
  connection: PairingConnection;
}

function isSafeDeploymentOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || local) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function decodeConnection(
  value: string | undefined,
): StoredDesktopConnection | null {
  if (!value || value.length > 20_000) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredDesktopConnection>;
    const connection = parsed.connection;
    if (
      typeof parsed.sourceId !== "string" ||
      !/^folder-[0-9a-f]{32}$/u.test(parsed.sourceId) ||
      !connection ||
      typeof connection.host !== "string" ||
      !isSafeDeploymentOrigin(connection.host) ||
      typeof connection.token !== "string" ||
      !/^[A-Za-z0-9_-]{20,256}$/u.test(connection.token) ||
      typeof connection.vaultId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        connection.vaultId,
      ) ||
      typeof connection.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(connection.fingerprint) ||
      typeof connection.issuedAt !== "number" ||
      !Number.isFinite(connection.issuedAt) ||
      connection.issuedAt < 0 ||
      (connection.expiresAt !== undefined &&
        (typeof connection.expiresAt !== "number" ||
          !Number.isFinite(connection.expiresAt) ||
          connection.expiresAt < connection.issuedAt))
    )
      return null;
    return { sourceId: parsed.sourceId, connection };
  } catch {
    return null;
  }
}

export class FolderSyncController implements SyncController {
  private status: SyncStatus = initialStatus();
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private runtime: SyncRuntime | undefined;
  private folderPath: string | undefined;
  private pendingPairingLink: string | undefined;

  constructor(
    private readonly custody: () => ProtectedCredentialCustody | undefined,
  ) {}

  getStatus(): SyncStatus {
    return this.status;
  }

  async selectFolder(folderPath: string): Promise<SyncStatus> {
    await this.runtime?.stop();
    this.runtime = undefined;
    this.folderPath = folderPath;
    const sourceId = await folderSourceIdentity(folderPath);
    if (this.pendingPairingLink) {
      const pending = this.pendingPairingLink;
      this.pendingPairingLink = undefined;
      try {
        return await this.pair(pending);
      } catch {
        return this.set({
          phase: "error",
          folderPath,
          message:
            "Pairing failed. Create a fresh private request and try again.",
          canRetry: false,
          canRepair: false,
        });
      }
    }
    const stored = decodeConnection(await this.custody()?.load());
    if (!stored || stored.sourceId !== sourceId) {
      return this.set({
        phase: "unconfigured",
        folderPath,
        message:
          "Folder selected. Create a private pairing request in your MDevolved dashboard.",
        canRetry: false,
        canRepair: false,
        revoked: false,
      });
    }
    return await this.start(stored);
  }

  async pair(pairingLink: string): Promise<SyncStatus> {
    if (!this.folderPath) {
      parsePairingLink(pairingLink);
      this.pendingPairingLink = pairingLink;
      return this.set({
        phase: "unconfigured",
        message: "Pairing request received. Choose the folder to connect.",
        canRetry: false,
        canRepair: false,
      });
    }
    const sourceId = await folderSourceIdentity(this.folderPath);
    const descriptor = createSourceDescriptor({
      sourceKind: "folder",
      label: basename(this.folderPath),
      capabilities: ["markdown", "watch"],
      clientVersion: CLIENT_VERSION,
      syncSchemaVersion: 1,
      provenance: { pairedAt: Date.now() },
    });
    const connection = await pairFolder(
      parsePairingLink(pairingLink),
      descriptor,
      basename(this.folderPath),
      CLIENT_VERSION,
      createFetchPairingTransport(),
    );
    await this.custody()?.save(JSON.stringify({ sourceId, connection }));
    return await this.start({ sourceId, connection });
  }

  async retry(): Promise<SyncStatus> {
    if (!this.runtime) return this.status;
    try {
      await this.runtime.syncOnce();
      if (!(await this.runtime.remote.confirmDurable())) {
        throw new Error("remote_receipt_unconfirmed");
      }
      return this.set({
        phase: "ready",
        message: "Up to date",
        canRetry: false,
      });
    } catch {
      return this.set({
        phase: "offline",
        message: "Offline; changes remain local",
        canRetry: true,
      });
    }
  }

  async repair(): Promise<SyncStatus> {
    return await this.retry();
  }

  async revoke(): Promise<SyncStatus> {
    await this.runtime?.source.core.revoke();
    await this.runtime?.stop();
    this.runtime = undefined;
    return this.set({
      phase: "revoked",
      message: "Disconnected",
      canRetry: false,
      canRepair: false,
      revoked: true,
    });
  }

  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async start(stored: StoredDesktopConnection): Promise<SyncStatus> {
    if (!this.folderPath) return this.status;
    const record: CredentialRecord = {
      sourceId: stored.sourceId,
      fingerprint: stored.connection.fingerprint,
      status: "active",
      issuedAt: stored.connection.issuedAt,
      ...(stored.connection.expiresAt === undefined
        ? {}
        : { expiresAt: stored.connection.expiresAt }),
    };
    const credentials = {
      get: async () => record,
      confirmReplacement: async (next: CredentialRecord) => {
        if (next.sourceId !== stored.sourceId)
          throw new Error("credential_scope_mismatch");
      },
      revoke: async () => undefined,
    };
    this.set({
      phase: "connecting",
      message: "Connecting",
      canRetry: true,
      revoked: false,
    });
    this.runtime = await createSyncRuntime({
      sourceRoot: this.folderPath,
      custody: credentials,
      vault: await createPortableVaultSync(stored.connection),
      clientVersion: CLIENT_VERSION,
      onStatus: (phase) => {
        if (phase === "offline")
          this.set({
            phase: "offline",
            message: "Offline; changes remain local",
            canRetry: true,
          });
      },
    });
    const startStatus = await this.runtime.start();
    if (startStatus === "offline") {
      return this.set({
        phase: "offline",
        message: "Offline; changes remain local",
        canRetry: true,
        canRepair: true,
      });
    }
    return this.set({
      phase: "ready",
      message: "Up to date",
      canRetry: false,
      canRepair: true,
      lastSyncedAt: new Date().toISOString(),
    });
  }

  private set(patch: Partial<SyncStatus>): SyncStatus {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
    return this.status;
  }
}
