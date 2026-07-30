import {
  apiErrorSchema,
  authenticationOptionsSchema,
  authenticationResultSchema,
  csrfResponseSchema,
  healthResponseSchema,
  registrationOptionsSchema,
  setupStatusSchema,
} from "@owd/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import { sha256Hex } from "../src/security";
import {
  createAuthenticationFixture,
  createRegistrationFixture,
} from "./webauthn-fixture";

const ORIGIN = "https://owd.test";

const exports = {
  default: {
    async fetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      return await worker.fetch(
        new Request(input, init),
        env,
        createExecutionContext(),
      );
    },
  },
};

function cookieFrom(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`, "u").exec(setCookie);

  if (!match?.[1]) {
    throw new Error(`Response did not set ${name}.`);
  }

  return `${name}=${match[1]}`;
}

async function issueCsrf(
  sessionCookie?: string,
): Promise<{ cookie: string; token: string }> {
  const response = await exports.default.fetch(`${ORIGIN}/api/auth/csrf`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : undefined,
  });
  const result = csrfResponseSchema.parse(await response.json());

  return {
    cookie: cookieFrom(response, "__Host-owd_csrf"),
    token: result.csrfToken,
  };
}

function mutationHeaders(
  csrf: { cookie: string; token: string },
  extraCookies: string[] = [],
  origin = ORIGIN,
): HeadersInit {
  return {
    Cookie: [csrf.cookie, ...extraCookies].join("; "),
    Origin: origin,
    "X-OWD-CSRF": csrf.token,
  };
}

async function cleanAuthTables(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await env.DB.exec(`
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
}

beforeEach(async () => {
  await cleanAuthTables();
});

describe("OWD Worker", () => {
  it("reports health with a request identifier", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/healthz`);
    const result = healthResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(result.requestId);
    expect(
      response.headers.get("content-security-policy-report-only"),
    ).toContain("connect-src 'self' wss://owd.test");
    expect(
      response.headers.get("content-security-policy-report-only"),
    ).not.toContain("'unsafe-inline'");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(result.service).toBe("owd-platform");
  });

  it("does not run release-prerequisite collaboration migrations during ordinary API traffic", async () => {
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND (
           name LIKE 'collaboration_%'
           OR name LIKE 'snapshot_intelligence_%'
           OR name LIKE 'project_initialization_%'
         )`,
    ).first<{ count: number }>();

    const response = await exports.default.fetch(`${ORIGIN}/api/setup/status`);

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND (
           name LIKE 'collaboration_%'
           OR name LIKE 'snapshot_intelligence_%'
           OR name LIKE 'project_initialization_%'
         )`,
    ).first<{ count: number }>();

    expect(before?.count).toBe(0);
    expect(response.status).toBe(200);
    expect(after?.count).toBe(0);
  });

  it("bootstraps an intentionally unclaimed setup state", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/setup/status`);
    const result = setupStatusSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      authenticated: false,
      claimAvailable: true,
      claimExpiresAt: null,
      claimMode: "open",
      claimed: false,
      nextAction: "claim-owner",
      pairingEnabled: true,
      state: "unclaimed",
      trialDays: null,
    });
  });

  it("does not discover or repair an interrupted schema during ordinary requests", async () => {
    await env.DB.exec("DROP TABLE audit_events;");

    const response = await exports.default.fetch(`${ORIGIN}/api/setup/status`);
    const restoredTable = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'",
    ).first<{ name: string }>();

    expect(response.status).toBe(200);
    expect(restoredTable).toBeNull();
  });

  it("returns a stable error contract for unknown API routes", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/api/unknown`);
    const result = apiErrorSchema.parse(await response.json());

    expect(response.status).toBe(404);
    expect(result.error.code).toBe("route_not_found");
  });

  it("denies missing, cross-origin, and CSRF-less mutations", async () => {
    const csrf = await issueCsrf();
    const missingOrigin = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: {
          Cookie: csrf.cookie,
          "X-OWD-CSRF": csrf.token,
        },
        method: "POST",
      },
    );
    const crossOrigin = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: mutationHeaders(csrf, [], "https://evil.test"),
        method: "POST",
      },
    );
    const missingCsrf = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: {
          Cookie: csrf.cookie,
          Origin: ORIGIN,
        },
        method: "POST",
      },
    );

    expect(missingOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(missingCsrf.status).toBe(403);
  });

  it("rate-limits repeated authentication mutations without storing raw addresses", async () => {
    const csrf = await issueCsrf();
    const responses: Response[] = [];

    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(
        await exports.default.fetch(`${ORIGIN}/api/auth/register/options`, {
          headers: {
            ...mutationHeaders(csrf),
            "CF-Connecting-IP": "203.0.113.10",
          },
          method: "POST",
        }),
      );
    }

    const storedKey = await env.DB.prepare(
      `SELECT key_hash, count FROM auth_rate_limits
       WHERE action = 'registration'`,
    ).first<{ count: number; key_hash: string }>();
    const denied = apiErrorSchema.parse(await responses[10]?.json());

    expect(
      responses.slice(0, 10).every((response) => response.status === 200),
    ).toBe(true);
    expect(responses[10]?.status).toBe(429);
    expect(denied.error.code).toBe("rate_limited");
    expect(storedKey?.count).toBe(10);
    expect(storedKey?.key_hash).not.toContain("203.0.113.10");
  });

  it("claims atomically, stores token hashes, signs back in, and logs out", async () => {
    const registrationCsrf = await issueCsrf();
    const optionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: mutationHeaders(registrationCsrf),
        method: "POST",
      },
    );
    const registrationOptions = registrationOptionsSchema.parse(
      await optionsResponse.json(),
    );
    const flowCookie = cookieFrom(optionsResponse, "__Host-owd_auth_flow");
    const fixture = await createRegistrationFixture(
      registrationOptions,
      ORIGIN,
      "owd.test",
    );
    const verifyResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/verify`,
      {
        body: JSON.stringify(fixture.response),
        headers: {
          ...mutationHeaders(registrationCsrf, [flowCookie]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    const verified = authenticationResultSchema.parse(
      await verifyResponse.json(),
    );

    expect(verifyResponse.status).toBe(200);
    expect(verified.authenticated).toBe(true);

    const sessionCookie = cookieFrom(verifyResponse, "__Host-owd_session");
    const sessionToken = sessionCookie.split("=")[1] ?? "";
    const storedSession = await env.DB.prepare(
      "SELECT token_hash FROM sessions",
    ).first<{ token_hash: string }>();

    expect(storedSession?.token_hash).toBe(await sha256Hex(sessionToken));
    expect(storedSession?.token_hash).not.toBe(sessionToken);

    const authenticatedStatus = setupStatusSchema.parse(
      await (
        await exports.default.fetch(`${ORIGIN}/api/setup/status`, {
          headers: { Cookie: sessionCookie },
        })
      ).json(),
    );
    expect(authenticatedStatus.authenticated).toBe(true);

    const logoutCsrf = await issueCsrf(sessionCookie);
    const deniedLogout = await exports.default.fetch(
      `${ORIGIN}/api/auth/logout`,
      {
        headers: {
          Cookie: `${sessionCookie}; ${logoutCsrf.cookie}`,
          Origin: ORIGIN,
        },
        method: "POST",
      },
    );
    expect(deniedLogout.status).toBe(403);

    const logoutResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/logout`,
      {
        headers: mutationHeaders(logoutCsrf, [sessionCookie]),
        method: "POST",
      },
    );
    expect(logoutResponse.status).toBe(204);

    const loginCsrf = await issueCsrf();
    const loginOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/login/options`,
      {
        headers: mutationHeaders(loginCsrf),
        method: "POST",
      },
    );
    const loginOptions = authenticationOptionsSchema.parse(
      await loginOptionsResponse.json(),
    );
    const loginFlowCookie = cookieFrom(
      loginOptionsResponse,
      "__Host-owd_auth_flow",
    );
    const authenticationResponse = await createAuthenticationFixture(
      fixture.passkey,
      loginOptions,
      ORIGIN,
      "owd.test",
      1,
    );
    const loginVerifyResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/login/verify`,
      {
        body: JSON.stringify(authenticationResponse),
        headers: {
          ...mutationHeaders(loginCsrf, [loginFlowCookie]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );

    expect(loginVerifyResponse.status).toBe(200);
    expect(
      authenticationResultSchema.parse(await loginVerifyResponse.json())
        .verified,
    ).toBe(true);

    const owner = await env.DB.prepare(
      "SELECT counter, last_authenticated_at FROM owners WHERE id = 1",
    ).first<{ counter: number; last_authenticated_at: number | null }>();
    expect(owner?.counter).toBe(1);
    expect(owner?.last_authenticated_at).not.toBeNull();
  });

  it("adds a second passkey and can sign in with it independently", async () => {
    const registrationCsrf = await issueCsrf();
    const firstOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: mutationHeaders(registrationCsrf),
        method: "POST",
      },
    );
    const firstOptions = registrationOptionsSchema.parse(
      await firstOptionsResponse.json(),
    );
    const firstFixture = await createRegistrationFixture(
      firstOptions,
      ORIGIN,
      "owd.test",
    );
    const firstVerify = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/verify`,
      {
        body: JSON.stringify(firstFixture.response),
        headers: {
          ...mutationHeaders(registrationCsrf, [
            cookieFrom(firstOptionsResponse, "__Host-owd_auth_flow"),
          ]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(firstVerify.status).toBe(200);

    const sessionCookie = cookieFrom(firstVerify, "__Host-owd_session");
    const backupCsrf = await issueCsrf(sessionCookie);
    const backupOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/passkeys/register/options`,
      {
        headers: mutationHeaders(backupCsrf, [sessionCookie]),
        method: "POST",
      },
    );
    const backupOptions = registrationOptionsSchema.parse(
      await backupOptionsResponse.json(),
    );
    expect(backupOptions.excludeCredentials?.map(({ id }) => id)).toContain(
      firstFixture.response.id,
    );
    const backupFixture = await createRegistrationFixture(
      backupOptions,
      ORIGIN,
      "owd.test",
    );
    const backupVerify = await exports.default.fetch(
      `${ORIGIN}/api/auth/passkeys/register/verify`,
      {
        body: JSON.stringify(backupFixture.response),
        headers: {
          ...mutationHeaders(backupCsrf, [
            sessionCookie,
            cookieFrom(backupOptionsResponse, "__Host-owd_auth_flow"),
          ]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(backupVerify.status).toBe(204);

    const credentialRows = await env.DB.prepare(
      `SELECT credential_id FROM owner_credentials
       ORDER BY created_at, credential_id`,
    ).all<{ credential_id: string }>();
    expect(credentialRows.results.map((row) => row.credential_id)).toEqual(
      expect.arrayContaining([
        firstFixture.response.id,
        backupFixture.response.id,
      ]),
    );

    await env.DB.prepare("DELETE FROM sessions").run();
    const loginCsrf = await issueCsrf();
    const loginOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/login/options`,
      {
        headers: mutationHeaders(loginCsrf),
        method: "POST",
      },
    );
    const loginOptions = authenticationOptionsSchema.parse(
      await loginOptionsResponse.json(),
    );
    expect(loginOptions.allowCredentials?.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        firstFixture.response.id,
        backupFixture.response.id,
      ]),
    );
    const backupAuthentication = await createAuthenticationFixture(
      backupFixture.passkey,
      loginOptions,
      ORIGIN,
      "owd.test",
      1,
    );
    const loginVerify = await exports.default.fetch(
      `${ORIGIN}/api/auth/login/verify`,
      {
        body: JSON.stringify(backupAuthentication),
        headers: {
          ...mutationHeaders(loginCsrf, [
            cookieFrom(loginOptionsResponse, "__Host-owd_auth_flow"),
          ]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(loginVerify.status).toBe(200);
    expect(
      authenticationResultSchema.parse(await loginVerify.json()).authenticated,
    ).toBe(true);
    const backupCredential = await env.DB.prepare(
      `SELECT counter, last_authenticated_at
       FROM owner_credentials WHERE credential_id = ?`,
    )
      .bind(backupFixture.response.id)
      .first<{ counter: number; last_authenticated_at: number | null }>();
    expect(backupCredential).toMatchObject({
      counter: 1,
    });
    expect(backupCredential?.last_authenticated_at).not.toBeNull();
  });

  it("rejects WebAuthn origin and RP-ID mismatches and consumes challenges once", async () => {
    const csrf = await issueCsrf();
    const originOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: mutationHeaders(csrf),
        method: "POST",
      },
    );
    const originOptions = registrationOptionsSchema.parse(
      await originOptionsResponse.json(),
    );
    const originFlowCookie = cookieFrom(
      originOptionsResponse,
      "__Host-owd_auth_flow",
    );
    const originFixture = await createRegistrationFixture(
      originOptions,
      "https://evil.test",
      "owd.test",
    );
    const originMismatchResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/verify`,
      {
        body: JSON.stringify(originFixture.response),
        headers: {
          ...mutationHeaders(csrf, [originFlowCookie]),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    const rpOptionsResponse = await exports.default.fetch(
      `${ORIGIN}/api/auth/register/options`,
      {
        headers: mutationHeaders(csrf),
        method: "POST",
      },
    );
    const rpOptions = registrationOptionsSchema.parse(
      await rpOptionsResponse.json(),
    );
    const rpFlowCookie = cookieFrom(rpOptionsResponse, "__Host-owd_auth_flow");
    const rpFixture = await createRegistrationFixture(
      rpOptions,
      ORIGIN,
      "different-rp.test",
    );
    const rpRequest = () =>
      exports.default.fetch(`${ORIGIN}/api/auth/register/verify`, {
        body: JSON.stringify(rpFixture.response),
        headers: {
          ...mutationHeaders(csrf, [rpFlowCookie]),
          "Content-Type": "application/json",
        },
        method: "POST",
      });

    const mismatchResponse = await rpRequest();
    const replayResponse = await rpRequest();
    const originMismatchError = apiErrorSchema.parse(
      await originMismatchResponse.json(),
    );
    const mismatchError = apiErrorSchema.parse(await mismatchResponse.json());
    const replayError = apiErrorSchema.parse(await replayResponse.json());

    expect(originMismatchResponse.status).toBe(400);
    expect(originMismatchError.error.code).toBe(
      "credential_verification_failed",
    );
    expect(mismatchResponse.status).toBe(400);
    expect(mismatchError.error.code).toBe("credential_verification_failed");
    expect(replayResponse.status).toBe(400);
    expect(replayError.error.code).toBe("challenge_invalid");
  });

  it("keeps credential payloads out of logs and error responses", async () => {
    const sentinel = "SYNTHETIC_VAULT_CONTENT_MUST_NOT_LEAK";
    const csrf = await issueCsrf();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const response = await exports.default.fetch(
        `${ORIGIN}/api/auth/register/verify`,
        {
          body: JSON.stringify({ vaultContent: sentinel }),
          headers: {
            ...mutationHeaders(csrf),
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      const responseText = await response.text();
      const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .join(" ");

      expect(response.status).toBe(400);
      expect(responseText).not.toContain(sentinel);
      expect(logged).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("allows only one first-owner transaction during a claim race", async () => {
    const now = Math.floor(Date.now() / 1000);
    const firstSession = await createSessionMaterial(now);
    const secondSession = await createSessionMaterial(now);
    const ownerInput = {
      backedUp: true,
      counter: 0,
      credentialId: "synthetic-credential",
      deviceType: "multiDevice" as const,
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: "synthetic-user",
    };
    const results = await Promise.allSettled([
      commitFirstOwner(
        env.DB,
        ownerInput,
        firstSession,
        crypto.randomUUID(),
        now,
      ),
      commitFirstOwner(
        env.DB,
        {
          ...ownerInput,
          credentialId: "competing-credential",
          webauthnUserId: "competing-user",
        },
        secondSession,
        crypto.randomUUID(),
        now,
      ),
    ]);
    const ownerCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM owners",
    ).first<{ count: number }>();
    const sessionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions",
    ).first<{ count: number }>();

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(ownerCount?.count).toBe(1);
    expect(sessionCount?.count).toBe(1);
  });

  it("creates a YAOS-ready vault-scoped Durable Object stub", async () => {
    const vault = env.VAULTS.getByName("synthetic-vault");

    await expect(vault.health()).resolves.toMatchObject({
      ready: true,
      protocol: "yaos-yjs",
      serverVersion: "0.3.0",
      schemaVersion: null,
      supportedSchemaVersions: { min: 1, max: 3 },
      persistence: {
        status: "healthy",
        pendingPersistence: false,
        journalEntryCount: 0,
        journalBytes: 0,
      },
    });
  });
});
