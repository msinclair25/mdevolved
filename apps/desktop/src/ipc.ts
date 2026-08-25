export const IPC_CHANNELS = {
  selectFolder: "mdevolved:select-folder",
  getStatus: "mdevolved:get-status",
  retry: "mdevolved:retry",
  repair: "mdevolved:repair",
  revoke: "mdevolved:revoke",
  setStartAtLogin: "mdevolved:set-start-at-login",
  statusChanged: "mdevolved:status-changed",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type SyncPhase =
  | "unconfigured"
  | "connecting"
  | "syncing"
  | "ready"
  | "offline"
  | "conflict"
  | "repairing"
  | "revoked"
  | "error";

export interface SyncStatus {
  phase: SyncPhase;
  folderPath?: string;
  message?: string;
  pendingChanges: number;
  lastSyncedAt?: string;
  canRetry: boolean;
  canRepair: boolean;
  revoked: boolean;
}

export interface SyncController {
  getStatus(): SyncStatus;
  selectFolder(folderPath: string): Promise<SyncStatus>;
  retry(): Promise<SyncStatus>;
  repair(): Promise<SyncStatus>;
  revoke(): Promise<SyncStatus>;
  pair?(pairingLink: string): Promise<SyncStatus>;
  onStatusChange?(listener: (status: SyncStatus) => void): () => void;
}

export interface DesktopApi {
  selectFolder(): Promise<SyncStatus>;
  getStatus(): Promise<SyncStatus>;
  retry(): Promise<SyncStatus>;
  repair(): Promise<SyncStatus>;
  revoke(): Promise<SyncStatus>;
  setStartAtLogin(enabled: boolean): Promise<{ enabled: boolean }>;
  onStatusChange(listener: (status: SyncStatus) => void): () => void;
}

const phases = new Set<SyncPhase>([
  "unconfigured",
  "connecting",
  "syncing",
  "ready",
  "offline",
  "conflict",
  "repairing",
  "revoked",
  "error",
]);

export function isSyncStatus(value: unknown): value is SyncStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    phases.has(candidate.phase as SyncPhase) &&
    (candidate.folderPath === undefined ||
      typeof candidate.folderPath === "string") &&
    (candidate.message === undefined ||
      typeof candidate.message === "string") &&
    Number.isSafeInteger(candidate.pendingChanges) &&
    (candidate.lastSyncedAt === undefined ||
      typeof candidate.lastSyncedAt === "string") &&
    typeof candidate.canRetry === "boolean" &&
    typeof candidate.canRepair === "boolean" &&
    typeof candidate.revoked === "boolean"
  );
}

export function assertBooleanArg(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new TypeError("boolean argument required");
  return value;
}

export function assertTrustedSender(
  url: string,
  expectedFileUrl: string,
): void {
  if (url !== expectedFileUrl) throw new Error("untrusted IPC sender");
}

export function assertSafeNavigation(
  url: string,
  expectedFileUrl: string,
): void {
  if (url !== expectedFileUrl) throw new Error("navigation denied");
}

export function assertFolderPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new TypeError("folder path required");
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new TypeError("invalid folder path");
  }
  return value;
}

export function selectedFolder(result: {
  canceled: boolean;
  filePaths: readonly string[];
}): string | undefined {
  if (result.canceled || result.filePaths.length !== 1) return undefined;
  return assertFolderPath(result.filePaths[0]);
}

export function assertStatus(value: unknown): SyncStatus {
  if (!isSyncStatus(value)) throw new TypeError("invalid sync status");
  return value;
}
