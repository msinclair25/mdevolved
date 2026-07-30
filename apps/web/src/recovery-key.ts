import { identityToRecipient } from "age-encryption";
import { identityFromFile } from "./backup-archive";
import { validateRecoveryFile } from "./recovery-file-selection";

export type RecoveryKeyDownload = {
  blob: Blob;
  byteLength: number;
  filename: string;
};

export function createRecoveryKeyFilename(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/u, "Z");
  return `owd-recovery-key-${stamp}.txt`;
}

export function createRecoveryKeyDocument(identity: string): string {
  return [
    "# OWD recovery key",
    "# Keep this file private. OWD never receives this secret.",
    "# This is the only key that can open matching encrypted backups.",
    identity,
    "",
  ].join("\n");
}

export function createRecoveryKeyDownload(
  identity: string,
  suggestedName = createRecoveryKeyFilename(),
): RecoveryKeyDownload {
  const contents = createRecoveryKeyDocument(identity);
  const blob = new Blob([contents], { type: "text/plain" });
  return {
    blob,
    byteLength: blob.size,
    filename: suggestedName,
  };
}

export async function verifyRecoveryKeyFile(
  file: File,
  expectedRecipient: string,
): Promise<string> {
  const problem = validateRecoveryFile(file, "identity");
  if (problem !== null) throw new Error(problem);
  const identity = identityFromFile(await file.text());
  const recipient = await identityToRecipient(identity);
  if (recipient !== expectedRecipient) {
    throw new Error(
      "That recovery key does not match this backup setup. Choose the key saved for this OWD deployment.",
    );
  }
  return recipient;
}

export function recoveryKeyVerifiedForSession(
  configuredRecipient: string | null | undefined,
  verifiedRecipient: string | null,
): boolean {
  return (
    configuredRecipient !== null &&
    configuredRecipient !== undefined &&
    configuredRecipient === verifiedRecipient
  );
}
