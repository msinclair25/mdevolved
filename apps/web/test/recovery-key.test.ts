import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import {
  createRecoveryKeyDownload,
  createRecoveryKeyDocument,
  createRecoveryKeyFilename,
  recoveryKeyVerifiedForSession,
  verifyRecoveryKeyFile,
} from "../src/recovery-key";

describe("recovery key handling", () => {
  it("creates a calm, recognizable recovery-key file", () => {
    expect(
      createRecoveryKeyFilename(new Date("2026-07-22T12:34:56.789Z")),
    ).toBe("mdevolved-recovery-key-2026-07-22T12-34-56Z.txt");
    expect(createRecoveryKeyDocument("AGE-SECRET-KEY-1EXAMPLE")).toContain(
      "# MDevolved recovery key (legacy-compatible format)",
    );
    expect(createRecoveryKeyDocument("AGE-SECRET-KEY-1EXAMPLE")).toContain(
      "only key",
    );
  });

  it("proves that a saved key matches the configured public lock", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const file = new File(
      [createRecoveryKeyDocument(identity)],
      "owd-recovery-key-test.txt",
    );

    await expect(verifyRecoveryKeyFile(file, recipient)).resolves.toBe(
      recipient,
    );
  });

  it("rejects a different recovery key without uploading it", async () => {
    const expectedIdentity = await generateX25519Identity();
    const wrongIdentity = await generateX25519Identity();
    const file = new File(
      [createRecoveryKeyDocument(wrongIdentity)],
      "owd-recovery-key-wrong.txt",
    );

    await expect(
      verifyRecoveryKeyFile(file, await identityToRecipient(expectedIdentity)),
    ).rejects.toThrow("does not match");
  });

  it("prepares a complete non-empty browser download without a native save picker", async () => {
    const identity = "AGE-SECRET-KEY-1EXAMPLE";
    const filename = "owd-recovery-key-test.txt";
    const contents = createRecoveryKeyDocument(identity);
    const download = createRecoveryKeyDownload(identity, filename);

    expect(download.filename).toBe(filename);
    expect(download.byteLength).toBeGreaterThan(0);
    expect(download.byteLength).toBe(new Blob([contents]).size);
    await expect(download.blob.text()).resolves.toBe(contents);
  });

  it("accepts the downloaded bytes only after the owner reselects them", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const download = createRecoveryKeyDownload(
      identity,
      "owd-recovery-key-downloaded.txt",
    );
    const selected = new File([download.blob], download.filename);

    await expect(verifyRecoveryKeyFile(selected, recipient)).resolves.toBe(
      recipient,
    );
  });

  it("rejects an empty file selected after a download request", async () => {
    await expect(
      verifyRecoveryKeyFile(
        new File([], "owd-recovery-key-empty.txt"),
        "age1expected",
      ),
    ).rejects.toThrow("empty");
  });

  it("rejects altered bytes selected after a download request", async () => {
    await expect(
      verifyRecoveryKeyFile(
        new File(["not an age identity"], "owd-recovery-key-altered.txt"),
        "age1expected",
      ),
    ).rejects.toThrow();
  });

  it("unlocks backup creation only for the matching configured key", () => {
    expect(recoveryKeyVerifiedForSession("age1configured", null)).toBe(false);
    expect(
      recoveryKeyVerifiedForSession("age1configured", "age1different"),
    ).toBe(false);
    expect(
      recoveryKeyVerifiedForSession("age1configured", "age1configured"),
    ).toBe(true);
    expect(recoveryKeyVerifiedForSession(null, null)).toBe(false);
  });
});
