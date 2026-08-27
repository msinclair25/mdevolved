import {
  apiErrorSchema,
  backupArtifactSchema,
  backupListResponseSchema,
  backupRecipientStatusSchema,
  csrfResponseSchema,
  currentMaterializationResponseSchema,
  materializationJobSchema,
  type BackupArtifact,
  type BackupRecipientStatus,
  type VaultSummary,
} from "@mdevolved/contracts";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { useEffect, useRef, useState } from "react";
import { OperationalRegion } from "./OperationalRegion";
import { RecoveryKeyCard, type PendingRecoveryKey } from "./RecoveryKeyCard";
import { RestorePanel } from "./RestorePanel";
import { SnapshotPanel } from "./SnapshotPanel";
import {
  createBackupWithPreparedSource,
  settleMaterializationJob,
} from "./backup-workflow";
import {
  createRecoveryKeyDownload,
  recoveryKeyVerifiedForSession,
  verifyRecoveryKeyFile,
} from "./recovery-key";

type Props = {
  activeVaults: VaultSummary[];
  autoOpen?: boolean;
  initialVaultId: string;
  onRestoreApplied: (vaultId: string) => Promise<void> | void;
  vaults: VaultSummary[];
};

type SnapshotState =
  | { kind: "idle" | "loading" }
  | { available: boolean; kind: "ready" }
  | { kind: "error"; message: string };

type RecoveryTask = "backup" | "restore";

type GeneratedIdentity = {
  byteLength: number;
  downloadHref: string;
  downloadRequested: boolean;
  filename: string;
  identity: string;
  recipient: string;
  verifiedFilename: string | null;
};

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

export function backupCreatedMessage(
  artifact: Pick<BackupArtifact, "backupId" | "noteCount">,
  verifiedAtLabel: string,
): string {
  const noteLabel = artifact.noteCount === 1 ? "note" : "notes";
  return `Backup created and checked at ${verifiedAtLabel}. Look for the entry with ${artifact.noteCount.toLocaleString()} ${noteLabel} under Your backups. Reference: ${artifact.backupId.slice(0, 8)}.`;
}

export function defaultBackupHistoryVaultId(
  vaults: VaultSummary[],
  preferredVaultId: string,
): string {
  if (
    preferredVaultId !== "" &&
    vaults.some(
      (vault) => vault.id === preferredVaultId && vault.status !== "pending",
    )
  ) {
    return preferredVaultId;
  }
  return vaults.find((vault) => vault.status !== "pending")?.id ?? "";
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
  options: {
    body?: unknown;
    csrf?: string;
    method?: "POST" | "PUT";
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.csrf === undefined
        ? {}
        : { "X-MDevolved-CSRF": options.csrf }),
    },
    method: options.method ?? "GET",
    signal: options.signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "The request could not be completed.",
    );
  }
  return payload;
}

export function BackupPanel({
  activeVaults,
  autoOpen = false,
  initialVaultId,
  onRestoreApplied,
  vaults,
}: Props) {
  const [recoveryTask, setRecoveryTask] = useState<RecoveryTask>("backup");
  const [restoreOpened, setRestoreOpened] = useState(false);
  const [backupVaultId, setBackupVaultId] = useState(initialVaultId);
  const [recipient, setRecipient] = useState<BackupRecipientStatus | null>(
    null,
  );
  const [generated, setGenerated] = useState<GeneratedIdentity | null>(null);
  const [verifiedRecipient, setVerifiedRecipient] = useState<string | null>(
    null,
  );
  const [verifiedKeyFilename, setVerifiedKeyFilename] = useState<string | null>(
    null,
  );
  const [backups, setBackups] = useState<BackupArtifact[]>([]);
  const [historyVaultId, setHistoryVaultId] = useState(() =>
    defaultBackupHistoryVaultId(vaults, initialVaultId),
  );
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({
    kind: "idle",
  });
  const [working, setWorking] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backupHistoryControllerRef = useRef<AbortController | null>(null);

  async function refreshRecipient(): Promise<void> {
    setRecipient(
      backupRecipientStatusSchema.parse(
        await apiJson("/api/backups/recovery-recipient"),
      ),
    );
  }

  async function refreshBackups(vaultId = historyVaultId): Promise<void> {
    backupHistoryControllerRef.current?.abort();
    const controller = new AbortController();
    backupHistoryControllerRef.current = controller;
    if (vaultId === "") {
      setBackups([]);
      backupHistoryControllerRef.current = null;
      return;
    }
    try {
      const response = backupListResponseSchema.parse(
        await apiJson(`/api/vaults/${encodeURIComponent(vaultId)}/backups`, {
          signal: controller.signal,
        }),
      );
      if (backupHistoryControllerRef.current !== controller) return;
      setBackups(response.backups);
    } finally {
      if (backupHistoryControllerRef.current === controller) {
        backupHistoryControllerRef.current = null;
      }
    }
  }

  useEffect(() => {
    void refreshRecipient().catch((reason: unknown) => {
      setError(
        reason instanceof Error
          ? reason.message
          : "Recovery status could not be loaded.",
      );
    });
  }, []);

  useEffect(() => {
    if (
      verifiedRecipient === null ||
      verifiedRecipient === recipient?.recipient
    ) {
      return;
    }
    setVerifiedRecipient(null);
    setVerifiedKeyFilename(null);
  }, [recipient?.recipient, verifiedRecipient]);

  useEffect(() => {
    void refreshBackups().catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Backups could not be loaded.",
      );
    });
    return () => {
      backupHistoryControllerRef.current?.abort();
      backupHistoryControllerRef.current = null;
    };
  }, [historyVaultId]);

  useEffect(() => {
    setBackupVaultId((current) =>
      activeVaults.some((vault) => vault.id === current)
        ? current
        : activeVaults.some((vault) => vault.id === initialVaultId)
          ? initialVaultId
          : (activeVaults[0]?.id ?? ""),
    );
  }, [activeVaults, initialVaultId]);

  useEffect(() => {
    if (backupVaultId === "") {
      setSnapshotState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setSnapshotState({ kind: "loading" });
    void apiJson(
      `/api/vaults/${encodeURIComponent(backupVaultId)}/materialization`,
      { signal: controller.signal },
    )
      .then((payload) => {
        if (controller.signal.aborted) return;
        const status = currentMaterializationResponseSchema.parse(payload);
        setSnapshotState({
          available: status.generation !== null,
          kind: "ready",
        });
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        setSnapshotState({
          kind: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "Snapshot status could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [backupVaultId]);

  useEffect(() => {
    if (
      historyVaultId === "" ||
      !vaults.some(
        (vault) => vault.id === historyVaultId && vault.status !== "pending",
      )
    ) {
      setHistoryVaultId(defaultBackupHistoryVaultId(vaults, backupVaultId));
    }
  }, [backupVaultId, historyVaultId, vaults]);

  async function generateIdentity(): Promise<void> {
    setWorking("Creating a private recovery key in this browser…");
    setError(null);
    setMessage(null);
    try {
      const identity = await generateX25519Identity();
      const nextRecipient = await identityToRecipient(identity);
      const download = createRecoveryKeyDownload(identity);
      setGenerated({
        byteLength: download.byteLength,
        downloadHref: URL.createObjectURL(download.blob),
        downloadRequested: false,
        filename: download.filename,
        identity,
        recipient: nextRecipient,
        verifiedFilename: null,
      });
      setMessage(
        "Recovery key created locally. Download and reopen the timestamped file before continuing.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "A recovery key could not be created.",
      );
    } finally {
      setWorking(null);
    }
  }

  function noteRecoveryKeyDownload(): void {
    if (generated === null) return;
    setError(null);
    setGenerated({ ...generated, downloadRequested: true });
    setMessage(
      `Download requested for ${generated.filename}. Choose that exact file below; setup remains locked until MDevolved verifies it.`,
    );
  }

  async function verifySelectedRecoveryKey(file: File): Promise<void> {
    const expectedRecipient = generated?.recipient ?? recipient?.recipient;
    if (expectedRecipient === null || expectedRecipient === undefined) return;
    setWorking("Checking the selected recovery key locally…");
    setError(null);
    setMessage(null);
    try {
      const matchedRecipient = await verifyRecoveryKeyFile(
        file,
        expectedRecipient,
      );
      if (generated !== null) {
        setGenerated({ ...generated, verifiedFilename: file.name });
        setMessage(
          "Recovery key confirmed. Finish setup to use it for future backups.",
        );
      } else {
        setVerifiedRecipient(matchedRecipient);
        setVerifiedKeyFilename(file.name);
        setMessage("Recovery key confirmed. You can create a backup now.");
      }
    } catch (reason: unknown) {
      if (generated !== null) {
        setGenerated({ ...generated, verifiedFilename: null });
      } else {
        setVerifiedRecipient(null);
        setVerifiedKeyFilename(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : "The selected recovery key could not be checked.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function configureRecipient(): Promise<void> {
    if (generated === null || generated.verifiedFilename === null) return;
    setWorking("Preparing future backups with the verified recovery key…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const configured = backupRecipientStatusSchema.parse(
        await apiJson("/api/backups/recovery-recipient", {
          body: { recipient: generated.recipient },
          csrf,
          method: "PUT",
        }),
      );
      setRecipient(configured);
      setVerifiedRecipient(configured.recipient);
      setVerifiedKeyFilename(generated.verifiedFilename);
      URL.revokeObjectURL(generated.downloadHref);
      setGenerated(null);
      setMessage(
        "Future backups will use this recovery key. Its private contents stayed in your saved file and were never uploaded.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The recovery key could not be activated.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function createBackup(): Promise<void> {
    if (
      backupVaultId === "" ||
      recipient === null ||
      recipient.recipient === null ||
      recipient.fingerprint === null ||
      verifiedRecipient !== recipient.recipient ||
      generated !== null ||
      snapshotState.kind !== "ready"
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const artifact = await createBackupWithPreparedSource({
        create: async () => {
          setWorking("Creating and checking the encrypted backup…");
          return backupArtifactSchema.parse(
            await apiJson(
              `/api/vaults/${encodeURIComponent(backupVaultId)}/backups`,
              {
                body: { recipientFingerprint: recipient.fingerprint },
                csrf: await loadCsrf(),
                method: "POST",
              },
            ),
          );
        },
        prepare: async () => {
          setWorking("Preparing a fresh Source library for this backup…");
          const started = materializationJobSchema.parse(
            await apiJson(
              `/api/vaults/${encodeURIComponent(backupVaultId)}/materializations`,
              { csrf: await loadCsrf(), method: "POST" },
            ),
          );
          const settled = await settleMaterializationJob({
            initialJob: started,
            maxAttempts: 360,
            onProgress: (job) =>
              setWorking(
                `Preparing a fresh Source library · ${job.processedNoteCount.toLocaleString()} of ${job.totalNoteCount.toLocaleString()} notes…`,
              ),
            poll: async (job) =>
              materializationJobSchema.parse(
                await apiJson(
                  `/api/vaults/${encodeURIComponent(backupVaultId)}/materializations/${encodeURIComponent(job.jobId)}`,
                ),
              ),
            wait: () =>
              new Promise((resolve) => window.setTimeout(resolve, 500)),
          });
          if (settled.status !== "completed") {
            throw new Error(
              settled.status === "failed"
                ? "The backup library preparation stopped safely. Retry the backup."
                : "The backup library is still preparing. Retry in a moment.",
            );
          }
          setSnapshotState({ available: true, kind: "ready" });
        },
        // A library can become stale after this panel's readiness check.
        // Re-capture immediately before every backup; unchanged state returns
        // the existing completed job without additional projection work.
        sourceReady: false,
      });
      if (historyVaultId === backupVaultId) {
        await refreshBackups(backupVaultId);
      } else {
        setHistoryVaultId(backupVaultId);
      }
      setMessage(
        backupCreatedMessage(artifact, formatTimestamp(artifact.verifiedAt)),
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The backup could not be created.",
      );
    } finally {
      setWorking(null);
    }
  }

  const recoveryKeyVerified =
    recipient?.configured === true &&
    recoveryKeyVerifiedForSession(recipient.recipient, verifiedRecipient);
  const pendingRecoveryKey: PendingRecoveryKey | null =
    generated === null
      ? null
      : {
          byteLength: generated.byteLength,
          downloadHref: generated.downloadHref,
          downloadRequested: generated.downloadRequested,
          filename: generated.filename,
          verifiedFilename: generated.verifiedFilename,
        };
  const recoverySummary =
    recipient === null
      ? "Checking recovery protection…"
      : `${recipient.configured ? "Recovery key configured" : "Recovery key not configured"} · ${backups.length.toLocaleString()} backup${
          backups.length === 1 ? "" : "s"
        } for selected history`;

  const content = (
    <section className="backup-panel" aria-labelledby="backup-heading">
      <div className="section-heading backup-heading">
        <div>
          <span className="section-kicker">Backup &amp; restore</span>
          <h2 id="backup-heading">
            Keep a safe copy. Restore only when you need it.
          </h2>
        </div>
        {recoveryKeyVerified ? (
          <span className="recipient-badge">Recovery key ready</span>
        ) : null}
      </div>

      {activeVaults.length === 0 ? (
        <p className="recovery-task-guidance" role="status">
          No active Source is connected. You can still download or check an
          existing backup. Pair a folder or Obsidian Source before creating a
          new backup or applying a restore.
        </p>
      ) : null}

      <div className="backup-grid recovery-key-grid">
        <RecoveryKeyCard
          configured={recipient?.configured ?? null}
          disabled={working !== null}
          fingerprint={recipient?.fingerprint ?? null}
          pending={pendingRecoveryKey}
          sessionVerifiedFilename={verifiedKeyFilename}
          onActivate={() => void configureRecipient()}
          onCancel={() => {
            if (generated !== null) {
              URL.revokeObjectURL(generated.downloadHref);
            }
            setGenerated(null);
            setMessage(null);
            setError(null);
          }}
          onChooseFile={verifySelectedRecoveryKey}
          onCreate={() => void generateIdentity()}
          onDownload={noteRecoveryKeyDownload}
        />
      </div>

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

      <SnapshotPanel
        activeVaults={activeVaults}
        disabled={working !== null || restoreBusy || generated !== null}
        onRestoreApplied={onRestoreApplied}
        recoveryKeyVerified={recoveryKeyVerified}
      />

      <details className="legacy-recovery-tools">
        <summary>Advanced: legacy single-vault backups and restore</summary>

        <div className="recovery-task-intro">
          <span className="backup-step">Choose a task</span>
          <h3>What do you need to do?</h3>
          <p>
            Select one of the buttons below. Your place on this page will stay
            put.
          </p>
        </div>

        <div className="recovery-task-picker" aria-label="Backup or restore">
          <button
            aria-pressed={recoveryTask === "backup"}
            disabled={working !== null || restoreBusy}
            type="button"
            onClick={() => setRecoveryTask("backup")}
          >
            <strong>Back up a vault</strong>
            <span>Make a new safe copy</span>
            <span className="recovery-task-action" aria-hidden="true">
              {recoveryTask === "backup"
                ? "Backup steps open ✓"
                : "Open backup steps →"}
            </span>
          </button>
          <button
            aria-pressed={recoveryTask === "restore"}
            disabled={working !== null || restoreBusy || generated !== null}
            type="button"
            onClick={() => {
              setRestoreOpened(true);
              setRecoveryTask("restore");
            }}
          >
            <strong>Restore a vault</strong>
            <span>Use a backup to recover notes</span>
            <span className="recovery-task-action" aria-hidden="true">
              {recoveryTask === "restore"
                ? "Restore steps open ✓"
                : "Open restore steps →"}
            </span>
          </button>
        </div>
        {restoreBusy ? (
          <p className="recovery-task-guidance" aria-live="polite">
            Finish the current restore step before switching tasks.
          </p>
        ) : generated !== null ? (
          <p className="recovery-task-guidance" aria-live="polite">
            Finish saving this recovery key—or cancel—before switching tasks.
          </p>
        ) : null}

        <div className="recovery-task-panel" hidden={recoveryTask !== "backup"}>
          <div className="backup-grid">
            <article className="backup-card">
              <span className="backup-step">Legacy V1 · Choose a vault</span>
              <h3>Create a legacy single-vault backup</h3>
              <label>
                <span>Vault to back up</span>
                <select
                  disabled={activeVaults.length === 0}
                  value={backupVaultId}
                  onChange={(event) => setBackupVaultId(event.target.value)}
                >
                  {activeVaults.length === 0 ? (
                    <option value="">No active vault connected</option>
                  ) : null}
                  {activeVaults.map((vault) => (
                    <option value={vault.id} key={vault.id}>
                      {vault.displayName ?? vault.id}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                MDevolved makes a private, encrypted copy of this vault’s
                Markdown notes. Passwords, account access, and agent connections
                are never included.
              </p>
              <button
                className="primary-action"
                disabled={
                  working !== null ||
                  generated !== null ||
                  backupVaultId === "" ||
                  !recoveryKeyVerified ||
                  recipient?.configured !== true ||
                  snapshotState.kind !== "ready"
                }
                type="button"
                onClick={() => void createBackup()}
              >
                Create backup
              </button>
              {activeVaults.length === 0 ? (
                <small>
                  Pair an Obsidian vault to create a new backup. Existing
                  backups remain available below.
                </small>
              ) : snapshotState.kind === "loading" ? (
                <small>Checking whether this vault is ready…</small>
              ) : snapshotState.kind === "error" ? (
                <small>{snapshotState.message}</small>
              ) : !recoveryKeyVerified ? (
                <small>
                  Complete step 1 once to prove you still have the recovery key.
                </small>
              ) : snapshotState.kind === "ready" && !snapshotState.available ? (
                <small>
                  You can continue—MDevolved will prepare this vault
                  automatically.
                </small>
              ) : (
                <small>
                  Ready. MDevolved will confirm a fresh vault library before
                  encrypting.
                </small>
              )}
            </article>
          </div>

          <div className="backup-history">
            <div className="backup-history-heading">
              <div>
                <h3>Your backups</h3>
                <p>
                  These copies remain available even if a vault is disconnected.
                </p>
              </div>
              <div className="backup-history-controls">
                <label>
                  <span>Show backups for</span>
                  <select
                    value={historyVaultId}
                    onChange={(event) => setHistoryVaultId(event.target.value)}
                  >
                    {vaults
                      .filter((vault) => vault.status !== "pending")
                      .map((vault) => (
                        <option value={vault.id} key={vault.id}>
                          {vault.displayName ?? vault.id}
                          {vault.status === "revoked" ? " · disconnected" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="text-action"
                  disabled={working !== null}
                  type="button"
                  onClick={() => void refreshBackups()}
                >
                  Refresh
                </button>
              </div>
            </div>
            {backups.length === 0 ? (
              <p>No backups for this vault yet.</p>
            ) : (
              <div className="backup-list">
                {backups.map((backup) => (
                  <article key={backup.backupId}>
                    <div>
                      <strong>{formatTimestamp(backup.verifiedAt)}</strong>
                      <span>
                        {backup.noteCount.toLocaleString()} notes ·{" "}
                        {formatBytes(backup.ciphertextBytes)}
                      </span>
                      <details className="backup-technical-details">
                        <summary>Technical details</summary>
                        <code>
                          Generation {backup.generationId.slice(0, 8)} ·
                          encrypted .age file
                        </code>
                      </details>
                    </div>
                    <a
                      className="secondary-action"
                      download
                      href={`/api/backups/${encodeURIComponent(backup.backupId)}/download`}
                    >
                      Download backup file
                    </a>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>

        {restoreOpened ? (
          <div
            className="recovery-task-panel"
            hidden={recoveryTask !== "restore"}
          >
            <div className="restore-archive-picker">
              <div>
                <h3>Which vault was backed up?</h3>
                <p>Choose the vault name shown when the backup was created.</p>
              </div>
              <div className="backup-history-controls">
                <label>
                  <span>Vault with the backup</span>
                  <select
                    value={historyVaultId}
                    onChange={(event) => setHistoryVaultId(event.target.value)}
                  >
                    {vaults
                      .filter((vault) => vault.status !== "pending")
                      .map((vault) => (
                        <option value={vault.id} key={vault.id}>
                          {vault.displayName ?? vault.id}
                          {vault.status === "revoked" ? " · disconnected" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="text-action"
                  type="button"
                  onClick={() => void refreshBackups()}
                >
                  Refresh
                </button>
              </div>
            </div>
            <RestorePanel
              activeVaults={activeVaults}
              archiveVaultName={
                vaults.find((vault) => vault.id === historyVaultId)
                  ?.displayName ?? historyVaultId
              }
              availableBackups={backups}
              initialTargetVaultId={backupVaultId}
              onApplied={onRestoreApplied}
              onBusyChange={setRestoreBusy}
            />
          </div>
        ) : null}
      </details>
    </section>
  );

  return (
    <OperationalRegion
      attention={error === null ? "none" : "error"}
      autoOpen={
        autoOpen || generated !== null || working !== null || restoreBusy
      }
      heading="Backup and recovery"
      id="recovery"
      kicker="Owner-controlled recovery"
      summary={recoverySummary}
    >
      {content}
    </OperationalRegion>
  );
}
