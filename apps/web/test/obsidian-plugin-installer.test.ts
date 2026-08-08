import { describe, expect, it } from "vitest";
import {
  browserSupportsOwdSyncInstall,
  installOwdSyncIntoVault,
  isOwdSyncInstallCancellation,
  normalizeOwdSyncInstallerError,
  OWD_SYNC_INSTALLER_BASE_PATH,
  OWD_SYNC_INSTALLER_FORMAT,
  OWD_SYNC_INSTALLER_MANIFEST_URL,
  OWD_SYNC_PLUGIN_ID,
  OwdSyncInstallerError,
  type OwdSyncDirectoryHandle,
  type OwdSyncFileHandle,
  type OwdSyncInstallerDependencies,
  type OwdSyncReadableFile,
  type OwdSyncWritableFile,
} from "../src/obsidian-plugin-installer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type WriteFailure = (path: string) => boolean;

class MemoryFile implements OwdSyncFileHandle {
  readonly kind = "file";

  constructor(
    readonly name: string,
    private path: string,
    private bytes: Uint8Array,
    private shouldFailWrite: WriteFailure,
  ) {}

  async createWritable(): Promise<OwdSyncWritableFile> {
    let pending = Uint8Array.from(this.bytes);
    return {
      abort: async () => undefined,
      close: async () => {
        this.bytes = Uint8Array.from(pending);
      },
      write: async (data) => {
        if (this.shouldFailWrite(this.path)) {
          throw new Error(`Injected write failure for ${this.path}`);
        }
        pending = new Uint8Array(data);
      },
    };
  }

  async getFile(): Promise<OwdSyncReadableFile> {
    const snapshot = Uint8Array.from(this.bytes);
    return {
      arrayBuffer: async () => Uint8Array.from(snapshot).buffer,
      size: snapshot.byteLength,
    };
  }

  read(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class MemoryDirectory implements OwdSyncDirectoryHandle {
  readonly kind = "directory";
  private readonly entries = new Map<string, MemoryDirectory | MemoryFile>();

  constructor(
    readonly name: string,
    private path = name,
    private shouldFailWrite: WriteFailure = () => false,
  ) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryDirectory> {
    const existing = this.entries.get(name);
    if (existing instanceof MemoryDirectory) {
      return existing;
    }
    if (existing !== undefined || options?.create !== true) {
      throw new DOMException(`${name} was not found`, "NotFoundError");
    }
    const directory = new MemoryDirectory(
      name,
      `${this.path}/${name}`,
      this.shouldFailWrite,
    );
    this.entries.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MemoryFile> {
    const existing = this.entries.get(name);
    if (existing instanceof MemoryFile) {
      return existing;
    }
    if (existing !== undefined || options?.create !== true) {
      throw new DOMException(`${name} was not found`, "NotFoundError");
    }
    const file = new MemoryFile(
      name,
      `${this.path}/${name}`,
      new Uint8Array(),
      this.shouldFailWrite,
    );
    this.entries.set(name, file);
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    const existing = this.entries.get(name);
    if (existing === undefined) {
      throw new DOMException(`${name} was not found`, "NotFoundError");
    }
    if (
      existing instanceof MemoryDirectory &&
      existing.entries.size > 0 &&
      options?.recursive !== true
    ) {
      throw new DOMException(
        `${name} is not empty`,
        "InvalidModificationError",
      );
    }
    this.entries.delete(name);
  }

  async seedDirectory(name: string): Promise<MemoryDirectory> {
    return this.getDirectoryHandle(name, { create: true });
  }

  async seedFile(name: string, value: string): Promise<void> {
    const file = await this.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(encoder.encode(value).buffer);
    await writable.close();
  }

  async readText(name: string): Promise<string | null> {
    try {
      const file = await this.getFileHandle(name);
      return decoder.decode(file.read());
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return null;
      }
      throw error;
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(value: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
    ),
  );
}

async function installerDependencies(options?: {
  alterAsset?: "main.js" | "manifest.json" | "styles.css";
  manifestVersion?: string;
}): Promise<OwdSyncInstallerDependencies> {
  const assets = new Map<string, Uint8Array>([
    ["main.js", encoder.encode("console.log('OWD Sync');\n")],
    [
      "manifest.json",
      encoder.encode(
        JSON.stringify({
          id: OWD_SYNC_PLUGIN_ID,
          name: "OWD Sync",
          version: "0.1.7",
        }),
      ),
    ],
    ["styles.css", encoder.encode(".owd-sync { display: block; }\n")],
  ]);
  const manifest = {
    assets: await Promise.all(
      [...assets].map(async ([name, bytes]) => ({
        bytes: bytes.byteLength,
        name,
        sha256: await sha256(bytes),
      })),
    ),
    format: OWD_SYNC_INSTALLER_FORMAT,
    pluginId: OWD_SYNC_PLUGIN_ID,
    version: options?.manifestVersion ?? "0.1.7",
  };

  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === OWD_SYNC_INSTALLER_MANIFEST_URL) {
      return Response.json(manifest);
    }
    const name = url.slice(`${OWD_SYNC_INSTALLER_BASE_PATH}/`.length);
    const value = assets.get(name);
    if (value === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(
      options?.alterAsset === name
        ? encoder.encode("tampered")
        : Uint8Array.from(value),
    );
  };
  return { fetch: fetcher, sha256 };
}

describe("OWD Sync direct vault installer", () => {
  it("installs the pinned assets and preserves every existing enabled plugin", async () => {
    const vault = new MemoryDirectory("Product vault");
    const obsidian = await vault.seedDirectory(".obsidian");
    await obsidian.seedFile(
      "community-plugins.json",
      JSON.stringify(["calendar", "obsidian42-brat", "calendar"]),
    );

    const result = await installOwdSyncIntoVault(
      vault,
      await installerDependencies(),
    );
    const plugin = await (
      await obsidian.getDirectoryHandle("plugins")
    ).getDirectoryHandle(OWD_SYNC_PLUGIN_ID);

    expect(result).toEqual({
      enabledPluginCount: 3,
      vaultName: "Product vault",
      version: "0.1.7",
    });
    expect(await plugin.readText("main.js")).toBe("console.log('OWD Sync');\n");
    expect(
      JSON.parse((await plugin.readText("manifest.json")) ?? "null"),
    ).toMatchObject({
      id: OWD_SYNC_PLUGIN_ID,
      version: "0.1.7",
    });
    expect(
      JSON.parse((await obsidian.readText("community-plugins.json")) ?? "null"),
    ).toEqual(["calendar", "obsidian42-brat", OWD_SYNC_PLUGIN_ID]);
  });

  it("rejects a non-vault folder before loading or writing installer assets", async () => {
    const vault = new MemoryDirectory("Not a vault");
    let requested = false;
    const dependencies = await installerDependencies();
    dependencies.fetch = async (...parameters) => {
      requested = true;
      return fetch(...parameters);
    };

    await expect(
      installOwdSyncIntoVault(vault, dependencies),
    ).rejects.toMatchObject({
      code: "not_an_obsidian_vault",
    });
    expect(requested).toBe(false);
  });

  it("rejects version drift and asset tampering without touching vault files", async () => {
    const vault = new MemoryDirectory("Safe vault");
    const obsidian = await vault.seedDirectory(".obsidian");
    await obsidian.seedFile("community-plugins.json", '["calendar"]\n');

    await expect(
      installOwdSyncIntoVault(
        vault,
        await installerDependencies({ manifestVersion: "0.1.4" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_installer_manifest",
    });
    await expect(
      installOwdSyncIntoVault(
        vault,
        await installerDependencies({ alterAsset: "main.js" }),
      ),
    ).rejects.toMatchObject({
      code: "installer_asset_mismatch",
    });

    expect(await obsidian.readText("community-plugins.json")).toBe(
      '["calendar"]\n',
    );
    await expect(obsidian.getDirectoryHandle("plugins")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("restores an existing plugin and enabled list after a partial write failure", async () => {
    let failStyles = false;
    const vault = new MemoryDirectory(
      "Rollback vault",
      "Rollback vault",
      (path) => {
        if (failStyles && path.endsWith("/styles.css")) {
          failStyles = false;
          return true;
        }
        return false;
      },
    );
    const obsidian = await vault.seedDirectory(".obsidian");
    const plugins = await obsidian.seedDirectory("plugins");
    const plugin = await plugins.seedDirectory(OWD_SYNC_PLUGIN_ID);
    await plugin.seedFile("main.js", "old main");
    await plugin.seedFile("manifest.json", "old manifest");
    await plugin.seedFile("styles.css", "old styles");
    await obsidian.seedFile("community-plugins.json", '["calendar"]\n');
    failStyles = true;

    await expect(
      installOwdSyncIntoVault(vault, await installerDependencies()),
    ).rejects.toBeInstanceOf(OwdSyncInstallerError);

    expect(await plugin.readText("main.js")).toBe("old main");
    expect(await plugin.readText("manifest.json")).toBe("old manifest");
    expect(await plugin.readText("styles.css")).toBe("old styles");
    expect(await obsidian.readText("community-plugins.json")).toBe(
      '["calendar"]\n',
    );
  });

  it("treats picker cancellation as a no-change outcome and reports support honestly", () => {
    expect(
      isOwdSyncInstallCancellation(
        new DOMException("The user cancelled", "AbortError"),
      ),
    ).toBe(true);
    expect(browserSupportsOwdSyncInstall()).toBe(false);
  });

  it("turns browser folder failures into specific, recoverable Mac guidance", () => {
    expect(
      normalizeOwdSyncInstallerError(
        new DOMException("Permission denied", "NotAllowedError"),
      ),
    ).toMatchObject({
      code: "folder_permission_denied",
      message: expect.stringContaining("choose Allow"),
    });
    expect(
      normalizeOwdSyncInstallerError(
        new DOMException("File is busy", "NotReadableError"),
      ),
    ).toMatchObject({
      code: "vault_not_writable",
      message: expect.stringContaining("⌘Q"),
    });
    expect(
      normalizeOwdSyncInstallerError(
        new DOMException("Picker blocked", "SecurityError"),
      ),
    ).toMatchObject({
      code: "folder_picker_blocked",
      message: expect.stringContaining("BRAT fallback"),
    });
  });
});
