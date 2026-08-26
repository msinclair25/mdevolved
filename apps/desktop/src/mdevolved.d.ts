declare module "mdevolved" {
  import type {
    CredentialCustodyPort,
    FolderReconciliationResult,
    MarkdownRemotePort,
    SourceDescriptor,
  } from "@owd/yaos-core";

  export const CLIENT_VERSION = "mdevolved-cli-alpha.1";

  export interface PairingParameters {
    deploymentUrl: string;
    grant: string;
  }

  export interface PairingConnection {
    host: string;
    token: string;
    vaultId: string;
    fingerprint: string;
    issuedAt: number;
    expiresAt?: number;
  }

  export interface PairingTransport {
    exchange(request: {
      deploymentUrl: string;
      grant: string;
      sourceDescriptor: SourceDescriptor;
      sourceName: string;
      clientVersion: string;
    }): Promise<unknown>;
  }

  export interface VaultSyncLike {
    getActiveMarkdownPaths(): readonly string[];
    getTextForPath(path: string): unknown;
  }

  export type SyncRuntimeStatus =
    "starting" | "running" | "syncing" | "offline" | "error" | "stopped";

  export interface SyncRuntime {
    readonly source: {
      readonly core: {
        revoke(): Promise<void>;
      };
    };
    readonly remote: MarkdownRemotePort;
    start(): Promise<SyncRuntimeStatus>;
    syncOnce(): Promise<FolderReconciliationResult>;
    stop(): Promise<void>;
  }

  export function parsePairingLink(value: string): PairingParameters;
  export function createFetchPairingTransport(
    fetchImpl?: typeof fetch,
  ): PairingTransport;
  export function pairFolder(
    pairing: PairingParameters,
    sourceDescriptor: SourceDescriptor,
    sourceName: string,
    clientVersion: string,
    transport: PairingTransport,
  ): Promise<PairingConnection>;
  export function createPortableVaultSync(
    connection: PairingConnection,
  ): Promise<VaultSyncLike>;
  export function createSyncRuntime(options: {
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
  }): Promise<SyncRuntime>;
}
