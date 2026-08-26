import type { VaultSummary } from "@owd/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BackupPanel,
  backupCreatedMessage,
  defaultBackupHistoryVaultId,
} from "../src/BackupPanel";

const vault: VaultSummary = {
  createdAt: 1,
  displayName: "Disposable vault",
  id: "11111111-1111-4111-8111-111111111111",
  lastConnectedAt: 1,
  pairedAt: 1,
  status: "active",
};

const revokedVault: VaultSummary = {
  ...vault,
  displayName: "Disconnected archive",
  id: "22222222-2222-4222-8222-222222222222",
  status: "revoked",
};

const pendingVault: VaultSummary = {
  ...vault,
  displayName: null,
  id: "33333333-3333-4333-8333-333333333333",
  pairedAt: null,
  status: "pending",
};

describe("backup and restore task chooser", () => {
  it("shows one calm choice and does not load restore before it is chosen", () => {
    const html = renderToStaticMarkup(
      createElement(BackupPanel, {
        activeVaults: [vault],
        initialVaultId: vault.id,
        onRestoreApplied: () => undefined,
        vaults: [vault],
      }),
    );

    expect(html).toContain("Back up a vault");
    expect(html).toContain("What do you need to do?");
    expect(html).toContain("Select one of the buttons below");
    expect(html).toContain("Make a new safe copy");
    expect(html).toContain("Backup steps open ✓");
    expect(html).toContain("Restore a vault");
    expect(html).toContain("Use a backup to recover notes");
    expect(html).toContain("Open restore steps →");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Create backup");
    expect(html).not.toContain("Which vault was backed up?");
    expect(html).not.toContain("Follow one step at a time");
    expect(html).not.toContain("Immutable artifact");
  });

  it("identifies a completed backup by time, note count, and reference", () => {
    expect(
      backupCreatedMessage(
        {
          backupId: "12345678-1234-4234-8234-123456789abc",
          noteCount: 25,
        },
        "Jul 22, 2026, 4:35 PM",
      ),
    ).toBe(
      "Backup created and checked at Jul 22, 2026, 4:35 PM. Look for the entry with 25 notes under Your backups. Reference: 12345678.",
    );
  });

  it("keeps recovery and disconnected backup history visible without an active vault", () => {
    const html = renderToStaticMarkup(
      createElement(BackupPanel, {
        activeVaults: [],
        initialVaultId: "",
        onRestoreApplied: () => undefined,
        vaults: [pendingVault, revokedVault],
      }),
    );

    expect(defaultBackupHistoryVaultId([pendingVault, revokedVault], "")).toBe(
      revokedVault.id,
    );
    expect(html).toContain("Backup &amp; restore");
    expect(html).toContain("No active Source is connected");
    expect(html).toContain("No active vault connected");
    expect(html).toContain("Existing backups remain available below");
    expect(html).toContain("Disconnected archive · disconnected");
    expect(html).not.toContain(pendingVault.id);
  });
});
