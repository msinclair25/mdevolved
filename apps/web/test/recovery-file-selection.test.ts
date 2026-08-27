import { describe, expect, it } from "vitest";
import {
  createStoredBackupFile,
  describeRecoveryFile,
  validateRecoveryFile,
} from "../src/recovery-file-selection";
import type { BackupArtifact } from "@mdevolved/contracts";

describe("recovery file selection", () => {
  it("accepts non-empty recovery files and describes an attached file", () => {
    const backup = new File([new Uint8Array(1536)], "backup.AGE");
    const identity = new File(["private"], "identity.txt");

    expect(validateRecoveryFile(backup, "backup")).toBeNull();
    expect(validateRecoveryFile(identity, "identity")).toBeNull();
    expect(describeRecoveryFile(backup)).toBe("Attached: backup.AGE · 1.5 KiB");
  });

  it("rejects empty files and the wrong recovery file type", () => {
    expect(
      validateRecoveryFile(new File(["data"], "backup.txt"), "backup"),
    ).toContain(".age");
    expect(
      validateRecoveryFile(new File([], "identity.txt"), "identity"),
    ).toContain("empty");
    expect(
      validateRecoveryFile(
        new File([new Uint8Array(64 * 1024 + 1)], "identity.txt"),
        "identity",
      ),
    ).toContain("recovery limit");
    expect(
      validateRecoveryFile(
        new File([new Uint8Array(40 * 1024 * 1024 + 1)], "backup.age"),
        "backup",
      ),
    ).toContain("recovery limit");
  });

  it("creates a portable File only from the complete verified cloud copy", () => {
    const backup: BackupArtifact = {
      backupId: crypto.randomUUID(),
      ciphertextBytes: 4,
      completedAt: 1,
      createdAt: 1,
      format: "owd-backup-v1",
      generationId: crypto.randomUUID(),
      noteCount: 1,
      recipientFingerprint: "a".repeat(64),
      vaultId: crypto.randomUUID(),
      verifiedAt: 1,
    };
    const file = createStoredBackupFile(backup, new Blob(["safe"]));
    expect(file.name).toBe(`owd-backup-${backup.backupId}.age`);
    expect(file.size).toBe(backup.ciphertextBytes);
    expect(() => createStoredBackupFile(backup, new Blob(["short"]))).toThrow(
      "size did not match",
    );
  });

  it("uses the canonical filename for newly written MDevolved backups", () => {
    const backup: BackupArtifact = {
      backupId: crypto.randomUUID(),
      ciphertextBytes: 4,
      completedAt: 1,
      createdAt: 1,
      format: "mdevolved-backup-v1",
      generationId: crypto.randomUUID(),
      noteCount: 1,
      recipientFingerprint: "a".repeat(64),
      vaultId: crypto.randomUUID(),
      verifiedAt: 1,
    };
    expect(createStoredBackupFile(backup, new Blob(["safe"])).name).toBe(
      `mdevolved-backup-${backup.backupId}.age`,
    );
  });
});
