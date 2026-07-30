import type { MaterializationGeneration } from "@owd/contracts";
import { describe, expect, it } from "vitest";
import {
  beginLibraryRefresh,
  completeLibraryRefresh,
  failLibraryRefresh,
  type LibraryState,
} from "../src/library-refresh-state";

const generation: MaterializationGeneration = {
  completedAt: 2,
  createdAt: 1,
  generationId: "22222222-2222-4222-8222-222222222222",
  noteCount: 1,
  sourceStateVectorSha256: "a".repeat(64),
  totalBytes: 4,
  vaultId: "11111111-1111-4111-8111-111111111111",
};

const ready: LibraryState = completeLibraryRefresh(
  generation,
  [
    {
      byteLength: 4,
      contentSha256: "b".repeat(64),
      modifiedAt: 1,
      path: "Note.md",
      title: "Note",
    },
  ],
  null,
);

describe("library refresh state", () => {
  it("keeps the existing library mounted during a background refresh", () => {
    expect(beginLibraryRefresh(ready, "background")).toEqual({
      ...ready,
      refreshing: true,
    });
  });

  it("uses a blocking state when the selected library vault changes", () => {
    expect(beginLibraryRefresh(ready, "initial")).toEqual({ kind: "loading" });
  });

  it("keeps the existing library mounted when a background refresh fails", () => {
    expect(failLibraryRefresh(ready, "Refresh failed.")).toEqual({
      ...ready,
      refreshError: "Refresh failed.",
    });
  });
});
