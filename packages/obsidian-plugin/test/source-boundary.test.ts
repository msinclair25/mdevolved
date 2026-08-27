import { describe, expect, it, vi } from "vitest";

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
  return {
    Notice: vi.fn(),
    TFile,
    TFolder,
    normalizePath: (path: string) => path.replaceAll("\\", "/"),
  };
});

vi.mock("obsidian", () => obsidian);

import { createObsidianSourceAdapter } from "../src/obsidian-adapter";
import { planClosedFileReconcile } from "../vendor/yaos-src/runtime/reconcile/closedFilePlanner";
import { isBlobConflictArtifactPath } from "../vendor/yaos-src/sync/blobSync";

function fixture() {
  const contents = new Map<string, string>([["notes/one.md", "one"]]);
  const note = new obsidian.TFile("notes/one.md", { mtime: 1, size: 3 });
  const notes = new obsidian.TFolder("notes", [note]);
  const root = new obsidian.TFolder("", [notes]);
  const files = new Map<string, unknown>([
    ["", root],
    ["notes", notes],
    ["notes/one.md", note],
  ]);
  const listeners = new Map<string, Array<(file: { path: string }) => void>>();
  const vault = {
    create: vi.fn(async (path: string, text: string) => {
      const file = new obsidian.TFile(path, {
        mtime: 2,
        size: new TextEncoder().encode(text).byteLength,
      });
      files.set(path, file);
      contents.set(path, text);
      return file;
    }),
    createFolder: vi.fn(async (path: string) => {
      const folder = new obsidian.TFolder(path, []);
      files.set(path, folder);
      return folder;
    }),
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    getName: () => "Synthetic vault",
    getRoot: () => root,
    modify: vi.fn(async (file: { path: string }, text: string) => {
      contents.set(file.path, text);
    }),
    offref: vi.fn(),
    on: vi.fn((event: string, listener: (file: { path: string }) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return { event, listener };
    }),
    read: vi.fn(
      async (file: { path: string }) => contents.get(file.path) ?? "",
    ),
  };
  return { app: { vault } as never, contents };
}

describe("Obsidian source-neutral adapter", () => {
  it("runs the existing vault through the four ports without persisting credentials", async () => {
    const { app, contents } = fixture();
    const state: Record<string, unknown> = {};
    const statuses: string[] = [];
    const connection = {
      sourceId: "vault-1",
      token: "synthetic_pairing_credential",
    };
    const boundary = createObsidianSourceAdapter({
      app,
      clientVersion: "0.1.7",
      syncSchemaVersion: 3,
      getConnection: () => connection,
      readState: async <T>(key: string) => state[key] as T | undefined,
      writeState: async <T>(key: string, value: T) => {
        state[key] = value;
      },
      removeState: async (key: string) => {
        delete state[key];
      },
      getMaxWriteBytes: () => 1024 * 1024,
      onStatus: (status) => statuses.push(status),
    });

    await expect(boundary.core.start()).resolves.toBe("running");
    await expect(boundary.core.read("notes/one.md")).resolves.toEqual(
      new TextEncoder().encode("one"),
    );
    await boundary.core.write(
      "notes/one.md",
      new TextEncoder().encode("updated"),
    );
    await expect(boundary.core.rescan()).resolves.toMatchObject({
      files: [{ path: "notes/one.md" }],
    });
    expect(contents.get("notes/one.md")).toBe("updated");
    expect(JSON.stringify(state)).not.toContain(connection.token);
    expect(JSON.stringify(state)).not.toContain('"attachments"');
    expect(statuses).toContain("running");
  });

  it("keeps revocation terminal across restart and accepts only re-paired credentials", async () => {
    const { app } = fixture();
    const state: Record<string, unknown> = {};
    let token = "revoked_credential";
    const options = {
      app,
      clientVersion: "0.1.7",
      syncSchemaVersion: 3,
      getConnection: () => ({ sourceId: "vault-1", token }),
      readState: async <T>(key: string) => state[key] as T | undefined,
      writeState: async <T>(key: string, value: T) => {
        state[key] = value;
      },
      removeState: async (key: string) => {
        delete state[key];
      },
      getMaxWriteBytes: () => 1024 * 1024,
      onStatus: () => undefined,
    };
    const first = createObsidianSourceAdapter(options);
    await first.core.start();
    await first.core.revoke();
    await expect(
      createObsidianSourceAdapter(options).core.start(),
    ).resolves.toBe("revoked");

    token = "replacement_credential";
    const repaired = createObsidianSourceAdapter(options);
    const credential = await repaired.currentCredential();
    expect(credential).not.toBeNull();
    await expect(repaired.core.replaceCredentials(credential!)).resolves.toBe(
      "running",
    );
  });
});

describe("source-neutral reconciliation compatibility", () => {
  it("keeps canonical and legacy blob conflict artifacts local-only", () => {
    expect(
      isBlobConflictArtifactPath(
        "attachments/file (MDevolved Sync remote conflict 2026-08-27T10-20-30Z).png",
      ),
    ).toBe(true);
    expect(
      isBlobConflictArtifactPath(
        "attachments/file (OWD Sync remote conflict 2026-08-27T10-20-30Z).png",
      ),
    ).toBe(true);
    expect(isBlobConflictArtifactPath("attachments/file.png")).toBe(false);
  });

  it("preserves the remote side when disk and CRDT both changed", () => {
    expect(
      planClosedFileReconcile({
        path: "notes/conflict.md",
        mode: "authoritative",
        isOpenOrBound: false,
        baselineHash: "baseline",
        diskHash: "disk-change",
        crdtHash: "remote-change",
      }),
    ).toMatchObject({
      kind: "create-conflict-artifact",
      reason: "both-changed",
      winner: "disk",
      preserveSide: "crdt",
    });
  });
});
