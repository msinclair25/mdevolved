import type { VaultSummary } from "@owd/contracts";

export function partitionVaults(vaults: readonly VaultSummary[]): {
  connected: VaultSummary[];
  disconnected: VaultSummary[];
} {
  const connected: VaultSummary[] = [];
  const disconnected: VaultSummary[] = [];

  for (const vault of vaults) {
    (vault.status === "revoked" ? disconnected : connected).push(vault);
  }

  return { connected, disconnected };
}

export function disconnectedHistoryLabel(count: number): string {
  return `${count.toLocaleString()} disconnected Source${count === 1 ? "" : "s"}`;
}
