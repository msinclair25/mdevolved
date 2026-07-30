import {
  OWD_BACKUP_FORMAT,
  OWD_BACKUP_MAGIC,
  type BackupArchiveManifest,
} from "@owd/contracts";
import {
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { describe, expect, it } from "vitest";
import { identityFromFile, inspectBackupArchive } from "../src/backup-archive";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)),
  );
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

async function createFixture() {
  const content = "# Locally verified\nprivate";
  const contentBytes = encoder.encode(content);
  const backupId = crypto.randomUUID();
  const vaultId = crypto.randomUUID();
  const manifest: BackupArchiveManifest = {
    backupId,
    createdAt: 1,
    excludedSections: [
      "oauth",
      "sessions",
      "pairing-codes",
      "agent-grants",
      "pending-agent-proposals",
      "unknown-obsidian-plugin-data",
    ],
    format: OWD_BACKUP_FORMAT,
    generation: {
      completedAt: 1,
      createdAt: 1,
      generationId: crypto.randomUUID(),
      noteCount: 1,
      sourceStateVectorSha256: "a".repeat(64),
      totalBytes: contentBytes.byteLength,
      vaultId,
    },
    includedSections: ["notes"],
    notes: [
      {
        byteLength: contentBytes.byteLength,
        contentSha256: await sha256(contentBytes),
        modifiedAt: 1,
        path: "Safe.md",
      },
    ],
    reservedSections: [
      "attachments",
      "obsidian-allowlist",
      "accepted-memory",
      "skills",
      "provenance",
      "policy",
    ],
    vaultName: "Local recovery fixture",
  };
  const plaintext = new Blob([
    OWD_BACKUP_MAGIC,
    JSON.stringify(manifest),
    "\n",
    content,
  ]);
  const identity = await generateX25519Identity();
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
  const ciphertext = await readAll(await encrypter.encrypt(plaintext.stream()));
  return { ciphertext, content, identity, manifest };
}

describe("browser backup inspection", () => {
  it("extracts a commented identity file and validates every note locally", async () => {
    const fixture = await createFixture();
    expect(identityFromFile(`# private\n${fixture.identity}\n`)).toBe(
      fixture.identity,
    );
    const notes: Array<[string, string]> = [];
    const manifest = await inspectBackupArchive(
      new Blob([fixture.ciphertext.buffer]),
      fixture.identity,
      async (note, content) => {
        notes.push([note.path, content]);
      },
    );
    expect(manifest).toEqual(fixture.manifest);
    expect(notes).toEqual([["Safe.md", fixture.content]]);
  });

  it("rejects a wrong identity, tampering, and truncated ciphertext", async () => {
    const fixture = await createFixture();
    await expect(
      inspectBackupArchive(
        new Blob([fixture.ciphertext.buffer]),
        await generateX25519Identity(),
      ),
    ).rejects.toThrow();

    const tampered = fixture.ciphertext.slice();
    tampered[tampered.byteLength - 1] =
      (tampered[tampered.byteLength - 1] ?? 0) ^ 1;
    await expect(
      inspectBackupArchive(new Blob([tampered.buffer]), fixture.identity),
    ).rejects.toThrow();
    await expect(
      inspectBackupArchive(
        new Blob([fixture.ciphertext.slice(0, -8).buffer]),
        fixture.identity,
      ),
    ).rejects.toThrow();
  });

  it("rejects oversized local identity input before parsing it", () => {
    expect(() => identityFromFile("x".repeat(64 * 1024 + 1))).toThrow(
      "too large",
    );
  });
});
