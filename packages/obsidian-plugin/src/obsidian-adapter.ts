import {
  createSourceDescriptor,
  type CredentialRecord,
  type LocalStatePort,
  SourceNeutralSyncCore,
  type UserInteractionPort,
  validateMarkdownPath,
  type WorkspaceEntry,
  type WorkspaceFilesPort,
} from "@mdevolved/yaos-core";
import { Notice, TFile, TFolder, type App, type EventRef } from "obsidian";
import type {
  SourceAdapterBoundary,
  SourceAdapterOptions,
} from "../vendor/yaos-src/runtime/sourceAdapterPort";

export interface ObsidianAdapterOptions extends SourceAdapterOptions {
  app: App;
}

function workspaceEntry(file: TFile | TFolder): WorkspaceEntry {
  if (file instanceof TFolder) {
    return { path: file.path, kind: "directory" };
  }
  return {
    path: file.path,
    kind: "file",
    mtimeMs: file.stat.mtime,
    size: file.stat.size,
  };
}

export function createObsidianWorkspaceFilesPort(
  app: App,
  getMaxWriteBytes: () => number,
): WorkspaceFilesPort {
  return {
    async list(relativeDirectory) {
      const parent =
        relativeDirectory === ""
          ? app.vault.getRoot()
          : app.vault.getAbstractFileByPath(relativeDirectory);
      return parent instanceof TFolder
        ? parent.children.flatMap((child) =>
            child instanceof TFile || child instanceof TFolder
              ? [workspaceEntry(child)]
              : [],
          )
        : [];
    },
    async stat(relativePath) {
      const file = app.vault.getAbstractFileByPath(relativePath);
      return file instanceof TFile || file instanceof TFolder
        ? workspaceEntry(file)
        : null;
    },
    async read(relativePath) {
      const path = validateMarkdownPath(relativePath);
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        throw new Error(`source_file_not_found:${path}`);
      }
      return new TextEncoder().encode(await app.vault.read(file));
    },
    async write(relativePath, contents) {
      const path = validateMarkdownPath(relativePath);
      const maxWriteBytes = getMaxWriteBytes();
      if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes < 1) {
        throw new TypeError("source_write_ceiling_invalid");
      }
      if (contents.byteLength > maxWriteBytes) {
        throw new Error(`source_file_oversized:${path}`);
      }
      const current = app.vault.getAbstractFileByPath(path);
      const text = new TextDecoder().decode(contents);
      if (current instanceof TFile) {
        await app.vault.modify(current, text);
        return;
      }
      if (current !== null) {
        throw new Error(`source_path_not_file:${path}`);
      }
      const slash = path.lastIndexOf("/");
      if (slash > 0) {
        const parts = path.slice(0, slash).split("/");
        for (let index = 1; index <= parts.length; index += 1) {
          const directory = parts.slice(0, index).join("/");
          if (!app.vault.getAbstractFileByPath(directory)) {
            await app.vault.createFolder(directory);
          }
        }
      }
      await app.vault.create(path, text);
    },
    watch(listener) {
      const refs: EventRef[] = [
        app.vault.on("create", (file) => listener(file.path)),
        app.vault.on("modify", (file) => listener(file.path)),
        app.vault.on("delete", (file) => listener(file.path)),
        app.vault.on("rename", (file) => listener(file.path)),
      ];
      return () => {
        for (const ref of refs) app.vault.offref(ref);
      };
    },
  };
}

async function credentialFingerprint(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createObsidianSourceAdapter(
  options: ObsidianAdapterOptions,
): SourceAdapterBoundary {
  const files = createObsidianWorkspaceFilesPort(
    options.app,
    options.getMaxWriteBytes,
  );
  const state: LocalStatePort = {
    read: (key) => options.readState(key),
    write: (key, value) => options.writeState(key, value),
    remove: (key) => options.removeState(key),
  };
  const currentCredential = async (): Promise<CredentialRecord | null> => {
    const { sourceId, token } = options.getConnection();
    if (sourceId.trim() === "" || token === "") return null;
    return {
      sourceId,
      fingerprint: await credentialFingerprint(token),
      status: "active",
      issuedAt: 0,
    };
  };
  const credentials = {
    get: currentCredential,
    async confirmReplacement(record: CredentialRecord) {
      const current = await currentCredential();
      if (
        current === null ||
        current.sourceId !== record.sourceId ||
        current.fingerprint !== record.fingerprint
      ) {
        throw new Error("source_credential_requires_pairing");
      }
    },
    async revoke() {
      // The core persists only the revoked fingerprint. Raw pairing material
      // remains owned by Obsidian's existing settings storage.
    },
  };
  const ui: UserInteractionPort = {
    emit(event) {
      if (event.kind === "status") {
        options.onStatus(event.status);
        return;
      }
      if (event.kind === "error") {
        new Notice(`MDevolved Sync for Obsidian: ${event.message}`, 8000);
        return;
      }
      if (event.kind === "message") {
        new Notice(event.message, event.durationMs);
      }
    },
  };
  const descriptor = createSourceDescriptor({
    sourceKind: "obsidian",
    label: options.app.vault.getName() || "Obsidian vault",
    capabilities: ["markdown", "editor-integration", "watch"],
    clientVersion: options.clientVersion,
    syncSchemaVersion: options.syncSchemaVersion,
    provenance: { pairedAt: 0 },
  });
  return {
    core: new SourceNeutralSyncCore({
      credentials,
      descriptor,
      files,
      state,
      ui,
    }),
    interaction: ui,
    currentCredential,
  };
}
