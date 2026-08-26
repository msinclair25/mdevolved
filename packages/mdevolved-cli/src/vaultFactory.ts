import "fake-indexeddb/auto";
import { VaultSync } from "../../obsidian-plugin/vendor/yaos-src/sync/vaultSync.js";
import type { VaultSyncSettings } from "../../obsidian-plugin/vendor/yaos-src/settings/settingsStore.js";
import type { PairingConnection } from "./pairing.js";
import type { VaultSyncLike } from "./runtime.js";
import * as Y from "yjs";
import { OWD_SYNC_COMPAT_VERSION } from "./pairing.js";

interface SocketTicket {
  value: string;
  expiresAt: number;
  localExpiresAt: number;
  ttlMs: number;
}

function socketTicketFetcher(connection: PairingConnection) {
  let cached: SocketTicket | undefined;
  return async (force = false): Promise<SocketTicket | null> => {
    if (!force && cached && cached.localExpiresAt - Date.now() > 30_000) {
      return cached;
    }
    const response = await fetch(
      `${connection.host.replace(/\/$/u, "")}/vault/${encodeURIComponent(connection.vaultId)}/auth/ticket`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}` },
      },
    );
    if ([404, 405, 501].includes(response.status)) return null;
    if (!response.ok) throw new Error(`socket_ticket_http_${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.ticket !== "string" ||
      body.ticket.length < 20 ||
      body.ticket.length > 512 ||
      typeof body.expiresAt !== "number" ||
      !Number.isFinite(body.expiresAt) ||
      typeof body.ttlMs !== "number" ||
      !Number.isFinite(body.ttlMs) ||
      body.ttlMs <= 0 ||
      body.ttlMs > 86_400_000
    ) {
      throw new Error("socket_ticket_response_invalid");
    }
    cached = {
      value: body.ticket,
      expiresAt: body.expiresAt,
      localExpiresAt: Date.now() + body.ttlMs,
      ttlMs: body.ttlMs,
    };
    return cached;
  };
}

export async function createPortableVaultSync(
  connection: PairingConnection,
): Promise<VaultSyncLike> {
  if (!connection.host || !connection.vaultId || !connection.token) {
    throw new Error("vault_connection_incomplete");
  }
  const settings: VaultSyncSettings = {
    host: connection.host,
    token: connection.token,
    vaultId: connection.vaultId,
    deviceName: connection.deviceId ?? "MDevolved folder",
    sourceDeviceId: connection.deviceId ?? "",
    sourceRootFingerprintSha256: connection.rootFingerprintSha256 ?? "",
    debug: false,
    frontmatterGuardEnabled: true,
    excludePatterns: "",
    maxFileSizeKB: 2_048,
    externalEditPolicy: "always",
    enableAttachmentSync: false,
    attachmentSyncExplicitlyConfigured: true,
    maxAttachmentSizeKB: 1,
    attachmentConcurrency: 1,
    showRemoteCursors: false,
    qaTraceEnabled: false,
    qaTraceMode: "safe",
    qaTraceSecret: "",
    updateRepoUrl: "",
    updateRepoBranch: "main",
    qaDebugMode: false,
  };
  const vault = new VaultSync(settings, {
    getSocketTicket: socketTicketFetcher(connection),
  });
  const localYjsPersistenceLoaded = await vault.waitForLocalPersistence();
  await vault.initializeServerAckTracking(settings, "mdevolved-cli-alpha.1", {
    localYjsPersistenceLoaded,
  });
  Object.defineProperty(vault, "getStateVector", {
    value: () => Y.encodeStateVector(vault.ydoc),
  });
  return vault;
}

export async function confirmSourcePublication(
  connection: PairingConnection,
  stateVector: Uint8Array | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (connection.deviceId === undefined || stateVector === null) return;
  const response = await fetchImpl(
    `${connection.host.replace(/\/$/u, "")}/api/vaults/${encodeURIComponent(connection.vaultId)}/sync-confirmation`,
    {
      body: JSON.stringify({
        pluginVersion: OWD_SYNC_COMPAT_VERSION,
        schemaVersion: 3,
        stateVector: Buffer.from(stateVector).toString("base64url"),
      }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`source_publication_http_${response.status}`);
  }
}
