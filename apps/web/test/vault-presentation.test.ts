import type { VaultSummary } from "@owd/contracts";
import { describe, expect, it } from "vitest";
import {
  disconnectedHistoryLabel,
  partitionVaults,
} from "../src/vault-presentation";

const vault = (id: string, status: VaultSummary["status"]): VaultSummary => ({
  createdAt: 1,
  displayName: id,
  id,
  lastConnectedAt: status === "active" ? 3 : null,
  pairedAt: status === "active" ? 2 : null,
  status,
});

describe("vault presentation", () => {
  it("keeps active and pending vaults primary while separating revoked history", () => {
    expect(
      partitionVaults([
        vault("active", "active"),
        vault("revoked", "revoked"),
        vault("pending", "pending"),
      ]),
    ).toEqual({
      connected: [vault("active", "active"), vault("pending", "pending")],
      disconnected: [vault("revoked", "revoked")],
    });
  });

  it("uses an accessible singular or plural history count", () => {
    expect(disconnectedHistoryLabel(1)).toBe("1 disconnected Source");
    expect(disconnectedHistoryLabel(18)).toBe("18 disconnected Sources");
  });
});
