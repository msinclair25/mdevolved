import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const obsidian = vi.hoisted(() => {
  class TFile {
    constructor(
      readonly path: string,
      readonly stat: { mtime: number; size: number },
    ) {}
  }
  class TFolder {
    constructor(
      readonly path: string,
      readonly children: Array<TFile | TFolder>,
    ) {}
  }
  return { Notice: vi.fn(), TFile, TFolder };
});

vi.mock("obsidian", () => obsidian);

import { reconcileFolder, type MarkdownRemotePort } from "@mdevolved/yaos-core";
import {
  createFolderSource,
  folderSourceIdentity,
} from "@mdevolved/folder-adapter";
import { createObsidianSourceAdapter } from "../src/obsidian-adapter";
import {
  SettingsStore,
  type VaultSyncSettings,
} from "../vendor/yaos-src/settings/settingsStore";
import contract from "./fixtures/md3-adapter-contract.json";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createObsidianFixture() {
  const contents = new Map<string, string>([
    ...Object.entries(contract.markdown),
    ...Object.entries(contract.excluded),
  ]);
  const files = new Map<string, InstanceType<typeof obsidian.TFile>>();
  const folders = new Map<string, InstanceType<typeof obsidian.TFolder>>();
  folders.set("", new obsidian.TFolder("", []));

  for (const [path, text] of contents) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      if (!folders.has(directory)) {
        folders.set(directory, new obsidian.TFolder(directory, []));
      }
    }
    files.set(
      path,
      new obsidian.TFile(path, {
        mtime: 1_720_000_000_000,
        size: encoder.encode(text).byteLength,
      }),
    );
  }
  for (const [path, folder] of folders) {
    if (path === "") continue;
    const parent = folders.get(dirname(path) === "." ? "" : dirname(path));
    parent?.children.push(folder);
  }
  for (const [path, file] of files) {
    const parent = folders.get(dirname(path) === "." ? "" : dirname(path));
    parent?.children.push(file);
  }
  const abstractFiles = new Map<string, unknown>([
    ...folders.entries(),
    ...files.entries(),
  ]);
  const vault = {
    create: vi.fn(async (path: string, text: string) => {
      contents.set(path, text);
      const file = new obsidian.TFile(path, {
        mtime: 1_720_000_000_001,
        size: encoder.encode(text).byteLength,
      });
      abstractFiles.set(path, file);
      return file;
    }),
    createFolder: vi.fn(async (path: string) => {
      const folder = new obsidian.TFolder(path, []);
      abstractFiles.set(path, folder);
      return folder;
    }),
    getAbstractFileByPath: (path: string) => abstractFiles.get(path) ?? null,
    getName: () => "MD3 synthetic vault",
    getRoot: () => folders.get(""),
    modify: vi.fn(async (file: { path: string }, text: string) => {
      contents.set(file.path, text);
    }),
    offref: vi.fn(),
    on: vi.fn(() => ({})),
    read: vi.fn(
      async (file: { path: string }) => contents.get(file.path) ?? "",
    ),
  };
  return { app: { vault } as never, contents };
}

function memoryRemote(library: Map<string, string>): MarkdownRemotePort {
  return {
    listPaths: () => [...library.keys()],
    read: (path) => library.get(path) ?? null,
    write: (path, contents) => {
      library.set(path, contents);
    },
    isTombstoned: () => false,
    confirmDurable: async () => true,
  };
}

describe("MD3 adapter contract", () => {
  it("produces the same durable hashes and Markdown library through folder and Obsidian adapters", async () => {
    const root = await temporaryDirectory("mdevolved-md3-folder-");
    const stateDirectory = await temporaryDirectory("mdevolved-md3-state-");
    for (const [path, contents] of [
      ...Object.entries(contract.markdown),
      ...Object.entries(contract.excluded),
    ]) {
      await fs.mkdir(dirname(join(root, path)), { recursive: true });
      await fs.writeFile(join(root, path), contents, "utf8");
    }
    const sourceId = await folderSourceIdentity(root);
    const credential = {
      sourceId,
      fingerprint: "synthetic-folder-fingerprint",
      status: "active" as const,
      issuedAt: 1,
    };
    const folder = await createFolderSource({
      root,
      stateDirectory,
      credentials: {
        get: async () => credential,
        confirmReplacement: async () => undefined,
        revoke: async () => undefined,
      },
      now: () => 1_720_000_000_000,
    });
    await folder.core.start();

    const obsidianState: Record<string, unknown> = {};
    const { app, contents: obsidianContents } = createObsidianFixture();
    const obsidianAdapter = createObsidianSourceAdapter({
      app,
      clientVersion: "0.1.7",
      syncSchemaVersion: 3,
      getConnection: () => ({
        sourceId: "00000000-0000-4000-8000-000000000003",
        token: "synthetic_adapter_credential",
      }),
      readState: async <T>(key: string) => obsidianState[key] as T | undefined,
      writeState: async <T>(key: string, value: T) => {
        obsidianState[key] = value;
      },
      removeState: async (key: string) => {
        delete obsidianState[key];
      },
      getMaxWriteBytes: () => 1024 * 1024,
      onStatus: () => undefined,
    });
    await obsidianAdapter.core.start();

    const folderLibrary = new Map<string, string>();
    const obsidianLibrary = new Map<string, string>();
    await reconcileFolder(
      folder.core,
      folder.state,
      memoryRemote(folderLibrary),
      {
        maxFileBytes: 2 * 1024 * 1024,
        now: () => 1_720_000_000_000,
      },
    );
    await reconcileFolder(
      obsidianAdapter.core,
      {
        read: async <T>(key: string) => obsidianState[key] as T | undefined,
        write: async <T>(key: string, value: T) => {
          obsidianState[key] = value;
        },
        remove: async (key: string) => {
          delete obsidianState[key];
        },
      },
      memoryRemote(obsidianLibrary),
      { maxFileBytes: 2 * 1024 * 1024, now: () => 1_720_000_000_000 },
    );

    expect(Object.fromEntries(folderLibrary)).toEqual(contract.markdown);
    expect(Object.fromEntries(obsidianLibrary)).toEqual(contract.markdown);
    expect(obsidianLibrary).toEqual(folderLibrary);
    const folderBaseline = await folder.state.read<{
      hashes: Record<string, string>;
    }>("mdevolved/folder-reconciliation/v1");
    const obsidianBaseline = obsidianState[
      "mdevolved/folder-reconciliation/v1"
    ] as { hashes: Record<string, string> };
    expect(folderBaseline?.hashes).toEqual(contract.libraryHashes);
    expect(obsidianBaseline.hashes).toEqual(contract.libraryHashes);

    folderLibrary.set("README.md", "# Remote edit\n");
    obsidianLibrary.set("README.md", "# Remote edit\n");
    await reconcileFolder(
      folder.core,
      folder.state,
      memoryRemote(folderLibrary),
      { maxFileBytes: 2 * 1024 * 1024, now: () => 1_720_000_000_001 },
    );
    await reconcileFolder(
      obsidianAdapter.core,
      {
        read: async <T>(key: string) => obsidianState[key] as T | undefined,
        write: async <T>(key: string, value: T) => {
          obsidianState[key] = value;
        },
        remove: async (key: string) => {
          delete obsidianState[key];
        },
      },
      memoryRemote(obsidianLibrary),
      { maxFileBytes: 2 * 1024 * 1024, now: () => 1_720_000_000_001 },
    );
    expect(await fs.readFile(join(root, "README.md"), "utf8")).toBe(
      "# Remote edit\n",
    );
    expect(obsidianContents.get("README.md")).toBe("# Remote edit\n");

    await expect(
      reconcileFolder(
        obsidianAdapter.core,
        {
          read: async <T>(key: string) => obsidianState[key] as T | undefined,
          write: async <T>(key: string, value: T) => {
            obsidianState[key] = value;
          },
          remove: async (key: string) => {
            delete obsidianState[key];
          },
        },
        memoryRemote(new Map([[".obsidian/plugins/hostile.md", "# denied\n"]])),
        { maxFileBytes: 2 * 1024 * 1024, now: () => 1_720_000_000_002 },
      ),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(obsidianContents.has(".obsidian/plugins/hostile.md")).toBe(false);
    await expect(
      obsidianAdapter.core.write(
        "notes/oversized.md",
        new Uint8Array(1024 * 1024 + 1),
      ),
    ).rejects.toThrow("source_file_oversized");
    await expect(obsidianAdapter.core.read(".env")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await folder.close();
  });

  it("upgrades populated legacy settings without changing pairing identity or requiring re-pair", async () => {
    type LegacyState = Partial<VaultSyncSettings> & {
      _diskIndex?: unknown;
      _sourceCore?: Record<string, unknown>;
    };
    const saved: unknown[] = [];
    const store = new SettingsStore<LegacyState>({
      loadData: async () => structuredClone(contract.legacyPluginState),
      saveData: async (value) => {
        saved.push(value);
      },
    });
    const loaded = await store.load();
    expect(loaded.migrated).toBe(true);
    expect(loaded.settings).toMatchObject({
      host: contract.legacyPluginState.host,
      token: contract.legacyPluginState.token,
      vaultId: contract.legacyPluginState.vaultId,
    });

    const sourceState = loaded.persistedState._sourceCore ?? {};
    const { app } = createObsidianFixture();
    const adapter = createObsidianSourceAdapter({
      app,
      clientVersion: "0.1.7",
      syncSchemaVersion: 3,
      getConnection: () => ({
        sourceId: loaded.settings.vaultId,
        token: loaded.settings.token,
      }),
      readState: async <T>(key: string) => sourceState[key] as T | undefined,
      writeState: async <T>(key: string, value: T) => {
        sourceState[key] = value;
      },
      removeState: async (key: string) => {
        delete sourceState[key];
      },
      getMaxWriteBytes: () => 1024 * 1024,
      onStatus: () => undefined,
    });
    await expect(adapter.core.start()).resolves.toBe("running");
    await store.save(
      store.withSettings(loaded.persistedState, loaded.settings),
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      host: contract.legacyPluginState.host,
      token: contract.legacyPluginState.token,
      vaultId: contract.legacyPluginState.vaultId,
      _diskIndex: contract.legacyPluginState._diskIndex,
      _sourceCore: contract.legacyPluginState._sourceCore,
      attachmentSyncExplicitlyConfigured: true,
    });
    expect(await adapter.currentCredential()).toMatchObject({
      sourceId: contract.legacyPluginState.vaultId,
      status: "active",
    });
  });
});
