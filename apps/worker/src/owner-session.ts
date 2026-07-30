import type { Context } from "hono";
import { ApiProblem } from "./api-problem";
import { readSession, type SessionRecord } from "./auth-store";
import { readSessionToken, requireCsrf, sha256Hex } from "./security";
import type { AppBindings } from "./types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export async function readOwnerSession(
  context: Context<AppBindings>,
): Promise<SessionRecord | null> {
  const token = readSessionToken(context);
  if (!token) return null;

  return readSession(context.env.DB, await sha256Hex(token), nowSeconds());
}

export async function requireOwnerSession(
  context: Context<AppBindings>,
  options: { csrf: boolean },
): Promise<SessionRecord> {
  const session = await readOwnerSession(context);
  if (!session) {
    throw new ApiProblem(
      401,
      "authentication_required",
      "Sign in with your owner passkey to continue.",
    );
  }

  if (options.csrf) {
    await requireCsrf(context, session.csrf_hash);
  }

  return session;
}
