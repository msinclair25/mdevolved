import { describe, expect, it, vi } from "vitest";
import {
  guardSocketTicketAbuse,
  type SocketTicketAbuseEnv,
} from "../src/socket-ticket-abuse";
import { sha256Hex } from "../src/security";

const ORIGIN = "https://owd.test";
const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";

type TestLimiter = {
  limit: ReturnType<typeof vi.fn<RateLimit["limit"]>>;
};

function limiter(success: boolean): TestLimiter {
  return {
    limit: vi.fn(async () => ({ success })),
  };
}

function testEnv(input?: {
  client?: TestLimiter;
  vault?: TestLimiter;
}): SocketTicketAbuseEnv {
  return {
    SOCKET_TICKET_IP_LIMITER: input?.client ?? limiter(true),
    SOCKET_TICKET_VAULT_LIMITER: input?.vault ?? limiter(true),
  };
}

function ticketRequest(vaultId = VAULT_ID): Request {
  return new Request(
    `${ORIGIN}/vault/${encodeURIComponent(vaultId)}/auth/ticket`,
    {
      headers: { "CF-Connecting-IP": "203.0.113.8" },
      method: "POST",
    },
  );
}

describe("socket-ticket abuse guard", () => {
  it("ignores unrelated routes and methods", async () => {
    const client = limiter(true);
    const vault = limiter(true);
    const env = testEnv({ client, vault });

    expect(
      await guardSocketTicketAbuse(
        new Request(`${ORIGIN}/api/capabilities`),
        env,
      ),
    ).toBeNull();
    expect(
      await guardSocketTicketAbuse(
        new Request(`${ORIGIN}/vault/${VAULT_ID}/auth/ticket`),
        env,
      ),
    ).toBeNull();
    expect(client.limit).not.toHaveBeenCalled();
    expect(vault.limit).not.toHaveBeenCalled();
  });

  it("uses hashed per-client and per-vault budgets", async () => {
    const client = limiter(true);
    const vault = limiter(true);
    const guarded = await guardSocketTicketAbuse(
      ticketRequest(),
      testEnv({ client, vault }),
    );

    expect(guarded).toBeNull();
    expect(client.limit).toHaveBeenCalledWith({
      key: await sha256Hex("203.0.113.8"),
    });
    expect(client.limit).not.toHaveBeenCalledWith({ key: "203.0.113.8" });
    expect(vault.limit).toHaveBeenCalledWith({
      key: await sha256Hex(VAULT_ID),
    });
    expect(vault.limit).not.toHaveBeenCalledWith({ key: VAULT_ID });
  });

  it("isolates requests without an edge address by their hashed vault key", async () => {
    const client = limiter(true);
    const vault = limiter(true);
    const vaultHash = await sha256Hex(VAULT_ID);
    const request = new Request(
      `${ORIGIN}/vault/${encodeURIComponent(VAULT_ID)}/auth/ticket`,
      { method: "POST" },
    );

    expect(
      await guardSocketTicketAbuse(request, testEnv({ client, vault })),
    ).toBeNull();
    expect(client.limit).toHaveBeenCalledWith({
      key: await sha256Hex(`address-unavailable:${vaultHash}`),
    });
  });

  it("returns a retryable 429 when either budget is exhausted", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const env of [
      testEnv({ client: limiter(false) }),
      testEnv({ vault: limiter(false) }),
    ]) {
      const response = await guardSocketTicketAbuse(ticketRequest(), env);
      expect(response?.status).toBe(429);
      expect(response?.headers.get("Retry-After")).toBe("60");
      expect(await response?.json()).toMatchObject({
        error: { code: "socket_ticket_rate_limited" },
      });
    }
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"socket_ticket.rate_limited"'),
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(VAULT_ID));
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("203.0.113.8"),
    );
    log.mockRestore();
  });

  it("does not spend a vault budget after the client budget is exhausted", async () => {
    const vault = limiter(true);
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await guardSocketTicketAbuse(
      ticketRequest(),
      testEnv({ client: limiter(false), vault }),
    );

    expect(response?.status).toBe(429);
    expect(vault.limit).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("fails closed without logging limiter details", async () => {
    const client = limiter(true);
    client.limit.mockRejectedValueOnce(new Error("private limiter failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await guardSocketTicketAbuse(
      ticketRequest(),
      testEnv({ client }),
    );

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("10");
    expect(log).toHaveBeenCalledWith(
      expect.not.stringContaining("private limiter failure"),
    );
    log.mockRestore();
  });
});
