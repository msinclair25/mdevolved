import { useState } from "react";
import {
  browserSupportsOwdSyncInstall,
  chooseVaultAndInstallOwdSync,
  isOwdSyncInstallCancellation,
  OwdSyncInstallerError,
} from "./obsidian-plugin-installer";
import { OWD_SYNC_REQUIRED_VERSION } from "./obsidian-plugin-links";

type InstallState =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "success"; vaultName: string }
  | { kind: "error"; message: string };

export function ObsidianPluginInstaller() {
  const [state, setState] = useState<InstallState>({ kind: "idle" });
  const supported = browserSupportsOwdSyncInstall();

  const install = async () => {
    setState({ kind: "installing" });
    try {
      const result = await chooseVaultAndInstallOwdSync();
      setState({ kind: "success", vaultName: result.vaultName });
    } catch (error) {
      if (isOwdSyncInstallCancellation(error)) {
        setState({ kind: "idle" });
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof OwdSyncInstallerError
            ? error.message
            : "OWD Sync could not be installed. Your existing vault files were left unchanged.",
      });
    }
  };

  return (
    <div className="plugin-installer">
      <p className="plugin-installer-prerequisite">
        First time only: in Obsidian, open{" "}
        <strong>Settings → Community plugins</strong> and choose{" "}
        <strong>Turn on community plugins</strong>. Obsidian requires that
        security consent; OWD will not bypass it.
      </p>
      <div className="plugin-installer-action">
        <button
          className="primary-action"
          disabled={!supported || state.kind === "installing"}
          type="button"
          onClick={() => void install()}
        >
          {state.kind === "installing"
            ? "Installing and verifying…"
            : `Install OWD Sync ${OWD_SYNC_REQUIRED_VERSION}`}
        </button>
        <span>
          Close Obsidian, click once, and choose the vault folder. Your browser
          will ask for local write permission.
        </span>
      </div>

      {!supported ? (
        <p className="plugin-installer-status" role="status">
          Direct install needs current Chrome or Edge over HTTPS. Use the
          fallback below in Safari or Firefox.
        </p>
      ) : null}
      {state.kind === "success" ? (
        <p
          className="plugin-installer-status plugin-installer-status--success"
          role="status"
        >
          OWD Sync {OWD_SYNC_REQUIRED_VERSION} is installed and queued as
          enabled in <strong>{state.vaultName}</strong>. Reopen Obsidian once,
          confirm it is enabled, then return here to create the pairing request.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p
          className="plugin-installer-status plugin-installer-status--error"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
