import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  promises as fs,
  watch as watchFilesystem,
  type Dirent,
  type FSWatcher,
  type WatchEventType,
} from "node:fs";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createSourceDescriptor,
  SourceNeutralSyncCore,
  SourceScanError,
  validateMarkdownPath,
  validateRelativePath,
  type CredentialCustodyPort,
  type CredentialRecord,
  type LocalStatePort,
  type SourceCoreOptions,
  type SourceDescriptor,
  type UserInteractionPort,
  type WorkspaceEntry,
  type WorkspaceFilesPort,
} from "@mdevolved/yaos-core";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_STATE_DIRECTORY = "mdevolved";
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".owd",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

export type FolderSourceErrorCode =
  | "root_invalid"
  | "path_invalid"
  | "path_outside_root"
  | "permission_denied"
  | "read_failed"
  | "write_failed"
  | "state_invalid"
  | "credential_scope_mismatch";

export class FolderSourceError extends Error {
  readonly code: FolderSourceErrorCode;
  readonly path?: string;

  constructor(code: FolderSourceErrorCode, message: string, path?: string) {
    super(message);
    this.name = "FolderSourceError";
    this.code = code;
    this.path = path;
  }
}

export interface FolderSourceOptions {
  root: string;
  credentials: CredentialCustodyPort;
  stateDirectory?: string;
  clientVersion?: string;
  syncSchemaVersion?: number;
  pairedAt?: number;
  ui?: UserInteractionPort;
  now?: () => number;
  debounceMs?: number;
}

export interface FolderSource {
  readonly root: string;
  readonly sourceId: string;
  readonly descriptor: SourceDescriptor;
  readonly files: WorkspaceFilesPort;
  readonly state: LocalStatePort;
  readonly credentials: CredentialCustodyPort;
  readonly core: SourceNeutralSyncCore;
  readonly stateDirectory: string;
  watch(listener: (relativePath: string) => void): () => void;
  close(): Promise<void>;
}

function isPathInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
}

function isSecretShaped(path: string): boolean {
  return /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential|token|private[-_]?key).*)$/iu.test(
    path,
  );
}

function hasExcludedComponent(path: string): boolean {
  return path
    .split("/")
    .some((part) => EXCLUDED_DIRECTORIES.has(part) || part.startsWith("."));
}

function assertPortablePath(path: string, allowRoot = false): string {
  if (allowRoot && path === "") return path;
  try {
    return validateRelativePath(path);
  } catch (error) {
    if (error instanceof SourceScanError) {
      throw new FolderSourceError("path_invalid", error.message, path);
    }
    throw error;
  }
}

function assertAllowedPath(path: string): void {
  assertPortablePath(path);
  if (hasExcludedComponent(path) || isSecretShaped(path)) {
    throw new FolderSourceError(
      "path_invalid",
      "hidden, generated, dependency, or secret-shaped paths are outside the source boundary",
      path,
    );
  }
}

function assertMarkdownPath(path: string): string {
  try {
    return validateMarkdownPath(path);
  } catch (error) {
    if (error instanceof SourceScanError) {
      throw new FolderSourceError("path_invalid", error.message, path);
    }
    throw error;
  }
}

function errorCode(error: unknown): FolderSourceErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "EACCES" ||
      (error as { code?: unknown }).code === "EPERM")
  ) {
    return "permission_denied";
  }
  return "read_failed";
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function asPortablePath(root: string, candidate: string): string {
  const value = relative(root, candidate);
  if (
    value === "" ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value)
  ) {
    throw new FolderSourceError(
      "path_outside_root",
      "path resolves outside the selected folder",
      candidate,
    );
  }
  return value.split(sep).join("/");
}

async function assertRealPathInside(root: string, path: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await fs.realpath(path);
  } catch (error) {
    throw new FolderSourceError(
      errorCode(error),
      "could not resolve source path",
      path,
    );
  }
  if (!isPathInside(root, canonical)) {
    throw new FolderSourceError(
      "path_outside_root",
      "path resolves outside the selected folder",
      path,
    );
  }
}

async function lstatSafe(
  path: string,
): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function lstatWorkspace(
  path: string,
  message: string,
): Promise<import("node:fs").Stats | null> {
  try {
    return await lstatSafe(path);
  } catch (error) {
    throw new FolderSourceError(errorCode(error), message, path);
  }
}

async function ensureDirectory(
  path: string,
  selectedRoot: string,
): Promise<void> {
  const existing = await lstatSafe(path);
  if (existing?.isSymbolicLink()) {
    throw new FolderSourceError(
      "state_invalid",
      "state directory cannot be a symlink",
      path,
    );
  }
  if (existing !== null && !existing.isDirectory()) {
    throw new FolderSourceError(
      "state_invalid",
      "state path is not a directory",
      path,
    );
  }
  if (existing === null) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(path);
  if (isPathInside(selectedRoot, canonical)) {
    throw new FolderSourceError(
      "state_invalid",
      "local state must remain outside the selected folder",
      path,
    );
  }
  if (canonical !== path && (await lstatSafe(path))?.isSymbolicLink()) {
    throw new FolderSourceError(
      "state_invalid",
      "state directory cannot be a symlink",
      path,
    );
  }
}

export async function canonicalizeFolderRoot(
  selectedRoot: string,
): Promise<string> {
  if (
    typeof selectedRoot !== "string" ||
    selectedRoot.trim().length === 0 ||
    selectedRoot.includes("\u0000")
  ) {
    throw new FolderSourceError("root_invalid", "a folder path is required");
  }
  const requested = resolve(selectedRoot);
  const requestedStat = await lstatSafe(requested);
  if (
    requestedStat === null ||
    !requestedStat.isDirectory() ||
    requestedStat.isSymbolicLink()
  ) {
    throw new FolderSourceError(
      "root_invalid",
      "the selected path must be a real directory",
      requested,
    );
  }
  const canonical = await fs.realpath(requested);
  if (canonical === dirname(canonical)) {
    throw new FolderSourceError(
      "root_invalid",
      "the filesystem root is not a bounded source",
      canonical,
    );
  }
  return canonical;
}

export async function folderSourceIdentity(
  selectedRoot: string,
): Promise<string> {
  const canonical = await canonicalizeFolderRoot(selectedRoot);
  return sourceIdentityForCanonicalRoot(canonical);
}

export function sourceIdentityForCanonicalRoot(canonicalRoot: string): string {
  const normalized = resolve(canonicalRoot);
  return `folder-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

function defaultStateDirectory(): string {
  if (platform() === "win32")
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "MDevolved",
    );
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "MDevolved");
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "mdevolved",
  );
}

async function stateDirectoryFor(
  root: string,
  requested?: string,
): Promise<string> {
  const raw = resolve(
    requested ??
      join(defaultStateDirectory(), sourceIdentityForCanonicalRoot(root)),
  );
  const selected = join(
    await fs.realpath(dirname(raw)).catch(() => dirname(raw)),
    basename(raw),
  );
  if (!isPathInside(root, selected)) return selected;
  const sibling = join(
    dirname(root),
    `.${DEFAULT_STATE_DIRECTORY}-state-${sourceIdentityForCanonicalRoot(root).slice(-12)}`,
  );
  if (isPathInside(root, sibling)) {
    throw new FolderSourceError(
      "state_invalid",
      "could not place local state outside the selected folder",
      sibling,
    );
  }
  return sibling;
}

class FileStateStore implements LocalStatePort {
  constructor(private readonly directory: string) {}

  private fileFor(key: string): string {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("\u0000") ||
      key.includes("..")
    ) {
      throw new FolderSourceError("state_invalid", "state key is invalid");
    }
    return join(this.directory, `${encodeURIComponent(key)}.json`);
  }

  async read<T>(key: string): Promise<T | undefined> {
    try {
      const text = await fs.readFile(this.fileFor(key), "utf8");
      return JSON.parse(text) as T;
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof SyntaxError)
        throw new FolderSourceError(
          "state_invalid",
          "state file is not valid JSON",
        );
      throw new FolderSourceError(
        errorCode(error),
        "could not read local state",
      );
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    const file = this.fileFor(key);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await fs.open(
        temp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw new FolderSourceError(
        errorCode(error),
        "could not write local state",
      );
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.rm(this.fileFor(key));
    } catch (error) {
      if (isMissing(error)) return;
      throw new FolderSourceError(
        errorCode(error),
        "could not remove local state",
      );
    }
  }
}

class NodeFolderFiles implements WorkspaceFilesPort {
  constructor(
    private readonly root: string,
    private readonly maxFileBytes: number,
  ) {}

  private absolute(relativePath: string, allowRoot = false): string {
    const path = assertPortablePath(relativePath, allowRoot);
    if (!allowRoot || path.length > 0) assertAllowedPath(path);
    const absolute = resolve(this.root, path);
    if (!isPathInside(this.root, absolute)) {
      throw new FolderSourceError(
        "path_outside_root",
        "path resolves outside the selected folder",
        relativePath,
      );
    }
    return absolute;
  }

  async list(relativeDirectory: string): Promise<readonly WorkspaceEntry[]> {
    const directory = this.absolute(relativeDirectory, true);
    const directoryStat = await lstatWorkspace(
      directory,
      "could not inspect source directory",
    );
    if (
      directoryStat === null ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    ) {
      throw new FolderSourceError(
        "read_failed",
        "source directory is unavailable",
        relativeDirectory,
      );
    }
    await assertRealPathInside(this.root, directory);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new FolderSourceError(
        errorCode(error),
        "could not enumerate source directory",
        relativeDirectory,
      );
    }
    const result: WorkspaceEntry[] = [];
    for (const dirent of entries.sort((left, right) =>
      left.name.localeCompare(right.name, "en-US"),
    )) {
      const absolute = join(directory, dirent.name);
      const path = asPortablePath(this.root, absolute);
      const stats = await lstatWorkspace(
        absolute,
        "could not inspect source entry",
      );
      if (stats === null) continue;
      if (stats.isSymbolicLink()) {
        result.push({ path, kind: "symlink" });
        continue;
      }
      await assertRealPathInside(this.root, absolute);
      if (stats.isDirectory()) {
        result.push({ path, kind: "directory", mtimeMs: stats.mtimeMs });
      } else if (stats.isFile()) {
        result.push({
          path,
          kind: "file",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        });
      } else {
        throw new FolderSourceError(
          "read_failed",
          "unsupported filesystem entry",
          path,
        );
      }
    }
    return result;
  }

  async stat(relativePath: string): Promise<WorkspaceEntry | null> {
    const path = assertPortablePath(relativePath);
    assertAllowedPath(path);
    const absolute = this.absolute(path);
    const stats = await lstatWorkspace(
      absolute,
      "could not inspect source file",
    );
    if (stats === null) return null;
    if (stats.isSymbolicLink()) return { path, kind: "symlink" };
    await assertRealPathInside(this.root, absolute);
    if (stats.isDirectory())
      return { path, kind: "directory", mtimeMs: stats.mtimeMs };
    if (stats.isFile())
      return { path, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs };
    throw new FolderSourceError(
      "read_failed",
      "unsupported filesystem entry",
      path,
    );
  }

  async read(relativePath: string): Promise<Uint8Array> {
    const path = assertMarkdownPath(relativePath);
    const absolute = this.absolute(path);
    const stats = await lstatWorkspace(
      absolute,
      "could not inspect source file",
    );
    if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
      throw new FolderSourceError(
        "read_failed",
        "source file is unavailable",
        path,
      );
    }
    if (stats.size > this.maxFileBytes)
      throw new SourceScanError(
        "scan_limit",
        "file exceeds the size ceiling",
        path,
      );
    await assertRealPathInside(this.root, absolute);
    try {
      return new Uint8Array(await fs.readFile(absolute));
    } catch (error) {
      throw new FolderSourceError(
        errorCode(error),
        "could not read source file",
        path,
      );
    }
  }

  async write(relativePath: string, contents: Uint8Array): Promise<void> {
    const path = assertMarkdownPath(relativePath);
    if (contents.byteLength > this.maxFileBytes)
      throw new SourceScanError(
        "scan_limit",
        "file exceeds the size ceiling",
        path,
      );
    const absolute = this.absolute(path);
    const parent = dirname(absolute);
    const parentRelative = relative(this.root, parent);
    let cursor = this.root;
    for (const segment of parentRelative.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      const current = await lstatSafe(cursor);
      if (current === null) await fs.mkdir(cursor, { mode: 0o700 });
      const created = await lstatWorkspace(
        cursor,
        "could not inspect source parent directory",
      );
      if (
        created === null ||
        !created.isDirectory() ||
        created.isSymbolicLink()
      ) {
        throw new FolderSourceError(
          "write_failed",
          "source parent directory is unavailable",
          path,
        );
      }
      await assertRealPathInside(this.root, cursor);
    }
    const parentStat = await lstatWorkspace(
      parent,
      "could not inspect source parent directory",
    );
    if (
      parentStat === null ||
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink()
    ) {
      throw new FolderSourceError(
        "write_failed",
        "source parent directory is unavailable",
        path,
      );
    }
    await assertRealPathInside(this.root, parent);
    const current = await lstatWorkspace(
      absolute,
      "could not inspect source file",
    );
    if (current?.isSymbolicLink() || (current !== null && !current.isFile())) {
      throw new FolderSourceError(
        "path_invalid",
        "source path is not a regular file",
        path,
      );
    }
    if (current !== null) await assertRealPathInside(this.root, absolute);
    const temp = join(parent, `.${basename(absolute)}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(
        temp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertRealPathInside(this.root, parent);
      await fs.rename(temp, absolute);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      if (
        error instanceof SourceScanError ||
        error instanceof FolderSourceError
      )
        throw error;
      throw new FolderSourceError(
        errorCode(error),
        "could not write source file",
        path,
      );
    }
  }

  watch(listener: (relativePath: string) => void): () => void {
    return watchFolder(this.root, listener, DEFAULT_DEBOUNCE_MS);
  }
}

function watchFolder(
  root: string,
  listener: (relativePath: string) => void,
  debounceMs: number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let pendingPath = "";
  const notify = (filename: string | Buffer | null): void => {
    if (closed) return;
    if (typeof filename === "string" && filename.length > 0) {
      const candidate = filename.split(sep).join("/");
      try {
        assertPortablePath(candidate);
        pendingPath = candidate;
      } catch {
        pendingPath = "";
      }
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) listener(pendingPath);
    }, debounceMs);
    timer.unref?.();
  };
  let watcher: FSWatcher;
  try {
    watcher = watchFilesystem(
      root,
      { recursive: true, encoding: "utf8" },
      (_event: WatchEventType, filename) => notify(filename),
    );
  } catch {
    watcher = watchFilesystem(
      root,
      { encoding: "utf8" },
      (_event: WatchEventType, filename) => notify(filename),
    );
  }
  watcher.on("error", () => undefined);
  // fs.watch recursive support differs by platform. A bounded periodic rescan
  // is the correctness path; watcher events merely reduce latency.
  const rescanTimer = setInterval(
    () => {
      if (!closed) listener("");
    },
    Math.max(500, debounceMs),
  );
  rescanTimer.unref?.();
  return () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    clearInterval(rescanTimer);
    watcher.close();
  };
}

export function createMemoryCredentialCustody(
  initial: CredentialRecord | null = null,
): CredentialCustodyPort {
  let record = initial;
  return {
    async get(): Promise<CredentialRecord | null> {
      return record === null ? null : { ...record };
    },
    async confirmReplacement(next: CredentialRecord): Promise<void> {
      record = { ...next, status: "active" };
    },
    async revoke(): Promise<void> {
      if (record !== null) record = { ...record, status: "revoked" };
    },
  };
}

export async function createFolderSource(
  options: FolderSourceOptions,
): Promise<FolderSource> {
  const root = await canonicalizeFolderRoot(options.root);
  const sourceId = sourceIdentityForCanonicalRoot(root);
  const credential = await options.credentials.get();
  if (credential !== null && credential.sourceId !== sourceId) {
    throw new FolderSourceError(
      "credential_scope_mismatch",
      "protected credentials belong to a different selected folder",
    );
  }
  const stateDirectory = await stateDirectoryFor(root, options.stateDirectory);
  if (isPathInside(root, stateDirectory)) {
    throw new FolderSourceError(
      "state_invalid",
      "local state must remain outside the selected folder",
      stateDirectory,
    );
  }
  try {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  } catch {
    throw new FolderSourceError(
      "state_invalid",
      "could not create local state directory",
      stateDirectory,
    );
  }
  await ensureDirectory(stateDirectory, root);
  const credentials: CredentialCustodyPort = {
    async get(): Promise<CredentialRecord | null> {
      const record = await options.credentials.get();
      if (record !== null && record.sourceId !== sourceId) {
        throw new FolderSourceError(
          "credential_scope_mismatch",
          "protected credentials belong to a different selected folder",
        );
      }
      return record;
    },
    async confirmReplacement(record: CredentialRecord): Promise<void> {
      if (record.sourceId !== sourceId) {
        throw new FolderSourceError(
          "credential_scope_mismatch",
          "replacement credentials belong to a different selected folder",
        );
      }
      await options.credentials.confirmReplacement(record);
    },
    async revoke(): Promise<void> {
      await options.credentials.revoke();
    },
  };
  const files = new NodeFolderFiles(root, MAX_FILE_BYTES);
  const state = new FileStateStore(stateDirectory);
  const descriptor = createSourceDescriptor({
    sourceKind: "folder",
    label: basename(root),
    capabilities: ["markdown", "watch"],
    clientVersion: options.clientVersion ?? "mdevolved-folder-alpha",
    syncSchemaVersion: options.syncSchemaVersion ?? 1,
    provenance: { pairedAt: options.pairedAt ?? (options.now ?? Date.now)() },
  });
  const coreOptions: SourceCoreOptions = {
    descriptor,
    files,
    state,
    credentials,
    ...(options.ui !== undefined ? { ui: options.ui } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const core = new SourceNeutralSyncCore(coreOptions);
  const debounceMs = Math.max(
    1,
    Math.min(options.debounceMs ?? DEFAULT_DEBOUNCE_MS, 5_000),
  );
  const activeWatchers = new Set<() => void>();
  const watch = (listener: (relativePath: string) => void): (() => void) => {
    const stop = watchFolder(root, listener, debounceMs);
    const trackedStop = (): void => {
      if (!activeWatchers.delete(trackedStop)) return;
      stop();
    };
    activeWatchers.add(trackedStop);
    return trackedStop;
  };
  return {
    root,
    sourceId,
    descriptor,
    files,
    state,
    credentials,
    core,
    stateDirectory,
    watch,
    async close(): Promise<void> {
      for (const stop of activeWatchers) stop();
      await core.stop();
    },
  };
}
