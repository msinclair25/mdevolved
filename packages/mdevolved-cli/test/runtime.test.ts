import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderSourceIdentity } from "@owd/folder-adapter";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryProtectedCredentialBackend,
  ProtectedCredentialCustody,
} from "../src/custody.js";
import {
  createSyncRuntime,
  createVaultSyncRemote,
  type VaultSyncLike,
} from "../src/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

class FakeText {
  constructor(private value: string) {}
  toString(): string {
    return this.value;
  }
  delete(index: number, length: number): void {
    this.value = this.value.slice(0, index) + this.value.slice(index + length);
  }
  insert(index: number, value: string): void {
    this.value = this.value.slice(0, index) + value + this.value.slice(index);
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("generic VaultSync bridge", () => {
  it("maps bounded Markdown paths and confirms durable state", async () => {
    const files = new Map<string, FakeText>([
      ["README.md", new FakeText("old")],
    ]);
    const vault: VaultSyncLike = {
      connected: true,
      providerSynced: true,
      serverAppliedLocalState: true,
      getActiveMarkdownPaths: () => [...files.keys()],
      getTextForPath: (path) => files.get(path) ?? null,
      ensureFile: (path, content) => {
        const text = new FakeText(content);
        files.set(path, text);
        return text;
      },
    };
    const remote = createVaultSyncRemote(vault, "device");
    expect(remote.listPaths()).toEqual(["README.md"]);
    expect(remote.read("README.md")).toBe("old");
    await remote.write("README.md", "new");
    expect(remote.read("README.md")).toBe("new");
    expect(await remote.confirmDurable()).toBe(true);
  });

  it("runs a protected bidirectional folder through restart, conflict, offline receipt, and revocation", async () => {
    const root = await temporaryDirectory("mdevolved-runtime-");
    const stateDirectory = await temporaryDirectory("mdevolved-state-");
    await fs.writeFile(join(root, "local.md"), "local", "utf8");
    const sourceId = await folderSourceIdentity(root);
    const custody = new ProtectedCredentialCustody(
      sourceId,
      new MemoryProtectedCredentialBackend(),
    );
    await custody.install(
      {
        sourceId,
        fingerprint: "synthetic-fingerprint",
        status: "active",
        issuedAt: 1,
      },
      "synthetic-secret",
      {
        host: "https://example.com",
        vaultId: "00000000-0000-4000-8000-000000000001",
      },
    );
    const files = new Map<string, FakeText>([
      ["remote.md", new FakeText("remote")],
    ]);
    const vault: VaultSyncLike = {
      connected: true,
      providerSynced: true,
      serverAppliedLocalState: true,
      getActiveMarkdownPaths: () => [...files.keys()],
      getTextForPath: (path) => files.get(path) ?? null,
      ensureFile: (path, content) => {
        const text = new FakeText(content);
        files.set(path, text);
        return text;
      },
    };
    const first = await createSyncRuntime({
      sourceRoot: root,
      stateDirectory,
      custody,
      vault,
      watch: false,
      now: () => 1_000,
    });
    expect(await first.start()).toBe("running");
    expect(files.get("local.md")?.toString()).toBe("local");
    expect(await fs.readFile(join(root, "remote.md"), "utf8")).toBe("remote");
    await first.stop();

    await fs.writeFile(join(root, "local.md"), "disk edit", "utf8");
    files.set("local.md", new FakeText("remote edit"));
    const restarted = await createSyncRuntime({
      sourceRoot: root,
      stateDirectory,
      custody,
      vault,
      watch: false,
      now: () => 2_000,
    });
    expect(await restarted.start()).toBe("running");
    expect(
      (await fs.readdir(root)).some((path) =>
        path.startsWith("local (MDevolved conflict"),
      ),
    ).toBe(true);

    await fs.writeFile(join(root, "offline.md"), "not confirmed", "utf8");
    Object.assign(vault, {
      connected: false,
      providerSynced: false,
      serverAppliedLocalState: false,
    });
    await expect(restarted.syncOnce()).rejects.toThrow(
      "remote_receipt_unconfirmed",
    );
    await restarted.stop();

    const offlineRestart = await createSyncRuntime({
      sourceRoot: root,
      stateDirectory,
      custody,
      vault,
      watch: false,
    });
    expect(await offlineRestart.start()).toBe("offline");
    await offlineRestart.stop();

    await custody.revoke();
    const revoked = await createSyncRuntime({
      sourceRoot: root,
      stateDirectory,
      custody,
      vault,
      watch: false,
    });
    expect(await revoked.start()).toBe("offline");
    await revoked.stop();
  });
});
