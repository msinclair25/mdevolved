import {
  OWD_BACKUP_MAGIC,
  backupArchiveManifestSchema,
  type BackupArchiveManifest,
  type BackupArchiveNote,
} from "@owd/contracts";
import { Decrypter } from "age-encryption";

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_IDENTITY_FILE_BYTES = 64 * 1024;

class StreamByteReader {
  private buffer = new Uint8Array(0);
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(): Promise<void> {
    if (this.done) return;
    const next = await this.reader.read();
    if (next.done) {
      this.done = true;
      return;
    }
    if (this.buffer.byteLength === 0) {
      const copy = new Uint8Array(next.value.byteLength);
      copy.set(next.value);
      this.buffer = copy;
      return;
    }
    const combined = new Uint8Array(
      this.buffer.byteLength + next.value.byteLength,
    );
    combined.set(this.buffer);
    combined.set(next.value, this.buffer.byteLength);
    this.buffer = combined;
  }

  async readLine(maxBytes: number): Promise<Uint8Array> {
    while (true) {
      const lineEnd = this.buffer.indexOf(10);
      if (lineEnd >= 0) {
        if (lineEnd > maxBytes) {
          throw new Error("The backup header is incomplete or too large.");
        }
        const line = this.buffer.slice(0, lineEnd);
        this.buffer = this.buffer.slice(lineEnd + 1);
        return line;
      }
      if (this.buffer.byteLength > maxBytes || this.done) {
        throw new Error("The backup header is incomplete or too large.");
      }
      await this.fill();
    }
  }

  async readExact(byteLength: number): Promise<Uint8Array> {
    while (this.buffer.byteLength < byteLength && !this.done) {
      await this.fill();
    }
    if (this.buffer.byteLength < byteLength) {
      throw new Error("The backup ended before all note bytes were read.");
    }
    const value = this.buffer.slice(0, byteLength);
    this.buffer = this.buffer.slice(byteLength);
    return value;
  }

  async assertEnd(): Promise<void> {
    while (!this.done) await this.fill();
    if (this.buffer.byteLength !== 0) {
      throw new Error("The backup contains unexpected trailing bytes.");
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
  );
}

export function identityFromFile(value: string): string {
  if (new Blob([value]).size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error("The recovery key file is too large.");
  }
  const identity = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("AGE-SECRET-KEY-1"));
  if (identity === undefined) {
    throw new Error("This file does not contain a MDevolved recovery key.");
  }
  return identity;
}

export async function inspectBackupArchive(
  file: Blob,
  identity: string,
  onNote?: (
    note: BackupArchiveNote,
    content: string,
    index: number,
  ) => Promise<void>,
): Promise<BackupArchiveManifest> {
  const decrypter = new Decrypter();
  try {
    decrypter.addIdentity(identity);
  } catch {
    throw new Error("The recovery key is invalid.");
  }
  let decrypted: ReadableStream<Uint8Array>;
  try {
    decrypted = await decrypter.decrypt(file.stream());
  } catch {
    throw new Error("That recovery key cannot open this encrypted backup.");
  }
  const reader = new StreamByteReader(decrypted);
  try {
    const magic = `${decoder.decode(await reader.readLine(64))}\n`;
    if (magic !== OWD_BACKUP_MAGIC) {
      throw new Error(
        "This is not a MDevolved-compatible legacy backup archive.",
      );
    }
    const manifest = backupArchiveManifestSchema.parse(
      JSON.parse(
        decoder.decode(await reader.readLine(MAX_MANIFEST_BYTES)),
      ) as unknown,
    );
    for (const [index, note] of manifest.notes.entries()) {
      const bytes = await reader.readExact(note.byteLength);
      if ((await sha256Hex(bytes)) !== note.contentSha256) {
        throw new Error(`The backup checksum failed for ${note.path}.`);
      }
      const content = decoder.decode(bytes);
      await onNote?.(note, content, index);
    }
    await reader.assertEnd();
    return manifest;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("The encrypted backup could not be validated.");
  }
}
