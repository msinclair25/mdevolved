export type PairingCopyState =
  { kind: "idle" } | { kind: "copied" } | { kind: "error"; message: string };

type PairingCopyControlProps = {
  onCopy: () => void;
  state: PairingCopyState;
};

export function PairingCopyControl({ onCopy, state }: PairingCopyControlProps) {
  const message =
    state.kind === "copied"
      ? "Copied to this device. Continue in the intended Obsidian vault."
      : state.kind === "error"
        ? state.message
        : "The short-lived link will be copied to this device.";

  return (
    <div className="pairing-copy-control">
      <button
        aria-describedby="pairing-copy-status"
        className="primary-action"
        type="button"
        onClick={onCopy}
      >
        {state.kind === "copied" ? (
          <>
            Copied <span aria-hidden="true">✓</span>
          </>
        ) : state.kind === "error" ? (
          "Try copying again"
        ) : (
          "Copy pairing link"
        )}
      </button>
      <p
        className={`pairing-copy-status pairing-copy-status--${state.kind}`}
        id="pairing-copy-status"
        role={state.kind === "error" ? "alert" : "status"}
      >
        {message}
      </p>
    </div>
  );
}
