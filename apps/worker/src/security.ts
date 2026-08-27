import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { ApiProblem } from "./api-problem";
import type { AppBindings } from "./types";

export const CSRF_COOKIE = "__Host-owd_csrf";
export const FLOW_COOKIE = "__Host-owd_auth_flow";
export const SESSION_COOKIE = "__Host-owd_session";

const encoder = new TextEncoder();
const DEFAULT_MAX_JSON_BYTES = 65_536;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function randomToken(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(encoder.encode(value));
}

export async function sha256HexBytes(
  value: Uint8Array<ArrayBufferLike>,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(value).buffer,
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function tokensMatch(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export function requestOrigin(context: Context<AppBindings>): {
  origin: string;
  rpID: string;
} {
  const requestUrl = new URL(context.req.url);

  return {
    origin: requestUrl.origin,
    rpID: requestUrl.hostname,
  };
}

export function requireSameOrigin(context: Context<AppBindings>): void {
  const expectedOrigin = requestOrigin(context).origin;
  const suppliedOrigin = context.req.header("Origin");

  if (suppliedOrigin !== expectedOrigin) {
    throw new ApiProblem(
      403,
      "origin_denied",
      "This request was not sent by the MDevolved site.",
    );
  }
}

export async function requireCsrf(
  context: Context<AppBindings>,
  expectedHash?: string,
): Promise<void> {
  requireSameOrigin(context);

  const cookieToken = getCookie(context, CSRF_COOKIE);
  const headerToken = context.req.header("X-OWD-CSRF");

  if (
    !cookieToken ||
    !headerToken ||
    !(await tokensMatch(cookieToken, headerToken))
  ) {
    throw new ApiProblem(
      403,
      "csrf_denied",
      "The request could not be verified.",
    );
  }

  if (
    expectedHash &&
    !(await tokensMatch(await sha256Hex(cookieToken), expectedHash))
  ) {
    throw new ApiProblem(
      403,
      "csrf_denied",
      "The request could not be verified.",
    );
  }
}

export function readFlowToken(
  context: Context<AppBindings>,
): string | undefined {
  return getCookie(context, FLOW_COOKIE);
}

export function readSessionToken(
  context: Context<AppBindings>,
): string | undefined {
  return getCookie(context, SESSION_COOKIE);
}

export function setAnonymousCsrfCookie(
  context: Context<AppBindings>,
  token: string,
): void {
  setCookie(context, CSRF_COOKIE, token, {
    httpOnly: false,
    maxAge: 600,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
}

export function setFlowCookie(
  context: Context<AppBindings>,
  token: string,
): void {
  setCookie(context, FLOW_COOKIE, token, {
    httpOnly: true,
    maxAge: 300,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
}

export function clearFlowCookie(context: Context<AppBindings>): void {
  setCookie(context, FLOW_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
}

export function setSessionCookies(
  context: Context<AppBindings>,
  token: string,
  csrfToken: string,
  maxAgeSeconds: number,
): void {
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
  setCookie(context, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    maxAge: maxAgeSeconds,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
}

export function clearSessionCookies(context: Context<AppBindings>): void {
  setCookie(context, SESSION_COOKIE, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
  setCookie(context, CSRF_COOKIE, "", {
    expires: new Date(0),
    httpOnly: false,
    maxAge: 0,
    path: "/",
    sameSite: "Strict",
    secure: true,
  });
}

export async function parseJsonBody(
  context: Context<AppBindings>,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<unknown> {
  const contentType = context.req.header("Content-Type") ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiProblem(
      400,
      "invalid_content_type",
      "The request must contain JSON.",
    );
  }

  const declaredLength = Number(context.req.header("Content-Length") ?? "0");

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiProblem(413, "request_too_large", "The request is too large.");
  }

  const bytes = await context.req.raw.arrayBuffer();

  if (bytes.byteLength > maxBytes) {
    throw new ApiProblem(413, "request_too_large", "The request is too large.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiProblem(
      400,
      "invalid_json",
      "The request contains invalid JSON.",
    );
  }
}
