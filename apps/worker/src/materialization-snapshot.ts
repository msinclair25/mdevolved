import {
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  decodeFileMeta,
} from "@owd/yaos-core";
import * as Y from "yjs";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

export const MAX_MATERIALIZED_NOTES = 2_000;
export const MAX_MATERIALIZED_NOTE_BYTES = 1024 * 1024;
export const MAX_MATERIALIZED_GENERATION_BYTES = 32 * 1024 * 1024;

const encoder = new TextEncoder();

export type MaterializationFailureCode =
  | "generation_too_large"
  | "note_too_large"
  | "snapshot_invalid"
  | "snapshot_schema_unsupported"
  | "vault_path_collision"
  | "vault_path_invalid";

export class MaterializationSnapshotError extends Error {
  readonly code: MaterializationFailureCode;

  constructor(code: MaterializationFailureCode) {
    super(code);
    this.name = "MaterializationSnapshotError";
    this.code = code;
  }
}

export type MaterializedSnapshotNote = {
  byteLength: number;
  content: string;
  fileId: string;
  modifiedAt: number | null;
  path: string;
  pathKey: string;
  title: string;
};

export type MaterializedSnapshot = {
  notes: MaterializedSnapshotNote[];
  schemaVersion: number;
  totalBytes: number;
};

type Candidate = {
  fileId: string;
  modifiedAt: number | null;
  path: string;
};

function candidateIsNewer(candidate: Candidate, existing: Candidate): boolean {
  const candidateMtime = candidate.modifiedAt ?? 0;
  const existingMtime = existing.modifiedAt ?? 0;
  if (candidateMtime !== existingMtime) return candidateMtime > existingMtime;
  return candidate.fileId > existing.fileId;
}

function activeCandidates(document: Y.Doc, schemaVersion: number): Candidate[] {
  const metadata = document.getMap("meta");
  const candidates = new Map<string, Candidate>();

  const add = (candidate: Candidate) => {
    const existing = candidates.get(candidate.path);
    if (existing === undefined || candidateIsNewer(candidate, existing)) {
      candidates.set(candidate.path, candidate);
    }
  };

  if (schemaVersion >= 2) {
    metadata.forEach((rawMetadata, fileId) => {
      const decoded = decodeFileMeta(rawMetadata);
      if (decoded === null) {
        throw new MaterializationSnapshotError("snapshot_invalid");
      }
      if (decoded.deleted === true || decoded.deletedAt !== undefined) return;
      add({
        fileId,
        modifiedAt: decoded.mtime ?? null,
        path: decoded.path,
      });
    });
    return [...candidates.values()];
  }

  document.getMap("pathToId").forEach((rawFileId, path) => {
    if (typeof rawFileId !== "string" || rawFileId.length === 0) {
      throw new MaterializationSnapshotError("snapshot_invalid");
    }
    const decoded = decodeFileMeta(metadata.get(rawFileId));
    if (decoded?.deleted === true || decoded?.deletedAt !== undefined) return;
    add({ fileId: rawFileId, modifiedAt: decoded?.mtime ?? null, path });
  });

  metadata.forEach((rawMetadata, fileId) => {
    const decoded = decodeFileMeta(rawMetadata);
    if (decoded === null) {
      throw new MaterializationSnapshotError("snapshot_invalid");
    }
    if (
      decoded.deleted === true ||
      decoded.deletedAt !== undefined ||
      candidates.has(decoded.path)
    ) {
      return;
    }
    add({
      fileId,
      modifiedAt: decoded.mtime ?? null,
      path: decoded.path,
    });
  });

  return [...candidates.values()];
}

export function extractMaterializedSnapshot(
  document: Y.Doc,
): MaterializedSnapshot {
  const rawSchemaVersion = document.getMap("sys").get("schemaVersion");
  if (
    typeof rawSchemaVersion !== "number" ||
    !Number.isInteger(rawSchemaVersion) ||
    rawSchemaVersion < SERVER_MIN_SCHEMA_VERSION ||
    rawSchemaVersion > SERVER_MAX_SCHEMA_VERSION
  ) {
    throw new MaterializationSnapshotError("snapshot_schema_unsupported");
  }

  const idToText = document.getMap("idToText");
  const notes: MaterializedSnapshotNote[] = [];
  const canonicalPaths = new Map<string, string>();
  let totalBytes = 0;

  for (const candidate of activeCandidates(document, rawSchemaVersion)) {
    let validated;
    try {
      validated = validateMarkdownVaultPath(candidate.path);
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new MaterializationSnapshotError("vault_path_invalid");
      }
      throw error;
    }

    const existingPath = canonicalPaths.get(validated.pathKey);
    if (existingPath !== undefined && existingPath !== validated.path) {
      throw new MaterializationSnapshotError("vault_path_collision");
    }
    canonicalPaths.set(validated.pathKey, validated.path);

    const text = idToText.get(candidate.fileId);
    if (!(text instanceof Y.Text)) {
      throw new MaterializationSnapshotError("snapshot_invalid");
    }
    const content = text.toString();
    const byteLength = encoder.encode(content).byteLength;
    if (byteLength > MAX_MATERIALIZED_NOTE_BYTES) {
      throw new MaterializationSnapshotError("note_too_large");
    }

    totalBytes += byteLength;
    if (
      notes.length >= MAX_MATERIALIZED_NOTES ||
      totalBytes > MAX_MATERIALIZED_GENERATION_BYTES
    ) {
      throw new MaterializationSnapshotError("generation_too_large");
    }

    notes.push({
      ...validated,
      byteLength,
      content,
      fileId: candidate.fileId,
      modifiedAt: candidate.modifiedAt,
    });
  }

  notes.sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  return { notes, schemaVersion: rawSchemaVersion, totalBytes };
}
