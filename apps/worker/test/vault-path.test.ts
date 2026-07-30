import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import fixtureFile from "../../../packages/yaos-core/fixtures/schema-compatibility.json";
import {
  MaterializationSnapshotError,
  extractMaterializedSnapshot,
} from "../src/materialization-snapshot";
import { VaultPathError, validateMarkdownVaultPath } from "../src/vault-path";

const rejectedPaths = [
  "",
  "/absolute.md",
  "C:/drive.md",
  "../escape.md",
  "folder/../escape.md",
  "./note.md",
  "folder//note.md",
  "folder\\note.md",
  "folder/",
  ".obsidian/config.md",
  ".OBSIDIAN/plugins/data.md",
  "NUL.md",
  "folder/COM1.txt.md",
  "trailing-dot./note.md",
  "trailing-space /note.md",
  "bad:name.md",
  "not-markdown.txt",
  "zero\u200Bwidth.md",
  "line\nfeed.md",
  "Cafe\u0301.md",
] as const;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe("vault path policy", () => {
  for (const path of rejectedPaths) {
    it(`rejects ${JSON.stringify(path)}`, () => {
      expect(() => validateMarkdownVaultPath(path)).toThrow(VaultPathError);
    });
  }

  it("accepts a normalized nested Unicode Markdown path", () => {
    expect(validateMarkdownVaultPath("Projets/Café/Été.md")).toEqual({
      path: "Projets/Café/Été.md",
      pathKey: "projets/café/été.md",
      title: "Été",
    });
  });

  it("retains a stable reason for the browser-independent security boundary", () => {
    expect(() => validateMarkdownVaultPath(".obsidian/data.md")).toThrowError(
      expect.objectContaining<Partial<VaultPathError>>({
        reason: "obsidian",
      }),
    );
  });

  it("enforces segment limits in UTF-8 bytes", () => {
    const maximum = `${"é".repeat(126)}.md`;
    expect(validateMarkdownVaultPath(maximum).path).toBe(maximum);
    expect(() =>
      validateMarkdownVaultPath(`${"é".repeat(127)}.md`),
    ).toThrowError(
      expect.objectContaining<Partial<VaultPathError>>({
        reason: "segment_too_long",
      }),
    );
  });

  for (const fixture of fixtureFile.fixtures) {
    it(`extracts the pinned schema v${fixture.schemaVersion} fixture`, () => {
      const document = new Y.Doc();
      Y.applyUpdate(document, decodeBase64(fixture.updateBase64));
      const snapshot = extractMaterializedSnapshot(document);

      expect(snapshot.schemaVersion).toBe(fixture.schemaVersion);
      expect(snapshot.notes).toContainEqual(
        expect.objectContaining({
          content: fixture.content,
          fileId: fixture.fileId,
          path: fixture.path,
        }),
      );
      document.destroy();
    });
  }

  it("rejects case-insensitive collisions for a whole generation", () => {
    const document = new Y.Doc();
    document.getMap("sys").set("schemaVersion", 3);
    for (const [fileId, path] of [
      ["first", "Folder/Note.md"],
      ["second", "folder/note.md"],
    ] as const) {
      const metadata = new Y.Map<unknown>();
      metadata.set("path", path);
      document.getMap("meta").set(fileId, metadata);
      document.getMap<Y.Text>("idToText").set(fileId, new Y.Text("safe"));
    }

    expect(() => extractMaterializedSnapshot(document)).toThrowError(
      expect.objectContaining<Partial<MaterializationSnapshotError>>({
        code: "vault_path_collision",
      }),
    );
    document.destroy();
  });
});
