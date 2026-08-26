import {
  MAX_SNAPSHOT_ITEMS,
  OWD_SNAPSHOT_EXPORT_MAGIC,
  snapshotExportIndexSchema,
  snapshotManifestSchema,
  unsupportedSnapshotRequiredCapabilities,
  type SnapshotEntryManifest,
  type SnapshotExportIndex,
  type SnapshotManifest,
  type SnapshotVaultManifest,
} from "@owd/contracts";
import { Decrypter } from "age-encryption";

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_EXPORT_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ENCRYPTED_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_DECRYPTED_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_AGE_OBJECT_OVERHEAD_BYTES = 64 * 1024;

type LocatedPart = SnapshotExportIndex["parts"][number] & {
  end: number;
  start: number;
};

export type InspectedSnapshotEntry = {
  bytes: Uint8Array;
  entry: SnapshotEntryManifest;
  vault: SnapshotVaultManifest;
};

export type InspectedSnapshotArchive = {
  index: SnapshotExportIndex;
  intelligenceObjects: Map<string, Uint8Array>;
  manifest: SnapshotManifest;
};

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

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("snapshot_plaintext_limit_exceeded");
        throw new Error(
          "The decrypted snapshot part exceeds its safety limit.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function parsePortableIndex(file: Blob): Promise<{
  index: SnapshotExportIndex;
  parts: Map<string, LocatedPart>;
}> {
  const prefix = new Uint8Array(
    await file.slice(0, MAX_EXPORT_INDEX_BYTES).arrayBuffer(),
  );
  const firstLineEnd = prefix.indexOf(10);
  const secondLineEnd =
    firstLineEnd < 0 ? -1 : prefix.indexOf(10, firstLineEnd + 1);
  if (firstLineEnd < 0 || secondLineEnd < 0) {
    throw new Error("The portable snapshot header is incomplete or too large.");
  }
  const magic = `${decoder.decode(prefix.slice(0, firstLineEnd))}\n`;
  if (magic !== OWD_SNAPSHOT_EXPORT_MAGIC) {
    throw new Error(
      "This is not a MDevolved-compatible OWD portable snapshot.",
    );
  }
  const index = snapshotExportIndexSchema.parse(
    JSON.parse(
      decoder.decode(prefix.slice(firstLineEnd + 1, secondLineEnd)),
    ) as unknown,
  );
  const unsupported = unsupportedSnapshotRequiredCapabilities(
    index.requiredCapabilities,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `This snapshot requires a newer compatible OWD version (${unsupported.join(", ")}).`,
    );
  }
  let offset = secondLineEnd + 1;
  const parts = new Map<string, LocatedPart>();
  for (const part of index.parts) {
    const end = offset + part.ciphertextBytes;
    parts.set(part.portableObjectId, { ...part, end, start: offset });
    offset = end;
  }
  if (offset !== file.size) {
    throw new Error("The portable snapshot byte boundaries are invalid.");
  }
  return { index, parts };
}

async function decryptPart(
  file: Blob,
  part: LocatedPart,
  identity: string,
  maxPlaintextBytes: number,
): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  try {
    decrypter.addIdentity(identity);
  } catch {
    throw new Error("The recovery key is invalid.");
  }
  let decrypted: ReadableStream<Uint8Array>;
  try {
    decrypted = await decrypter.decrypt(
      file.slice(part.start, part.end).stream(),
    );
  } catch {
    throw new Error("That recovery key cannot open this encrypted snapshot.");
  }
  return readBoundedStream(decrypted, maxPlaintextBytes);
}

export async function inspectSnapshotArchive(
  file: Blob,
  identity: string,
  onEntry?: (
    value: InspectedSnapshotEntry,
    index: number,
    total: number,
  ) => Promise<void>,
): Promise<InspectedSnapshotArchive> {
  const portable = await parsePortableIndex(file);
  const manifestPart = portable.index.parts[0];
  const locatedManifest =
    manifestPart === undefined
      ? undefined
      : portable.parts.get(manifestPart.portableObjectId);
  if (
    locatedManifest === undefined ||
    locatedManifest.role !== "manifest" ||
    locatedManifest.ciphertextBytes > MAX_ENCRYPTED_MANIFEST_BYTES
  ) {
    throw new Error("The portable snapshot manifest is invalid.");
  }
  const manifest = snapshotManifestSchema.parse(
    JSON.parse(
      decoder.decode(
        await decryptPart(
          file,
          locatedManifest,
          identity,
          MAX_DECRYPTED_MANIFEST_BYTES,
        ),
      ),
    ) as unknown,
  );
  if (manifest.snapshotId !== portable.index.snapshotId) {
    throw new Error(
      "The portable snapshot identity does not match its manifest.",
    );
  }
  const unsupported = unsupportedSnapshotRequiredCapabilities(
    manifest.requiredCapabilities,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `This snapshot requires a newer compatible OWD version (${unsupported.join(", ")}).`,
    );
  }
  const contentPartIds = new Set(
    portable.index.parts
      .filter((part) => part.role === "content")
      .map((part) => part.portableObjectId),
  );
  const intelligenceDescriptors = [
    ...(manifest.intelligence?.approved?.records ?? []),
    ...(manifest.intelligence?.approved?.evidenceObjects ?? []),
    ...(manifest.intelligence?.unvetted?.records ?? []),
    ...(manifest.intelligence?.unvetted?.evidenceObjects ?? []),
  ];
  const expectedContentPartIds = new Set([
    ...manifest.objects.map((object) => object.portableObjectId),
    ...intelligenceDescriptors.map((object) => object.portableObjectId),
  ]);
  if (
    contentPartIds.size !== expectedContentPartIds.size ||
    [...expectedContentPartIds].some((id) => !contentPartIds.has(id)) ||
    (portable.index.intelligenceSelection !== undefined &&
      portable.index.intelligenceSelection !==
        (manifest.intelligence?.selection ?? "none"))
  ) {
    throw new Error("The portable snapshot object inventory is incomplete.");
  }

  const objects = new Map(
    manifest.objects.map((object) => [object.portableObjectId, object]),
  );
  const verified = new Map<string, Uint8Array>();
  for (const object of manifest.objects) {
    const part = portable.parts.get(object.portableObjectId);
    if (part === undefined || part.role !== "content") {
      throw new Error("The portable snapshot is missing a content object.");
    }
    if (
      part.ciphertextBytes >
      object.byteLength + MAX_AGE_OBJECT_OVERHEAD_BYTES
    ) {
      throw new Error("A portable snapshot content object is oversized.");
    }
    const bytes = await decryptPart(file, part, identity, object.byteLength);
    if (
      bytes.byteLength !== object.byteLength ||
      (await sha256Hex(bytes)) !== object.contentSha256
    ) {
      throw new Error("A portable snapshot content checksum failed.");
    }
    verified.set(object.portableObjectId, bytes);
  }
  const intelligenceObjects = new Map<string, Uint8Array>();
  for (const object of intelligenceDescriptors) {
    const part = portable.parts.get(object.portableObjectId);
    if (part === undefined || part.role !== "content") {
      throw new Error(
        "The portable snapshot is missing an intelligence object.",
      );
    }
    if (
      part.ciphertextBytes >
      object.byteLength + MAX_AGE_OBJECT_OVERHEAD_BYTES
    ) {
      throw new Error("A portable intelligence object is oversized.");
    }
    const bytes = await decryptPart(file, part, identity, object.byteLength);
    if (
      bytes.byteLength !== object.byteLength ||
      (await sha256Hex(bytes)) !== object.contentSha256
    ) {
      throw new Error("A portable intelligence checksum failed.");
    }
    intelligenceObjects.set(object.portableObjectId, bytes);
  }

  const entries = manifest.vaults.flatMap((vault) =>
    vault.entries.map((entry) => ({ entry, vault })),
  );
  if (entries.length > MAX_SNAPSHOT_ITEMS) {
    throw new Error("The portable snapshot contains too many items.");
  }
  for (const [index, value] of entries.entries()) {
    const object = objects.get(value.entry.portableObjectId);
    const bytes = verified.get(value.entry.portableObjectId);
    if (
      object === undefined ||
      bytes === undefined ||
      object.section !== value.entry.section
    ) {
      throw new Error("A portable snapshot entry is incomplete.");
    }
    await onEntry?.({ ...value, bytes }, index, entries.length);
  }
  return { index: portable.index, intelligenceObjects, manifest };
}
