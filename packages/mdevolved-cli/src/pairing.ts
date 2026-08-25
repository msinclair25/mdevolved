import { createHash } from "node:crypto";
import type { SourceDescriptor } from "@owd/yaos-core";

export const MDEVOLVED_SCHEMA_VERSION = 3;
const MAX_LINK_LENGTH = 2_048;

export interface PairingParameters {
  deploymentUrl: string;
  grant: string;
}

export interface PairingConnection {
  host: string;
  token: string;
  vaultId: string;
  fingerprint: string;
  issuedAt: number;
  expiresAt?: number;
}

export interface PairingExchangeRequest {
  deploymentUrl: string;
  grant: string;
  sourceDescriptor: SourceDescriptor;
  sourceName: string;
  clientVersion: string;
}

export interface PairingTransport {
  exchange(request: PairingExchangeRequest): Promise<unknown>;
}

export class PairingError extends Error {
  override readonly name = "PairingError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function base64Url(value: unknown, min = 20, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function deploymentOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PairingError("pairing_deployment_invalid");
  }
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp)
    throw new PairingError("pairing_deployment_insecure");
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new PairingError("pairing_deployment_invalid");
  }
  return url.origin;
}

export function parsePairingLink(value: string): PairingParameters {
  const link = value.trim();
  if (!link || link.length > MAX_LINK_LENGTH || hasControlCharacters(link)) {
    throw new PairingError("pairing_link_invalid");
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new PairingError("pairing_link_invalid");
  }
  const keys = [...url.searchParams.keys()];
  if (
    !["owd-pair:", "mdevolved:"].includes(url.protocol) ||
    url.hostname !== "connect" ||
    !["", "/"].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("deployment") ||
    !keys.includes("grant")
  ) {
    throw new PairingError("pairing_link_invalid");
  }
  const deploymentUrl = deploymentOrigin(
    url.searchParams.get("deployment") ?? "",
  );
  const grant = url.searchParams.get("grant")?.trim() ?? "";
  if (!base64Url(grant, 20, 128))
    throw new PairingError("pairing_grant_invalid");
  return { deploymentUrl, grant };
}

function parseConnection(
  value: unknown,
  deploymentUrl: string,
): PairingConnection {
  if (!isRecord(value)) throw new PairingError("pairing_response_invalid");
  const returnedDeployment =
    typeof value.deploymentUrl === "string"
      ? deploymentOrigin(value.deploymentUrl)
      : "";
  const vaultId = value.vaultId;
  const token = value.credential;
  const supported = value.supportedSchemaVersions;
  if (
    returnedDeployment !== deploymentUrl ||
    typeof vaultId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      vaultId,
    ) ||
    !base64Url(token, 20, 256) ||
    !isRecord(supported) ||
    typeof supported.min !== "number" ||
    typeof supported.max !== "number" ||
    !Number.isInteger(supported.min) ||
    !Number.isInteger(supported.max) ||
    supported.min > MDEVOLVED_SCHEMA_VERSION ||
    supported.max < MDEVOLVED_SCHEMA_VERSION
  ) {
    throw new PairingError("pairing_response_invalid");
  }
  const issuedAt =
    typeof value.issuedAt === "number" && Number.isFinite(value.issuedAt)
      ? value.issuedAt
      : Date.now();
  const expiresAt =
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? value.expiresAt
      : undefined;
  return {
    host: deploymentUrl,
    token,
    vaultId,
    fingerprint: createHash("sha256").update(token, "utf8").digest("hex"),
    issuedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export async function pairFolder(
  pairing: PairingParameters,
  sourceDescriptor: SourceDescriptor,
  sourceName: string,
  clientVersion: string,
  transport: PairingTransport,
): Promise<PairingConnection> {
  const name = sourceName.trim();
  if (!name || name.length > 120 || hasControlCharacters(name))
    throw new PairingError("pairing_source_name_invalid");
  const response = await transport.exchange({
    deploymentUrl: pairing.deploymentUrl,
    grant: pairing.grant,
    sourceDescriptor,
    sourceName: name,
    clientVersion,
  });
  return parseConnection(response, pairing.deploymentUrl);
}

export function createFetchPairingTransport(
  fetchImpl: typeof fetch = fetch,
): PairingTransport {
  return {
    async exchange(request): Promise<unknown> {
      const response = await fetchImpl(
        `${request.deploymentUrl}/api/pairing/exchange`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant: request.grant,
            pluginVersion: request.clientVersion,
            schemaVersion: MDEVOLVED_SCHEMA_VERSION,
            vaultName: request.sourceName,
            sourceDescriptor: {
              sourceKind: request.sourceDescriptor.sourceKind,
              label: request.sourceDescriptor.label,
              capabilities: request.sourceDescriptor.capabilities,
              clientVersion: request.sourceDescriptor.clientVersion,
              syncSchemaVersion: request.sourceDescriptor.syncSchemaVersion,
            },
          }),
        },
      );
      if (!response.ok)
        throw new PairingError(
          response.status === 400
            ? "pairing_grant_expired"
            : `pairing_http_${response.status}`,
        );
      return response.json();
    },
  };
}
