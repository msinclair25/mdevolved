import {
  OWD_BACKUP_FORMAT,
  apiErrorSchema,
  backupArchiveManifestSchema,
  collaborationDurableRecordSchema,
  collaborationRestoreJobSchema,
  collaborationRestoreResultSchema,
  csrfResponseSchema,
  restoreApplyResponseSchema,
  restoreJobSchema,
  type BackupArchiveManifest,
  type CollaborationRestoreJob,
  type CollaborationRestoreVaultMapping,
  type RestoreJob,
  type SnapshotManifest,
  type SnapshotSummary,
  type SnapshotVaultManifest,
  type VaultSummary,
} from "@mdevolved/contracts";
import { useEffect, useRef, useState } from "react";
import { identityFromFile } from "./backup-archive";
import {
  inspectSnapshotArchive,
  type InspectedSnapshotArchive,
} from "./snapshot-archive";

type Props = {
  activeVaults: VaultSummary[];
  initialSnapshot: SnapshotSummary | null;
  onApplied: (vaultId: string) => Promise<void> | void;
  onClose: () => void;
};

type PreparedSnapshot = InspectedSnapshotArchive & {
  file: Blob;
  identity: string;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function snapshotArchiveFilename(
  file: Blob,
  initialSnapshot: Pick<SnapshotSummary, "format" | "snapshotId"> | null,
): string {
  const namedFile = file as Blob & { name?: unknown };
  if (typeof namedFile.name === "string" && namedFile.name.trim().length > 0) {
    return namedFile.name;
  }
  return initialSnapshot === null
    ? "Encrypted snapshot copy"
    : `${
        initialSnapshot.format === "mdevolved-snapshot-v3" ? "mdevolved" : "owd"
      }-snapshot-${initialSnapshot.snapshotId}.owdsnapshot`;
}

export function snapshotArchiveSelectionMessage(
  file: Blob,
  initialSnapshot: Pick<SnapshotSummary, "format" | "snapshotId"> | null,
): string {
  return `Selected ${snapshotArchiveFilename(file, initialSnapshot)} · ${formatBytes(file.size)}.`;
}

export function snapshotArchiveSummary(
  manifest: Pick<SnapshotManifest, "captureCompletedAt" | "snapshotId"> & {
    vaults: ReadonlyArray<{ entries: ReadonlyArray<unknown> }>;
  },
  filename: string,
  captureCompletedAtLabel = formatTimestamp(manifest.captureCompletedAt),
): string {
  const itemCount = manifest.vaults.reduce(
    (total, vault) => total + vault.entries.length,
    0,
  );
  return `${filename} · created ${captureCompletedAtLabel} · ${manifest.vaults.length.toLocaleString()} Source${manifest.vaults.length === 1 ? "" : "s"} · ${itemCount.toLocaleString()} items · portable manifest reference ${manifest.snapshotId.slice(0, 8)}`;
}

export function revealRestoreCompletion(
  element: Pick<HTMLElement, "focus" | "scrollIntoView">,
): void {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "center" });
}

async function loadCsrf(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not start a secure request.");
  return csrfResponseSchema.parse(await response.json()).csrfToken;
}

async function apiJson(
  path: string,
  options: { body?: unknown; csrf: string; method?: "POST" | "PUT" },
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      "X-MDevolved-CSRF": options.csrf,
    },
    method: options.method ?? "POST",
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "The restore request could not be completed.",
    );
  }
  return payload;
}

export function snapshotVaultRestoreManifest(
  manifest: SnapshotManifest,
  vault: SnapshotVaultManifest,
): BackupArchiveManifest {
  if (vault.sourceGeneration === null) {
    throw new Error(
      `The source generation for ${vault.vaultName} is not available in this portable copy.`,
    );
  }
  const notes = vault.entries
    .filter((entry) => entry.section === "notes")
    .map((entry) => ({
      byteLength: entry.byteLength,
      contentSha256: entry.contentSha256,
      modifiedAt: entry.modifiedAt,
      path: entry.path,
    }))
    .sort((left, right) =>
      left.path
        .normalize("NFC")
        .toLocaleLowerCase("en-US")
        .localeCompare(right.path.normalize("NFC").toLocaleLowerCase("en-US")),
    );
  return backupArchiveManifestSchema.parse({
    backupId: manifest.snapshotId,
    createdAt: manifest.captureCompletedAt,
    excludedSections: [
      "oauth",
      "sessions",
      "pairing-codes",
      "agent-grants",
      "pending-agent-proposals",
      "unknown-obsidian-plugin-data",
    ],
    format: OWD_BACKUP_FORMAT,
    generation: {
      completedAt: vault.sourceGeneration.completedAt,
      createdAt: vault.sourceGeneration.createdAt,
      generationId: vault.sourceGeneration.generationId,
      noteCount: vault.sourceGeneration.noteCount,
      sourceStateVectorSha256: vault.sourceGeneration.sourceStateVectorSha256,
      totalBytes: vault.sourceGeneration.totalBytes,
      vaultId: vault.snapshotVaultId,
    },
    includedSections: ["notes"],
    notes,
    ...(vault.sourceDevices === undefined
      ? {}
      : { sourceDevices: vault.sourceDevices }),
    reservedSections: [
      "attachments",
      "obsidian-allowlist",
      "accepted-memory",
      "skills",
      "provenance",
      "policy",
    ],
    vaultName: vault.vaultName,
  });
}

function targetName(
  activeVaults: VaultSummary[],
  mappings: Record<string, string>,
  snapshotVaultId: string,
): string {
  const targetId = mappings[snapshotVaultId];
  return activeVaults.find((vault) => vault.id === targetId)?.displayName ?? "";
}

export function collaborationRestoreVaultMappings(
  manifest: Pick<SnapshotManifest, "intelligence" | "vaults">,
  intelligenceObjects: ReadonlyMap<string, Uint8Array>,
  targets: Record<string, string>,
): CollaborationRestoreVaultMapping[] {
  const targetIdFor = (snapshotVaultId: string): string => {
    const targetVaultId = targets[snapshotVaultId];
    if (targetVaultId === undefined || targetVaultId === "") {
      throw new Error("Every Source needs an approved destination.");
    }
    return targetVaultId;
  };
  const identified = manifest.vaults.filter(
    (vault) =>
      vault.sourceVaultId !== null && vault.sourceVaultId !== undefined,
  );
  if (identified.length === manifest.vaults.length) {
    return manifest.vaults.map((vault) => ({
      sourceVaultId: vault.sourceVaultId!,
      targetVaultId: targetIdFor(vault.snapshotVaultId),
    }));
  }
  if (identified.length > 0) {
    throw new Error(
      "The encrypted snapshot has an incomplete Source identity map.",
    );
  }
  const intelligence = manifest.intelligence;
  if (intelligence === undefined || intelligence.selection === "none")
    return [];
  const sourceVaultIds = new Set<string>();
  const descriptors = [
    ...(intelligence.approved?.records ?? []),
    ...(intelligence.unvetted?.records ?? []),
  ].filter((descriptor) => descriptor.recordType === "knowledge-space-version");
  for (const descriptor of descriptors) {
    const bytes = intelligenceObjects.get(descriptor.portableObjectId);
    if (bytes === undefined) {
      throw new Error("The verified Project context object is missing.");
    }
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
      throw new Error("The verified Project context object is invalid.");
    }
    const record = collaborationDurableRecordSchema.safeParse(value);
    if (
      !record.success ||
      record.data.recordType !== "knowledge-space-version"
    ) {
      throw new Error("The verified Project context object is invalid.");
    }
    for (const member of record.data.members) {
      sourceVaultIds.add(member.vaultId);
    }
  }
  if (sourceVaultIds.size === 0) return [];
  if (manifest.vaults.length !== 1 || sourceVaultIds.size !== 1) {
    throw new Error(
      "This older multi-Source snapshot cannot prove an exact Project Source mapping.",
    );
  }
  return [
    {
      sourceVaultId: [...sourceVaultIds][0]!,
      targetVaultId: targetIdFor(manifest.vaults[0]!.snapshotVaultId),
    },
  ];
}

export function SnapshotRestorePanel({
  activeVaults,
  initialSnapshot,
  onApplied,
  onClose,
}: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [sourceFile, setSourceFile] = useState<File | Blob | null>(null);
  const [identityFile, setIdentityFile] = useState<File | null>(null);
  const [identityText, setIdentityText] = useState("");
  const [prepared, setPrepared] = useState<PreparedSnapshot | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [jobs, setJobs] = useState<Record<string, RestoreJob>>({});
  const [intelligenceJob, setIntelligenceJob] =
    useState<CollaborationRestoreJob | null>(null);
  const [intelligenceConfirmation, setIntelligenceConfirmation] = useState("");
  const [confirmations, setConfirmations] = useState<Record<string, string>>(
    {},
  );
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);
  const completionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    if (initialSnapshot === null) return;
    const controller = new AbortController();
    setWorking("Loading the named encrypted snapshot…");
    setError(null);
    void fetch(
      `/api/snapshots/${encodeURIComponent(initialSnapshot.snapshotId)}/download`,
      {
        headers: { Accept: "application/octet-stream" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("The named encrypted snapshot could not be loaded.");
        }
        const blob = await response.blob();
        if (!controller.signal.aborted) {
          setSourceFile(blob);
          setMessage("Named snapshot loaded. Choose its recovery key.");
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The named encrypted snapshot could not be loaded.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorking(null);
      });
    return () => controller.abort();
  }, [initialSnapshot?.snapshotId]);

  function resetAfterSourceChange(): void {
    setPrepared(null);
    setMappings({});
    setMappingConfirmed(false);
    setJobs({});
    setIntelligenceJob(null);
    setIntelligenceConfirmation("");
    setConfirmations({});
    setError(null);
    setMessage(null);
  }

  async function checkSnapshot(): Promise<void> {
    if (sourceFile === null || (identityFile === null && identityText === "")) {
      return;
    }
    setWorking("Unlocking and checking every snapshot object in this browser…");
    setError(null);
    setMessage(null);
    try {
      const identity = identityFromFile(
        identityText !== ""
          ? identityText
          : ((await identityFile?.text()) ?? ""),
      );
      const inspected = await inspectSnapshotArchive(sourceFile, identity);
      const unsupportedRestoreSections = inspected.manifest.vaults.flatMap(
        (vault) => vault.entries.filter((entry) => entry.section !== "notes"),
      );
      if (unsupportedRestoreSections.length > 0) {
        throw new Error(
          "This copy contains attachments or Obsidian settings. This installation can verify them but cannot safely write those sections yet, so restore stopped without omitting them.",
        );
      }
      for (const vault of inspected.manifest.vaults) {
        snapshotVaultRestoreManifest(inspected.manifest, vault);
      }
      setPrepared({ ...inspected, file: sourceFile, identity });
      setIdentityText("");
      setMappings(
        Object.fromEntries(
          inspected.manifest.vaults.map((vault) => [vault.snapshotVaultId, ""]),
        ),
      );
      setMessage(
        "Snapshot and recovery key match. Map every Source before staging a preview.",
      );
    } catch (reason: unknown) {
      setPrepared(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "The encrypted snapshot could not be checked.",
      );
    } finally {
      setWorking(null);
    }
  }

  function mappingsAreComplete(): boolean {
    if (prepared === null) return false;
    const targetIds = prepared.manifest.vaults.map(
      (vault) => mappings[vault.snapshotVaultId] ?? "",
    );
    return (
      targetIds.every((value) => value !== "") &&
      new Set(targetIds).size === targetIds.length
    );
  }

  async function stagePreview(): Promise<void> {
    if (prepared === null || !mappingsAreComplete() || !mappingConfirmed)
      return;
    setWorking("Creating isolated restore staging areas…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const nextJobs: Record<string, RestoreJob> = { ...jobs };
      for (const sourceVault of prepared.manifest.vaults) {
        const targetVaultId = mappings[sourceVault.snapshotVaultId];
        if (targetVaultId === undefined || targetVaultId === "") {
          throw new Error("Every Source needs an explicit target.");
        }
        const existing = nextJobs[sourceVault.snapshotVaultId];
        if (existing === undefined) {
          nextJobs[sourceVault.snapshotVaultId] = restoreJobSchema.parse(
            await apiJson(
              `/api/vaults/${encodeURIComponent(targetVaultId)}/restores`,
              {
                body: {
                  manifest: snapshotVaultRestoreManifest(
                    prepared.manifest,
                    sourceVault,
                  ),
                },
                csrf,
              },
            ),
          );
        } else if (
          existing.status !== "staging" &&
          existing.status !== "preview"
        ) {
          throw new Error(
            "A previous preview attempt is no longer resumable. Close this restore and start it again.",
          );
        }
      }
      setJobs(nextJobs);
      await inspectSnapshotArchive(
        prepared.file,
        prepared.identity,
        async ({ bytes, entry, vault }, index, total) => {
          if (entry.section !== "notes") return;
          const job = nextJobs[vault.snapshotVaultId];
          if (job === undefined) {
            throw new Error("The restore staging map is incomplete.");
          }
          if (job.status === "preview") return;
          setWorking(`Staging item ${index + 1} of ${total}…`);
          nextJobs[vault.snapshotVaultId] = restoreJobSchema.parse(
            await apiJson(
              `/api/restores/${encodeURIComponent(job.restoreId)}/note`,
              {
                body: { content: decoder.decode(bytes), path: entry.path },
                csrf,
                method: "PUT",
              },
            ),
          );
          setJobs({ ...nextJobs });
        },
      );
      for (const sourceVault of prepared.manifest.vaults) {
        const job = nextJobs[sourceVault.snapshotVaultId];
        if (job === undefined) throw new Error("A restore preview is missing.");
        setWorking(`Checking destination ${sourceVault.vaultName}…`);
        nextJobs[sourceVault.snapshotVaultId] =
          job.status === "preview"
            ? job
            : restoreJobSchema.parse(
                await apiJson(
                  `/api/restores/${encodeURIComponent(job.restoreId)}/complete`,
                  { csrf },
                ),
              );
      }
      setJobs({ ...nextJobs });
      const intelligence = prepared.manifest.intelligence;
      if (intelligence !== undefined && intelligence.selection !== "none") {
        let job =
          intelligenceJob ??
          collaborationRestoreJobSchema.parse(
            await apiJson("/api/collaboration/restores", {
              body: {
                manifest: intelligence,
                vaultMappings: collaborationRestoreVaultMappings(
                  prepared.manifest,
                  prepared.intelligenceObjects,
                  mappings,
                ),
              },
              csrf,
            }),
          );
        setIntelligenceJob(job);
        const descriptors = [
          ...(intelligence.approved?.records ?? []),
          ...(intelligence.approved?.evidenceObjects ?? []),
          ...(intelligence.unvetted?.records ?? []),
          ...(intelligence.unvetted?.evidenceObjects ?? []),
        ];
        for (const [index, descriptor] of descriptors.entries()) {
          const bytes = prepared.intelligenceObjects.get(
            descriptor.portableObjectId,
          );
          if (bytes === undefined) {
            throw new Error(
              "The verified intelligence recovery object is missing.",
            );
          }
          setWorking(
            `Staging portable intelligence ${index + 1} of ${descriptors.length}…`,
          );
          job = collaborationRestoreJobSchema.parse(
            await apiJson(
              `/api/collaboration/restores/${encodeURIComponent(job.restoreId)}/items`,
              {
                body: {
                  bytesBase64Url: encodeBase64Url(bytes),
                  portableObjectId: descriptor.portableObjectId,
                },
                csrf,
              },
            ),
          );
          setIntelligenceJob(job);
        }
        if (job.status !== "preview") {
          throw new Error(
            "Portable intelligence staging did not reach a complete preview.",
          );
        }
      }
      setPrepared((current) =>
        current === null
          ? null
          : { ...current, identity: "", file: new Blob() },
      );
      setMessage("Preview ready. No destination has changed.");
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The workspace restore preview could not be prepared.",
      );
    } finally {
      setWorking(null);
    }
  }

  function previewsReady(): boolean {
    return (
      prepared !== null &&
      prepared.manifest.vaults.every(
        (vault) =>
          jobs[vault.snapshotVaultId]?.status === "preview" ||
          jobs[vault.snapshotVaultId]?.status === "applying" ||
          jobs[vault.snapshotVaultId]?.status === "applied",
      ) &&
      (prepared.manifest.intelligence === undefined ||
        prepared.manifest.intelligence.selection === "none" ||
        intelligenceJob?.status === "preview" ||
        intelligenceJob?.status === "applied")
    );
  }

  function confirmationsMatch(): boolean {
    if (prepared === null) return false;
    const vaultsMatch = prepared.manifest.vaults.every((vault) => {
      const expected = targetName(
        activeVaults,
        mappings,
        vault.snapshotVaultId,
      );
      return (
        expected !== "" && confirmations[vault.snapshotVaultId] === expected
      );
    });
    const intelligenceMatches =
      prepared.manifest.intelligence === undefined ||
      prepared.manifest.intelligence.selection === "none" ||
      intelligenceConfirmation === "RESTORE PORTABLE INTELLIGENCE";
    return vaultsMatch && intelligenceMatches;
  }

  async function applyJob(
    initialJob: RestoreJob,
    csrf: string,
  ): Promise<RestoreJob> {
    let current = initialJob;
    const maximumBatches = Math.ceil(current.expectedNoteCount / 20) + 2;
    for (let batch = 0; batch < maximumBatches; batch += 1) {
      const result = restoreApplyResponseSchema.parse(
        await apiJson(
          `/api/restores/${encodeURIComponent(current.restoreId)}/apply`,
          { csrf },
        ),
      );
      current = result.job;
      if (result.complete) break;
    }
    if (current.status !== "applied") {
      throw new Error("The restore paused before verification. Retry safely.");
    }
    return current;
  }

  async function confirmAndApply(): Promise<void> {
    if (prepared === null || !previewsReady() || !confirmationsMatch()) return;
    setWorking("Locking every approved destination…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const nextJobs = { ...jobs };
      for (const vault of prepared.manifest.vaults) {
        const job = nextJobs[vault.snapshotVaultId];
        const name = targetName(activeVaults, mappings, vault.snapshotVaultId);
        if (job === undefined || name === "") {
          throw new Error("The approved destination map changed.");
        }
        nextJobs[vault.snapshotVaultId] =
          job.status === "preview"
            ? restoreJobSchema.parse(
                await apiJson(
                  `/api/restores/${encodeURIComponent(job.restoreId)}/confirm`,
                  { body: { vaultName: name }, csrf },
                ),
              )
            : job;
      }
      setJobs({ ...nextJobs });
      for (const vault of prepared.manifest.vaults) {
        const job = nextJobs[vault.snapshotVaultId];
        if (job === undefined)
          throw new Error("A confirmed restore is missing.");
        setWorking(`Restoring ${vault.vaultName} into its approved target…`);
        nextJobs[vault.snapshotVaultId] =
          job.status === "applied" ? job : await applyJob(job, csrf);
        setJobs({ ...nextJobs });
        await onApplied(job.targetVaultId);
      }
      if (
        prepared.manifest.intelligence !== undefined &&
        prepared.manifest.intelligence.selection !== "none"
      ) {
        if (intelligenceJob?.status !== "preview") {
          throw new Error("The portable intelligence preview is missing.");
        }
        setWorking("Restoring portable intelligence with grants disabled…");
        const result = collaborationRestoreResultSchema.parse(
          await apiJson(
            `/api/collaboration/restores/${encodeURIComponent(intelligenceJob.restoreId)}/confirm`,
            {
              body: { confirmation: "RESTORE PORTABLE INTELLIGENCE" },
              csrf,
            },
          ),
        );
        setIntelligenceJob({
          ...intelligenceJob,
          status: result.status,
        });
      }
      setMessage(
        "Workspace restore complete and checked. Target-only notes were preserved; restored grants remain disabled.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The workspace restore could not be completed.",
      );
    } finally {
      setWorking(null);
    }
  }

  const restoreComplete =
    prepared !== null &&
    prepared.manifest.vaults.every(
      (vault) => jobs[vault.snapshotVaultId]?.status === "applied",
    ) &&
    (prepared.manifest.intelligence === undefined ||
      prepared.manifest.intelligence.selection === "none" ||
      intelligenceJob?.status === "applied");

  useEffect(() => {
    if (!restoreComplete || completionRef.current === null) return;
    revealRestoreCompletion(completionRef.current);
  }, [restoreComplete]);

  const sourceFilename =
    sourceFile === null
      ? null
      : snapshotArchiveFilename(sourceFile, initialSnapshot);

  return (
    <section
      id="portable-snapshot-restore"
      className="snapshot-restore"
      aria-labelledby="snapshot-restore-heading"
    >
      <div className="snapshot-restore-heading">
        <div>
          <span className="backup-step">Restore named snapshot</span>
          <h3 id="snapshot-restore-heading" ref={headingRef} tabIndex={-1}>
            {initialSnapshot === null
              ? "Open an encrypted snapshot copy"
              : `Restore ${initialSnapshot.snapshotId.slice(0, 8)}`}
          </h3>
        </div>
        <button className="text-action" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {prepared !== null && sourceFilename !== null ? (
        <p
          className="snapshot-loaded-summary"
          aria-label="Loaded snapshot identity"
        >
          {snapshotArchiveSummary(prepared.manifest, sourceFilename)}
        </p>
      ) : null}

      {restoreComplete ? (
        <div
          className="recovery-complete"
          ref={completionRef}
          role="status"
          tabIndex={-1}
        >
          <span>Restore checked</span>
          <h4>Every mapped Source was restored.</h4>
          <p>Target-only notes were kept and fresh libraries were verified.</p>
        </div>
      ) : prepared === null ? (
        <div className="recovery-wizard-grid snapshot-source-grid">
          <section className="recovery-step-card">
            <span className="recovery-step-number">1 · Snapshot</span>
            <h4>Choose the encrypted copy.</h4>
            {initialSnapshot === null ? (
              <>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => sourceInputRef.current?.click()}
                >
                  Choose snapshot file
                </button>
                <input
                  accept=".owdsnapshot,application/octet-stream"
                  className="visually-hidden"
                  ref={sourceInputRef}
                  type="file"
                  onChange={(event) => {
                    resetAfterSourceChange();
                    setSourceFile(event.target.files?.item(0) ?? null);
                  }}
                />
              </>
            ) : null}
            <p>
              {sourceFile === null
                ? "No snapshot loaded."
                : snapshotArchiveSelectionMessage(sourceFile, initialSnapshot)}
            </p>
          </section>
          <section className="recovery-step-card">
            <span className="recovery-step-number">2 · Recovery key</span>
            <h4>Choose the matching private key.</h4>
            <button
              className="secondary-action"
              type="button"
              onClick={() => identityInputRef.current?.click()}
            >
              Choose recovery key file
            </button>
            <input
              accept=".txt,text/plain"
              className="visually-hidden"
              ref={identityInputRef}
              type="file"
              onChange={(event) => {
                resetAfterSourceChange();
                setIdentityFile(event.target.files?.item(0) ?? null);
                setIdentityText("");
              }}
            />
            <details>
              <summary>Advanced: paste key text</summary>
              <input
                autoComplete="off"
                placeholder="Paste complete recovery key file contents"
                type="password"
                value={identityText}
                onChange={(event) => {
                  resetAfterSourceChange();
                  setIdentityFile(null);
                  setIdentityText(event.target.value);
                }}
              />
            </details>
          </section>
          <button
            className="primary-action snapshot-check-action"
            disabled={
              working !== null ||
              sourceFile === null ||
              (identityFile === null && identityText === "")
            }
            type="button"
            onClick={() => void checkSnapshot()}
          >
            Check snapshot and key
          </button>
        </div>
      ) : !previewsReady() ? (
        <div className="snapshot-mapping">
          <div>
            <h4>Map every Source to one destination.</h4>
            <p>
              Targets start blank deliberately. A target can be used only once
              in this workspace restore.
            </p>
          </div>
          {prepared.manifest.vaults.map((vault) => (
            <div className="snapshot-mapping-row" key={vault.snapshotVaultId}>
              <div>
                <strong>{vault.vaultName}</strong>
                <span>{vault.entries.length.toLocaleString()} items</span>
              </div>
              <span aria-hidden="true">→</span>
              <label>
                <span>Restore into</span>
                <select
                  disabled={Object.keys(jobs).length > 0}
                  value={mappings[vault.snapshotVaultId] ?? ""}
                  onChange={(event) => {
                    setMappingConfirmed(false);
                    setMappings((current) => ({
                      ...current,
                      [vault.snapshotVaultId]: event.target.value,
                    }));
                  }}
                >
                  <option value="">Choose a target Source</option>
                  {activeVaults.map((target) => (
                    <option value={target.id} key={target.id}>
                      {target.displayName ?? target.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
          {!mappingsAreComplete() &&
          Object.values(mappings).some((targetId) => targetId !== "") &&
          new Set(Object.values(mappings).filter(Boolean)).size !==
            Object.values(mappings).filter(Boolean).length ? (
            <p className="action-error" role="alert">
              Choose a different target for each Source.
            </p>
          ) : null}
          <label className="cross-vault-confirmation">
            <input
              checked={mappingConfirmed}
              disabled={!mappingsAreComplete() || Object.keys(jobs).length > 0}
              type="checkbox"
              onChange={(event) => setMappingConfirmed(event.target.checked)}
            />
            <span>
              I reviewed every source and target name in this mapping.
            </span>
          </label>
          <button
            className="primary-action"
            disabled={
              working !== null || !mappingsAreComplete() || !mappingConfirmed
            }
            type="button"
            onClick={() => void stagePreview()}
          >
            {Object.keys(jobs).length > 0
              ? "Continue preparing preview"
              : "Review what will change"}
          </button>
        </div>
      ) : (
        <div className="snapshot-workspace-preview">
          <h4>Review every destination before applying.</h4>
          {prepared.manifest.vaults.map((vault) => {
            const job = jobs[vault.snapshotVaultId];
            const expectedName = targetName(
              activeVaults,
              mappings,
              vault.snapshotVaultId,
            );
            return (
              <article key={vault.snapshotVaultId}>
                <div>
                  <strong>
                    {vault.vaultName} → {expectedName}
                  </strong>
                  <span>
                    {job?.addedCount ?? 0} added · {job?.changedCount ?? 0}{" "}
                    changed · {job?.unchangedCount ?? 0} unchanged · 0 deleted
                  </span>
                </div>
                <label>
                  <span>Type {expectedName} to confirm</span>
                  <input
                    autoComplete="off"
                    value={confirmations[vault.snapshotVaultId] ?? ""}
                    onChange={(event) =>
                      setConfirmations((current) => ({
                        ...current,
                        [vault.snapshotVaultId]: event.target.value,
                      }))
                    }
                  />
                </label>
              </article>
            );
          })}
          {prepared.manifest.intelligence !== undefined &&
          prepared.manifest.intelligence.selection !== "none" ? (
            <article>
              <div>
                <strong>Portable Intelligence → owner-only ledger</strong>
                <span>
                  {prepared.manifest.intelligence.approved?.recordCount ?? 0}{" "}
                  Approved records ·{" "}
                  {prepared.manifest.intelligence.unvetted?.recordCount ?? 0}{" "}
                  Unvetted records forced into quarantine · 0 grants
                </span>
              </div>
              <label>
                <span>Type RESTORE PORTABLE INTELLIGENCE to confirm</span>
                <input
                  autoComplete="off"
                  value={intelligenceConfirmation}
                  onChange={(event) =>
                    setIntelligenceConfirmation(event.target.value)
                  }
                />
              </label>
            </article>
          ) : null}
          <button
            className="primary-action"
            disabled={working !== null || !confirmationsMatch()}
            type="button"
            onClick={() => void confirmAndApply()}
          >
            Restore mapped Sources and intelligence
          </button>
        </div>
      )}

      {working !== null ? (
        <p className="vault-message" aria-live="polite">
          {working}
        </p>
      ) : error !== null ? (
        <p className="action-error" role="alert">
          {error}
        </p>
      ) : message !== null ? (
        <p className="backup-message" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}
