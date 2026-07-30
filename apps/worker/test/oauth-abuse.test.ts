import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthSchema } from "../src/auth-store";
import { guardOAuthAbuse, type OAuthAbuseEnv } from "../src/oauth-abuse";
import { sha256Hex } from "../src/security";

const ORIGIN = "https://owd.test";
const DAY_SECONDS = 24 * 60 * 60;

type TestLimiter = {
  limit: ReturnType<typeof vi.fn<RateLimit["limit"]>>;
};

function limiter(success: boolean): TestLimiter {
  return {
    limit: vi.fn(async () => ({ success })),
  };
}

function testEnv(input?: {
  registrationClient?: TestLimiter;
  registrationRoute?: TestLimiter;
  tokenClient?: TestLimiter;
}): OAuthAbuseEnv {
  return {
    DB: env.DB,
    OAUTH_REGISTRATION_CLIENT_LIMITER:
      input?.registrationClient ?? limiter(true),
    OAUTH_REGISTRATION_ROUTE_LIMITER: input?.registrationRoute ?? limiter(true),
    OAUTH_TOKEN_CLIENT_LIMITER: input?.tokenClient ?? limiter(true),
  };
}

beforeEach(async () => {
  await ensureAuthSchema(env.DB);
  await env.DB.prepare("DELETE FROM auth_rate_limits").run();
});

describe("OAuth abuse guard", () => {
  it("rejects a native registration limit before consuming the D1 budget", async () => {
    const registrationClient = limiter(false);
    const guarded = await guardOAuthAbuse(
      new Request(`${ORIGIN}/register`, {
        headers: { "CF-Connecting-IP": "192.0.2.10" },
        method: "POST",
      }),
      testEnv({ registrationClient }),
    );

    expect(guarded?.status).toBe(429);
    expect(guarded?.headers.get("Retry-After")).toBe("60");
    expect(await guarded?.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM auth_rate_limits
       WHERE action = 'oauth-register-global'`,
    ).first<{ count: number }>();
    expect(rows?.count).toBe(0);
  });

  it("holds a saturated daily registration budget at its exact cap", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const bucketStart = Math.floor(now / DAY_SECONDS) * DAY_SECONDS;
    const keyHash = await sha256Hex("oauth-register-global");
    await env.DB.prepare(
      `INSERT INTO auth_rate_limits (
        key_hash, action, bucket_start, count, updated_at
      ) VALUES (?, 'oauth-register-global', ?, 500, ?)`,
    )
      .bind(keyHash, bucketStart, now)
      .run();

    const guarded = await guardOAuthAbuse(
      new Request(`${ORIGIN}/register`, {
        headers: { "CF-Connecting-IP": "192.0.2.11" },
        method: "POST",
      }),
      testEnv(),
    );

    expect(guarded?.status).toBe(429);
    expect(await guarded?.json()).toMatchObject({
      error_description:
        "Dynamic client registration has reached its daily safety budget.",
    });
    const stored = await env.DB.prepare(
      `SELECT count FROM auth_rate_limits
         WHERE key_hash = ? AND action = 'oauth-register-global'
           AND bucket_start = ?`,
    )
      .bind(keyHash, bucketStart)
      .first<{ count: number }>();
    expect(stored?.count).toBe(500);
  });

  it("limits token traffic independently and fails closed on limiter errors", async () => {
    const tokenClient = limiter(false);
    const limited = await guardOAuthAbuse(
      new Request(`${ORIGIN}/token`, {
        headers: { "CF-Connecting-IP": "192.0.2.12" },
        method: "POST",
      }),
      testEnv({ tokenClient }),
    );
    expect(limited?.status).toBe(429);
    expect(tokenClient.limit).toHaveBeenCalledWith({ key: "192.0.2.12" });

    const failing = limiter(true);
    failing.limit.mockRejectedValueOnce(new Error("limiter unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unavailable = await guardOAuthAbuse(
      new Request(`${ORIGIN}/token`, { method: "POST" }),
      testEnv({ tokenClient: failing }),
    );
    expect(unavailable?.status).toBe(503);
    expect(unavailable?.headers.get("Retry-After")).toBe("10");
    expect(log).toHaveBeenCalledWith(
      expect.not.stringContaining("limiter unavailable"),
    );
    log.mockRestore();
  });
});
