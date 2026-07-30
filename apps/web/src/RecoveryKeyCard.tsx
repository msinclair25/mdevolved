import { useRef } from "react";

export type PendingRecoveryKey = {
  byteLength: number;
  downloadHref: string;
  downloadRequested: boolean;
  filename: string;
  verifiedFilename: string | null;
};

type Props = {
  configured: boolean | null;
  disabled: boolean;
  fingerprint: string | null;
  onActivate: () => void;
  onCancel: () => void;
  onChooseFile: (file: File) => Promise<void> | void;
  onCreate: () => void;
  onDownload: () => void;
  pending: PendingRecoveryKey | null;
  sessionVerifiedFilename: string | null;
};

export function RecoveryKeyCard({
  configured,
  disabled,
  fingerprint,
  onActivate,
  onCancel,
  onChooseFile,
  onCreate,
  onDownload,
  pending,
  sessionVerifiedFilename,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function chooseSavedKey(): void {
    if (inputRef.current !== null) {
      inputRef.current.value = "";
      inputRef.current.click();
    }
  }

  const keyPicker = (
    <div
      className={`recovery-key-picker ${
        pending?.verifiedFilename !== null &&
        pending?.verifiedFilename !== undefined
          ? "recovery-key-picker--ready"
          : sessionVerifiedFilename !== null
            ? "recovery-key-picker--ready"
            : ""
      }`}
    >
      <button
        className="secondary-action"
        disabled={disabled}
        type="button"
        onClick={chooseSavedKey}
      >
        Choose recovery key file
      </button>
      <input
        aria-label="Standard saved recovery key file picker"
        accept=".txt,text/plain"
        className="restore-file-native-input"
        ref={inputRef}
        type="file"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file !== null && file !== undefined) void onChooseFile(file);
          event.currentTarget.value = "";
        }}
      />
      <span aria-live="polite">
        {pending?.verifiedFilename !== null &&
        pending?.verifiedFilename !== undefined
          ? `Verified: ${pending.verifiedFilename}`
          : sessionVerifiedFilename !== null
            ? `Verified for this session: ${sessionVerifiedFilename}`
            : "Not checked yet."}
      </span>
    </div>
  );

  return (
    <article className="recovery-card recovery-key-card">
      <span className="backup-step">01 · Recovery key</span>
      {configured === null ? (
        <p>Checking whether your backups already have a recovery key…</p>
      ) : pending !== null ? (
        <>
          {pending.downloadRequested ? (
            <>
              <h3>Confirm the downloaded key.</h3>
              <p>
                OWD asked your browser to download {pending.filename} (
                {pending.byteLength.toLocaleString()} bytes) through its normal
                Downloads flow. OWD has not assumed where the browser placed it.
              </p>
              <ol className="recovery-key-checklist">
                <li>Keep this small `.txt` file private.</li>
                <li>Save a second copy somewhere you can recover later.</li>
                <li>
                  Find the exact timestamped file and choose it below. OWD will
                  read and verify it locally.
                </li>
              </ol>
              {configured ? (
                <p className="recovery-key-rotation-warning">
                  <strong>Existing backups do not change.</strong> They still
                  need their original recovery key.
                </p>
              ) : null}
              {keyPicker}
              <div className="backup-actions recovery-key-actions">
                <button
                  className="primary-action"
                  disabled={pending.verifiedFilename === null || disabled}
                  type="button"
                  onClick={onActivate}
                >
                  Finish setup
                </button>
                <a
                  aria-disabled={disabled}
                  className="text-action"
                  download={pending.filename}
                  href={pending.downloadHref}
                  onClick={(event) => {
                    if (disabled) {
                      event.preventDefault();
                      return;
                    }
                    onDownload();
                  }}
                >
                  Download another copy
                </a>
              </div>
            </>
          ) : (
            <>
              <h3>Download your recovery key now.</h3>
              <p>
                OWD uses the browser&apos;s normal Downloads flow and does not
                call the native save-location API. OWD will not claim the key is
                safely kept until you select and verify the downloaded file.
              </p>
              <div
                className="recovery-key-equation"
                aria-label="Recovery model"
              >
                <span>Encrypted backup</span>
                <b aria-hidden="true">+</b>
                <span>Recovery key</span>
                <b aria-hidden="true">=</b>
                <strong>Restorable vault</strong>
              </div>
              <p>
                File: {pending.filename} ({pending.byteLength.toLocaleString()}{" "}
                bytes)
              </p>
              <a
                aria-disabled={disabled}
                className="primary-action"
                download={pending.filename}
                href={pending.downloadHref}
                onClick={(event) => {
                  if (disabled) {
                    event.preventDefault();
                    return;
                  }
                  onDownload();
                }}
              >
                Download recovery key
              </a>
            </>
          )}
          <div className="backup-actions recovery-key-actions">
            <button
              className="text-action"
              disabled={disabled}
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </>
      ) : configured === false ? (
        <>
          <h3>Create the key to your backups.</h3>
          <p>
            This is a small private file you keep. You only need it when
            restoring a backup, and OWD cannot recreate it for you.
          </p>
          <div className="recovery-key-equation" aria-label="Recovery model">
            <span>Encrypted backup</span>
            <b aria-hidden="true">+</b>
            <span>Recovery key</span>
            <b aria-hidden="true">=</b>
            <strong>Restorable vault</strong>
          </div>
          <button
            className="primary-action"
            disabled={disabled}
            type="button"
            onClick={onCreate}
          >
            Create recovery key
          </button>
        </>
      ) : sessionVerifiedFilename === null ? (
        <>
          <h3>Confirm you still have your recovery key.</h3>
          <p>
            Choose the small `.txt` file you saved during setup. OWD checks it
            only in this browser and never uploads it.
          </p>
          {keyPicker}
          <details className="recovery-key-help">
            <summary>I can’t find my recovery key</summary>
            <p>
              Stop here. Existing encrypted backups need their original key.
              Creating a replacement key will protect future backups but will
              not unlock older ones.
            </p>
          </details>
          <button
            className="text-action"
            disabled={disabled}
            type="button"
            onClick={onCreate}
          >
            Create a replacement key
          </button>
          <details className="recovery-key-help">
            <summary>Technical details</summary>
            <p>
              Recovery key reference: {fingerprint?.slice(0, 12) ?? "unknown"}
            </p>
          </details>
        </>
      ) : (
        <>
          <h3>Recovery key ready.</h3>
          <p>
            OWD confirmed that you still have the key needed to restore new
            backups. You can safely continue to step 2.
          </p>
          <div className="recovery-key-ready" aria-live="polite">
            <strong>Ready for backup</strong>
            <span>{sessionVerifiedFilename}</span>
          </div>
          <details className="recovery-key-help">
            <summary>Change the recovery key</summary>
            <p>
              Existing backups always need their original key. A replacement key
              applies only to future backups.
            </p>
            <button
              className="text-action"
              disabled={disabled}
              type="button"
              onClick={onCreate}
            >
              Create a replacement key
            </button>
          </details>
        </>
      )}
    </article>
  );
}
