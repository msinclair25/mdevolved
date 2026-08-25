export type ClosedFileConflictDecision =
  | { kind: "no-op" }
  | { kind: "apply-remote-to-disk"; reason: "disk-at-baseline" }
  | { kind: "import-disk-to-crdt"; reason: "crdt-at-baseline" }
  | {
      kind: "preserve-conflict";
      reason: "both-changed" | "missing-baseline";
      winner: "disk" | "crdt";
      preserveCrdt?: true;
      preserveDisk?: true;
    };

export interface ClosedFileConflictInput {
  baselineHash: string | null;
  diskHash: string;
  crdtHash: string;
  diskMtime?: number;
  lastDiskIndexPersistedAt?: number;
}

export type MissingBaselineWinnerPolicy =
  | "disk-mtime-after-last-index-save"
  | "crdt-default-no-evidence"
  | "crdt-default-disk-not-newer";

/** Pure three-way authority decision shared by Obsidian and folder sources. */
export function decideClosedFileConflict(
  input: ClosedFileConflictInput,
): ClosedFileConflictDecision & {
  _missingBaselinePolicy?: MissingBaselineWinnerPolicy;
} {
  const {
    baselineHash,
    diskHash,
    crdtHash,
    diskMtime,
    lastDiskIndexPersistedAt,
  } = input;
  if (diskHash === crdtHash) return { kind: "no-op" };
  if (baselineHash === null) {
    const hasMtimeEvidence =
      diskMtime !== undefined && lastDiskIndexPersistedAt !== undefined;
    if (hasMtimeEvidence && diskMtime > lastDiskIndexPersistedAt) {
      return {
        kind: "preserve-conflict",
        reason: "missing-baseline",
        winner: "disk",
        preserveCrdt: true,
        _missingBaselinePolicy: "disk-mtime-after-last-index-save",
      };
    }
    return {
      kind: "preserve-conflict",
      reason: "missing-baseline",
      winner: "crdt",
      preserveDisk: true,
      _missingBaselinePolicy: hasMtimeEvidence
        ? "crdt-default-disk-not-newer"
        : "crdt-default-no-evidence",
    };
  }
  if (diskHash === baselineHash && crdtHash !== baselineHash) {
    return { kind: "apply-remote-to-disk", reason: "disk-at-baseline" };
  }
  if (crdtHash === baselineHash && diskHash !== baselineHash) {
    return { kind: "import-disk-to-crdt", reason: "crdt-at-baseline" };
  }
  return {
    kind: "preserve-conflict",
    reason: "both-changed",
    winner: "disk",
    preserveCrdt: true,
  };
}
