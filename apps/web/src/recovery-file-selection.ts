import {
  MDEVOLVED_BACKUP_FORMAT,
  type BackupArtifact,
} from "@mdevolved/contracts";

export type RecoveryFileKind = "backup" | "identity";

export type NativeFilePicker = (options: {
  excludeAcceptAllOption: boolean;
  id: string;
  multiple: boolean;
  types: Array<{
    accept: Record<string, string[]>;
    description: string;
  }>;
}) => Promise<Array<{ getFile: () => Promise<File> }>>;

const MAX_PORTABLE_BACKUP_BYTES = 40 * 1024 * 1024;
const MAX_RECOVERY_IDENTITY_BYTES = 64 * 1024;

const expectedExtension: Record<RecoveryFileKind, string> = {
  backup: ".age",
  identity: ".txt",
};

const fileDescription: Record<RecoveryFileKind, string> = {
  backup: "encrypted MDevolved backup",
  identity: "private MDevolved recovery key",
};

export function readNativeFilePicker(): NativeFilePicker | null {
  const candidate: unknown = Reflect.get(window, "showOpenFilePicker");
  return typeof candidate === "function"
    ? (candidate.bind(window) as NativeFilePicker)
    : null;
}

export function recoveryFilePickerOptions(kind: RecoveryFileKind, id: string) {
  return kind === "backup"
    ? {
        excludeAcceptAllOption: false,
        id,
        multiple: false,
        types: [
          {
            accept: { "application/octet-stream": [".age"] },
            description: "Encrypted MDevolved backup",
          },
        ],
      }
    : {
        excludeAcceptAllOption: false,
        id,
        multiple: false,
        types: [
          {
            accept: { "text/plain": [".txt"] },
            description: "Private MDevolved recovery key",
          },
        ],
      };
}

export function validateRecoveryFile(
  file: File,
  kind: RecoveryFileKind,
): string | null {
  const extension = expectedExtension[kind];
  if (!file.name.toLocaleLowerCase("en-US").endsWith(extension)) {
    return `Choose the ${fileDescription[kind]} ${extension} file.`;
  }
  if (file.size === 0) {
    return `The selected ${fileDescription[kind]} file is empty.`;
  }
  const maximumBytes =
    kind === "backup" ? MAX_PORTABLE_BACKUP_BYTES : MAX_RECOVERY_IDENTITY_BYTES;
  if (file.size > maximumBytes) {
    return `The selected ${fileDescription[kind]} file is larger than MDevolved's recovery limit.`;
  }
  return null;
}

export function describeRecoveryFile(file: File): string {
  const kibibytes = file.size / 1024;
  const size =
    kibibytes < 1024
      ? `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`
      : `${(kibibytes / 1024).toFixed(1)} MiB`;
  return `Attached: ${file.name} · ${size}`;
}

export function createStoredBackupFile(
  backup: BackupArtifact,
  encrypted: Blob,
): File {
  if (encrypted.size !== backup.ciphertextBytes) {
    throw new Error("The verified encrypted copy size did not match.");
  }
  const prefix =
    backup.format === MDEVOLVED_BACKUP_FORMAT ? "mdevolved" : "owd";
  return new File([encrypted], `${prefix}-backup-${backup.backupId}.age`, {
    type: "application/octet-stream",
  });
}
