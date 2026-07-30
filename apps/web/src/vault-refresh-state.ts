import type { VaultSummary } from "@owd/contracts";

export type VaultState =
  | { kind: "idle" | "loading" }
  | {
      kind: "ready";
      refreshError: string | null;
      refreshing: boolean;
      vaults: VaultSummary[];
    }
  | { kind: "error"; message: string };

export type VaultRefreshMode = "background" | "initial";

export function beginVaultRefresh(
  current: VaultState,
  mode: VaultRefreshMode,
): VaultState {
  if (mode === "background" && current.kind === "ready") {
    return { ...current, refreshError: null, refreshing: true };
  }
  return { kind: "loading" };
}

export function completeVaultRefresh(vaults: VaultSummary[]): VaultState {
  return {
    kind: "ready",
    refreshError: null,
    refreshing: false,
    vaults,
  };
}

export function failVaultRefresh(
  current: VaultState,
  message: string,
): VaultState {
  if (current.kind === "ready") {
    return { ...current, refreshError: message, refreshing: false };
  }
  return { kind: "error", message };
}
