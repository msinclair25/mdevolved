import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FolderSyncController,
  MemorySyncController,
  decodeConnection,
  initialStatus,
} from "../src/controller.js";
import { ProtectedCredentialCustody } from "../src/custody.js";
import {
  assertBooleanArg,
  assertFolderPath,
  assertSafeNavigation,
  assertTrustedSender,
  isSyncStatus,
  selectedFolder,
} from "../src/ipc.js";
import { windowCloseAction } from "../src/lifecycle.js";
import {
  canonicalManifestPayload,
  verifyArtifactHash,
  verifyUpdateManifest,
} from "../src/updateManifest.js";

describe("desktop IPC boundary", () => {
  it("accepts only the packaged renderer as sender", () => {
    expect(() =>
      assertTrustedSender("file:///app/index.html", "file:///app/index.html"),
    ).not.toThrow();
    expect(() =>
      assertTrustedSender("https://evil.example", "file:///app/index.html"),
    ).toThrow();
    expect(() =>
      assertSafeNavigation("https://evil.example", "file:///app/index.html"),
    ).toThrow();
    expect(() => assertBooleanArg("true")).toThrow();
    expect(() => assertFolderPath("/Users/example/notes")).not.toThrow();
    expect(() => assertFolderPath("notes\0.md")).toThrow();
    expect(selectedFolder({ canceled: true, filePaths: [] })).toBeUndefined();
    expect(selectedFolder({ canceled: false, filePaths: ["/tmp/notes"] })).toBe(
      "/tmp/notes",
    );
  });

  it("recognizes a narrow status shape and rejects forged values", () => {
    expect(isSyncStatus(initialStatus())).toBe(true);
    expect(isSyncStatus({ phase: "ready" })).toBe(false);
  });
});

describe("protected credential custody", () => {
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "Keychain",
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) =>
      value.toString().replace("encrypted:", ""),
  };

  it("fails closed when Electron cannot protect credentials", () => {
    expect(() =>
      ProtectedCredentialCustody.create(
        { ...storage, isEncryptionAvailable: () => false },
        "/tmp/x",
        "darwin",
      ),
    ).toThrow();
    expect(() =>
      ProtectedCredentialCustody.create(
        { ...storage, getSelectedStorageBackend: () => "basic_text" },
        "/tmp/x",
        "linux",
      ),
    ).toThrow();
  });

  it("stores encrypted bytes without exposing them through metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mdevolved-desktop-"));
    const path = join(directory, "credential.bin");
    try {
      const custody = ProtectedCredentialCustody.create(
        storage,
        path,
        "darwin",
      );
      await custody.save("opaque-pairing-token");
      expect(custody.metadata()).toEqual({
        present: true,
        backend: "Keychain",
      });
      expect(await custody.load()).toBe("opaque-pairing-token");
      expect(await readFile(path, "utf8")).toContain("ZW5jcnlwdGVk");
      await custody.revoke();
      expect(await custody.load()).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("controller lifecycle", () => {
  it("supports folder, retry, repair and revoke transitions", async () => {
    const controller = new MemorySyncController();
    expect((await controller.selectFolder("/tmp/notes")).phase).toBe("ready");
    expect((await controller.repair()).phase).toBe("ready");
    await controller.revoke();
    expect((await controller.retry()).phase).toBe("revoked");
  });

  it("hides on close but quits after explicit quit", () => {
    expect(windowCloseAction(false)).toBe("hide");
    expect(windowCloseAction(true)).toBe("quit");
  });

  it("retains a valid pairing request until a folder is selected", async () => {
    const controller = new FolderSyncController(() => undefined);
    const status = await controller.pair?.(
      `mdevolved://connect?deployment=${encodeURIComponent("https://example.com")}&grant=${"a".repeat(24)}`,
    );
    expect(status?.phase).toBe("unconfigured");
    expect(status?.message).toContain("Choose the folder");
  });

  it("rejects malformed protected connection records before network use", () => {
    const valid = {
      sourceId: `folder-${"a".repeat(32)}`,
      connection: {
        host: "https://example.com",
        token: "a".repeat(24),
        vaultId: "00000000-0000-4000-8000-000000000001",
        fingerprint: "b".repeat(64),
        rootFingerprintSha256: "c".repeat(64),
        issuedAt: 1,
        expiresAt: 2,
      },
    };
    expect(decodeConnection(JSON.stringify(valid))).toEqual(valid);
    expect(
      decodeConnection(
        JSON.stringify({ ...valid, folderPath: "/tmp/synthetic-project" }),
      ),
    ).toEqual({ ...valid, folderPath: "/tmp/synthetic-project" });
    expect(
      decodeConnection(JSON.stringify({ ...valid, folderPath: "bad\npath" })),
    ).toBeNull();
    expect(
      decodeConnection(
        JSON.stringify({
          ...valid,
          connection: { ...valid.connection, host: "http://evil.example" },
        }),
      ),
    ).toBeNull();
    expect(
      decodeConnection(
        JSON.stringify({
          ...valid,
          connection: {
            ...valid.connection,
            rootFingerprintSha256: "wrong",
          },
        }),
      ),
    ).toBeNull();
    expect(
      decodeConnection(
        JSON.stringify({
          ...valid,
          connection: { ...valid.connection, token: "short" },
        }),
      ),
    ).toBeNull();
    expect(
      decodeConnection(
        JSON.stringify({
          ...valid,
          sourceId: `folder-${"z".repeat(32)}`,
        }),
      ),
    ).toBeNull();
  });
});

describe("signed update manifest", () => {
  const base = {
    format: "mdevolved-update/v1" as const,
    version: "1.2.0",
    platform: "darwin-arm64" as const,
    url: "https://updates.example/mdevolved-1.2.0.dmg",
    sha256: "a".repeat(64),
    keyId: "release-2026",
  };

  it("accepts a signed newer platform manifest", async () => {
    const payload = canonicalManifestPayload(base);
    const manifest = { ...base, signature: `sig:${payload}` };
    const verified = await verifyUpdateManifest(
      manifest,
      "darwin-arm64",
      "1.1.0",
      {
        verify: async (candidate, signature, keyId) =>
          candidate === payload &&
          signature === `sig:${payload}` &&
          keyId === "release-2026",
      },
    );
    expect(verified.sha256).toBe(base.sha256);
  });

  it.each([
    ["wrong platform", { platform: "linux-x64" }],
    ["old version", { version: "1.0.0" }],
    ["bad hash", { sha256: "not-a-hash" }],
    ["unsafe URL", { url: "http://updates.example/file" }],
  ])("rejects %s", async (_label, patch) => {
    await expect(
      verifyUpdateManifest(
        { ...base, ...patch, signature: "signature-long-enough" },
        "darwin-arm64",
        "1.1.0",
        { verify: async () => true },
      ),
    ).rejects.toThrow();
  });

  it("rejects a forged signature", async () => {
    await expect(
      verifyUpdateManifest(
        { ...base, signature: "signature-long-enough" },
        "darwin-arm64",
        "1.1.0",
        { verify: async () => false },
      ),
    ).rejects.toThrow("signature");
  });

  it("rejects an installer whose bytes do not match the signed hash", () => {
    expect(
      verifyArtifactHash(new TextEncoder().encode("installer"), "a".repeat(64)),
    ).toBe(false);
  });
});
