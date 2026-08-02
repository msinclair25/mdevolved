import { useEffect, useId, useState } from "react";

type CopyState = "copied" | "error" | "idle";

type SmartCopyFieldProps = {
  disabled?: boolean;
  label: string;
  value: string;
};

export function SmartCopyField({
  disabled = false,
  label,
  value,
}: SmartCopyFieldProps) {
  const [state, setState] = useState<CopyState>("idle");
  const statusId = useId();

  useEffect(() => {
    if (state === "idle") return;
    const timeout = window.setTimeout(() => setState("idle"), 2_500);
    return () => window.clearTimeout(timeout);
  }, [state]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("error");
    }
  }

  return (
    <div className={`smart-copy-field smart-copy-field--${state}`}>
      <pre tabIndex={0}>
        <code>{value}</code>
      </pre>
      <button
        aria-describedby={statusId}
        className="smart-copy-action"
        disabled={disabled}
        type="button"
        onClick={() => void copy()}
      >
        {state === "copied"
          ? "Copied ✓"
          : state === "error"
            ? "Try again"
            : label}
      </button>
      <span className="smart-copy-status" id={statusId} role="status">
        {state === "copied"
          ? "Copied to this device."
          : state === "error"
            ? "Clipboard access was blocked. Select the command to copy it."
            : ""}
      </span>
    </div>
  );
}
