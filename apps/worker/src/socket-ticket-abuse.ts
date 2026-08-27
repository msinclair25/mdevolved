import { vaultIdSchema } from "@mdevolved/contracts";
import { sha256Hex } from "./security";

const SOCKET_TICKET_PATH = /^\/vault\/([^/]+)\/auth\/ticket$/u;

export type SocketTicketAbuseEnv = Pick<
  Env,
  "SOCKET_TICKET_IP_LIMITER" | "SOCKET_TICKET_VAULT_LIMITER"
>;

function problem(
  status: 429 | 503,
  code: "socket_ticket_rate_limited" | "socket_ticket_guard_unavailable",
  message: string,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
      },
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

/**
 * Cheap, pre-router protection for the socket-ticket endpoint. Hashed client
 * and vault budgets contain a misbehaving installation without exposing its
 * address or vault identifier to the limiter service.
 */
export async function guardSocketTicketAbuse(
  request: Request,
  env: SocketTicketAbuseEnv,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const pathname = new URL(request.url).pathname;
  const match = SOCKET_TICKET_PATH.exec(pathname);
  if (match === null) return null;

  let decodedVaultId: string | null = null;
  try {
    decodedVaultId = decodeURIComponent(match[1] ?? "");
  } catch {
    decodedVaultId = null;
  }
  const parsedVaultId = vaultIdSchema.safeParse(decodedVaultId);
  const vaultLimitKey = await sha256Hex(
    parsedVaultId.success ? parsedVaultId.data : "invalid-vault-id",
  );
  const clientAddress = request.headers.get("CF-Connecting-IP");
  const clientLimitKey = await sha256Hex(
    clientAddress ?? `address-unavailable:${vaultLimitKey}`,
  );

  try {
    const clientAllowed = await nativeLimit(
      env.SOCKET_TICKET_IP_LIMITER,
      clientLimitKey,
    );
    if (!clientAllowed) {
      console.warn(
        JSON.stringify({
          budget: "client",
          event: "socket_ticket.rate_limited",
          level: "warn",
          route: "/vault/:vaultId/auth/ticket",
        }),
      );
      return problem(
        429,
        "socket_ticket_rate_limited",
        "Too many socket-ticket requests. Retry later.",
      );
    }
    const vaultAllowed = await nativeLimit(
      env.SOCKET_TICKET_VAULT_LIMITER,
      vaultLimitKey,
    );
    if (!vaultAllowed) {
      console.warn(
        JSON.stringify({
          budget: "vault",
          event: "socket_ticket.rate_limited",
          level: "warn",
          route: "/vault/:vaultId/auth/ticket",
        }),
      );
      return problem(
        429,
        "socket_ticket_rate_limited",
        "Too many socket-ticket requests. Retry later.",
      );
    }
    return null;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "UnknownError",
        event: "socket_ticket.abuse_guard_failed",
        level: "error",
        route: "/vault/:vaultId/auth/ticket",
      }),
    );
    return problem(
      503,
      "socket_ticket_guard_unavailable",
      "Socket-ticket protection is temporarily unavailable.",
    );
  }
}
