import {
  apiErrorSchema,
  csrfResponseSchema,
  materializationJobSchema,
  restoreApplyResponseSchema,
  restoreJobSchema,
  type BackupArchiveManifest,
  type BackupArtifact,
  type RestoreJob,
  type VaultSummary,
} from "@owd/contracts";
import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { identityFromFile, inspectBackupArchive } from "./backup-archive";
import {
  createStoredBackupFile,
  describeRecoveryFile,
  readNativeFilePicker,
  recoveryFilePickerOptions,
  type RecoveryFileKind,
  validateRecoveryFile,
} from "./recovery-file-selection";
import {
  canStageRestorePreview,
  recoveryWorkflowInstruction,
  recoveryWorkflowStage,
} from "./recovery-workflow";

type Props = {
  activeVaults: VaultSummary[];
  archiveVaultName: string;
  availableBackups: BackupArtifact[];
  initialTargetVaultId: string;
  onApplied: (vaultId: string) => Promise<void> | void;
  onBusyChange?: (busy: boolean) => void;
};

type RecoverySourceMode = "portable" | "stored";

type SourceLoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };

type ValidatedArchive = {
  backupFile: File | null;
  identity: string | null;
  manifest: BackupArchiveManifest;
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
    csrf: string;
    method?: "POST" | "PUT";
  },
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      "X-OWD-CSRF": options.csrf,
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

async function fetchApiJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "The restore status could not be loaded.",
    );
  }
  return payload;
}

export function RestorePanel({
  activeVaults,
  archiveVaultName,
  availableBackups,
  initialTargetVaultId,
  onApplied,
  onBusyChange,
}: Props) {
  const [targetVaultId, setTargetVaultId] = useState(initialTargetVaultId);
  const [sourceMode, setSourceMode] = useState<RecoverySourceMode>("stored");
  const [storedBackupId, setStoredBackupId] = useState("");
  const [sourceRevision, setSourceRevision] = useState(0);
  const [sourceLoad, setSourceLoad] = useState<SourceLoadState>({
    kind: "idle",
  });
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [identityFile, setIdentityFile] = useState<File | null>(null);
  const [identityText, setIdentityText] = useState("");
  const [validated, setValidated] = useState<ValidatedArchive | null>(null);
  const [job, setJob] = useState<RestoreJob | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [crossVaultConfirmed, setCrossVaultConfirmed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const identityInputRef = useRef<HTMLInputElement>(null);

  const selectedStoredBackup = availableBackups.find(
    (backup) => backup.backupId === storedBackupId,
  );
  const selectedStoredBackupKey =
    selectedStoredBackup === undefined
      ? ""
      : `${selectedStoredBackup.backupId}:${selectedStoredBackup.ciphertextBytes}`;
  const targetVault = activeVaults.find((vault) => vault.id === targetVaultId);
  const targetName = targetVault?.displayName ?? "";
  const identityReady = identityFile !== null || identityText !== "";
  const crossesVaultIds =
    validated !== null &&
    validated.manifest.generation.vaultId !== targetVaultId;
  const workflowStage = recoveryWorkflowStage({
    identityReady,
    jobStatus: job?.status ?? null,
    sourceReady: backupFile !== null,
    validated: validated !== null,
  });
  const restoreIsBusy = working !== null;

  useEffect(() => {
    onBusyChange?.(restoreIsBusy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, restoreIsBusy]);

  useEffect(() => {
    setTargetVaultId((current) =>
      activeVaults.some((vault) => vault.id === current)
        ? current
        : activeVaults.some((vault) => vault.id === initialTargetVaultId)
          ? initialTargetVaultId
          : (activeVaults[0]?.id ?? ""),
    );
  }, [activeVaults, initialTargetVaultId]);

  const resetAfterInputChange = useCallback((): void => {
    setValidated(null);
    setJob(null);
    setConfirmation("");
    setCrossVaultConfirmed(false);
    setMessage(null);
    setError(null);
  }, []);

  function startAnotherRestore(): void {
    setValidated(null);
    setJob(null);
    setConfirmation("");
    setCrossVaultConfirmed(false);
    setIdentityFile(null);
    setIdentityText("");
    setBackupFile(null);
    setMessage(null);
    setError(null);
    setSourceMode("stored");
    setSourceRevision((current) => current + 1);
  }

  useEffect(() => {
    setTargetVaultId((current) =>
      activeVaults.some((vault) => vault.id === current)
        ? current
        : activeVaults.some((vault) => vault.id === initialTargetVaultId)
          ? initialTargetVaultId
          : (activeVaults[0]?.id ?? ""),
    );
  }, [activeVaults, initialTargetVaultId]);

  useEffect(() => {
    setStoredBackupId((current) =>
      availableBackups.some((backup) => backup.backupId === current)
        ? current
        : (availableBackups[0]?.backupId ?? ""),
    );
  }, [availableBackups]);

  useEffect(() => {
    if (sourceMode !== "stored") return;
    if (selectedStoredBackup === undefined) {
      setBackupFile(null);
      setSourceLoad({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setBackupFile(null);
    setSourceLoad({ kind: "loading" });
    resetAfterInputChange();
    void fetch(
      `/api/backups/${encodeURIComponent(selectedStoredBackup.backupId)}/download`,
      {
        headers: { Accept: "application/octet-stream" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("The verified encrypted copy could not be loaded.");
        }
        const file = createStoredBackupFile(
          selectedStoredBackup,
          await response.blob(),
        );
        if (controller.signal.aborted) return;
        setBackupFile(file);
        setSourceLoad({
          kind: "ready",
          message: `Backup ready in this browser · ${formatBytes(file.size)}`,
        });
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") {
          return;
        }
        setBackupFile(null);
        setSourceLoad({
          kind: "error",
          message:
            reason instanceof Error
              ? reason.message
              : "The verified encrypted copy could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [
    resetAfterInputChange,
    selectedStoredBackupKey,
    sourceMode,
    sourceRevision,
  ]);

  function chooseSourceMode(mode: RecoverySourceMode): void {
    if (mode === sourceMode) return;
    setSourceMode(mode);
    setBackupFile(null);
    setSourceLoad({ kind: "idle" });
    resetAfterInputChange();
  }

  function attachRecoveryFile(file: File | null, kind: RecoveryFileKind): void {
    if (file === null) return;
    resetAfterInputChange();
    const problem = validateRecoveryFile(file, kind);
    if (problem !== null) {
      if (kind === "backup") setBackupFile(null);
      else setIdentityFile(null);
      setError(problem);
      return;
    }
    if (kind === "backup") {
      setBackupFile(file);
      setSourceLoad({
        kind: "ready",
        message: describeRecoveryFile(file),
      });
    } else {
      setIdentityFile(file);
      setIdentityText("");
    }
  }

  function acceptDroppedFile(
    event: DragEvent<HTMLDivElement>,
    kind: RecoveryFileKind,
  ): void {
    event.preventDefault();
    attachRecoveryFile(event.dataTransfer.files.item(0), kind);
  }

  function allowFileDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async function chooseRecoveryFile(kind: RecoveryFileKind): Promise<void> {
    const picker = readNativeFilePicker();
    if (picker === null) {
      const input =
        kind === "backup" ? backupInputRef.current : identityInputRef.current;
      if (input !== null) {
        // Browsers do not emit change when the same file is selected twice
        // unless the native control is cleared before opening it again.
        input.value = "";
        input.click();
      }
      return;
    }
    setWorking("Opening the secure local file picker…");
    setError(null);
    try {
      const handles = await picker(
        recoveryFilePickerOptions(
          kind,
          kind === "backup" ? "owd-encrypted-backup" : "owd-recovery-key",
        ),
      );
      attachRecoveryFile((await handles[0]?.getFile()) ?? null, kind);
    } catch (reason: unknown) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        return;
      }
      setError("The browser could not attach that local recovery file.");
    } finally {
      setWorking(null);
    }
  }

  function acceptPastedIdentity(event: ClipboardEvent<HTMLInputElement>): void {
    event.preventDefault();
    resetAfterInputChange();
    try {
      const identity = identityFromFile(event.clipboardData.getData("text"));
      setIdentityFile(null);
      setIdentityText(identity);
      setMessage(
        "Recovery key loaded only into this tab. It has not been uploaded.",
      );
    } catch {
      setIdentityText("");
      setError(
        "The pasted text is not a MDevolved recovery key. Copy the complete .txt file contents.",
      );
    }
  }

  async function validateRecoveryInputs(): Promise<void> {
    if (backupFile === null || !identityReady) return;
    setWorking("Checking the backup and recovery key in this browser…");
    setError(null);
    setMessage(null);
    try {
      let identitySource = identityText;
      if (identitySource === "") {
        const selectedIdentityFile = identityFile;
        if (selectedIdentityFile === null) return;
        identitySource = await selectedIdentityFile.text();
      }
      const identity = identityFromFile(identitySource);
      const manifest = await inspectBackupArchive(backupFile, identity);
      setValidated({ backupFile, identity, manifest });
      setIdentityText("");
      setMessage(
        "Backup and recovery key match. Every note passed its safety check.",
      );
    } catch (reason: unknown) {
      setValidated(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "The encrypted backup could not be unlocked and checked.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function stagePreview(): Promise<void> {
    if (
      validated === null ||
      validated.backupFile === null ||
      validated.identity === null ||
      !canStageRestorePreview({
        crossVaultConfirmed,
        crossesVaultIds,
        targetVaultId,
        working: working !== null,
      })
    ) {
      return;
    }
    const validatedBackupFile = validated.backupFile;
    const validatedIdentity = validated.identity;
    setWorking("Preparing a safe preview…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      let currentJob = restoreJobSchema.parse(
        await apiJson(
          `/api/vaults/${encodeURIComponent(targetVaultId)}/restores`,
          {
            body: { manifest: validated.manifest },
            csrf,
          },
        ),
      );
      setJob(currentJob);
      await inspectBackupArchive(
        validatedBackupFile,
        validatedIdentity,
        async (note, content, index) => {
          setWorking(
            `Staging note ${index + 1} of ${validated.manifest.notes.length}…`,
          );
          currentJob = restoreJobSchema.parse(
            await apiJson(
              `/api/restores/${encodeURIComponent(currentJob.restoreId)}/note`,
              {
                body: { content, path: note.path },
                csrf,
                method: "PUT",
              },
            ),
          );
          setJob(currentJob);
        },
      );
      setWorking("Checking the destination and calculating the preview…");
      currentJob = restoreJobSchema.parse(
        await apiJson(
          `/api/restores/${encodeURIComponent(currentJob.restoreId)}/complete`,
          { csrf },
        ),
      );
      setJob(currentJob);
      if (
        currentJob.status !== "preview" &&
        currentJob.materializationJobId !== null
      ) {
        setWorking(
          "Refreshing the destination library before calculating the preview…",
        );
        await waitForMaterialization(currentJob);
        currentJob = restoreJobSchema.parse(
          await apiJson(
            `/api/restores/${encodeURIComponent(currentJob.restoreId)}/complete`,
            { csrf },
          ),
        );
        setJob(currentJob);
      }
      if (currentJob.status !== "preview") {
        throw new Error(
          "The destination library is still refreshing. Retry the preview safely.",
        );
      }
      setValidated((current) =>
        current === null
          ? null
          : { ...current, backupFile: null, identity: null },
      );
      setMessage("Preview ready. The destination Source has not been changed.");
    } catch (reason: unknown) {
      setJob(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "The restore preview could not be prepared.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function applyConfirmedRestore(
    initialJob: RestoreJob,
    csrf: string,
  ): Promise<void> {
    let currentJob = initialJob;
    const maxBatches = Math.ceil(currentJob.expectedNoteCount / 20) + 2;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      setWorking(
        `Applying ${currentJob.appliedNoteCount} of ${currentJob.expectedNoteCount} notes…`,
      );
      const result = restoreApplyResponseSchema.parse(
        await apiJson(
          `/api/restores/${encodeURIComponent(currentJob.restoreId)}/apply`,
          { csrf },
        ),
      );
      currentJob = result.job;
      setJob(currentJob);
      if (result.complete) break;
      if (
        currentJob.appliedNoteCount === currentJob.expectedNoteCount &&
        currentJob.materializationJobId !== null
      ) {
        setWorking("Checking the restored library generation…");
        await waitForMaterialization(currentJob);
        const completed = restoreApplyResponseSchema.parse(
          await apiJson(
            `/api/restores/${encodeURIComponent(currentJob.restoreId)}/apply`,
            { csrf },
          ),
        );
        currentJob = completed.job;
        setJob(currentJob);
        if (completed.complete) break;
        throw new Error("The restored library was not verified. Retry safely.");
      }
    }
    if (currentJob.status !== "applied") {
      throw new Error("The restore paused before verification. Retry safely.");
    }
    await onApplied(currentJob.targetVaultId);
    setValidated(null);
    setBackupFile(null);
    setIdentityFile(null);
    setIdentityText("");
    setConfirmation("");
    setMessage(
      `Restore complete and checked. Notes that were already in the destination were kept. Reference: ${currentJob.verifiedGenerationId?.slice(0, 8)}.`,
    );
  }

  async function waitForMaterialization(currentJob: RestoreJob): Promise<void> {
    if (currentJob.materializationJobId === null) {
      throw new Error("The restore library refresh was not scheduled.");
    }
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const materialization = materializationJobSchema.parse(
        await fetchApiJson(
          `/api/vaults/${encodeURIComponent(currentJob.targetVaultId)}/materializations/${encodeURIComponent(currentJob.materializationJobId)}`,
        ),
      );
      if (materialization.status === "completed") return;
      if (materialization.status === "failed") {
        throw new Error(
          "The restored library could not be verified. Retry safely.",
        );
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    throw new Error("The restored library is still refreshing. Retry safely.");
  }

  async function confirmAndApply(): Promise<void> {
    if (
      job?.status !== "preview" ||
      targetName === "" ||
      confirmation !== targetName
    ) {
      return;
    }
    setWorking("Locking the approved target…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const confirmed = restoreJobSchema.parse(
        await apiJson(
          `/api/restores/${encodeURIComponent(job.restoreId)}/confirm`,
          { body: { vaultName: confirmation }, csrf },
        ),
      );
      setJob(confirmed);
      await applyConfirmedRestore(confirmed, csrf);
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The Source could not be restored.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function retryApply(): Promise<void> {
    if (job?.status !== "applying") return;
    setWorking("Safely continuing the restore…");
    setError(null);
    try {
      await applyConfirmedRestore(job, await loadCsrf());
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The interrupted restore could not continue.",
      );
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="restore-panel" data-recovery-stage={workflowStage}>
      <div className="restore-heading">
        <div>
          <span className="backup-step">Restore a Source workspace</span>
          <h3>Follow one step at a time.</h3>
        </div>
        <span>Nothing changes before final approval</span>
      </div>

      <div className={`recovery-stage recovery-stage--${workflowStage}`}>
        <strong>{recoveryWorkflowInstruction(workflowStage)}</strong>
      </div>

      {job?.status === "applied" ? (
        <div className="recovery-complete">
          <span>Restore checked</span>
          <h4>Your Source workspace was restored safely.</h4>
          <p>
            Notes from the backup were added or updated. Notes that were already
            in the destination were kept.
          </p>
          <button
            className="secondary-action"
            type="button"
            onClick={startAnotherRestore}
          >
            Start another restore
          </button>
        </div>
      ) : validated === null ? (
        <>
          <div className="recovery-wizard-grid">
            <section
              className="recovery-step-card"
              aria-labelledby="source-step-heading"
            >
              <span className="recovery-step-number">1 · Source</span>
              <h4 id="source-step-heading">Choose the backup to recover.</h4>
              <div
                className="recovery-source-tabs"
                aria-label="Where is the backup?"
              >
                <button
                  aria-pressed={sourceMode === "stored"}
                  type="button"
                  onClick={() => chooseSourceMode("stored")}
                >
                  Saved in MDevolved
                </button>
                <button
                  aria-pressed={sourceMode === "portable"}
                  type="button"
                  onClick={() => chooseSourceMode("portable")}
                >
                  Backup file
                </button>
              </div>

              {sourceMode === "stored" ? (
                <div className="stored-backup-source">
                  <p>
                    <strong>{archiveVaultName}</strong>
                    <span>Source selected above</span>
                  </p>
                  {availableBackups.length === 0 ? (
                    <div className="recovery-empty-source">
                      No backup exists for this Source yet. Choose another
                      Source above or create a backup first.
                    </div>
                  ) : (
                    <>
                      <label>
                        <span>Backup date</span>
                        <select
                          value={storedBackupId}
                          onChange={(event) =>
                            setStoredBackupId(event.target.value)
                          }
                        >
                          {availableBackups.map((backup) => (
                            <option
                              value={backup.backupId}
                              key={backup.backupId}
                            >
                              {formatTimestamp(backup.verifiedAt)} ·{" "}
                              {backup.noteCount} notes
                            </option>
                          ))}
                        </select>
                      </label>
                      <div
                        className={`stored-source-status stored-source-status--${sourceLoad.kind}`}
                        aria-live="polite"
                      >
                        {sourceLoad.kind === "loading"
                          ? "Preparing this encrypted backup in your browser…"
                          : sourceLoad.kind === "ready" ||
                              sourceLoad.kind === "error"
                            ? sourceLoad.message
                            : "Choose a backup."}
                      </div>
                      <button
                        className="text-action"
                        disabled={sourceLoad.kind === "loading"}
                        type="button"
                        onClick={() =>
                          setSourceRevision((current) => current + 1)
                        }
                      >
                        Reload backup
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <div
                  aria-label="Portable encrypted MDevolved backup"
                  className={
                    backupFile === null
                      ? "restore-file-picker"
                      : "restore-file-picker restore-file-picker--ready"
                  }
                  onDragOver={allowFileDrop}
                  onDrop={(event) => acceptDroppedFile(event, "backup")}
                  role="group"
                >
                  <span className="restore-file-label">Backup file</span>
                  <button
                    className="restore-file-button"
                    disabled={working !== null}
                    type="button"
                    onClick={() => void chooseRecoveryFile("backup")}
                  >
                    Choose backup file
                  </button>
                  <input
                    aria-label="Standard portable backup file picker"
                    accept=".age,application/octet-stream"
                    className="restore-file-native-input"
                    ref={backupInputRef}
                    type="file"
                    onChange={(event) => {
                      attachRecoveryFile(
                        event.target.files?.item(0) ?? null,
                        "backup",
                      );
                      event.currentTarget.value = "";
                    }}
                  />
                  <small className="restore-file-selection" aria-live="polite">
                    {backupFile === null
                      ? "Choose or drop a backup file you downloaded from MDevolved."
                      : describeRecoveryFile(backupFile)}
                  </small>
                </div>
              )}
            </section>

            <section
              className="recovery-step-card"
              aria-labelledby="identity-step-heading"
            >
              <span className="recovery-step-number">2 · Recovery key</span>
              <h4 id="identity-step-heading">
                Choose the key for this backup.
              </h4>
              <div className="recovery-key-explainer">
                <strong>The backup and its recovery key belong together</strong>
                <p>
                  The key unlocks the backup only inside this browser. MDevolved
                  never receives or stores its private contents.
                </p>
              </div>
              <div
                aria-label="Private MDevolved recovery key"
                className={
                  identityReady
                    ? "restore-file-picker restore-file-picker--ready"
                    : "restore-file-picker"
                }
                onDragOver={allowFileDrop}
                onDrop={(event) => acceptDroppedFile(event, "identity")}
                role="group"
              >
                <span className="restore-file-label">Recovery key (.txt)</span>
                <button
                  className="restore-file-button"
                  disabled={working !== null}
                  type="button"
                  onClick={() => void chooseRecoveryFile("identity")}
                >
                  Choose recovery key file
                </button>
                <input
                  aria-label="Standard recovery key file picker"
                  accept=".txt,text/plain"
                  className="restore-file-native-input"
                  ref={identityInputRef}
                  type="file"
                  onChange={(event) => {
                    attachRecoveryFile(
                      event.target.files?.item(0) ?? null,
                      "identity",
                    );
                    event.currentTarget.value = "";
                  }}
                />
                <small className="restore-file-selection" aria-live="polite">
                  {identityFile !== null
                    ? describeRecoveryFile(identityFile)
                    : identityText !== ""
                      ? "Recovery key loaded from pasted text."
                      : "No recovery key selected."}
                </small>
              </div>

              <details className="recovery-key-help">
                <summary>Where do I get this file?</summary>
                <p>
                  MDevolved asked you to save it before creating the backup. New
                  files look like <code>mdevolved-recovery-key-date.txt</code>.
                  A legacy OWD backup may use{" "}
                  <code>owd-recovery-key-date.txt</code> or{" "}
                  <code>owd-recovery-identity-date.txt</code>.
                </p>
                <p>
                  <strong>Can’t find it?</strong> Stop here. A replacement key
                  can protect a new backup, but it cannot open this older one.
                </p>
              </details>

              <details className="portable-identity-option">
                <summary>Advanced: paste the key text instead</summary>
                <p className="recovery-trust-note">
                  Paste the complete `.txt` contents. The field is masked and
                  never included in a request.
                </p>
                <label className="recovery-identity-entry">
                  <span>Recovery key contents</span>
                  <input
                    aria-label="Recovery key contents"
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    placeholder="Paste complete recovery key file contents"
                    spellCheck={false}
                    type="password"
                    value={identityText}
                    onChange={(event) => {
                      resetAfterInputChange();
                      setIdentityFile(null);
                      setIdentityText(event.target.value);
                    }}
                    onPaste={acceptPastedIdentity}
                  />
                </label>
                <div
                  className={`identity-status ${identityReady ? "identity-status--ready" : ""}`}
                  aria-live="polite"
                >
                  {identityText !== ""
                    ? "Recovery key text loaded in this browser."
                    : "No recovery key text pasted."}
                </div>
              </details>
              {identityReady ? (
                <button
                  className="text-action"
                  type="button"
                  onClick={() => {
                    resetAfterInputChange();
                    setIdentityFile(null);
                    setIdentityText("");
                  }}
                >
                  Clear recovery key
                </button>
              ) : null}
            </section>
          </div>

          <div className="recovery-validate-row">
            <p>
              MDevolved checks everything in this browser first. No Source is
              changed during this step.
            </p>
            <button
              className="primary-action"
              disabled={
                working !== null || backupFile === null || !identityReady
              }
              type="button"
              onClick={() => void validateRecoveryInputs()}
            >
              Check backup and key
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="restore-summary">
            <div>
              <span>Backup from</span>
              <strong>{validated.manifest.vaultName}</strong>
              <small>
                {validated.manifest.notes.length.toLocaleString()} notes · ready
                to restore
              </small>
            </div>
            <span className="restore-arrow" aria-hidden="true">
              →
            </span>
            <label>
              <span>Restore into</span>
              <select
                disabled={job !== null || activeVaults.length === 0}
                value={targetVaultId}
                onChange={(event) => {
                  setTargetVaultId(event.target.value);
                  setCrossVaultConfirmed(false);
                }}
              >
                {activeVaults.length === 0 ? (
                  <option value="">No active Source connected</option>
                ) : null}
                {activeVaults.map((vault) => (
                  <option value={vault.id} key={vault.id}>
                    {vault.displayName ?? vault.id}
                  </option>
                ))}
              </select>
              <details className="restore-technical-details">
                <summary>Technical details</summary>
                <code>{targetVaultId}</code>
              </details>
            </label>
          </div>

          {activeVaults.length === 0 ? (
            <p className="recovery-task-guidance" role="status">
              The backup and key can be checked without a destination. Pair an
              active Source before reviewing or applying a restore.
            </p>
          ) : null}

          {crossesVaultIds && job === null ? (
            <label className="cross-vault-confirmation">
              <input
                checked={crossVaultConfirmed}
                type="checkbox"
                onChange={(event) =>
                  setCrossVaultConfirmed(event.target.checked)
                }
              />
              <span>
                I checked both Source names above and want to restore this
                backup into a different Source.
              </span>
            </label>
          ) : null}

          {job === null ? (
            <div className="recovery-target-actions">
              <button
                className="text-action"
                type="button"
                onClick={startAnotherRestore}
              >
                Start over
              </button>
              <button
                className="primary-action"
                disabled={
                  !canStageRestorePreview({
                    crossVaultConfirmed,
                    crossesVaultIds,
                    targetVaultId,
                    working: working !== null,
                  })
                }
                type="button"
                onClick={() => void stagePreview()}
              >
                Review what will change
              </button>
            </div>
          ) : null}
        </>
      )}

      {job?.status === "preview" ? (
        <div className="restore-preview">
          <div className="restore-counts">
            <div>
              <strong>{job.addedCount}</strong>
              <span>Added</span>
            </div>
            <div>
              <strong>{job.changedCount}</strong>
              <span>Changed</span>
            </div>
            <div>
              <strong>{job.unchangedCount}</strong>
              <span>Unchanged</span>
            </div>
            <div>
              <strong>0</strong>
              <span>Deleted</span>
            </div>
          </div>
          <label className="restore-name-confirmation">
            <span>
              Type <strong>{targetName}</strong> to confirm the destination
              Source.
            </span>
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            className="primary-action"
            disabled={working !== null || confirmation !== targetName}
            type="button"
            onClick={() => void confirmAndApply()}
          >
            Restore this Source
          </button>
        </div>
      ) : null}

      {job?.status === "applying" && working === null ? (
        <div className="recovery-interrupted">
          <p>
            The connection was interrupted. It is safe to continue; MDevolved
            will not duplicate notes that were already restored.
          </p>
          <div>
            <button
              className="text-action"
              type="button"
              onClick={startAnotherRestore}
            >
              Start over
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={() => void retryApply()}
            >
              Continue restore
            </button>
          </div>
        </div>
      ) : job?.status === "failed" ? (
        <button
          className="secondary-action recovery-retry"
          type="button"
          onClick={startAnotherRestore}
        >
          Start a fresh recovery
        </button>
      ) : null}

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
    </div>
  );
}
