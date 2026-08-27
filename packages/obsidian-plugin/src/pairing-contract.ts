export const OWD_SCHEMA_VERSION = 3;

export interface OwdPairingParameters {
  deploymentUrl: string;
  grant: string;
}

export interface OwdPairingConsent {
  deploymentHost: string;
  vaultName: string;
}

export interface OwdConnection {
  host: string;
  token: string;
  vaultId: string;
  deviceId?: string;
  rootFingerprintSha256?: string;
}

export interface OwdPairingRequest {
  body: string;
  headers: Record<string, string>;
  method: "POST";
  url: string;
}

export interface OwdPairingResponse {
  json: unknown;
  status: number;
}

export interface OwdPairingDependencies {
  applyConnection(connection: OwdConnection): Promise<void>;
  confirm(consent: OwdPairingConsent): Promise<boolean>;
  request(request: OwdPairingRequest): Promise<OwdPairingResponse>;
  createDeviceMaterial?(): Promise<{
    credential: string;
    deviceId: string;
    idempotencyKey: string;
  }>;
}

export type OwdPairingOutcome = "cancelled" | "paired";

export class OwdPairingError extends Error {
  override readonly name = "OwdPairingError";
}

const OWD_PAIRING_LINK_MAX_LENGTH = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBase64Url(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sourceRootFingerprintSha256(
  rootIdentity: string,
): Promise<string> {
  return sha256Hex(rootIdentity);
}

async function defaultDeviceMaterial() {
  return {
    credential: base64Url(crypto.getRandomValues(new Uint8Array(32))),
    deviceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  };
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function normalizeDeployment(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OwdPairingError(
      "The MDevolved pairing link has an invalid deployment URL.",
    );
  }

  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new OwdPairingError(
      "MDevolved pairing requires HTTPS, except when using a local development server.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new OwdPairingError(
      "The MDevolved pairing link has an invalid deployment origin.",
    );
  }

  return url;
}

export function parseOwdPairingParameters(
  params: Record<string, string>,
): OwdPairingParameters {
  const deployment = params.deployment?.trim() ?? "";
  const grant = params.grant?.trim() ?? "";
  const url = normalizeDeployment(deployment);

  if (!isBase64Url(grant)) {
    throw new OwdPairingError(
      "The MDevolved pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  return { deploymentUrl: url.origin, grant };
}

export function parseObsidianPairingProtocol(
  params: Readonly<Record<string, string>>,
): OwdPairingParameters {
  const keys = Object.keys(params);
  if (
    !["mdevolved-pair", "owd-pair"].includes(params.action ?? "") ||
    keys.length !== 3 ||
    !keys.includes("deployment") ||
    !keys.includes("grant")
  ) {
    throw new OwdPairingError(
      "The MDevolved pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  return parseOwdPairingParameters({
    deployment: params.deployment ?? "",
    grant: params.grant ?? "",
  });
}

export function parseOwdPairingLink(value: string): OwdPairingParameters {
  const link = value.trim();
  if (
    link.length === 0 ||
    link.length > OWD_PAIRING_LINK_MAX_LENGTH ||
    hasControlCharacters(link)
  ) {
    throw new OwdPairingError(
      "The MDevolved pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new OwdPairingError(
      "The MDevolved pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  const keys = [...url.searchParams.keys()];
  const uniqueKeys = new Set(keys);
  if (
    !["mdevolved:", "owd-pair:"].includes(url.protocol) ||
    url.hostname !== "connect" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    keys.length !== 2 ||
    uniqueKeys.size !== 2 ||
    !uniqueKeys.has("deployment") ||
    !uniqueKeys.has("grant")
  ) {
    throw new OwdPairingError(
      "The MDevolved pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  return parseOwdPairingParameters({
    deployment: url.searchParams.get("deployment") ?? "",
    grant: url.searchParams.get("grant") ?? "",
  });
}

function parseConnection(
  value: unknown,
  expectedDeployment: string,
  localCredential?: string,
  expectedDeviceId?: string,
  expectedRootFingerprintSha256?: string,
): OwdConnection {
  if (!isRecord(value)) {
    throw new OwdPairingError(
      "The MDevolved deployment returned an invalid pairing response.",
    );
  }

  const deploymentUrl = value.deploymentUrl;
  const supported = value.supportedSchemaVersions;
  if (
    typeof deploymentUrl !== "string" ||
    normalizeDeployment(deploymentUrl).origin !== expectedDeployment ||
    !isUuid(value.vaultId) ||
    !isBase64Url(
      value.credentialAccepted === true ? localCredential : value.credential,
    ) ||
    typeof value.serverVersion !== "string" ||
    value.serverVersion.length === 0 ||
    value.serverVersion.length > 64 ||
    !isRecord(supported) ||
    !Number.isInteger(supported.min) ||
    !Number.isInteger(supported.max) ||
    Number(supported.min) > OWD_SCHEMA_VERSION ||
    Number(supported.max) < OWD_SCHEMA_VERSION
  ) {
    throw new OwdPairingError(
      "The MDevolved deployment returned an invalid pairing response.",
    );
  }

  const deviceId = isRecord(value.sourceDevice)
    ? value.sourceDevice.deviceId
    : undefined;
  if (
    value.credentialAccepted === true &&
    (!isUuid(deviceId) || deviceId !== expectedDeviceId)
  ) {
    throw new OwdPairingError(
      "The MDevolved deployment returned an invalid pairing response.",
    );
  }

  return {
    host: expectedDeployment,
    token:
      value.credentialAccepted === true
        ? (localCredential as string)
        : (value.credential as string),
    vaultId: value.vaultId,
    ...(typeof deviceId === "string" ? { deviceId } : {}),
    ...(typeof deviceId === "string" &&
    typeof expectedRootFingerprintSha256 === "string"
      ? { rootFingerprintSha256: expectedRootFingerprintSha256 }
      : {}),
  };
}

export async function pairOwdVault(
  pairing: OwdPairingParameters,
  vaultNameValue: string,
  rootIdentityValue: string,
  pluginVersion: string,
  dependencies: OwdPairingDependencies,
): Promise<OwdPairingOutcome> {
  const vaultName = vaultNameValue.trim();
  if (
    vaultName.length === 0 ||
    vaultName.length > 120 ||
    hasControlCharacters(vaultName)
  ) {
    throw new OwdPairingError(
      "This vault name cannot be used for MDevolved pairing.",
    );
  }

  const deploymentHost = new URL(pairing.deploymentUrl).host;
  if (!(await dependencies.confirm({ deploymentHost, vaultName }))) {
    return "cancelled";
  }

  const rootIdentity = rootIdentityValue.trim();
  if (
    rootIdentity.length === 0 ||
    rootIdentity.length > 4_096 ||
    hasControlCharacters(rootIdentity)
  ) {
    throw new OwdPairingError(
      "This vault root cannot be used for MDevolved pairing.",
    );
  }
  const capabilities = ["markdown", "editor-integration", "watch"] as const;
  const boundaryCanonical = JSON.stringify({
    version: 1,
    root: ".",
    pathPolicy: "mdevolved-markdown-v1",
    sourceKind: "obsidian",
    capabilities,
  });
  const material = await (
    dependencies.createDeviceMaterial ?? defaultDeviceMaterial
  )();
  if (
    !isBase64Url(material.credential) ||
    !isUuid(material.deviceId) ||
    !isUuid(material.idempotencyKey)
  ) {
    throw new OwdPairingError(
      "MDevolved could not create a safe device identity.",
    );
  }

  const rootFingerprintSha256 = await sourceRootFingerprintSha256(rootIdentity);
  const request: OwdPairingRequest = {
    body: JSON.stringify({
      grant: pairing.grant,
      pluginVersion,
      schemaVersion: OWD_SCHEMA_VERSION,
      vaultName,
      sourceDescriptor: {
        sourceKind: "obsidian",
        label: vaultName,
        capabilities,
        clientVersion: pluginVersion,
        syncSchemaVersion: OWD_SCHEMA_VERSION,
      },
      sourceDevice: {
        contractVersion: 1,
        deviceId: material.deviceId,
        displayName: `Obsidian on ${globalThis.navigator?.platform || "this device"}`,
        rootFingerprintSha256,
        boundary: {
          version: 1,
          root: ".",
          pathPolicy: "mdevolved-markdown-v1",
          sourceKind: "obsidian",
          capabilities,
          boundarySha256: await sha256Hex(boundaryCanonical),
        },
        credentialSha256: await sha256Hex(material.credential),
        idempotencyKey: material.idempotencyKey,
      },
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    url: `${pairing.deploymentUrl}/api/pairing/exchange`,
  };
  let response: OwdPairingResponse;
  try {
    response = await dependencies.request(request);
  } catch {
    // Retry once with byte-identical client-generated material if the exchange
    // may have committed but its response was lost.
    response = await dependencies.request(request);
  }
  if (response.status !== 200) {
    throw new OwdPairingError(
      response.status === 400
        ? "This pairing link is expired or has already been used. Generate a new link from your MDevolved dashboard."
        : `MDevolved could not pair this vault (server status ${response.status}).`,
    );
  }

  await dependencies.applyConnection(
    parseConnection(
      response.json,
      pairing.deploymentUrl,
      material.credential,
      material.deviceId,
      rootFingerprintSha256,
    ),
  );
  return "paired";
}
