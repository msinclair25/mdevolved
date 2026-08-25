import { createHash } from "node:crypto";

export type UpdatePlatform =
  "darwin-arm64" | "darwin-x64" | "linux-x64" | "win32-x64";

export interface SignedUpdateManifest {
  format: "mdevolved-update/v1";
  version: string;
  platform: UpdatePlatform;
  url: string;
  sha256: string;
  signature: string;
  keyId: string;
}

export interface UpdateSignatureVerifier {
  verify(payload: string, signature: string, keyId: string): Promise<boolean>;
}

export interface VerifiedUpdate {
  version: string;
  platform: UpdatePlatform;
  url: string;
  sha256: string;
}

const platformValues = new Set<UpdatePlatform>([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
]);
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const hashPattern = /^[a-f0-9]{64}$/;

export function canonicalManifestPayload(
  manifest: Omit<SignedUpdateManifest, "signature">,
): string {
  return JSON.stringify({
    format: manifest.format,
    version: manifest.version,
    platform: manifest.platform,
    url: manifest.url,
    sha256: manifest.sha256,
    keyId: manifest.keyId,
  });
}

export async function verifyUpdateManifest(
  input: unknown,
  expectedPlatform: UpdatePlatform,
  currentVersion: string,
  verifier: UpdateSignatureVerifier,
): Promise<VerifiedUpdate> {
  if (typeof input !== "object" || input === null)
    throw new Error("invalid update manifest");
  const m = input as Partial<SignedUpdateManifest>;
  if (
    m.format !== "mdevolved-update/v1" ||
    typeof m.version !== "string" ||
    !versionPattern.test(m.version) ||
    typeof m.platform !== "string" ||
    !platformValues.has(m.platform as UpdatePlatform) ||
    m.platform !== expectedPlatform ||
    typeof m.url !== "string" ||
    !m.url.startsWith("https://") ||
    typeof m.sha256 !== "string" ||
    !hashPattern.test(m.sha256) ||
    typeof m.signature !== "string" ||
    m.signature.length < 16 ||
    typeof m.keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(m.keyId)
  )
    throw new Error("invalid update manifest");
  if (compareVersions(m.version, currentVersion) <= 0)
    throw new Error("update is not newer");
  const payload = canonicalManifestPayload({
    format: m.format,
    version: m.version,
    platform: m.platform,
    url: m.url,
    sha256: m.sha256,
    keyId: m.keyId,
  });
  if (!(await verifier.verify(payload, m.signature, m.keyId))) {
    throw new Error("update signature rejected");
  }
  return {
    version: m.version,
    platform: m.platform,
    url: m.url,
    sha256: m.sha256,
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string): readonly number[] =>
    (version.split("-", 1)[0] ?? "").split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyArtifactHash(
  bytes: Uint8Array,
  expectedHash: string,
): boolean {
  return hashPattern.test(expectedHash) && sha256Hex(bytes) === expectedHash;
}
