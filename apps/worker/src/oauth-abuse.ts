import { enforceRateLimit } from "./auth-store";
import { sha256Hex } from "./security";

const REGISTRATION_DAILY_LIMIT = 500;
const REGISTRATION_WINDOW_SECONDS = 24 * 60 * 60;

export type OAuthAbuseEnv = Pick<
  Env,
  | "DB"
  | "OAUTH_REGISTRATION_CLIENT_LIMITER"
  | "OAUTH_REGISTRATION_ROUTE_LIMITER"
  | "OAUTH_TOKEN_CLIENT_LIMITER"
>;

function oauthProblem(status: 429 | 503, description: string): Response {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: description,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": status === 429 ? "60" : "10",
      },
      status,
    },
  );
}

async function nativeLimit(limiter: RateLimit, key: string): Promise<boolean> {
  return (await limiter.limit({ key })).success;
}

export async function guardOAuthAbuse(
  request: Request,
  env: OAuthAbuseEnv,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/register" && pathname !== "/token") return null;

  const address =
    request.headers.get("CF-Connecting-IP") ?? "address-unavailable";

  try {
    if (pathname === "/register") {
      const [routeAllowed, clientAllowed] = await Promise.all([
        nativeLimit(env.OAUTH_REGISTRATION_ROUTE_LIMITER, "register"),
        nativeLimit(env.OAUTH_REGISTRATION_CLIENT_LIMITER, address),
      ]);
      if (!routeAllowed || !clientAllowed) {
        return oauthProblem(
          429,
          "Dynamic client registration is temporarily rate limited.",
        );
      }

      const withinDailyBudget = await enforceRateLimit(env.DB, {
        action: "oauth-register-global",
        keyHash: await sha256Hex("oauth-register-global"),
        limit: REGISTRATION_DAILY_LIMIT,
        now: Math.floor(Date.now() / 1_000),
        windowSeconds: REGISTRATION_WINDOW_SECONDS,
      });
      if (!withinDailyBudget) {
        return oauthProblem(
          429,
          "Dynamic client registration has reached its daily safety budget.",
        );
      }
      return null;
    }

    if (!(await nativeLimit(env.OAUTH_TOKEN_CLIENT_LIMITER, address))) {
      return oauthProblem(
        429,
        "OAuth token requests are temporarily rate limited.",
      );
    }
    return null;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "UnknownError",
        event: "oauth.abuse_guard_failed",
        level: "error",
        route: pathname,
      }),
    );
    return oauthProblem(
      503,
      "OAuth abuse protection is temporarily unavailable.",
    );
  }
}
