import type {
  MaterializationGeneration,
  MaterializedNoteSummary,
} from "@mdevolved/contracts";

export type LibraryState =
  | { kind: "idle" | "loading" }
  | { kind: "empty"; refreshError: string | null; refreshing: boolean }
  | {
      generation: MaterializationGeneration;
      kind: "ready";
      nextCursor: string | null;
      notes: MaterializedNoteSummary[];
      refreshError: string | null;
      refreshing: boolean;
    }
  | { kind: "error"; message: string };

export type LibraryRefreshMode = "background" | "initial";

export function beginLibraryRefresh(
  current: LibraryState,
  mode: LibraryRefreshMode,
): LibraryState {
  if (
    mode === "background" &&
    (current.kind === "ready" || current.kind === "empty")
  ) {
    return { ...current, refreshError: null, refreshing: true };
  }
  return { kind: "loading" };
}

export function completeEmptyLibraryRefresh(): LibraryState {
  return { kind: "empty", refreshError: null, refreshing: false };
}

export function completeLibraryRefresh(
  generation: MaterializationGeneration,
  notes: MaterializedNoteSummary[],
  nextCursor: string | null,
): LibraryState {
  return {
    generation,
    kind: "ready",
    nextCursor,
    notes,
    refreshError: null,
    refreshing: false,
  };
}

export function failLibraryRefresh(
  current: LibraryState,
  message: string,
): LibraryState {
  if (current.kind === "ready" || current.kind === "empty") {
    return { ...current, refreshError: message, refreshing: false };
  }
  return { kind: "error", message };
}
