import {
  apiErrorSchema,
  authenticationResultSchema,
  csrfResponseSchema,
  registrationOptionsSchema,
  setupStatusSchema,
} from "@mdevolved/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import invitedOwnerClaimMigration from "../../../migrations/0018_invited_owner_claim.sql";
import { app } from "../src/app";
import { ensureAuthSchema } from "../src/auth-store";
import { installManagedOwnerInvitation } from "../src/owner-claim-store";
import {
  enforceManagedTrialAccess,
  enforceRuntimeRouting,
  type RuntimeEnv,
} from "../src/runtime-config";
import { randomToken, sha256Hex } from "../src/security";
import { createRegistrationFixture } from "./webauthn-fixture";

const HOSTNAME = "w-7k4mq2x9ab.owd.mdevolved.com";
const ORIGIN = `https://${HOSTNAME}`;
const INVITATION_REF = "inv_00000000000000000001";

const managedEnv: RuntimeEnv = {
  ...env,
  APP_DEPLOYMENT_MODE: "managed",
  EXPECTED_HOSTNAME: HOSTNAME,
};

function executableMigration(source: string): string {
  return source
    .replace(/^--.*$/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function ensureInvitedClaimSchema(): Promise<void> {
  const table = await env.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = 'owner_claim_configuration'`,
  ).first<{ name: string }>();
  if (table === null) {
    await env.DB.exec(executableMigration(invitedOwnerClaimMigration));
  }
}

async function fetchManaged(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(
    new Request(input, init),
    managedEnv,
    createExecutionContext(),
  );
}

function cookieFrom(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`, "u").exec(setCookie);
  if (!match?.[1]) throw new Error(`Response did not set ${name}.`);
  return `${name}=${match[1]}`;
}

async function issueCsrf(): Promise<{ cookie: string; token: string }> {
  const response = await fetchManaged(`${ORIGIN}/api/auth/csrf`);
  const parsed = csrfResponseSchema.parse(await response.json());
  return {
    cookie: cookieFrom(response, "__Host-mdevolved_csrf"),
    token: parsed.csrfToken,
  };
}

function mutationHeaders(
  csrf: { cookie: string; token: string },
  flowCookie?: string,
): HeadersInit {
  return {
    Cookie: [csrf.cookie, flowCookie].filter(Boolean).join("; "),
    Origin: ORIGIN,
    "X-MDevolved-CSRF": csrf.token,
  };
}

async function installInvitation(
  claimToken: string,
  input: { configuredAt?: number; expiresAt?: number } = {},
): Promise<void> {
  const configuredAt = input.configuredAt ?? 1_800_000_000;
  await installManagedOwnerInvitation(env.DB, {
    configuredAt,
    expectedHostname: HOSTNAME,
    expiresAt: input.expiresAt ?? configuredAt + 7 * 24 * 60 * 60,
    invitationRef: INVITATION_REF,
    tokenHash: await sha256Hex(claimToken),
    trialDays: 30,
  });
}

async function registrationOptions(
  csrf: { cookie: string; token: string },
  claimToken: string,
): Promise<{
  flowCookie: string;
  options: ReturnType<typeof registrationOptionsSchema.parse>;
}> {
  const response = await fetchManaged(`${ORIGIN}/api/auth/register/options`, {
    body: JSON.stringify({ claimToken }),
    headers: {
      ...mutationHeaders(csrf),
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  return {
    flowCookie: cookieFrom(response, "__Host-mdevolved_auth_flow"),
    options: registrationOptionsSchema.parse(await response.json()),
  };
}

beforeEach(async () => {
  await ensureAuthSchema(env.DB);
  await ensureInvitedClaimSchema();
  await env.DB.exec(`
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM owners;
    DELETE FROM owner_claim_invitations;
    DELETE FROM owner_claim_configuration;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
  `);
});

describe("managed owner invitation claim", () => {
  it("fails closed until one exact, unexpired invitation is configured", async () => {
    const unconfigured = setupStatusSchema.parse(
      await (await fetchManaged(`${ORIGIN}/api/setup/status`)).json(),
    );
    expect(unconfigured).toMatchObject({
      claimAvailable: false,
      claimExpiresAt: null,
      claimMode: "invitation",
      claimed: false,
      trialDays: null,
    });

    const csrf = await issueCsrf();
    const response = await fetchManaged(`${ORIGIN}/api/auth/register/options`, {
      body: JSON.stringify({ claimToken: randomToken() }),
      headers: {
        ...mutationHeaders(csrf),
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "owner_invitation_invalid",
    );
  });

  it("binds the invitation to WebAuthn and consumes it with the owner atomically", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const claimToken = randomToken();
    await installInvitation(claimToken, { configuredAt: now });

    const setup = setupStatusSchema.parse(
      await (await fetchManaged(`${ORIGIN}/api/setup/status`)).json(),
    );
    expect(setup).toMatchObject({
      claimAvailable: true,
      claimMode: "invitation",
      trialDays: 30,
    });

    const csrf = await issueCsrf();
    const registration = await registrationOptions(csrf, claimToken);
    const fixture = await createRegistrationFixture(
      registration.options,
      ORIGIN,
      HOSTNAME,
    );
    const response = await fetchManaged(`${ORIGIN}/api/auth/register/verify`, {
      body: JSON.stringify(fixture.response),
      headers: {
        ...mutationHeaders(csrf, registration.flowCookie),
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(
      authenticationResultSchema.parse(await response.json()).authenticated,
    ).toBe(true);
    const invitation = await env.DB.prepare(
      `SELECT token_hash, consumed_at
       FROM owner_claim_invitations
       WHERE invitation_ref = ?`,
    )
      .bind(INVITATION_REF)
      .first<{ consumed_at: number | null; token_hash: string }>();
    const configuration = await env.DB.prepare(
      "SELECT claimed_at FROM owner_claim_configuration WHERE id = 1",
    ).first<{ claimed_at: number | null }>();
    expect(invitation?.token_hash).toBe(await sha256Hex(claimToken));
    expect(invitation?.token_hash).not.toBe(claimToken);
    expect(invitation?.consumed_at).not.toBeNull();
    expect(configuration?.claimed_at).toBe(invitation?.consumed_at);
  });

  it("rejects wrong, expired, and replayed invitations without creating an owner", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const claimToken = randomToken();
    await installInvitation(claimToken, {
      configuredAt: now - 120,
      expiresAt: now - 1,
    });
    const csrf = await issueCsrf();
    for (const token of [claimToken, randomToken()]) {
      const response = await fetchManaged(
        `${ORIGIN}/api/auth/register/options`,
        {
          body: JSON.stringify({ claimToken: token }),
          headers: {
            ...mutationHeaders(csrf),
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      expect(response.status).toBe(403);
    }

    expect(
      await env.DB.prepare("SELECT id FROM owners WHERE id = 1").first(),
    ).toBeNull();
  });

  it("rolls back when an invitation is consumed after its ceremony starts", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const claimToken = randomToken();
    await installInvitation(claimToken, { configuredAt: now });
    const csrf = await issueCsrf();
    const registration = await registrationOptions(csrf, claimToken);
    const fixture = await createRegistrationFixture(
      registration.options,
      ORIGIN,
      HOSTNAME,
    );

    await env.DB.prepare(
      `UPDATE owner_claim_invitations
          SET consumed_at = ?
        WHERE invitation_ref = ?`,
    )
      .bind(now, INVITATION_REF)
      .run();

    const response = await fetchManaged(`${ORIGIN}/api/auth/register/verify`, {
      body: JSON.stringify(fixture.response),
      headers: {
        ...mutationHeaders(csrf, registration.flowCookie),
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
      "owner_invitation_invalid",
    );
    expect(
      await env.DB.prepare("SELECT id FROM owners WHERE id = 1").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT token_hash FROM sessions").first(),
    ).toBeNull();
  });

  it("allows only one of two valid ceremonies to win the first-owner race", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const claimToken = randomToken();
    await installInvitation(claimToken, { configuredAt: now });
    const csrf = await issueCsrf();
    const first = await registrationOptions(csrf, claimToken);
    const second = await registrationOptions(csrf, claimToken);
    const [firstFixture, secondFixture] = await Promise.all([
      createRegistrationFixture(first.options, ORIGIN, HOSTNAME),
      createRegistrationFixture(second.options, ORIGIN, HOSTNAME),
    ]);

    const responses = await Promise.all([
      fetchManaged(`${ORIGIN}/api/auth/register/verify`, {
        body: JSON.stringify(firstFixture.response),
        headers: {
          ...mutationHeaders(csrf, first.flowCookie),
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      fetchManaged(`${ORIGIN}/api/auth/register/verify`, {
        body: JSON.stringify(secondFixture.response),
        headers: {
          ...mutationHeaders(csrf, second.flowCookie),
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const ownerCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM owners",
    ).first<{ count: number }>();
    expect(ownerCount?.count).toBe(1);
  });
});

describe("managed hostname routing", () => {
  it("accepts only the permanent HTTPS custom hostname", async () => {
    expect(
      enforceRuntimeRouting(new Request(`${ORIGIN}/healthz`), managedEnv),
    ).toBeNull();

    const wrongHost = enforceRuntimeRouting(
      new Request("https://other.owd.mdevolved.com/healthz"),
      managedEnv,
    );
    expect(wrongHost?.status).toBe(421);
    expect(apiErrorSchema.parse(await wrongHost?.json()).error.code).toBe(
      "deployment_hostname_denied",
    );

    const invalidConfig = enforceRuntimeRouting(new Request(`${ORIGIN}/`), {
      APP_DEPLOYMENT_MODE: "managed",
      EXPECTED_HOSTNAME: "",
    });
    expect(invalidConfig?.status).toBe(503);
  });

  it("keeps reads and authentication available after trial expiry but blocks mutations", async () => {
    const now = Math.floor(Date.now() / 1_000);
    await installInvitation(randomToken(), {
      configuredAt: now - 31 * 24 * 60 * 60,
      expiresAt: now + 24 * 60 * 60,
    });
    await env.DB.prepare(
      `UPDATE owner_claim_configuration
       SET claimed_at = ? WHERE id = 1`,
    )
      .bind(now - 31 * 24 * 60 * 60)
      .run();

    expect(
      await enforceManagedTrialAccess(
        new Request(`${ORIGIN}/api/diagnostics`),
        managedEnv,
      ),
    ).toBeNull();
    expect(
      await enforceManagedTrialAccess(
        new Request(`${ORIGIN}/api/auth/login/options`, { method: "POST" }),
        managedEnv,
      ),
    ).toBeNull();

    const blocked = await enforceManagedTrialAccess(
      new Request(`${ORIGIN}/api/pairing/grants`, { method: "POST" }),
      managedEnv,
    );
    expect(blocked?.status).toBe(503);
    expect(apiErrorSchema.parse(await blocked?.json()).error.code).toBe(
      "managed_trial_ended",
    );
  });
});
