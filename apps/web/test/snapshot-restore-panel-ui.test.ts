import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
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
      "owd-snapshot-92c2d08d-9c23-4843-9325-bba4d9be89f7.owdsnapshot · created Jul 22, 2026, 11:20 PM · 2 source vaults · 51 items · portable manifest reference 92c2d08d",
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
});
