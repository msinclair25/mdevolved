import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { CredentialCustodyPort, CredentialRecord } from "@owd/yaos-core";
import type { PairingConnection } from "./pairing.js";

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 4 * 1024;

export interface ProtectedCredentialBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryProtectedCredentialBackend implements ProtectedCredentialBackend {
  private readonly values = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

async function runNative(
  command: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: "pipe",
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `native_credential_command_failed:${command}:${code ?? "unknown"}`,
          ),
        );
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function keychainService(key: string): string {
  return `MDevolved/${key}`;
}

class MacKeychainBackend implements ProtectedCredentialBackend {
  async read(key: string): Promise<string | null> {
    try {
      return await runNative("security", [
        "find-generic-password",
        "-a",
        key,
        "-s",
        keychainService(key),
        "-w",
      ]);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    // `-w` is deliberately the final flag: security reads the value from
    // stdin instead of exposing it in process arguments or shell history.
    await runNative(
      "security",
      [
        "add-generic-password",
        "-U",
        "-a",
        key,
        "-s",
        keychainService(key),
        "-w",
      ],
      value,
    );
  }

  async remove(key: string): Promise<void> {
    await runNative("security", [
      "delete-generic-password",
      "-a",
      key,
      "-s",
      keychainService(key),
    ]).catch(() => undefined);
  }
}

class SecretServiceBackend implements ProtectedCredentialBackend {
  async read(key: string): Promise<string | null> {
    try {
      return await runNative("secret-tool", [
        "lookup",
        "application",
        "mdevolved",
        "source",
        key,
      ]);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    await runNative(
      "secret-tool",
      [
        "store",
        "--label",
        "MDevolved source credential",
        "application",
        "mdevolved",
        "source",
        key,
      ],
      value,
    );
  }

  async remove(key: string): Promise<void> {
    await runNative("secret-tool", [
      "clear",
      "application",
      "mdevolved",
      "source",
      key,
    ]).catch(() => undefined);
  }
}

/** Windows DPAPI-backed file. The file contains only CurrentUser-encrypted bytes. */
class WindowsDpapiBackend implements ProtectedCredentialBackend {
  constructor(private readonly directory: string) {}

  private file(key: string): string {
    return join(this.directory, `${encodeURIComponent(key)}.dpapi`);
  }

  private async prepareFile(key: string): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("credential_directory_invalid");
    }
    const file = this.file(key);
    const current = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (current !== null && (!current.isFile() || current.isSymbolicLink())) {
      throw new Error("credential_file_invalid");
    }
    return file;
  }

  private async protect(value: string): Promise<string> {
    const script =
      "$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());" +
      "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,0);" +
      "[Convert]::ToBase64String($p)";
    return runNative(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      value,
    );
  }

  private async unprotect(value: string): Promise<string> {
    const script =
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,0);" +
      "[Text.Encoding]::UTF8.GetString($p)";
    return runNative(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      value,
    );
  }

  async read(key: string): Promise<string | null> {
    try {
      const encrypted = await fs.readFile(await this.prepareFile(key), "utf8");
      return await this.unprotect(encrypted);
    } catch {
      return null;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const file = await this.prepareFile(key);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, await this.protect(value), {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async remove(key: string): Promise<void> {
    const file = await this.prepareFile(key);
    await fs.rm(file, { force: true });
  }
}

export function createSystemProtectedCredentialBackend(
  stateDirectory?: string,
): ProtectedCredentialBackend {
  switch (platform()) {
    case "darwin":
      return new MacKeychainBackend();
    case "win32":
      return new WindowsDpapiBackend(
        stateDirectory ??
          join(
            process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
            "MDevolved",
            "credentials",
          ),
      );
    default:
      return new SecretServiceBackend();
  }
}

interface StoredCredential {
  record: CredentialRecord;
  secret: string;
  connection?: { host: string; vaultId: string };
}

function decodeStored(value: string | null): StoredCredential | null {
  if (value === null || value.length > MAX_RECORD_BYTES + MAX_SECRET_BYTES)
    return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredCredential>;
    const record = parsed.record;
    if (
      !record ||
      typeof record.sourceId !== "string" ||
      typeof record.fingerprint !== "string" ||
      (record.status !== "active" && record.status !== "revoked") ||
      !Number.isFinite(record.issuedAt) ||
      (record.expiresAt !== undefined && !Number.isFinite(record.expiresAt)) ||
      typeof parsed.secret !== "string" ||
      parsed.secret.length > MAX_SECRET_BYTES
    ) {
      return null;
    }
    const connection = parsed.connection;
    if (
      connection !== undefined &&
      (!isSafeDeploymentOrigin(connection.host) ||
        typeof connection.vaultId !== "string" ||
        !/^[0-9a-f-]{36}$/iu.test(connection.vaultId))
    ) {
      return null;
    }
    return {
      record: { ...record },
      secret: parsed.secret,
      ...(connection === undefined ? {} : { connection: { ...connection } }),
    };
  } catch {
    return null;
  }
}

function isSafeDeploymentOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      (url.protocol === "https:" || local) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Credential custody that never writes an unencrypted secret to project state. */
export class ProtectedCredentialCustody implements CredentialCustodyPort {
  constructor(
    readonly sourceId: string,
    private readonly backend: ProtectedCredentialBackend,
  ) {}

  private key(): string {
    return this.sourceId;
  }

  async get(): Promise<CredentialRecord | null> {
    const stored = decodeStored(await this.backend.read(this.key()));
    if (stored === null || stored.record.sourceId !== this.sourceId)
      return null;
    return { ...stored.record };
  }

  async getSecret(): Promise<string | null> {
    const stored = decodeStored(await this.backend.read(this.key()));
    if (
      stored === null ||
      stored.record.sourceId !== this.sourceId ||
      stored.record.status !== "active"
    ) {
      return null;
    }
    return stored.secret;
  }

  async getConnection(): Promise<PairingConnection | null> {
    const stored = decodeStored(await this.backend.read(this.key()));
    if (
      stored === null ||
      stored.record.sourceId !== this.sourceId ||
      stored.record.status !== "active" ||
      stored.connection === undefined
    ) {
      return null;
    }
    return {
      host: stored.connection.host,
      vaultId: stored.connection.vaultId,
      token: stored.secret,
      fingerprint: stored.record.fingerprint,
      issuedAt: stored.record.issuedAt,
      ...(stored.record.expiresAt === undefined
        ? {}
        : { expiresAt: stored.record.expiresAt }),
    };
  }

  async install(
    record: CredentialRecord,
    secret: string,
    connection?: Pick<PairingConnection, "host" | "vaultId">,
  ): Promise<void> {
    if (record.sourceId !== this.sourceId || record.status !== "active") {
      throw new Error("credential_source_or_status_invalid");
    }
    if (
      secret.length === 0 ||
      Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
    ) {
      throw new Error("credential_size_invalid");
    }
    if (
      connection !== undefined &&
      (!isSafeDeploymentOrigin(connection.host) ||
        !/^[0-9a-f-]{36}$/iu.test(connection.vaultId))
    ) {
      throw new Error("credential_connection_invalid");
    }
    await this.backend.write(
      this.key(),
      JSON.stringify({ record, secret, ...(connection ? { connection } : {}) }),
    );
  }

  async confirmReplacement(next: CredentialRecord): Promise<void> {
    const current = await this.get();
    if (current?.fingerprint === next.fingerprint) return;
    throw new Error("credential_secret_required");
  }

  async revoke(): Promise<void> {
    const current = await this.get();
    if (current === null) {
      await this.backend.remove(this.key());
      return;
    }
    await this.backend.write(
      this.key(),
      JSON.stringify({ record: { ...current, status: "revoked" }, secret: "" }),
    );
  }
}
