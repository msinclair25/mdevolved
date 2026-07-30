import type { VaultSummary } from "@owd/contracts";
import { describe, expect, it } from "vitest";
import {
  beginVaultRefresh,
  completeVaultRefresh,
  failVaultRefresh,
  type VaultState,
} from "../src/vault-refresh-state";

const vault: VaultSummary = {
  createdAt: 1,
  displayName: "Portable recovery vault",
  id: "11111111-1111-4111-8111-111111111111",
  lastConnectedAt: 2,
  pairedAt: 1,
  status: "active",
};

const ready: VaultState = {
  kind: "ready",
  refreshError: null,
  refreshing: false,
  vaults: [vault],
};

describe("vault refresh state", () => {
  it("keeps mounted vault data during a focus-driven background refresh", () => {
    expect(beginVaultRefresh(ready, "background")).toEqual({
      ...ready,
      refreshing: true,
    });
  });

  it("uses a blocking loading state only for the initial vault load", () => {
    expect(beginVaultRefresh(ready, "initial")).toEqual({ kind: "loading" });
    expect(completeVaultRefresh([vault])).toEqual(ready);
  });

  it("keeps mounted vault data when a background refresh fails", () => {
    expect(failVaultRefresh(ready, "Refresh failed.")).toEqual({
      ...ready,
      refreshError: "Refresh failed.",
    });
    expect(
      failVaultRefresh({ kind: "loading" }, "Initial load failed."),
    ).toEqual({
      kind: "error",
      message: "Initial load failed.",
    });
  });
});
