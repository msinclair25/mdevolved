import { describe, expect, it } from "vitest";
import {
  type CredentialRecord,
  type LocalStatePort,
  type MarkdownRemotePort,
  SourceNeutralSyncCore,
  type WorkspaceEntry,
  type WorkspaceFilesPort,
  reconcileFolder,
} from "../src/index";

class MemoryState implements LocalStatePort {
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

class MemoryFiles implements WorkspaceFilesPort {
  readonly values = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  put(path: string, contents: string, mtimeMs = 1): void {
    this.values.set(path, {
      bytes: new TextEncoder().encode(contents),
      mtimeMs,
    });
  }
  async list(directory: string): Promise<readonly WorkspaceEntry[]> {
    const prefix = directory === "" ? "" : `${directory}/`;
    const directories = new Set<string>();
    const entries: WorkspaceEntry[] = [];
    for (const [path, value] of this.values) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        directories.add(`${prefix}${rest.slice(0, slash)}`);
      } else {
        entries.push({
          path,
          kind: "file",
          size: value.bytes.byteLength,
          mtimeMs: value.mtimeMs,
        });
      }
    }
    return [
      ...[...directories].map((path): WorkspaceEntry => ({
        path,
        kind: "directory",
      })),
      ...entries,
    ];
  }
  async stat(path: string): Promise<WorkspaceEntry | null> {
    const value = this.values.get(path);
    return value
      ? {
          path,
          kind: "file",
          size: value.bytes.byteLength,
          mtimeMs: value.mtimeMs,
        }
      : null;
  }
  async read(path: string): Promise<Uint8Array> {
    const value = this.values.get(path);
    if (!value) throw new Error("missing");
    return value.bytes;
  }
  async write(path: string, contents: Uint8Array): Promise<void> {
    this.values.set(path, { bytes: contents, mtimeMs: Date.now() });
  }
  watch(): () => void {
    return () => undefined;
  }
}

class MemoryRemote implements MarkdownRemotePort {
  readonly values = new Map<string, string>();
  readonly tombstones = new Set<string>();
  durable = true;
  listPaths(): readonly string[] {
    return [...this.values.keys()];
  }
  read(path: string): string | null {
    return this.values.get(path) ?? null;
  }
  write(path: string, contents: string): void {
    this.values.set(path, contents);
  }
  isTombstoned(path: string): boolean {
    return this.tombstones.has(path);
  }
  async confirmDurable(): Promise<boolean> {
    return this.durable;
  }
}

async function fixture(): Promise<{
  core: SourceNeutralSyncCore;
  files: MemoryFiles;
  remote: MemoryRemote;
  state: MemoryState;
}> {
  const files = new MemoryFiles();
  const state = new MemoryState();
  const credential: CredentialRecord = {
    sourceId: "source-1",
    fingerprint: "fingerprint-1",
    status: "active",
    issuedAt: 1,
  };
  const core = new SourceNeutralSyncCore({
    files,
    state,
    credentials: {
      get: async () => credential,
      confirmReplacement: async () => undefined,
      revoke: async () => undefined,
    },
  });
  await core.start();
  return { core, files, remote: new MemoryRemote(), state };
}

function text(files: MemoryFiles, path: string): string | undefined {
  const value = files.values.get(path);
  return value ? new TextDecoder().decode(value.bytes) : undefined;
}

describe("folder reconciliation", () => {
  it("publishes local Markdown and applies remote Markdown", async () => {
    const { core, files, remote, state } = await fixture();
    files.put("local.md", "local");
    remote.values.set("remote.md", "remote");
    await expect(
      reconcileFolder(core, state, remote, { maxFileBytes: 100 }),
    ).resolves.toMatchObject({ remoteWrites: 1, diskWrites: 1, durable: true });
    expect(remote.values.get("local.md")).toBe("local");
    expect(text(files, "remote.md")).toBe("remote");
  });

  it("uses the saved baseline for bidirectional edits and conflicts", async () => {
    const { core, files, remote, state } = await fixture();
    files.put("note.md", "base", 1);
    remote.values.set("note.md", "base");
    await reconcileFolder(core, state, remote, {
      maxFileBytes: 100,
      now: () => 10,
    });

    files.put("note.md", "disk edit", 20);
    await reconcileFolder(core, state, remote, {
      maxFileBytes: 100,
      now: () => 30,
    });
    expect(remote.values.get("note.md")).toBe("disk edit");

    files.put("note.md", "second disk edit", 40);
    remote.values.set("note.md", "remote edit");
    const result = await reconcileFolder(core, state, remote, {
      maxFileBytes: 100,
      now: () => 50,
    });
    expect(remote.values.get("note.md")).toBe("second disk edit");
    expect(result.conflicts).toHaveLength(1);
    expect(text(files, result.conflicts[0]!)).toBe("remote edit");
  });

  it("fails closed without a durable remote receipt", async () => {
    const { core, files, remote, state } = await fixture();
    files.put("note.md", "local");
    remote.durable = false;
    await expect(
      reconcileFolder(core, state, remote, { maxFileBytes: 100 }),
    ).rejects.toThrow("remote_receipt_unconfirmed");
    expect(state.values.has("mdevolved/folder-reconciliation/v1")).toBe(false);
  });

  it("does not publish tombstoned, oversized, or invalid UTF-8 files", async () => {
    const { core, files, remote, state } = await fixture();
    files.put("deleted.md", "x");
    files.put("large.md", "12345");
    remote.tombstones.add("deleted.md");
    const bounded = await reconcileFolder(core, state, remote, {
      maxFileBytes: 4,
    });
    expect(bounded.conflicts).toContain("deleted.md");
    expect(bounded.skippedOversize).toContain("large.md");
    expect(remote.values.size).toBe(0);

    files.values.set("invalid.md", {
      bytes: Uint8Array.of(0xff),
      mtimeMs: 1,
    });
    await expect(
      reconcileFolder(core, state, remote, { maxFileBytes: 100 }),
    ).rejects.toThrow("source_markdown_invalid_utf8:invalid.md");
  });

  it("rejects hostile remote paths, oversized remote text, and invalid clocks", async () => {
    const hostile = await fixture();
    hostile.remote.values.set("../outside.md", "x");
    await expect(
      reconcileFolder(hostile.core, hostile.state, hostile.remote, {
        maxFileBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });

    const oversized = await fixture();
    oversized.remote.values.set("large.md", "12345");
    await expect(
      reconcileFolder(oversized.core, oversized.state, oversized.remote, {
        maxFileBytes: 4,
      }),
    ).rejects.toThrow("remote_markdown_oversize:large.md");

    const clock = await fixture();
    await expect(
      reconcileFolder(clock.core, clock.state, clock.remote, {
        maxFileBytes: 100,
        now: () => Number.MAX_VALUE,
      }),
    ).rejects.toThrow("reconciliation_time_invalid");
  });
});
