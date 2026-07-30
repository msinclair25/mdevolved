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
      "The OWD pairing link has an invalid deployment URL.",
    );
  }

  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new OwdPairingError(
      "OWD pairing requires HTTPS, except when using a local development server.",
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
      "The OWD pairing link has an invalid deployment origin.",
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
      "The OWD pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  return { deploymentUrl: url.origin, grant };
}

export function parseObsidianPairingProtocol(
  params: Readonly<Record<string, string>>,
): OwdPairingParameters {
  const keys = Object.keys(params);
  if (
    params.action !== "owd-pair" ||
    keys.length !== 3 ||
    !keys.includes("deployment") ||
    !keys.includes("grant")
  ) {
    throw new OwdPairingError(
      "The OWD pairing link is incomplete or malformed. Generate a new link from your dashboard.",
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
      "The OWD pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new OwdPairingError(
      "The OWD pairing link is incomplete or malformed. Generate a new link from your dashboard.",
    );
  }

  const keys = [...url.searchParams.keys()];
  const uniqueKeys = new Set(keys);
  if (
    url.protocol !== "owd-pair:" ||
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
      "The OWD pairing link is incomplete or malformed. Generate a new link from your dashboard.",
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
): OwdConnection {
  if (!isRecord(value)) {
    throw new OwdPairingError(
      "The OWD deployment returned an invalid pairing response.",
    );
  }

  const deploymentUrl = value.deploymentUrl;
  const supported = value.supportedSchemaVersions;
  if (
    typeof deploymentUrl !== "string" ||
    normalizeDeployment(deploymentUrl).origin !== expectedDeployment ||
    !isUuid(value.vaultId) ||
    !isBase64Url(value.credential) ||
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
      "The OWD deployment returned an invalid pairing response.",
    );
  }

  return {
    host: expectedDeployment,
    token: value.credential,
    vaultId: value.vaultId,
  };
}

export async function pairOwdVault(
  pairing: OwdPairingParameters,
  vaultNameValue: string,
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
      "This vault name cannot be used for OWD pairing.",
    );
  }

  const deploymentHost = new URL(pairing.deploymentUrl).host;
  if (!(await dependencies.confirm({ deploymentHost, vaultName }))) {
    return "cancelled";
  }

  const response = await dependencies.request({
    body: JSON.stringify({
      grant: pairing.grant,
      pluginVersion,
      schemaVersion: OWD_SCHEMA_VERSION,
      vaultName,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    url: `${pairing.deploymentUrl}/api/pairing/exchange`,
  });
  if (response.status !== 200) {
    throw new OwdPairingError(
      response.status === 400
        ? "This pairing link is expired or has already been used. Generate a new link from your OWD dashboard."
        : `OWD could not pair this vault (server status ${response.status}).`,
    );
  }

  await dependencies.applyConnection(
    parseConnection(response.json, pairing.deploymentUrl),
  );
  return "paired";
}
