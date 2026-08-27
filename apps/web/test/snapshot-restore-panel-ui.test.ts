import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  snapshotIntelligenceManifestSchema,
  type SnapshotManifest,
} from "@mdevolved/contracts";
import {
  collaborationRestoreVaultMappings,
  revealRestoreCompletion,
  snapshotArchiveFilename,
  snapshotArchiveSelectionMessage,
  snapshotArchiveSummary,
  SnapshotRestorePanel,
} from "../src/SnapshotRestorePanel";

describe("snapshot restore panel UI", () => {
  it("shows both required files and provides a focus target", () => {
    const html = renderToStaticMarkup(
      createElement(SnapshotRestorePanel, {
        activeVaults: [],
        initialSnapshot: null,
        onApplied: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain("Open an encrypted snapshot copy");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Choose snapshot file");
    expect(html).toContain("Choose recovery key file");
    expect(html).toContain("Check snapshot and key");
  });

  it("identifies the exact encrypted snapshot file before checking it", () => {
    const file = new File(
      [new Uint8Array(2048)],
      "owd-snapshot-92c2d08d.owdsnapshot",
    );

    expect(snapshotArchiveFilename(file, null)).toBe(
      "owd-snapshot-92c2d08d.owdsnapshot",
    );
    expect(snapshotArchiveSelectionMessage(file, null)).toBe(
      "Selected owd-snapshot-92c2d08d.owdsnapshot · 2.0 KiB.",
    );
  });

  it("keeps the checked snapshot identity visible through mapping and apply", () => {
    expect(
      snapshotArchiveSummary(
        {
          captureCompletedAt: 1_785_000_000,
          snapshotId: "92c2d08d-9c23-4843-9325-bba4d9be89f7",
          vaults: [
            { entries: Array.from({ length: 25 }) },
            { entries: Array.from({ length: 26 }) },
          ],
        },
        "owd-snapshot-92c2d08d-9c23-4843-9325-bba4d9be89f7.owdsnapshot",
        "Jul 22, 2026, 11:20 PM",
      ),
    ).toBe(
      "owd-snapshot-92c2d08d-9c23-4843-9325-bba4d9be89f7.owdsnapshot · created Jul 22, 2026, 11:20 PM · 2 Sources · 51 items · portable manifest reference 92c2d08d",
    );
  });

  it("focuses and centers the checked restore result", () => {
    const focusCalls: FocusOptions[] = [];
    const scrollCalls: ScrollIntoViewOptions[] = [];
    const element = {
      focus: (options?: FocusOptions) => {
        focusCalls.push(options ?? {});
      },
      scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => {
        if (typeof options === "object") scrollCalls.push(options);
      },
    };

    revealRestoreCompletion(element);

    expect(focusCalls).toEqual([{ preventScroll: true }]);
    expect(scrollCalls).toEqual([{ block: "center" }]);
  });

  it("recovers the exact source vault identity from an older single-vault Project snapshot", () => {
    const sourceVaultId = "10000000-0000-4000-8000-000000000001";
    const targetVaultId = "20000000-0000-4000-8000-000000000002";
    const snapshotVaultId = "30000000-0000-4000-8000-000000000003";
    const portableObjectId = "40000000-0000-4000-8000-000000000004";
    const recordId = "50000000-0000-4000-8000-000000000005";
    const record = {
      createdAt: 1,
      knowledgeSpaceId: "60000000-0000-4000-8000-000000000006",
      knowledgeSpaceVersionId: recordId,
      members: [
        {
          exclusions: [],
          pathPrefixes: [{ path: "", pathKey: "" }],
          vaultId: sourceVaultId,
        },
      ],
      previousVersionId: null,
      recordType: "knowledge-space-version" as const,
      schemaVersion: 1 as const,
      selectorSha256: "a".repeat(64),
      version: 1,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    const intelligence = snapshotIntelligenceManifestSchema.parse({
      approved: {
        classification: "approved",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes: bytes.byteLength,
        newlyStoredBytes: bytes.byteLength,
        recordCount: 1,
        records: [
          {
            byteLength: bytes.byteLength,
            classification: "approved",
            contentSha256: "b".repeat(64),
            dependencies: [],
            evidenceOnly: false,
            originalState: {
              disposition: "accepted",
              visibility: "owner-only",
            },
            portableObjectId,
            projectId: "70000000-0000-4000-8000-000000000007",
            recordId,
            recordType: "knowledge-space-version",
            restoreDisposition: "restore-approved",
            schemaVersion: 1,
            workItemId: null,
          },
        ],
      },
      excludedAuthority: [
        "oauth-access-tokens",
        "oauth-refresh-tokens",
        "oauth-authorization-codes",
        "oauth-protocol-storage",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "vault-credentials",
        "live-agent-grants",
        "recovery-private-keys",
        "harness-context",
        "provider-credentials",
        "runtime-caches",
      ],
      format: "owd-snapshot-intelligence-v1",
      requiredCapabilities: [APPROVED_INTELLIGENCE_CAPABILITY],
      schemaVersion: 1,
      selection: "approved",
      unvetted: null,
    });
    const manifest = {
      intelligence,
      vaults: [
        {
          entries: [],
          snapshotVaultId,
          sourceGeneration: null,
          vaultName: "Source vault",
        },
      ],
    } satisfies Pick<SnapshotManifest, "intelligence" | "vaults">;

    expect(
      collaborationRestoreVaultMappings(
        manifest,
        new Map([[portableObjectId, bytes]]),
        { [snapshotVaultId]: targetVaultId },
      ),
    ).toEqual([{ sourceVaultId, targetVaultId }]);
  });
});
