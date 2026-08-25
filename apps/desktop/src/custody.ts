import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialMetadata {
  present: boolean;
  backend: string;
}

/** Main-process-only custody. The credential bytes never cross the renderer IPC boundary. */
export class ProtectedCredentialCustody {
  private constructor(
    private readonly storage: SafeStorageLike,
    private readonly filePath: string,
    private readonly backend: string,
  ) {}

  static create(
    storage: SafeStorageLike,
    filePath: string,
    platform: string,
  ): ProtectedCredentialCustody {
    const backend = storage.getSelectedStorageBackend?.() ?? "unknown";
    if (
      !storage.isEncryptionAvailable() ||
      (platform === "linux" &&
        !new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]).has(
          backend,
        ))
    ) {
      throw new Error("protected credential storage unavailable");
    }
    return new ProtectedCredentialCustody(storage, filePath, backend);
  }

  metadata(): CredentialMetadata {
    return { present: true, backend: this.backend };
  }

  async save(credential: string): Promise<void> {
    if (credential.length === 0 || credential.length > 16_384) {
      throw new Error("invalid credential");
    }
    const encrypted = this.storage.encryptString(credential).toString("base64");
    await mkdir(dirname(this.filePath), { recursive: true });
    const existing = await lstat(this.filePath).catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink())
      throw new Error("protected credential path invalid");
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async load(): Promise<string | undefined> {
    try {
      const encoded = await readFile(this.filePath, "utf8");
      return this.storage.decryptString(Buffer.from(encoded, "base64"));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return undefined;
      throw new Error("protected credential read failed");
    }
  }

  async revoke(): Promise<void> {
    const existing = await lstat(this.filePath).catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink())
      throw new Error("protected credential path invalid");
    await rm(this.filePath, { force: true });
  }
}
