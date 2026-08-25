/**
 * Source-neutral local sync boundary.
 *
 * This module deliberately contains no Obsidian or platform imports. Adapters
 * provide the four small ports and the core owns validation, bounded scans,
 * and lifecycle state.
 */

export type SourceKind = "folder" | "obsidian";

export type SourceCapability =
  "markdown" | "attachments" | "editor-integration" | "watch";

export interface SourceProvenance {
  pairedAt: number;
  pairingId?: string;
  changedAt?: number;
}

export interface SourceDescriptor {
  descriptorVersion: 1;
  sourceKind: SourceKind;
  label: string;
  capabilities: readonly SourceCapability[];
  clientVersion: string;
  syncSchemaVersion: number;
  provenance: SourceProvenance;
}

export interface SourceDescriptorInput {
  sourceKind?: SourceKind;
  label: string;
  capabilities?: readonly SourceCapability[];
  clientVersion: string;
  syncSchemaVersion: number;
  provenance: SourceProvenance;
}

/** Decode an old record with no source descriptor as the existing Obsidian source. */
export function normalizeSourceDescriptor(
  value: Partial<SourceDescriptor> | null | undefined,
): SourceDescriptor {
  return createSourceDescriptor({
    sourceKind: value?.sourceKind ?? "obsidian",
    label: value?.label ?? "Obsidian vault",
    capabilities: value?.capabilities ?? [
      "markdown",
      "attachments",
      "editor-integration",
      "watch",
    ],
    clientVersion: value?.clientVersion ?? "legacy",
    syncSchemaVersion: value?.syncSchemaVersion ?? 1,
    provenance: value?.provenance ?? { pairedAt: 0 },
  });
}

export function createSourceDescriptor(
  input: SourceDescriptorInput,
): SourceDescriptor {
  if (
    input.sourceKind !== undefined &&
    input.sourceKind !== "folder" &&
    input.sourceKind !== "obsidian"
  ) {
    throw new TypeError("source_kind_invalid");
  }
  if (input.label.trim().length === 0 || input.label.includes("\u0000")) {
    throw new TypeError("source_label_invalid");
  }
  if (
    !Number.isSafeInteger(input.syncSchemaVersion) ||
    input.syncSchemaVersion < 1
  ) {
    throw new TypeError("sync_schema_version_invalid");
  }
  if (
    !Number.isFinite(input.provenance.pairedAt) ||
    input.provenance.pairedAt < 0
  ) {
    throw new TypeError("source_provenance_invalid");
  }
  const capabilities = [
    ...new Set(input.capabilities ?? ["markdown"]),
  ] as SourceCapability[];
  const allowed = new Set<SourceCapability>([
    "markdown",
    "attachments",
    "editor-integration",
    "watch",
  ]);
  if (capabilities.some((capability) => !allowed.has(capability))) {
    throw new TypeError("source_capability_invalid");
  }
  return {
    descriptorVersion: 1,
    sourceKind: input.sourceKind ?? "obsidian",
    label: input.label,
    capabilities,
    clientVersion: input.clientVersion,
    syncSchemaVersion: input.syncSchemaVersion,
    provenance: { ...input.provenance },
  };
}

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  mtimeMs?: number;
}

/** Filesystem adapter. Every path is relative to the selected source root. */
export interface WorkspaceFilesPort {
  list(relativeDirectory: string): Promise<readonly WorkspaceEntry[]>;
  stat(relativePath: string): Promise<WorkspaceEntry | null>;
  read(relativePath: string): Promise<Uint8Array>;
  write(relativePath: string, contents: Uint8Array): Promise<void>;
  watch(listener: (relativePath: string) => void): () => void;
}

export interface LocalStatePort {
  read<T>(key: string): Promise<T | undefined>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CredentialRecord {
  sourceId: string;
  fingerprint: string;
  status: "active" | "revoked";
  issuedAt: number;
  expiresAt?: number;
}

/** Credential bytes stay inside the adapter; the core sees only custody metadata. */
export interface CredentialCustodyPort {
  get(): Promise<CredentialRecord | null>;
  /** Confirm that the adapter has already installed this opaque credential. */
  confirmReplacement(record: CredentialRecord): Promise<void>;
  revoke(): Promise<void>;
}

export type UserInteractionEvent =
  | { kind: "status"; status: SourceCoreStatus }
  | {
      kind: "message";
      level: "info" | "warning";
      message: string;
      durationMs?: number;
    }
  | { kind: "error"; code: string; message: string }
  | { kind: "consent-required"; descriptor: SourceDescriptor };

export interface UserInteractionPort {
  emit(event: UserInteractionEvent): Promise<void> | void;
}

export interface MarkdownFile {
  path: string;
  size: number;
  mtimeMs?: number;
  contents: Uint8Array;
}

export interface MarkdownScanOptions {
  maxEntries: number;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxDepth: number;
  concurrency: number;
}

export interface MarkdownScanResult {
  files: readonly MarkdownFile[];
  totalBytes: number;
  scanId: string;
}

export type SourceScanErrorCode =
  "invalid_path" | "path_collision" | "scan_limit" | "read_failed";

export class SourceScanError extends Error {
  readonly code: SourceScanErrorCode;
  readonly path?: string;

  constructor(code: SourceScanErrorCode, message: string, path?: string) {
    super(message);
    this.name = "SourceScanError";
    this.code = code;
    this.path = path;
  }
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".owd",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function isSecretShaped(path: string): boolean {
  return /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|credential|token|private[-_]?key).*)$/iu.test(
    path,
  );
}

/** Validate and return a portable relative path. */
export function validateRelativePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\u0000")
  ) {
    throw new SourceScanError(
      "invalid_path",
      "path must be a non-empty relative path",
      path,
    );
  }
  if (path !== path.normalize("NFC")) {
    throw new SourceScanError(
      "invalid_path",
      "path must use NFC Unicode",
      path,
    );
  }
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.includes("\\")
  ) {
    throw new SourceScanError(
      "invalid_path",
      "path must use portable relative separators",
      path,
    );
  }
  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new SourceScanError(
      "invalid_path",
      "path contains an invalid segment",
      path,
    );
  }
  return path;
}

function depth(path: string): number {
  return path.split("/").length;
}

function shouldExclude(path: string, kind: WorkspaceEntry["kind"]): boolean {
  const parts = path.split("/");
  const leaf = parts.at(-1) ?? "";
  if (
    parts
      .slice(0, -1)
      .some((part) => part.startsWith(".") || EXCLUDED_DIRECTORIES.has(part))
  ) {
    return true;
  }
  if (kind === "directory")
    return EXCLUDED_DIRECTORIES.has(leaf) || leaf.startsWith(".");
  return leaf.startsWith(".") || isSecretShaped(path) || !/\.md$/iu.test(leaf);
}

function scanFingerprint(files: readonly MarkdownFile[]): string {
  let hash = 2166136261;
  for (const file of files) {
    const value = `${file.path}\u0000${file.size}\u0000${file.mtimeMs ?? ""}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    for (const byte of file.contents) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const DEFAULT_SCAN_OPTIONS: MarkdownScanOptions = {
  maxEntries: 10_000,
  maxFiles: 2_000,
  maxBytes: 20 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  concurrency: 8,
};

function boundedOptions(options: MarkdownScanOptions): MarkdownScanOptions {
  const values = Object.values(options);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new SourceScanError(
      "scan_limit",
      "scan ceilings must be positive integers",
    );
  }
  return {
    maxEntries: options.maxEntries,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    maxFileBytes: options.maxFileBytes,
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
  };
}

export type MarkdownListOptions = Pick<
  MarkdownScanOptions,
  "maxEntries" | "maxFiles" | "maxDepth"
>;

/** Enumerate Markdown metadata without reading file contents. */
export async function listMarkdown(
  workspace: WorkspaceFilesPort,
  suppliedOptions?: Partial<MarkdownListOptions>,
): Promise<readonly WorkspaceEntry[]> {
  const options = boundedOptions({
    ...DEFAULT_SCAN_OPTIONS,
    ...suppliedOptions,
  });
  const directories = [""];
  const entries: WorkspaceEntry[] = [];
  const seen = new Map<string, string>();
  let scannedEntryCount = 0;
  while (directories.length > 0) {
    const directory = directories.shift() ?? "";
    const listed = await workspace.list(directory);
    for (const entry of listed) {
      scannedEntryCount += 1;
      if (scannedEntryCount > options.maxEntries) {
        throw new SourceScanError(
          "scan_limit",
          "workspace entry count exceeds the scan ceiling",
        );
      }
      const path = validateRelativePath(entry.path);
      const canonical = path.toLocaleLowerCase("en-US");
      const previous = seen.get(canonical);
      if (previous !== undefined && previous !== path) {
        throw new SourceScanError(
          "path_collision",
          "paths collide on portable filesystems",
          path,
        );
      }
      if (previous !== undefined) {
        throw new SourceScanError("path_collision", "duplicate path", path);
      }
      seen.set(canonical, path);
      if (depth(path) > options.maxDepth) {
        throw new SourceScanError(
          "scan_limit",
          "path exceeds the maximum depth",
          path,
        );
      }
      if (entry.kind === "symlink") {
        throw new SourceScanError(
          "invalid_path",
          "symlinks are not supported inside a selected source",
          path,
        );
      }
      if (entry.kind === "directory") {
        if (!shouldExclude(path, entry.kind)) directories.push(path);
        continue;
      }
      if (!shouldExclude(path, entry.kind)) entries.push({ ...entry, path });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  if (entries.length > options.maxFiles) {
    throw new SourceScanError(
      "scan_limit",
      "Markdown file count exceeds the scan ceiling",
    );
  }
  return entries;
}

/** Enumerate and read Markdown with explicit file, byte, depth, and concurrency bounds. */
export async function scanMarkdown(
  workspace: WorkspaceFilesPort,
  suppliedOptions?: Partial<MarkdownScanOptions>,
): Promise<MarkdownScanResult> {
  const options = boundedOptions({
    ...DEFAULT_SCAN_OPTIONS,
    ...suppliedOptions,
  });
  const entries = await listMarkdown(workspace, options);
  let totalBytes = 0;
  const files: Array<MarkdownFile | undefined> = Array.from({
    length: entries.length,
  });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      if (entry === undefined) return;
      if (entry.size !== undefined && entry.size > options.maxFileBytes) {
        throw new SourceScanError(
          "scan_limit",
          "file exceeds the size ceiling",
          entry.path,
        );
      }
      let contents: Uint8Array;
      try {
        contents = await workspace.read(entry.path);
      } catch {
        throw new SourceScanError(
          "read_failed",
          "could not read Markdown file",
          entry.path,
        );
      }
      if (contents.byteLength > options.maxFileBytes) {
        throw new SourceScanError(
          "scan_limit",
          "file exceeds the size ceiling",
          entry.path,
        );
      }
      totalBytes += contents.byteLength;
      if (totalBytes > options.maxBytes) {
        throw new SourceScanError(
          "scan_limit",
          "Markdown bytes exceed the scan ceiling",
        );
      }
      files[index] = {
        path: entry.path,
        size: contents.byteLength,
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
        contents,
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, Math.max(entries.length, 1)) },
      () => worker(),
    ),
  );
  const ordered = files.filter(
    (file): file is MarkdownFile => file !== undefined,
  );
  return { files: ordered, totalBytes, scanId: scanFingerprint(ordered) };
}

export type SourceCoreStatus =
  "stopped" | "running" | "unpaired" | "revoked" | "expired";

interface PersistedCoreState {
  descriptor: SourceDescriptor;
  status: SourceCoreStatus;
  revokedFingerprint?: string;
  lastScanId?: string;
}

function decodePersistedCoreState(value: unknown): PersistedCoreState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PersistedCoreState>;
  const allowedStatuses = new Set<SourceCoreStatus>([
    "stopped",
    "running",
    "unpaired",
    "revoked",
    "expired",
  ]);
  if (!allowedStatuses.has(candidate.status as SourceCoreStatus)) return null;
  try {
    const descriptor = normalizeSourceDescriptor(candidate.descriptor);
    return {
      descriptor,
      status: candidate.status as SourceCoreStatus,
      ...(typeof candidate.revokedFingerprint === "string"
        ? { revokedFingerprint: candidate.revokedFingerprint }
        : {}),
      ...(typeof candidate.lastScanId === "string"
        ? { lastScanId: candidate.lastScanId }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface SourceCoreOptions {
  descriptor?: SourceDescriptor;
  files: WorkspaceFilesPort;
  state: LocalStatePort;
  credentials: CredentialCustodyPort;
  ui?: UserInteractionPort;
  now?: () => number;
}

const CORE_STATE_KEY = "mdevolved/source-core/v1";

/** Small idempotent lifecycle wrapper shared by folder and Obsidian adapters. */
export class SourceNeutralSyncCore {
  private status: SourceCoreStatus = "stopped";
  private state: PersistedCoreState | null = null;
  private readonly now: () => number;

  constructor(private readonly options: SourceCoreOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  getStatus(): SourceCoreStatus {
    return this.status;
  }

  async stat(relativePath: string): Promise<WorkspaceEntry | null> {
    await this.requireRunning();
    const path = validateRelativePath(relativePath);
    const entry = await this.options.files.stat(path);
    if (entry === null) return null;
    if (validateRelativePath(entry.path) !== path || entry.kind === "symlink") {
      throw new SourceScanError(
        "invalid_path",
        "workspace returned an unsafe path",
        entry.path,
      );
    }
    return { ...entry, path };
  }

  async read(relativePath: string): Promise<Uint8Array> {
    const path = validateRelativePath(relativePath);
    const entry = await this.stat(path);
    if (entry?.kind !== "file") {
      throw new SourceScanError("read_failed", "source file not found", path);
    }
    return await this.options.files.read(path);
  }

  async write(relativePath: string, contents: Uint8Array): Promise<void> {
    const path = validateRelativePath(relativePath);
    const entry = await this.stat(path);
    if (entry !== null && entry.kind !== "file") {
      throw new SourceScanError(
        "invalid_path",
        "source path is not a writable file",
        path,
      );
    }
    await this.options.files.write(path, contents);
  }

  async start(): Promise<SourceCoreStatus> {
    if (this.status === "running") return this.status;
    const saved = decodePersistedCoreState(
      await this.options.state.read<unknown>(CORE_STATE_KEY),
    );
    const descriptor =
      saved?.descriptor ??
      this.options.descriptor ??
      normalizeSourceDescriptor(undefined);
    this.state = saved ?? { descriptor, status: "stopped" };
    const credential = await this.options.credentials.get();
    if (
      this.state.revokedFingerprint !== undefined &&
      this.state.revokedFingerprint === credential?.fingerprint
    ) {
      return this.setStatus("revoked");
    }
    if (credential === null) return this.setStatus("unpaired");
    if (credential.status === "revoked") return this.setStatus("revoked");
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= this.now()
    )
      return this.setStatus("expired");
    this.state = { ...this.state, descriptor, status: "running" };
    await this.options.state.write(CORE_STATE_KEY, this.state);
    return this.setStatus("running");
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") return;
    this.status = "stopped";
    if (this.state !== null) {
      this.state = { ...this.state, status: "stopped" };
      await this.options.state.write(CORE_STATE_KEY, this.state);
    }
    await this.options.ui?.emit({ kind: "status", status: "stopped" });
  }

  async rescan(
    options?: Partial<MarkdownScanOptions>,
  ): Promise<MarkdownScanResult> {
    await this.requireRunning();
    const result = await scanMarkdown(this.options.files, options);
    if (this.state !== null) {
      this.state = {
        ...this.state,
        lastScanId: result.scanId,
      };
      await this.options.state.write(CORE_STATE_KEY, this.state);
    }
    return result;
  }

  async listMarkdown(
    options?: Partial<MarkdownListOptions>,
  ): Promise<readonly WorkspaceEntry[]> {
    await this.requireRunning();
    return await listMarkdown(this.options.files, options);
  }

  async revoke(): Promise<void> {
    const credential = await this.options.credentials.get();
    await this.options.credentials.revoke();
    this.state = {
      ...(this.state ?? {
        descriptor:
          this.options.descriptor ?? normalizeSourceDescriptor(undefined),
        status: "stopped" as const,
      }),
      status: "revoked",
      ...(credential !== null
        ? { revokedFingerprint: credential.fingerprint }
        : {}),
    };
    await this.options.state.write(CORE_STATE_KEY, this.state);
    await this.setStatus("revoked");
  }

  async replaceCredentials(
    record: CredentialRecord,
  ): Promise<SourceCoreStatus> {
    if (record.status !== "active")
      throw new TypeError("replacement_credential_must_be_active");
    await this.options.credentials.confirmReplacement(record);
    this.state = {
      ...(this.state ?? {
        descriptor:
          this.options.descriptor ?? normalizeSourceDescriptor(undefined),
        status: "stopped" as const,
      }),
      status: "stopped",
      revokedFingerprint: undefined,
    };
    await this.options.state.write(CORE_STATE_KEY, this.state);
    return this.start();
  }

  private async setStatus(status: SourceCoreStatus): Promise<SourceCoreStatus> {
    this.status = status;
    if (this.state !== null && this.state.status !== status) {
      this.state = { ...this.state, status };
      await this.options.state.write(CORE_STATE_KEY, this.state);
    }
    await this.options.ui?.emit({ kind: "status", status });
    return status;
  }

  private async requireRunning(): Promise<void> {
    if (this.status !== "running") {
      throw new Error(`source_not_running:${this.status}`);
    }
    const credential = await this.options.credentials.get();
    if (credential === null) {
      await this.setStatus("unpaired");
      throw new Error("source_not_running:unpaired");
    }
    if (credential.status === "revoked") {
      await this.setStatus("revoked");
      throw new Error("source_not_running:revoked");
    }
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= this.now()
    ) {
      await this.setStatus("expired");
      throw new Error("source_not_running:expired");
    }
  }
}
