import {
  socketTicketResponseSchema,
  vaultIdSchema,
  type SocketTicketResponse,
} from "@mdevolved/contracts";
import { decodeBase64Url, encodeBase64Url, randomToken } from "./security";
import {
  readVaultCredentialById,
  type VaultCredentialRecord,
} from "./pairing-store";

const TICKET_VERSION = 1;
const TICKET_AUDIENCE = "owd-vault-ws";
const TICKET_TTL_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_TICKET_BYTES = 2_048;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

interface SocketTicketPayload {
  v: number;
  aud: string;
  vaultId: string;
  credentialId: string;
  iat: number;
  exp: number;
  nonce: string;
}

function isSocketTicketPayload(value: unknown): value is SocketTicketPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SocketTicketPayload>;

  return (
    candidate.v === TICKET_VERSION &&
    candidate.aud === TICKET_AUDIENCE &&
    vaultIdSchema.safeParse(candidate.vaultId).success &&
    vaultIdSchema.safeParse(candidate.credentialId).success &&
    typeof candidate.iat === "number" &&
    Number.isInteger(candidate.iat) &&
    typeof candidate.exp === "number" &&
    Number.isInteger(candidate.exp) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length >= 16 &&
    candidate.nonce.length <= 128 &&
    base64UrlPattern.test(candidate.nonce)
  );
}

async function importSigningKey(tokenHash: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(tokenHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSocketTicket(
  credential: VaultCredentialRecord,
): Promise<SocketTicketResponse> {
  const issuedAt = Date.now();
  const payload: SocketTicketPayload = {
    v: TICKET_VERSION,
    aud: TICKET_AUDIENCE,
    vaultId: credential.vault_id,
    credentialId: credential.id,
    iat: issuedAt,
    exp: issuedAt + TICKET_TTL_MS,
    nonce: randomToken(16),
  };
  const encodedPayload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(credential.token_hash),
    new TextEncoder().encode(encodedPayload),
  );

  return socketTicketResponseSchema.parse({
    ticket: `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`,
    expiresAt: payload.exp,
    ttlMs: TICKET_TTL_MS,
  });
}

export async function verifySocketTicket(
  db: D1Database,
  ticket: string,
  expectedVaultId: string,
): Promise<VaultCredentialRecord | null> {
  if (
    ticket.length === 0 ||
    ticket.length > MAX_TICKET_BYTES ||
    !vaultIdSchema.safeParse(expectedVaultId).success
  ) {
    return null;
  }

  const segments = ticket.split(".");
  const encodedPayload = segments[0];
  const encodedSignature = segments[1];
  if (
    segments.length !== 2 ||
    !encodedPayload ||
    !encodedSignature ||
    !base64UrlPattern.test(encodedPayload) ||
    !base64UrlPattern.test(encodedSignature)
  ) {
    return null;
  }

  let payload: unknown;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    );
    signature = decodeBase64Url(encodedSignature);
  } catch {
    return null;
  }

  if (!isSocketTicketPayload(payload)) return null;
  const now = Date.now();
  if (
    payload.vaultId !== expectedVaultId ||
    payload.iat > now + MAX_CLOCK_SKEW_MS ||
    payload.exp <= now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > TICKET_TTL_MS
  ) {
    return null;
  }

  const credential = await readVaultCredentialById(
    db,
    payload.vaultId,
    payload.credentialId,
  );
  if (!credential) return null;

  const verified = await crypto.subtle.verify(
    "HMAC",
    await importSigningKey(credential.token_hash),
    signature,
    new TextEncoder().encode(encodedPayload),
  );

  return verified ? credential : null;
}
