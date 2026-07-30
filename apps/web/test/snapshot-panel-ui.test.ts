import { snapshotSummarySchema } from "@owd/contracts";
import { describe, expect, it } from "vitest";
import {
  snapshotDownloadFilename,
  snapshotDownloadRequestedMessage,
  snapshotScopeSummary,
  splitSnapshotHistory,
} from "../src/SnapshotPanel";

describe("snapshot timeline UI", () => {
  it("identifies a requested encrypted-copy download beside its action", () => {
    const snapshotId = "92c2d08d-9c23-4843-9325-bba4d9be89f7";

    expect(snapshotDownloadFilename(snapshotId)).toBe(
      "owd-snapshot-92c2d08d-9c23-4843-9325-bba4d9be89f7.owdsnapshot",
    );
    expect(
      snapshotDownloadRequestedMessage(
        {
          snapshotId,
          verifiedAt: 1_785_000_000,
        },
        "Jul 22, 2026, 11:20 PM",
      ),
    ).toBe(
      "Download requested for owd-snapshot-92c2d08d-9c23-4843-9325-bba4d9be89f7.owdsnapshot. Snapshot created and checked at Jul 22, 2026, 11:20 PM. Snapshot record reference: 92c2d08d.",
    );
  });

  it("reports the actual snapshot scope and selected count", () => {
    expect(snapshotScopeSummary("all-active", 4, 1)).toEqual({
      label: "All active vaults",
      vaultCount: 4,
    });
    expect(snapshotScopeSummary("selected", 4, 1)).toEqual({
      label: "Only selected vaults",
      vaultCount: 1,
    });
  });

  it("separates reversible archive presentation from current history", () => {
    const current = snapshotSummarySchema.parse({
      archivedAt: null,
      captureCompletedAt: 20,
      captureStartedAt: 10,
      changedItemCount: 1,
      createdAt: 10,
      encryption: "age-x25519",
      failureCode: null,
      format: "owd-snapshot-v2",
      includedSections: ["notes"],
      intelligence: { approved: null, selection: "none", unvetted: null },
      integrityStatus: "verified",
      itemCount: 1,
      logicalBytes: 10,
      newlyStoredBytes: 20,
      pinned: false,
      processedObjectCount: 1,
      recipientFingerprint: "a".repeat(64),
      scope: "selected",
      snapshotId: "92c2d08d-9c23-4843-9325-bba4d9be89f7",
      status: "ready",
      totalObjectCount: 1,
      unavailableSections: [],
      vaults: [],
      verifiedAt: 20,
    });
    const archived = snapshotSummarySchema.parse({
      ...current,
      archivedAt: 30,
      snapshotId: "82c2d08d-9c23-4843-9325-bba4d9be89f7",
    });

    expect(splitSnapshotHistory([current, archived])).toEqual({
      archived: [archived],
      current: [current],
    });
  });
});
