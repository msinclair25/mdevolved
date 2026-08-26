import { useState } from "react";
import {
  browserSupportsOwdSyncInstall,
  chooseVaultAndInstallOwdSync,
  isOwdSyncInstallCancellation,
  normalizeOwdSyncInstallerError,
} from "./obsidian-plugin-installer";
import { OWD_SYNC_REQUIRED_VERSION } from "./obsidian-plugin-links";

type InstallState =
  | { kind: "idle" }
  | { kind: "choosing" }
  | { kind: "installing"; vaultName: string }
  | { kind: "success"; vaultName: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

type ObsidianPluginInstallerProps = {
  onFallbackNeeded?: () => void;
};

export function ObsidianPluginInstaller({
  onFallbackNeeded,
}: ObsidianPluginInstallerProps) {
  const [state, setState] = useState<InstallState>({ kind: "idle" });
  const supported = browserSupportsOwdSyncInstall();
  const busy = state.kind === "choosing" || state.kind === "installing";

  const install = async () => {
    setState({ kind: "choosing" });
    try {
      const result = await chooseVaultAndInstallOwdSync(undefined, (progress) =>
        setState({ kind: "installing", vaultName: progress.vaultName }),
      );
      setState({ kind: "success", vaultName: result.vaultName });
    } catch (error) {
      if (isOwdSyncInstallCancellation(error)) {
        setState({ kind: "cancelled" });
        return;
      }
      const installerError = normalizeOwdSyncInstallerError(error);
      setState({
        kind: "error",
        message: installerError.message,
      });
      onFallbackNeeded?.();
    }
  };

  return (
    <div className="plugin-installer">
      <ol className="plugin-installer-steps">
        <li>
          In Obsidian, turn on <strong>Settings → Community plugins</strong>,
          then choose <strong>Obsidian → Quit Obsidian</strong> or press{" "}
          <strong>⌘Q</strong>. Closing the Mac window is not enough. Obsidian
          requires this one-time security consent; MDevolved cannot bypass it.
        </li>
        <li>
          <div className="plugin-installer-action">
            <button
              className="primary-action"
              disabled={!supported || busy}
              type="button"
              onClick={() => void install()}
            >
              {state.kind === "choosing"
                ? "Waiting for Chrome’s folder picker…"
                : state.kind === "installing"
                  ? `Installing in ${state.vaultName}…`
                  : `Choose vault and install MDevolved Sync for Obsidian ${OWD_SYNC_REQUIRED_VERSION}`}
            </button>
            <span>
              Choose the vault root containing your notes and hidden{" "}
              <code>.obsidian</code> folder—not the <code>.obsidian</code>{" "}
              folder itself—then choose <strong>Allow</strong> if Chrome asks.
            </span>
          </div>
        </li>
        <li>
          Reopen that exact vault and confirm MDevolved Sync for Obsidian{" "}
          <strong>{OWD_SYNC_REQUIRED_VERSION}</strong> is enabled under
          Community plugins. Then return here to pair it.
        </li>
      </ol>

      {!supported ? (
        <p className="plugin-installer-status" role="status">
          Direct install needs current Chrome or Edge over HTTPS. No vault was
          changed. Use the BRAT fallback below.
        </p>
      ) : null}
      {state.kind === "choosing" ? (
        <p className="plugin-installer-status" role="status">
          Chrome should now be showing its folder picker. If you cancel it,
          MDevolved will confirm that nothing changed.
        </p>
      ) : null}
      {state.kind === "installing" ? (
        <p className="plugin-installer-status" role="status">
          Verifying the pinned release and installing it in{" "}
          <strong>{state.vaultName}</strong>. Keep this tab open.
        </p>
      ) : null}
      {state.kind === "success" ? (
        <div
          className="plugin-installer-status plugin-installer-status--success"
          role="status"
          tabIndex={-1}
        >
          <strong>
            Installed in {state.vaultName}. Installation is complete; pairing is
            next.
          </strong>
          <ol>
            <li>Reopen this exact vault in Obsidian.</li>
            <li>
              Open Settings → Community plugins and confirm MDevolved Sync for
              Obsidian {OWD_SYNC_REQUIRED_VERSION} is switched on.
            </li>
            <li>
              A brief Connecting or Disconnected status can appear while the
              first durable sync starts. Wait up to 30 seconds. If it stays
              disconnected, switch the MDevolved plugin off and back on once—do
              not reinstall it.
            </li>
            <li>Return here and continue with Pair this vault.</li>
          </ol>
          <span>Do not also install the Obsidian adapter with BRAT.</span>
        </div>
      ) : null}
      {state.kind === "cancelled" ? (
        <div className="plugin-installer-status" role="status">
          <p>No folder selected; nothing changed.</p>
          <button
            className="text-action"
            type="button"
            onClick={() => void install()}
          >
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          className="plugin-installer-status plugin-installer-status--error"
          role="alert"
        >
          <p>{state.message}</p>
          <div className="plugin-installer-status-actions">
            <button
              className="text-action"
              type="button"
              onClick={() => void install()}
            >
              Try again
            </button>
            <button
              className="text-action"
              type="button"
              onClick={onFallbackNeeded}
            >
              Show BRAT fallback
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
