import { describe, expect, it, vi } from "vitest";
import {
  type CredentialRecord,
  type LocalStatePort,
  type SourceCoreStatus,
  SourceNeutralSyncCore,
  SourceScanError,
  type UserInteractionEvent,
  type WorkspaceEntry,
  type WorkspaceFilesPort,
  createSourceDescriptor,
  normalizeSourceDescriptor,
  scanMarkdown,
  validateRelativePath,
} from "../src/index";

describe("source capability compatibility", () => {
  it("defaults records from old clients to an Obsidian source", () => {
    expect(normalizeSourceDescriptor(undefined)).toMatchObject({
      descriptorVersion: 1,
      sourceKind: "obsidian",
      clientVersion: "legacy",
      capabilities: expect.arrayContaining([
        "markdown",
        "attachments",
        "editor-integration",
        "watch",
      ]),
    });
  });

  it("describes a folder without widening its capabilities", () => {
    expect(
      createSourceDescriptor({
        sourceKind: "folder",
        label: "Project notes",
        capabilities: ["markdown", "watch"],
        clientVersion: "0.1.0",
        syncSchemaVersion: 1,
        provenance: { pairedAt: 1 },
      }),
    ).toMatchObject({
      sourceKind: "folder",
      capabilities: ["markdown", "watch"],
    });
  });
});

class FakeWorkspace implements WorkspaceFilesPort {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>([""]);
  activeReads = 0;
  maxActiveReads = 0;
  readDelayMs = 0;
  private readonly invalidEntries = new Map<
    string,
    readonly WorkspaceEntry[]
  >();

  add(path: string, contents: string): void {
    this.files.set(path, new TextEncoder().encode(contents));
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      this.directories.add(parts.slice(0, index).join("/"));
    }
  }

  addEntries(directory: string, entries: readonly WorkspaceEntry[]): void {
    this.invalidEntries.set(directory, entries);
  }

  async list(directory: string): Promise<readonly WorkspaceEntry[]> {
    const injected = this.invalidEntries.get(directory);
    if (injected !== undefined) return injected;
    const prefix = directory === "" ? "" : `${directory}/`;
    const result: WorkspaceEntry[] = [];
    for (const nested of this.directories) {
      if (nested === "" || !nested.startsWith(prefix)) continue;
      const rest = nested.slice(prefix.length);
      if (!rest.includes("/")) result.push({ path: nested, kind: "directory" });
    }
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes("/"))
        result.push({ path, kind: "file", size: bytes.byteLength, mtimeMs: 1 });
    }
    return result;
  }

  async stat(path: string): Promise<WorkspaceEntry | null> {
    const bytes = this.files.get(path);
    return bytes === undefined
      ? null
      : { path, kind: "file", size: bytes.byteLength, mtimeMs: 1 };
  }

  async read(path: string): Promise<Uint8Array> {
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    if (this.readDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
    const value = this.files.get(path);
    this.activeReads -= 1;
    if (value === undefined) throw new Error("missing");
    return value;
  }

  async write(path: string, contents: Uint8Array): Promise<void> {
    this.files.set(path, contents);
  }

  watch(): () => void {
    return () => undefined;
  }
}

class FakeState implements LocalStatePort {
  readonly values = new Map<string, unknown>();

  async read<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeCredentials {
  record: CredentialRecord | null = null;

  async get(): Promise<CredentialRecord | null> {
    return this.record;
  }

  async confirmReplacement(record: CredentialRecord): Promise<void> {
    this.record = record;
  }

  async revoke(): Promise<void> {
    if (this.record !== null)
      this.record = { ...this.record, status: "revoked" };
  }
}

describe("source-neutral Markdown boundary", () => {
  it("scans only Markdown, skips control trees, and returns deterministic results", async () => {
    const workspace = new FakeWorkspace();
    workspace.add("notes/one.md", "one");
    workspace.add("notes/two.txt", "skip");
    workspace.add(".obsidian/app.md", "skip");
    workspace.add("node_modules/pkg.md", "skip");
    const first = await scanMarkdown(workspace, {
      maxFiles: 10,
      maxBytes: 100,
      maxFileBytes: 20,
      maxDepth: 4,
      concurrency: 2,
    });
    const second = await scanMarkdown(workspace, {
      maxFiles: 10,
      maxBytes: 100,
      maxFileBytes: 20,
      maxDepth: 4,
      concurrency: 2,
    });
    expect(first.files.map((file) => file.path)).toEqual(["notes/one.md"]);
    expect(first.totalBytes).toBe(3);
    expect(first.scanId).toBe(second.scanId);
  });

  it.each([
    "/absolute.md",
    "C:/absolute.md",
    "../escape.md",
    "notes/../escape.md",
    "notes\\escape.md",
    "notes/\u0000.md",
    "notes/e\u0301.md",
  ])("rejects hostile relative path %s", (path) => {
    expect(() => validateRelativePath(path)).toThrow(SourceScanError);
  });

  it("rejects duplicate and case/unicode canonical collisions", async () => {
    const workspace = new FakeWorkspace();
    workspace.addEntries("", [
      { path: "A.md", kind: "file", size: 1 },
      { path: "a.md", kind: "file", size: 1 },
    ]);
    await expect(scanMarkdown(workspace)).rejects.toMatchObject({
      code: "path_collision",
    });
  });

  it("fails closed on symlinks", async () => {
    const workspace = new FakeWorkspace();
    workspace.addEntries("", [{ path: "linked.md", kind: "symlink" }]);
    await expect(scanMarkdown(workspace)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("enforces count, byte, file, and depth ceilings", async () => {
    const workspace = new FakeWorkspace();
    workspace.add("deep/one/two/three.md", "x");
    workspace.add("a.md", "1234");
    workspace.add("b.md", "1234");
    await expect(
      scanMarkdown(workspace, { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "scan_limit" });
    await expect(
      scanMarkdown(workspace, { maxFiles: 1 }),
    ).rejects.toMatchObject({ code: "scan_limit" });
    await expect(
      scanMarkdown(workspace, { maxBytes: 5 }),
    ).rejects.toMatchObject({ code: "scan_limit" });
    await expect(
      scanMarkdown(workspace, { maxFileBytes: 3 }),
    ).rejects.toMatchObject({ code: "scan_limit" });
    await expect(
      scanMarkdown(workspace, { maxDepth: 2 }),
    ).rejects.toMatchObject({ code: "scan_limit" });
  });

  it("keeps reads bounded by caller concurrency", async () => {
    const workspace = new FakeWorkspace();
    workspace.readDelayMs = 5;
    for (let index = 0; index < 8; index += 1)
      workspace.add(`notes/${index}.md`, "x");
    await scanMarkdown(workspace, {
      maxFiles: 20,
      maxBytes: 100,
      maxFileBytes: 10,
      maxDepth: 4,
      concurrency: 2,
    });
    expect(workspace.maxActiveReads).toBeLessThanOrEqual(2);
  });

  it("lists metadata without reading excluded or eligible contents", async () => {
    const workspace = new FakeWorkspace();
    workspace.add("notes/one.md", "one");
    workspace.add(".hidden/private.md", "private");
    const read = vi.spyOn(workspace, "read");
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
    };
    const core = new SourceNeutralSyncCore({
      files: workspace,
      state: new FakeState(),
      credentials,
    });
    await core.start();
    await expect(core.listMarkdown()).resolves.toMatchObject([
      { path: "notes/one.md", kind: "file" },
    ]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("source-neutral lifecycle", () => {
  it("restarts from local state, makes start/stop idempotent, and replays a scan", async () => {
    const workspace = new FakeWorkspace();
    workspace.add("readme.md", "hello");
    const state = new FakeState();
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
    };
    const statuses: SourceCoreStatus[] = [];
    const ui = {
      emit: (event: UserInteractionEvent) => {
        if (event.kind === "status") statuses.push(event.status);
      },
    };
    const makeCore = () =>
      new SourceNeutralSyncCore({ files: workspace, state, credentials, ui });
    const core = makeCore();
    expect(await core.start()).toBe("running");
    expect(await core.start()).toBe("running");
    const first = await core.rescan({
      maxFiles: 2,
      maxBytes: 100,
      maxFileBytes: 20,
      maxDepth: 3,
      concurrency: 1,
    });
    await core.stop();
    await core.stop();
    const restarted = makeCore();
    expect(await restarted.start()).toBe("running");
    expect(
      (
        await restarted.rescan({
          maxFiles: 2,
          maxBytes: 100,
          maxFileBytes: 20,
          maxDepth: 3,
          concurrency: 1,
        })
      ).scanId,
    ).toBe(first.scanId);
    expect(statuses).toContain("running");
  });

  it("stays terminal after revocation until credentials are replaced", async () => {
    const state = new FakeState();
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
    };
    const options = { files: new FakeWorkspace(), state, credentials };
    const core = new SourceNeutralSyncCore(options);
    await core.start();
    await core.revoke();
    expect(core.getStatus()).toBe("revoked");
    expect(await new SourceNeutralSyncCore(options).start()).toBe("revoked");
    expect(
      await core.replaceCredentials({
        sourceId: "source-1",
        fingerprint: "fp-2",
        status: "active",
        issuedAt: 2,
      }),
    ).toBe("running");
  });

  it("confines direct I/O and blocks writes after revocation", async () => {
    const workspace = new FakeWorkspace();
    workspace.add("safe.md", "before");
    const state = new FakeState();
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
    };
    const core = new SourceNeutralSyncCore({
      files: workspace,
      state,
      credentials,
    });
    await core.start();
    await expect(
      core.write("../escape.md", new TextEncoder().encode("no")),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await core.write("safe.md", new TextEncoder().encode("after"));
    await expect(core.read("safe.md")).resolves.toEqual(
      new TextEncoder().encode("after"),
    );
    await core.revoke();
    await expect(
      core.write("safe.md", new TextEncoder().encode("blocked")),
    ).rejects.toThrow("source_not_running:revoked");
  });

  it("expires an active source before its next I/O", async () => {
    let now = 10;
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
      expiresAt: 20,
    };
    const core = new SourceNeutralSyncCore({
      files: new FakeWorkspace(),
      state: new FakeState(),
      credentials,
      now: () => now,
    });
    expect(await core.start()).toBe("running");
    now = 20;
    await expect(core.stat("note.md")).rejects.toThrow(
      "source_not_running:expired",
    );
    expect(core.getStatus()).toBe("expired");
  });

  it("recovers safely from malformed persisted core state", async () => {
    const state = new FakeState();
    state.values.set("mdevolved/source-core/v1", {
      status: "running",
      descriptor: { sourceKind: "outside-root" },
    });
    const credentials = new FakeCredentials();
    credentials.record = {
      sourceId: "source-1",
      fingerprint: "fp-1",
      status: "active",
      issuedAt: 1,
    };
    const core = new SourceNeutralSyncCore({
      files: new FakeWorkspace(),
      state,
      credentials,
    });
    await expect(core.start()).resolves.toBe("running");
  });
});
