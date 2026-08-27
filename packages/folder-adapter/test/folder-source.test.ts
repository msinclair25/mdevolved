import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFolderSource,
  createMemoryCredentialCustody,
  folderSourceIdentity,
  sourceIdentityForCanonicalRoot,
  type FolderSource,
} from "../src/index";
import { type CredentialRecord } from "@mdevolved/yaos-core";

const roots: string[] = [];
const stateDirectories: string[] = [];
const extraPaths: string[] = [];
const encoder = new TextEncoder();

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "mdevolved-folder-"));
  roots.push(root);
  return root;
}

function credential(sourceId = "folder-test"): CredentialRecord {
  return {
    sourceId,
    fingerprint: `fingerprint-${sourceId}`,
    status: "active",
    issuedAt: 1,
  };
}

async function scopedCredential(root: string): Promise<CredentialRecord> {
  return credential(sourceIdentityForCanonicalRoot(await fs.realpath(root)));
}

async function openSource(
  root: string,
  now?: () => number,
): Promise<FolderSource> {
  const stateDirectory = join(root, "..", `.mdevolved-state-${randomUUID()}`);
  stateDirectories.push(stateDirectory);
  return await createFolderSource({
    root,
    credentials: createMemoryCredentialCustody(await scopedCredential(root)),
    stateDirectory,
    ...(now === undefined ? {} : { now }),
  });
}

async function write(
  root: string,
  path: string,
  text = "# note\n",
): Promise<void> {
  await fs.mkdir(join(root, path, ".."), { recursive: true });
  await fs.writeFile(join(root, path), text, "utf8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function closeAll(): Promise<void> {
  await Promise.all([
    ...roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
    ...stateDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
    ...extraPaths
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  ]);
}

afterEach(closeAll);

describe("native folder source", () => {
  it("scans, reads, and atomically writes Markdown inside the selected root", async () => {
    const root = await fixture();
    await write(root, "notes/one.md", "one");
    await write(root, "notes/two.txt", "ignored");
    const source = await openSource(root);
    expect(await source.core.start()).toBe("running");
    expect((await source.core.rescan()).files.map((file) => file.path)).toEqual(
      ["notes/one.md"],
    );
    await source.core.write("notes/one.md", encoder.encode("two"));
    await source.core.write(
      "remote/new.md",
      encoder.encode("created remotely"),
    );
    expect(
      new TextDecoder().decode(await source.core.read("notes/one.md")),
    ).toBe("two");
    expect(await fs.readFile(join(root, "remote/new.md"), "utf8")).toBe(
      "created remotely",
    );
    expect(
      (await fs.readdir(join(root, "notes"))).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
    await source.close();
  });

  it("keeps source identity stable and local state outside the synchronized folder", async () => {
    const root = await fixture();
    const first = await openSource(root);
    const second = await folderSourceIdentity(join(root, "."));
    expect(first.sourceId).toBe(second);
    expect(sourceIdentityForCanonicalRoot(first.root)).toBe(first.sourceId);
    expect(first.stateDirectory).not.toContain(first.root);
    expect(
      (await fs.readdir(root)).some((name) => name.includes("state")),
    ).toBe(false);
    await first.close();
  });

  it("moves an accidentally selected in-root state directory outside the source", async () => {
    const root = await fixture();
    const requested = join(root, ".mdevolved-state");
    const source = await createFolderSource({
      root,
      credentials: createMemoryCredentialCustody(await scopedCredential(root)),
      stateDirectory: requested,
    });
    expect(source.stateDirectory).not.toBe(requested);
    expect(source.stateDirectory).not.toContain(root);
    stateDirectories.push(source.stateDirectory);
    await source.close();
  });

  it("persists restart state without putting credentials in the source", async () => {
    const root = await fixture();
    const stateDirectory = join(root, "..", `.mdevolved-state-${randomUUID()}`);
    stateDirectories.push(stateDirectory);
    const custody = createMemoryCredentialCustody(await scopedCredential(root));
    const first = await createFolderSource({
      root,
      stateDirectory,
      credentials: custody,
    });
    expect(await first.core.start()).toBe("running");
    await first.core.rescan();
    await first.close();
    const second = await createFolderSource({
      root,
      stateDirectory,
      credentials: custody,
    });
    expect(await second.core.start()).toBe("running");
    expect(
      await second.state.read<unknown>("mdevolved/source-core/v1"),
    ).toMatchObject({ status: "running" });
    await second.close();
  });

  it("rejects credentials scoped to a different folder", async () => {
    const root = await fixture();
    await expect(
      createFolderSource({
        root,
        credentials: createMemoryCredentialCustody(credential("folder-other")),
      }),
    ).rejects.toMatchObject({ code: "credential_scope_mismatch" });
  });

  it("rejects traversal, hidden paths, symlinks, and out-of-root writes", async () => {
    const root = await fixture();
    await write(root, "good.md");
    await write(root, ".hidden.md");
    await fs.symlink(join(root, "good.md"), join(root, "linked.md"));
    const source = await openSource(root);
    await source.core.start();
    await expect(source.core.read("../outside.md")).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(source.core.read(".hidden.md")).rejects.toMatchObject({
      code: "path_invalid",
    });
    await expect(
      source.core.write("../outside.md", encoder.encode("x")),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(source.core.rescan()).rejects.toMatchObject({
      code: "invalid_path",
    });
    await source.close();
  });

  it("excludes hidden, dependency, generated, and credential-shaped content", async () => {
    const root = await fixture();
    await write(root, "keep.md");
    await write(root, ".git/history.md");
    await write(root, "node_modules/pkg.md");
    await write(root, "dist/generated.md");
    await write(root, "client-secret.md");
    await write(root, "config-token.md");
    const source = await openSource(root);
    await source.core.start();
    expect((await source.core.rescan()).files.map((file) => file.path)).toEqual(
      ["keep.md"],
    );
    await source.close();
  });

  it("fails closed for case and Unicode normalization collisions", async () => {
    const root = await fixture();
    await write(root, "Note.md");
    await write(root, "note.md");
    if (
      (await fs.readdir(root)).filter((name) => /note\.md/iu.test(name))
        .length < 2
    )
      return;
    const source = await openSource(root);
    await source.core.start();
    await expect(source.core.rescan()).rejects.toMatchObject({
      code: "path_collision",
    });
    await source.close();

    const normalizedRoot = await fixture();
    await write(normalizedRoot, "e\u0301.md");
    const normalized = await openSource(normalizedRoot);
    await normalized.core.start();
    await expect(normalized.core.rescan()).rejects.toMatchObject({
      code: "invalid_path",
    });
    await normalized.close();
  });

  it("enforces file, byte, entry, and depth ceilings", async () => {
    const root = await fixture();
    await write(root, "one.md", "1234");
    await write(root, "two.md", "5678");
    await write(root, "nested/deep.md", "9");
    const source = await openSource(root);
    await source.core.start();
    await expect(source.core.rescan({ maxBytes: 5 })).rejects.toMatchObject({
      code: "scan_limit",
    });
    await expect(source.core.rescan({ maxFiles: 1 })).rejects.toMatchObject({
      code: "scan_limit",
    });
    await expect(source.core.rescan({ maxEntries: 1 })).rejects.toMatchObject({
      code: "scan_limit",
    });
    await expect(source.core.rescan({ maxDepth: 1 })).rejects.toMatchObject({
      code: "scan_limit",
    });
    await expect(
      source.core.write("large.md", new Uint8Array(2 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "scan_limit" });
    await source.close();
  });

  it("stops I/O after revocation and after credential expiry", async () => {
    const root = await fixture();
    await write(root, "note.md");
    const custody = createMemoryCredentialCustody(await scopedCredential(root));
    const stateDirectory = join(root, "..", `.mdevolved-state-${randomUUID()}`);
    stateDirectories.push(stateDirectory);
    const source = await createFolderSource({
      root,
      credentials: custody,
      stateDirectory,
    });
    await source.core.start();
    await source.core.revoke();
    await expect(source.core.read("note.md")).rejects.toThrow(
      "source_not_running:revoked",
    );
    await source.core.replaceCredentials({
      ...(await scopedCredential(root)),
      fingerprint: "fingerprint-replacement",
    });
    expect(await source.core.read("note.md")).toBeInstanceOf(Uint8Array);
    await source.close();

    let current = 100;
    const expiredRoot = await fixture();
    await write(expiredRoot, "note.md");
    const expiredStateDirectory = join(
      expiredRoot,
      "..",
      `.mdevolved-state-${randomUUID()}`,
    );
    stateDirectories.push(expiredStateDirectory);
    const expired = await createFolderSource({
      root: expiredRoot,
      credentials: createMemoryCredentialCustody({
        ...(await scopedCredential(expiredRoot)),
        expiresAt: 200,
      }),
      stateDirectory: expiredStateDirectory,
      now: () => current,
    });
    await expired.core.start();
    current = 201;
    await expect(expired.core.read("note.md")).rejects.toThrow(
      "source_not_running:expired",
    );
    await expired.close();
  });

  it("debounces watcher hints and can be stopped cleanly", async () => {
    const root = await fixture();
    const source = await createFolderSource({
      root,
      credentials: createMemoryCredentialCustody(await scopedCredential(root)),
      stateDirectory: join(root, "..", `.mdevolved-state-${randomUUID()}`),
      debounceMs: 20,
    });
    stateDirectories.push(source.stateDirectory);
    const hints: string[] = [];
    const stop = source.watch((path) => hints.push(path));
    await fs.writeFile(join(root, "watched.md"), "first", "utf8");
    await fs.writeFile(join(root, "watched.md"), "second", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 650));
    stop();
    const count = hints.length;
    await fs.writeFile(join(root, "after-stop.md"), "ignored", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(hints.length).toBe(count);
    expect(hints.length).toBeGreaterThan(0);
    await source.close();
  });

  it("survives rapid rename/write bursts through the periodic correctness rescan", async () => {
    const root = await fixture();
    const source = await createFolderSource({
      root,
      credentials: createMemoryCredentialCustody(await scopedCredential(root)),
      stateDirectory: join(root, "..", `.mdevolved-state-${randomUUID()}`),
      debounceMs: 10,
    });
    stateDirectories.push(source.stateDirectory);
    await source.core.start();
    const hints: string[] = [];
    const stop = source.watch((path) => hints.push(path));
    await fs.writeFile(join(root, "burst.md"), "v0", "utf8");
    for (let index = 1; index <= 12; index += 1) {
      await fs.writeFile(join(root, "burst.md"), `v${index}`, "utf8");
    }
    await fs.rename(join(root, "burst.md"), join(root, "burst-renamed.md"));
    await fs.writeFile(join(root, "burst-renamed.md"), "final", "utf8");
    await waitFor(() => hints.includes(""));
    stop();

    const result = await source.core.rescan();
    expect(result.files.map((file) => file.path)).toEqual(["burst-renamed.md"]);
    expect(new TextDecoder().decode(result.files[0]?.contents)).toBe("final");
    await source.close();
  });

  it("preserves the prior file and removes its temp after an interrupted atomic write", async () => {
    const root = await fixture();
    await write(root, "note.md", "complete");
    const source = await openSource(root);
    await source.core.start();
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("synthetic interrupted rename"));
    await expect(
      source.core.write("note.md", encoder.encode("partial contents")),
    ).rejects.toMatchObject({
      code: "read_failed",
      message: "could not write source file",
    });
    rename.mockRestore();
    expect(new TextDecoder().decode(await source.core.read("note.md"))).toBe(
      "complete",
    );
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
    await source.close();
  });

  it("restarts after an offline interval and discovers durable folder changes", async () => {
    const root = await fixture();
    await write(root, "before.md", "before");
    const stateDirectory = join(root, "..", `.mdevolved-state-${randomUUID()}`);
    stateDirectories.push(stateDirectory);
    const custody = createMemoryCredentialCustody(await scopedCredential(root));
    const first = await createFolderSource({
      root,
      credentials: custody,
      stateDirectory,
    });
    await first.core.start();
    await first.core.rescan();
    await first.close();

    await fs.rm(join(root, "before.md"));
    await write(root, "after.md", "written while offline");
    const second = await createFolderSource({
      root,
      credentials: custody,
      stateDirectory,
    });
    await second.core.start();
    const result = await second.core.rescan();
    expect(result.files.map((file) => file.path)).toEqual(["after.md"]);
    expect(new TextDecoder().decode(await second.core.read("after.md"))).toBe(
      "written while offline",
    );
    await second.close();
  });

  it("scans a 2,000-file tree at the default ceiling and rejects its successor", async () => {
    const root = await fixture();
    const directoryCount = 50;
    const filesPerDirectory = 40;
    const fileBytes = 1_024;
    const contents = "x".repeat(fileBytes);
    for (let directory = 0; directory < directoryCount; directory += 1) {
      const path = join(root, `tree-${directory.toString().padStart(2, "0")}`);
      await fs.mkdir(path, { recursive: true });
      for (let file = 0; file < filesPerDirectory; file += 1) {
        await fs.writeFile(
          join(path, `note-${file.toString().padStart(2, "0")}.md`),
          contents,
          "utf8",
        );
      }
    }
    const source = await openSource(root);
    await source.core.start();
    const result = await source.core.rescan();
    expect(result.files).toHaveLength(2_000);
    expect(result.totalBytes).toBe(2_048_000);
    await write(root, "one-too-many.md", contents);
    await expect(source.core.rescan()).rejects.toMatchObject({
      code: "scan_limit",
    });
    await source.close();
  }, 30_000);

  it("rejects a selected-root symlink", async () => {
    const realRoot = await fixture();
    const linkDirectory = await fs.mkdtemp(join(tmpdir(), "mdevolved-link-"));
    extraPaths.push(linkDirectory);
    const link = join(linkDirectory, "root");
    await fs.symlink(realRoot, link);
    await expect(openSource(link)).rejects.toMatchObject({
      code: "root_invalid",
    });
  });

  it("rejects local state that resolves through a symlink into the source", async () => {
    const root = await fixture();
    const outside = await fs.mkdtemp(join(tmpdir(), "mdevolved-state-link-"));
    extraPaths.push(outside);
    const stateLink = join(outside, "state");
    await fs.symlink(root, stateLink);
    await expect(
      createFolderSource({
        root,
        credentials: createMemoryCredentialCustody(
          await scopedCredential(root),
        ),
        stateDirectory: stateLink,
      }),
    ).rejects.toMatchObject({ code: "state_invalid" });
  });

  it("reports permission failures without exposing file contents", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    await write(root, "private.md", "private content");
    const source = await openSource(root);
    await source.core.start();
    await fs.chmod(join(root, "private.md"), 0o000);
    try {
      await expect(source.core.read("private.md")).rejects.toMatchObject({
        code: "permission_denied",
      });
    } finally {
      await fs.chmod(join(root, "private.md"), 0o600);
    }
    await source.close();
  });
});
