import type { BackupArtifact, VaultSummary } from "@owd/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RestorePanel } from "../src/RestorePanel";

const vaultId = "11111111-1111-4111-8111-111111111111";

const vault: VaultSummary = {
  createdAt: 1,
  displayName: "Disposable target",
  id: vaultId,
  lastConnectedAt: 1,
  pairedAt: 1,
  status: "active",
};

const backup: BackupArtifact = {
  backupId: "22222222-2222-4222-8222-222222222222",
  ciphertextBytes: 42,
  completedAt: 2,
  createdAt: 1,
  format: "owd-backup-v1",
  generationId: "33333333-3333-4333-8333-333333333333",
  noteCount: 3,
  recipientFingerprint: "a".repeat(64),
  vaultId,
  verifiedAt: 2,
};

describe("recovery UI", () => {
  it("uses a stored OWD artifact without a file picker by default", () => {
    const html = renderToStaticMarkup(
      createElement(RestorePanel, {
        activeVaults: [vault],
        archiveVaultName: "Disposable source",
        availableBackups: [backup],
        initialTargetVaultId: vaultId,
        onApplied: () => undefined,
      }),
    );

    expect(html).toContain("Saved in OWD");
    expect(html).toContain("Vault selected above");
    expect(html).toContain("Choose the key for this backup");
    expect(html).toContain("Choose recovery key file");
    expect(html).toContain("Check backup and key");
    expect(html).toContain("Where do I get this file?");
    expect(html).toContain("owd-recovery-identity-date.txt");
    expect(html).toContain("Nothing changes before final approval");
    expect(html).not.toContain("Standard portable backup file picker");
    expect(html).not.toContain("Private recovery identity");
    expect(html).not.toContain("Unlock and check backup");
    expect(html).not.toContain("Use for restore");
  });
});
