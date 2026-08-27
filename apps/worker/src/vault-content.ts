import type {
  LiveMarkdownNote,
  MarkdownNoteWriteRequest,
  RestoreMarkdownNoteRequest,
} from "@mdevolved/contracts";
import {
  createNestedActiveMeta,
  decodeFileMeta,
  ensureNestedMetaEntry,
} from "@mdevolved/yaos-core";
import * as Y from "yjs";
import {
  MAX_MATERIALIZED_GENERATION_BYTES,
  MAX_MATERIALIZED_NOTES,
  MAX_MATERIALIZED_NOTE_BYTES,
  MaterializationSnapshotError,
  extractMaterializedSnapshot,
  type MaterializedSnapshot,
  type MaterializedSnapshotNote,
} from "./materialization-snapshot";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

const encoder = new TextEncoder();
const WEB_DEVICE = "owd-web";
const RESTORE_DEVICE = "owd-restore";

export type VaultContentFailureCode =
  | "generation_too_large"
  | "note_exists"
  | "note_not_found"
  | "note_stale"
  | "note_tombstoned"
  | "note_too_large"
  | "snapshot_invalid"
  | "snapshot_schema_unsupported"
  | "vault_busy"
  | "vault_not_active"
  | "vault_path_collision"
  | "vault_path_invalid"
  | "vault_persistence_unavailable";

export class VaultContentError extends Error {
  readonly code: VaultContentFailureCode;

  constructor(code: VaultContentFailureCode) {
    super(code);
    this.name = "VaultContentError";
    this.code = code;
  }
}

export type StableSnapshotNote = {
  snapshot: MaterializedSnapshot;
  note: MaterializedSnapshotNote;
};

function contentError(error: unknown): never {
  if (error instanceof VaultContentError) throw error;
  if (error instanceof MaterializationSnapshotError) {
    throw new VaultContentError(error.code);
  }
  if (error instanceof VaultPathError) {
    throw new VaultContentError("vault_path_invalid");
  }
  throw error;
}

export function readSnapshotNote(
  document: Y.Doc,
  rawPath: string,
): StableSnapshotNote {
  try {
    const requested = validateMarkdownVaultPath(rawPath);
    const snapshot = extractMaterializedSnapshot(document);
    const note = snapshot.notes.find(
      (candidate) => candidate.pathKey === requested.pathKey,
    );
    if (note === undefined) {
      throw new VaultContentError("note_not_found");
    }
    return { note, snapshot };
  } catch (error) {
    return contentError(error);
  }
}

function pathHasTombstone(document: Y.Doc, pathKey: string): boolean {
  let found = false;
  document.getMap("meta").forEach((rawMetadata) => {
    if (found) return;
    const decoded = decodeFileMeta(rawMetadata);
    if (
      decoded === null ||
      (decoded.deleted !== true && decoded.deletedAt === undefined)
    ) {
      return;
    }
    try {
      found = validateMarkdownVaultPath(decoded.path).pathKey === pathKey;
    } catch {
      // Invalid unrelated tombstones do not create a valid path identity.
    }
  });
  return found;
}

function removePathTombstones(document: Y.Doc, pathKey: string): void {
  const tombstoneIds: string[] = [];
  document.getMap("meta").forEach((rawMetadata, fileId) => {
    const decoded = decodeFileMeta(rawMetadata);
    if (
      decoded === null ||
      (decoded.deleted !== true && decoded.deletedAt === undefined)
    ) {
      return;
    }
    try {
      if (validateMarkdownVaultPath(decoded.path).pathKey === pathKey) {
        tombstoneIds.push(fileId);
      }
    } catch {
      // Invalid unrelated tombstones are not valid restore identities.
    }
  });

  if (tombstoneIds.length === 0) return;
  const tombstoneSet = new Set(tombstoneIds);
  const stalePaths: string[] = [];
  document.getMap("pathToId").forEach((fileId, path) => {
    if (typeof fileId === "string" && tombstoneSet.has(fileId)) {
      stalePaths.push(path);
    }
  });
  const metadata = document.getMap("meta");
  const text = document.getMap("idToText");
  const paths = document.getMap("pathToId");
  for (const fileId of tombstoneIds) {
    metadata.delete(fileId);
    text.delete(fileId);
  }
  for (const path of stalePaths) paths.delete(path);
}

function ensureGenerationBounds(
  snapshot: MaterializedSnapshot,
  previousByteLength: number,
  nextByteLength: number,
  creating: boolean,
): void {
  if (nextByteLength > MAX_MATERIALIZED_NOTE_BYTES) {
    throw new VaultContentError("note_too_large");
  }
  if (creating && snapshot.notes.length >= MAX_MATERIALIZED_NOTES) {
    throw new VaultContentError("generation_too_large");
  }
  if (
    snapshot.totalBytes - previousByteLength + nextByteLength >
    MAX_MATERIALIZED_GENERATION_BYTES
  ) {
    throw new VaultContentError("generation_too_large");
  }
}

function updateMetadata(
  metadata: Y.Map<unknown>,
  fileId: string,
  path: string,
  now: number,
): void {
  const entry = ensureNestedMetaEntry(metadata, fileId, {
    shape: "flat",
    path,
    mtime: now,
    device: WEB_DEVICE,
  });
  if (entry === null) throw new VaultContentError("snapshot_invalid");
  entry.set("path", path);
  entry.delete("deleted");
  entry.delete("deletedAt");
  entry.set("mtime", now);
  entry.set("device", WEB_DEVICE);
}

export function applyMarkdownNoteWrite(
  document: Y.Doc,
  request: MarkdownNoteWriteRequest,
  expectedNote: StableSnapshotNote | null,
  now: number,
  identity: { contentVersion: string; fileId: string },
): { note: LiveMarkdownNote; operation: "created" | "updated" } {
  try {
    const validated = validateMarkdownVaultPath(request.path);
    const nextByteLength = encoder.encode(request.content).byteLength;

    if (request.expectedVersion === null) {
      const snapshot = extractMaterializedSnapshot(document);
      if (snapshot.notes.some((note) => note.pathKey === validated.pathKey)) {
        throw new VaultContentError("note_exists");
      }
      if (pathHasTombstone(document, validated.pathKey)) {
        throw new VaultContentError("note_tombstoned");
      }
      ensureGenerationBounds(snapshot, 0, nextByteLength, true);

      const text = new Y.Text();
      document.transact(() => {
        if (request.content.length > 0) text.insert(0, request.content);
        document.getMap<Y.Text>("idToText").set(identity.fileId, text);
        document
          .getMap("meta")
          .set(
            identity.fileId,
            createNestedActiveMeta(validated.path, now, WEB_DEVICE),
          );
      }, WEB_DEVICE);

      return {
        note: {
          content: request.content,
          contentVersion: identity.contentVersion,
          modifiedAt: now,
          path: validated.path,
        },
        operation: "created",
      };
    }

    if (expectedNote === null) {
      throw new VaultContentError("note_not_found");
    }
    if (expectedNote.note.pathKey !== validated.pathKey) {
      throw new VaultContentError("note_not_found");
    }
    ensureGenerationBounds(
      expectedNote.snapshot,
      expectedNote.note.byteLength,
      nextByteLength,
      false,
    );

    const text = document
      .getMap<Y.Text>("idToText")
      .get(expectedNote.note.fileId);
    if (!(text instanceof Y.Text)) {
      throw new VaultContentError("snapshot_invalid");
    }

    document.transact(() => {
      if (text.length > 0) text.delete(0, text.length);
      if (request.content.length > 0) text.insert(0, request.content);
      updateMetadata(
        document.getMap("meta"),
        expectedNote.note.fileId,
        expectedNote.note.path,
        now,
      );
    }, WEB_DEVICE);

    return {
      note: {
        content: request.content,
        contentVersion: identity.contentVersion,
        modifiedAt: now,
        path: expectedNote.note.path,
      },
      operation: "updated",
    };
  } catch (error) {
    return contentError(error);
  }
}

export function applyMarkdownNoteRestore(
  document: Y.Doc,
  request: RestoreMarkdownNoteRequest,
  expectedNote: StableSnapshotNote | null,
  now: number,
  identity: { contentVersion: string; fileId: string },
): {
  note: LiveMarkdownNote;
  operation: "created" | "unchanged" | "updated";
} {
  try {
    const validated = validateMarkdownVaultPath(request.path);
    const nextByteLength = encoder.encode(request.content).byteLength;
    const modifiedAt = request.modifiedAt ?? now;

    if (expectedNote === null) {
      const snapshot = extractMaterializedSnapshot(document);
      if (snapshot.notes.some((note) => note.pathKey === validated.pathKey)) {
        throw new VaultContentError("note_stale");
      }
      ensureGenerationBounds(snapshot, 0, nextByteLength, true);
      const text = new Y.Text();
      document.transact(() => {
        removePathTombstones(document, validated.pathKey);
        if (request.content.length > 0) text.insert(0, request.content);
        document.getMap<Y.Text>("idToText").set(identity.fileId, text);
        document
          .getMap("meta")
          .set(
            identity.fileId,
            createNestedActiveMeta(validated.path, modifiedAt, RESTORE_DEVICE),
          );
      }, RESTORE_DEVICE);
      return {
        note: {
          content: request.content,
          contentVersion: identity.contentVersion,
          modifiedAt,
          path: validated.path,
        },
        operation: "created",
      };
    }

    if (expectedNote.note.pathKey !== validated.pathKey) {
      throw new VaultContentError("note_stale");
    }
    if (expectedNote.note.content === request.content) {
      return {
        note: {
          content: request.content,
          contentVersion: identity.contentVersion,
          modifiedAt: expectedNote.note.modifiedAt,
          path: expectedNote.note.path,
        },
        operation: "unchanged",
      };
    }
    ensureGenerationBounds(
      expectedNote.snapshot,
      expectedNote.note.byteLength,
      nextByteLength,
      false,
    );
    const text = document
      .getMap<Y.Text>("idToText")
      .get(expectedNote.note.fileId);
    if (!(text instanceof Y.Text)) {
      throw new VaultContentError("snapshot_invalid");
    }
    document.transact(() => {
      if (text.length > 0) text.delete(0, text.length);
      if (request.content.length > 0) text.insert(0, request.content);
      const metadata = document.getMap("meta");
      const entry = ensureNestedMetaEntry(metadata, expectedNote.note.fileId, {
        shape: "flat",
        path: expectedNote.note.path,
        mtime: modifiedAt,
        device: RESTORE_DEVICE,
      });
      if (entry === null) throw new VaultContentError("snapshot_invalid");
      entry.set("path", expectedNote.note.path);
      entry.delete("deleted");
      entry.delete("deletedAt");
      entry.set("mtime", modifiedAt);
      entry.set("device", RESTORE_DEVICE);
    }, RESTORE_DEVICE);
    return {
      note: {
        content: request.content,
        contentVersion: identity.contentVersion,
        modifiedAt,
        path: expectedNote.note.path,
      },
      operation: "updated",
    };
  } catch (error) {
    return contentError(error);
  }
}
