import type {
  AuthenticationOptions,
  AuthenticationResponse,
  RegistrationOptions,
  RegistrationResponse,
} from "@owd/contracts";
import { encodeBase64Url } from "../src/security";

type VirtualPasskey = {
  credentialId: Uint8Array<ArrayBuffer>;
  keyPair: CryptoKeyPair;
};

function concatenate(
  ...parts: Uint8Array<ArrayBufferLike>[]
): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function cborHeader(
  majorType: number,
  length: number,
): Uint8Array<ArrayBuffer> {
  if (length < 24) {
    return new Uint8Array([(majorType << 5) | length]);
  }

  if (length < 256) {
    return new Uint8Array([(majorType << 5) | 24, length]);
  }

  return new Uint8Array([
    (majorType << 5) | 25,
    (length >>> 8) & 0xff,
    length & 0xff,
  ]);
}

function cborInteger(value: number): Uint8Array<ArrayBuffer> {
  return value >= 0 ? cborHeader(0, value) : cborHeader(1, -1 - value);
}

function cborBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatenate(cborHeader(2, value.length), value);
}

function cborText(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  return concatenate(cborHeader(3, bytes.length), bytes);
}

function cborMap(
  entries: [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>][],
): Uint8Array<ArrayBuffer> {
  return concatenate(cborHeader(5, entries.length), ...entries.flat());
}

function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  ]);
}

async function rpIdHash(rpID: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpID)),
  );
}

function clientData(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({
      challenge,
      crossOrigin: false,
      origin,
      type,
    }),
  );
}

function derInteger(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let firstNonZero = 0;

  while (firstNonZero < bytes.length - 1 && bytes[firstNonZero] === 0) {
    firstNonZero += 1;
  }

  const magnitude = bytes.slice(firstNonZero);
  const needsPadding = ((magnitude[0] ?? 0) & 0x80) !== 0;
  const value = needsPadding
    ? concatenate(new Uint8Array([0]), magnitude)
    : magnitude;

  return concatenate(new Uint8Array([0x02, value.length]), value);
}

function toDerSignature(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature[0] === 0x30) {
    return Uint8Array.from(signature);
  }

  if (signature.length !== 64) {
    throw new Error("Unexpected synthetic ECDSA signature length.");
  }

  const r = derInteger(signature.slice(0, 32));
  const s = derInteger(signature.slice(32));
  return concatenate(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export async function createRegistrationFixture(
  options: RegistrationOptions,
  origin: string,
  rpID: string,
): Promise<{
  passkey: VirtualPasskey;
  response: RegistrationResponse;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
  const rawPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const cosePublicKey = cborMap([
    [cborInteger(1), cborInteger(2)],
    [cborInteger(3), cborInteger(-7)],
    [cborInteger(-1), cborInteger(1)],
    [cborInteger(-2), cborBytes(rawPublicKey.slice(1, 33))],
    [cborInteger(-3), cborBytes(rawPublicKey.slice(33, 65))],
  ]);
  const authenticatorData = concatenate(
    await rpIdHash(rpID),
    new Uint8Array([0x45]),
    counterBytes(0),
    new Uint8Array(16),
    new Uint8Array([0, credentialId.length]),
    credentialId,
    cosePublicKey,
  );
  const attestationObject = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authenticatorData)],
  ]);
  const encodedCredentialId = encodeBase64Url(credentialId);

  return {
    passkey: {
      credentialId,
      keyPair,
    },
    response: {
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      id: encodedCredentialId,
      rawId: encodedCredentialId,
      response: {
        attestationObject: encodeBase64Url(attestationObject),
        clientDataJSON: encodeBase64Url(
          clientData("webauthn.create", options.challenge, origin),
        ),
        transports: ["internal"],
      },
      type: "public-key",
    },
  };
}

export async function createAuthenticationFixture(
  passkey: VirtualPasskey,
  options: AuthenticationOptions,
  origin: string,
  rpID: string,
  counter: number,
): Promise<AuthenticationResponse> {
  const authenticatorData = concatenate(
    await rpIdHash(rpID),
    new Uint8Array([0x05]),
    counterBytes(counter),
  );
  const encodedClientData = clientData(
    "webauthn.get",
    options.challenge,
    origin,
  );
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encodedClientData),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      {
        hash: "SHA-256",
        name: "ECDSA",
      },
      passkey.keyPair.privateKey,
      concatenate(authenticatorData, clientDataHash),
    ),
  );
  const encodedCredentialId = encodeBase64Url(passkey.credentialId);

  return {
    authenticatorAttachment: "platform",
    clientExtensionResults: {},
    id: encodedCredentialId,
    rawId: encodedCredentialId,
    response: {
      authenticatorData: encodeBase64Url(authenticatorData),
      clientDataJSON: encodeBase64Url(encodedClientData),
      signature: encodeBase64Url(toDerSignature(signature)),
    },
    type: "public-key",
  };
}
