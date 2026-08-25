import { decideClosedFileConflict } from "./closedFileConflict";
import { validateRelativePath } from "./sourceBoundary";
import type {
  LocalStatePort,
  SourceNeutralSyncCore,
  WorkspaceEntry,
} from "./sourceBoundary";

const BASELINE_KEY = "mdevolved/folder-reconciliation/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface BaselineState {
  version: 1;
  savedAt: number;
  hashes: Record<string, string>;
}

export interface MarkdownRemotePort {
  listPaths(): readonly string[];
  read(path: string): string | null;
  write(path: string, contents: string): Promise<void> | void;
  isTombstoned(path: string): boolean;
  confirmDurable(): Promise<boolean>;
}

export interface FolderReconciliationOptions {
  maxFileBytes: number;
  now?: () => number;
}

export interface FolderReconciliationResult {
  conflicts: readonly string[];
  diskWrites: number;
  remoteWrites: number;
  skippedOversize: readonly string[];
  durable: boolean;
}

function readBaseline(value: unknown): BaselineState {
  if (typeof value !== "object" || value === null) {
    return { version: 1, savedAt: 0, hashes: {} };
  }
  const record = value as Partial<BaselineState>;
  if (
    record.version !== 1 ||
    !Number.isFinite(record.savedAt) ||
    typeof record.hashes !== "object" ||
    record.hashes === null
  ) {
    return { version: 1, savedAt: 0, hashes: {} };
  }
  const hashes = Object.fromEntries(
    Object.entries(record.hashes).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /^[0-9a-f]{64}$/u.test(entry[1]),
    ),
  );
  return { version: 1, savedAt: record.savedAt ?? 0, hashes };
}

async function sha256(contents: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(contents),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function conflictPath(
  path: string,
  now: number,
  side: "disk" | "remote",
): string {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const filename = slash < 0 ? path : path.slice(slash + 1);
  const stem = filename.toLowerCase().endsWith(".md")
    ? filename.slice(0, -3)
    : filename;
  const stamp = new Date(now).toISOString().replace(/[.:]/gu, "-");
  return `${directory}${stem.slice(0, 120)} (MDevolved conflict ${side} ${stamp}).md`;
}

async function safeText(
  files: SourceNeutralSyncCore,
  entry: WorkspaceEntry,
  maxFileBytes: number,
): Promise<string | null> {
  try {
    const contents = await files.read(entry.path);
    if (contents.byteLength > maxFileBytes) return null;
    return decoder.decode(contents);
  } catch (error) {
    throw new Error(`source_markdown_invalid_utf8:${entry.path}`, {
      cause: error,
    });
  }
}

/**
 * Reconcile one bounded folder snapshot against the existing YAOS document.
 * The remote port is an adapter over the current VaultSync engine, so this
 * service owns no transport, retry, credential, or CRDT implementation.
 */
export async function reconcileFolder(
  files: SourceNeutralSyncCore,
  state: LocalStatePort,
  remote: MarkdownRemotePort,
  options: FolderReconciliationOptions,
): Promise<FolderReconciliationResult> {
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1) {
    throw new TypeError("max_file_bytes_invalid");
  }
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new TypeError("reconciliation_time_invalid");
  const baseline = readBaseline(await state.read<unknown>(BASELINE_KEY));
  const entries = await files.listMarkdown();
  const eligible = entries.filter(
    (entry) =>
      entry.kind === "file" && (entry.size ?? 0) <= options.maxFileBytes,
  );
  const skippedOversize = entries
    .filter((entry) => (entry.size ?? 0) > options.maxFileBytes)
    .map((entry) => entry.path);
  const disk = new Map<string, { contents: string; entry: WorkspaceEntry }>();
  for (const entry of eligible) {
    const contents = await safeText(files, entry, options.maxFileBytes);
    if (contents === null) {
      skippedOversize.push(entry.path);
      continue;
    }
    disk.set(entry.path, { contents, entry });
  }
  const remotePaths = new Set(
    remote.listPaths().map((path) => validateRelativePath(path)),
  );
  const paths = new Set([...disk.keys(), ...remotePaths]);
  const occupiedPaths = new Set(paths);
  const nextHashes: Record<string, string> = {};
  const conflicts: string[] = [];
  let diskWrites = 0;
  let remoteWrites = 0;

  for (const path of [...paths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const local = disk.get(path);
    const remoteContents = remote.read(path);
    if (
      remoteContents !== null &&
      encoder.encode(remoteContents).byteLength > options.maxFileBytes
    ) {
      throw new Error(`remote_markdown_oversize:${path}`);
    }
    if (local === undefined) {
      if (remoteContents === null) continue;
      await files.write(path, encoder.encode(remoteContents));
      diskWrites += 1;
      nextHashes[path] = await sha256(remoteContents);
      continue;
    }
    if (remoteContents === null) {
      if (remote.isTombstoned(path)) {
        conflicts.push(path);
        continue;
      }
      await remote.write(path, local.contents);
      remoteWrites += 1;
      nextHashes[path] = await sha256(local.contents);
      continue;
    }
    const [diskHash, remoteHash] = await Promise.all([
      sha256(local.contents),
      sha256(remoteContents),
    ]);
    const decision = decideClosedFileConflict({
      baselineHash: baseline.hashes[path] ?? null,
      diskHash,
      crdtHash: remoteHash,
      ...(local.entry.mtimeMs === undefined
        ? {}
        : { diskMtime: local.entry.mtimeMs }),
      lastDiskIndexPersistedAt: baseline.savedAt,
    });
    switch (decision.kind) {
      case "no-op":
        nextHashes[path] = diskHash;
        break;
      case "apply-remote-to-disk":
        await files.write(path, encoder.encode(remoteContents));
        diskWrites += 1;
        nextHashes[path] = remoteHash;
        break;
      case "import-disk-to-crdt":
        await remote.write(path, local.contents);
        remoteWrites += 1;
        nextHashes[path] = diskHash;
        break;
      case "preserve-conflict": {
        const preserved = decision.preserveCrdt
          ? remoteContents
          : local.contents;
        const side = decision.preserveCrdt ? "remote" : "disk";
        let artifact = conflictPath(path, now, side);
        for (let suffix = 2; occupiedPaths.has(artifact); suffix += 1) {
          artifact = conflictPath(path, now + suffix, side);
        }
        occupiedPaths.add(artifact);
        await files.write(artifact, encoder.encode(preserved));
        diskWrites += 1;
        conflicts.push(artifact);
        if (decision.winner === "disk") {
          await remote.write(path, local.contents);
          remoteWrites += 1;
          nextHashes[path] = diskHash;
        } else {
          await files.write(path, encoder.encode(remoteContents));
          diskWrites += 1;
          nextHashes[path] = remoteHash;
        }
        break;
      }
    }
  }

  const durable = remoteWrites === 0 ? true : await remote.confirmDurable();
  if (remoteWrites > 0 && !durable)
    throw new Error("remote_receipt_unconfirmed");
  await state.write<BaselineState>(BASELINE_KEY, {
    version: 1,
    savedAt: now,
    hashes: nextHashes,
  });
  return { conflicts, diskWrites, remoteWrites, skippedOversize, durable };
}
