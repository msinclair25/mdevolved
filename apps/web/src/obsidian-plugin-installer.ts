import { OWD_SYNC_REQUIRED_VERSION } from "./obsidian-plugin-links";

export const OWD_SYNC_INSTALLER_FORMAT = "owd-sync-web-installer-v1";
export const OWD_SYNC_PLUGIN_ID = "owd-sync";
export const OWD_SYNC_INSTALLER_BASE_PATH = `/owd-sync/${OWD_SYNC_REQUIRED_VERSION}`;
export const OWD_SYNC_INSTALLER_MANIFEST_URL = `${OWD_SYNC_INSTALLER_BASE_PATH}/installer-manifest.json`;

const PLUGIN_ASSET_NAMES = ["main.js", "manifest.json", "styles.css"] as const;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_EXISTING_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ENABLED_PLUGIN_FILE_BYTES = 256 * 1024;

type PluginAssetName = (typeof PLUGIN_ASSET_NAMES)[number];

type InstallerAsset = {
  bytes: number;
  name: PluginAssetName;
  sha256: string;
};

type InstallerManifest = {
  assets: InstallerAsset[];
  format: typeof OWD_SYNC_INSTALLER_FORMAT;
  pluginId: typeof OWD_SYNC_PLUGIN_ID;
  version: string;
};

export type OwdSyncReadableFile = {
  readonly size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type OwdSyncWritableFile = {
  abort: (reason?: unknown) => Promise<void>;
  close: () => Promise<void>;
  write: (data: ArrayBuffer) => Promise<void>;
};

export type OwdSyncFileHandle = {
  readonly kind: "file";
  readonly name: string;
  createWritable: (options?: {
    keepExistingData?: boolean;
  }) => Promise<OwdSyncWritableFile>;
  getFile: () => Promise<OwdSyncReadableFile>;
};

export type OwdSyncDirectoryHandle = {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<OwdSyncDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<OwdSyncFileHandle>;
  removeEntry: (
    name: string,
    options?: { recursive?: boolean },
  ) => Promise<void>;
};

type FileBackup = {
  bytes: Uint8Array | null;
  directory: OwdSyncDirectoryHandle;
  name: string;
};

export type OwdSyncInstallResult = {
  enabledPluginCount: number;
  vaultName: string;
  version: string;
};

export type OwdSyncInstallProgress = {
  kind: "vault-selected";
  vaultName: string;
};

export type OwdSyncInstallerDependencies = {
  fetch: typeof fetch;
  sha256: (value: Uint8Array) => Promise<string>;
};

export class OwdSyncInstallerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwdSyncInstallerError";
    this.code = code;
  }
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
      startIn?: "documents";
    }) => Promise<OwdSyncDirectoryHandle>;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginAssetName(value: unknown): value is PluginAssetName {
  return (
    typeof value === "string" &&
    PLUGIN_ASSET_NAMES.some((name) => name === value)
  );
}

function parseInstallerManifest(value: unknown): InstallerManifest {
  if (
    !isRecord(value) ||
    value.format !== OWD_SYNC_INSTALLER_FORMAT ||
    value.pluginId !== OWD_SYNC_PLUGIN_ID ||
    value.version !== OWD_SYNC_REQUIRED_VERSION ||
    !Array.isArray(value.assets) ||
    value.assets.length !== PLUGIN_ASSET_NAMES.length
  ) {
    throw new OwdSyncInstallerError(
      "invalid_installer_manifest",
      "The MDevolved Sync for Obsidian installer manifest is invalid or version-mismatched.",
    );
  }

  const assets: InstallerAsset[] = [];
  const seen = new Set<PluginAssetName>();
  let totalBytes = 0;
  for (const candidate of value.assets) {
    if (
      !isRecord(candidate) ||
      !isPluginAssetName(candidate.name) ||
      seen.has(candidate.name) ||
      typeof candidate.bytes !== "number" ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes <= 0 ||
      candidate.bytes > MAX_ASSET_BYTES ||
      typeof candidate.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(candidate.sha256)
    ) {
      throw new OwdSyncInstallerError(
        "invalid_installer_manifest",
        "The MDevolved Sync for Obsidian installer manifest contains an invalid asset.",
      );
    }

    seen.add(candidate.name);
    totalBytes += candidate.bytes;
    assets.push({
      bytes: candidate.bytes,
      name: candidate.name,
      sha256: candidate.sha256,
    });
  }

  if (
    totalBytes > MAX_TOTAL_ASSET_BYTES ||
    PLUGIN_ASSET_NAMES.some((name) => !seen.has(name))
  ) {
    throw new OwdSyncInstallerError(
      "invalid_installer_manifest",
      "The MDevolved Sync for Obsidian installer asset set is incomplete or too large.",
    );
  }

  return {
    assets,
    format: OWD_SYNC_INSTALLER_FORMAT,
    pluginId: OWD_SYNC_PLUGIN_ID,
    version: OWD_SYNC_REQUIRED_VERSION,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "NotFoundError") ||
    (isRecord(error) && error.name === "NotFoundError")
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError")
  );
}

function errorName(error: unknown): string | null {
  if (error instanceof DOMException) {
    return error.name;
  }
  return isRecord(error) && typeof error.name === "string" ? error.name : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function defaultSha256(value: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
    ),
  );
}

const defaultDependencies: OwdSyncInstallerDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  sha256: defaultSha256,
};

async function fetchJson(
  url: string,
  dependencies: OwdSyncInstallerDependencies,
): Promise<unknown> {
  const response = await dependencies.fetch(url, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new OwdSyncInstallerError(
      "installer_asset_unavailable",
      "The pinned MDevolved Sync for Obsidian installer files are unavailable from this workspace.",
    );
  }
  return response.json();
}

async function loadVerifiedAssets(
  dependencies: OwdSyncInstallerDependencies,
): Promise<Map<PluginAssetName, Uint8Array>> {
  const manifest = parseInstallerManifest(
    await fetchJson(OWD_SYNC_INSTALLER_MANIFEST_URL, dependencies),
  );
  const assets = new Map<PluginAssetName, Uint8Array>();

  await Promise.all(
    manifest.assets.map(async (asset) => {
      const response = await dependencies.fetch(
        `${OWD_SYNC_INSTALLER_BASE_PATH}/${asset.name}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/octet-stream" },
        },
      );
      if (!response.ok) {
        throw new OwdSyncInstallerError(
          "installer_asset_unavailable",
          `The pinned OWD Sync ${asset.name} file is unavailable.`,
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength !== asset.bytes ||
        (await dependencies.sha256(bytes)) !== asset.sha256
      ) {
        throw new OwdSyncInstallerError(
          "installer_asset_mismatch",
          `The pinned OWD Sync ${asset.name} file failed integrity verification.`,
        );
      }
      assets.set(asset.name, bytes);
    }),
  );

  const pluginManifestBytes = assets.get("manifest.json");
  if (pluginManifestBytes === undefined) {
    throw new OwdSyncInstallerError(
      "installer_asset_mismatch",
      "The pinned MDevolved Sync for Obsidian plugin manifest is missing.",
    );
  }

  let pluginManifest: unknown;
  try {
    pluginManifest = JSON.parse(new TextDecoder().decode(pluginManifestBytes));
  } catch (error) {
    throw new OwdSyncInstallerError(
      "installer_asset_mismatch",
      "The pinned MDevolved Sync for Obsidian plugin manifest is not valid JSON.",
      { cause: error },
    );
  }
  if (
    !isRecord(pluginManifest) ||
    pluginManifest.id !== OWD_SYNC_PLUGIN_ID ||
    pluginManifest.version !== OWD_SYNC_REQUIRED_VERSION
  ) {
    throw new OwdSyncInstallerError(
      "installer_asset_mismatch",
      "The pinned MDevolved Sync for Obsidian plugin identity or version does not match this workspace.",
    );
  }

  return assets;
}

async function getExistingDirectory(
  parent: OwdSyncDirectoryHandle,
  name: string,
): Promise<OwdSyncDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readExistingFile(
  directory: OwdSyncDirectoryHandle,
  name: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  let handle: OwdSyncFileHandle;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  const file = await handle.getFile();
  if (file.size > maxBytes) {
    throw new OwdSyncInstallerError(
      "existing_file_too_large",
      `The existing ${name} file is too large to back up safely.`,
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFile(
  directory: OwdSyncDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(Uint8Array.from(bytes).buffer);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function restoreBackup(backup: FileBackup): Promise<void> {
  if (backup.bytes === null) {
    try {
      await backup.directory.removeEntry(backup.name);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
    return;
  }
  await writeFile(backup.directory, backup.name, backup.bytes);
}

function parseEnabledPlugins(bytes: Uint8Array | null): string[] {
  if (bytes === null) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new OwdSyncInstallerError(
      "invalid_enabled_plugins",
      "This vault's community-plugins.json is not valid JSON.",
      { cause: error },
    );
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new OwdSyncInstallerError(
      "invalid_enabled_plugins",
      "This vault's community-plugins.json is not a list of plugin IDs.",
    );
  }
  return [...new Set(value)];
}

function encodeEnabledPlugins(pluginIds: string[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(pluginIds, null, 2)}\n`);
}

async function rollback(
  backups: FileBackup[],
  obsidianDirectory: OwdSyncDirectoryHandle,
  removePluginDirectory: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  for (const backup of [...backups].reverse()) {
    try {
      await restoreBackup(backup);
    } catch (error) {
      errors.push(error);
    }
  }

  if (removePluginDirectory) {
    const pluginsDirectory = await getExistingDirectory(
      obsidianDirectory,
      "plugins",
    ).catch((error: unknown) => {
      errors.push(error);
      return null;
    });
    if (pluginsDirectory !== null) {
      try {
        await pluginsDirectory.removeEntry(OWD_SYNC_PLUGIN_ID, {
          recursive: true,
        });
      } catch (error) {
        if (!isNotFoundError(error)) {
          errors.push(error);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new OwdSyncInstallerError(
      "rollback_incomplete",
      "Installation failed and MDevolved could not fully restore the prior plugin files. Keep Obsidian closed and inspect .obsidian/plugins/owd-sync before retrying.",
      { cause: errors[0] },
    );
  }
}

export function browserSupportsOwdSyncInstall(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.showDirectoryPicker === "function"
  );
}

export function isOwdSyncInstallCancellation(error: unknown): boolean {
  return isAbortError(error);
}

export function normalizeOwdSyncInstallerError(
  error: unknown,
): OwdSyncInstallerError {
  if (error instanceof OwdSyncInstallerError) {
    return error;
  }

  switch (errorName(error)) {
    case "NotAllowedError":
      return new OwdSyncInstallerError(
        "folder_permission_denied",
        "Chrome did not receive permission to change that vault. Choose Try again, select the vault root, and choose Allow when Chrome asks for access.",
        { cause: error },
      );
    case "SecurityError":
      return new OwdSyncInstallerError(
        "folder_picker_blocked",
        "Chrome blocked the folder picker. Keep this secure MDevolved tab active, choose Try again, and allow the folder prompt. If it is still blocked, use the BRAT fallback below.",
        { cause: error },
      );
    case "NotReadableError":
    case "NoModificationAllowedError":
      return new OwdSyncInstallerError(
        "vault_not_writable",
        "Chrome could not update that vault. Fully quit Obsidian with ⌘Q, confirm the vault is writable in Finder, then choose Try again.",
        { cause: error },
      );
    default:
      return new OwdSyncInstallerError(
        "install_failed",
        "MDevolved Sync for Obsidian could not be installed. Your existing vault files were left unchanged. Try again or use the BRAT fallback below.",
        { cause: error },
      );
  }
}

export async function chooseVaultAndInstallOwdSync(
  dependencies: OwdSyncInstallerDependencies = defaultDependencies,
  onProgress?: (progress: OwdSyncInstallProgress) => void,
): Promise<OwdSyncInstallResult> {
  if (
    !browserSupportsOwdSyncInstall() ||
    window.showDirectoryPicker === undefined
  ) {
    throw new OwdSyncInstallerError(
      "unsupported_browser",
      "One-click installation needs current Chrome or Edge in a secure browser window.",
    );
  }

  const vaultDirectory = await window.showDirectoryPicker({
    id: "owd-sync-vault",
    mode: "readwrite",
    startIn: "documents",
  });
  onProgress?.({ kind: "vault-selected", vaultName: vaultDirectory.name });
  return installOwdSyncIntoVault(vaultDirectory, dependencies);
}

export async function installOwdSyncIntoVault(
  vaultDirectory: OwdSyncDirectoryHandle,
  dependencies: OwdSyncInstallerDependencies = defaultDependencies,
): Promise<OwdSyncInstallResult> {
  const obsidianDirectory = await getExistingDirectory(
    vaultDirectory,
    ".obsidian",
  );
  if (obsidianDirectory === null) {
    throw new OwdSyncInstallerError(
      "not_an_obsidian_vault",
      "That folder is not an Obsidian vault. Choose the vault root containing .obsidian.",
    );
  }

  const assets = await loadVerifiedAssets(dependencies);
  let pluginsDirectory = await getExistingDirectory(
    obsidianDirectory,
    "plugins",
  );
  if (pluginsDirectory === null) {
    pluginsDirectory = await obsidianDirectory.getDirectoryHandle("plugins", {
      create: true,
    });
  }

  let pluginDirectory = await getExistingDirectory(
    pluginsDirectory,
    OWD_SYNC_PLUGIN_ID,
  );
  const removePluginDirectory = pluginDirectory === null;
  if (pluginDirectory === null) {
    pluginDirectory = await pluginsDirectory.getDirectoryHandle(
      OWD_SYNC_PLUGIN_ID,
      { create: true },
    );
  }

  const backups: FileBackup[] = [];
  try {
    for (const name of PLUGIN_ASSET_NAMES) {
      backups.push({
        bytes: await readExistingFile(
          pluginDirectory,
          name,
          MAX_EXISTING_FILE_BYTES,
        ),
        directory: pluginDirectory,
        name,
      });
    }
    const enabledPluginsBackup = await readExistingFile(
      obsidianDirectory,
      "community-plugins.json",
      MAX_ENABLED_PLUGIN_FILE_BYTES,
    );
    backups.push({
      bytes: enabledPluginsBackup,
      directory: obsidianDirectory,
      name: "community-plugins.json",
    });
    const enabledPlugins = parseEnabledPlugins(enabledPluginsBackup);
    if (!enabledPlugins.includes(OWD_SYNC_PLUGIN_ID)) {
      enabledPlugins.push(OWD_SYNC_PLUGIN_ID);
    }

    for (const name of PLUGIN_ASSET_NAMES) {
      const bytes = assets.get(name);
      if (bytes === undefined) {
        throw new OwdSyncInstallerError(
          "installer_asset_mismatch",
          `The verified OWD Sync ${name} file is missing.`,
        );
      }
      await writeFile(pluginDirectory, name, bytes);
    }
    await writeFile(
      obsidianDirectory,
      "community-plugins.json",
      encodeEnabledPlugins(enabledPlugins),
    );

    return {
      enabledPluginCount: enabledPlugins.length,
      vaultName: vaultDirectory.name,
      version: OWD_SYNC_REQUIRED_VERSION,
    };
  } catch (error) {
    await rollback(backups, obsidianDirectory, removePluginDirectory);
    throw normalizeOwdSyncInstallerError(error);
  }
}
