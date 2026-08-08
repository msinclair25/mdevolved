import { describe, expect, it } from "vitest";
import { CAPABILITY_REFRESH_INTERVAL_MS } from "../vendor/yaos-src/runtime/capabilityPolicy";
import { SocketTicketHttpError } from "../vendor/yaos-src/sync/socketTicketError";
import {
  decideSocketTicketFailure,
  SOCKET_TICKET_RETRY_BASE_MS,
  SOCKET_TICKET_RETRY_MAX_MS,
  socketTicketRetryDelayMs,
} from "../vendor/yaos-src/sync/socketTicketRetry";

describe("socket ticket retry policy", () => {
  it.each([401, 403] as const)(
    "turns HTTP %s into terminal authorization state with no retry",
    (status) => {
      const decision = decideSocketTicketFailure(
        new SocketTicketHttpError(status),
        0,
        0.5,
      );

      expect(decision).toMatchObject({
        kind: "fatal",
        code: "unauthorized",
        status,
      });
      expect("delayMs" in decision).toBe(false);
      if (decision.kind !== "fatal") {
        throw new Error("expected a fatal socket-ticket decision");
      }
      expect(decision.reason).toContain("Re-pair");
    },
  );

  it.each([429, 500, 503])("backs off retryable HTTP %s failures", (status) => {
    const decision = decideSocketTicketFailure(
      new SocketTicketHttpError(status),
      2,
      0.5,
    );
    expect(decision).toEqual({
      kind: "retry",
      delayMs: SOCKET_TICKET_RETRY_BASE_MS * 4,
      nextAttempt: 3,
    });
  });

  it("backs off network failures exponentially with bounded jitter and a hard cap", () => {
    expect(socketTicketRetryDelayMs(0, 0)).toBe(24_000);
    expect(socketTicketRetryDelayMs(0, 1)).toBe(36_000);
    expect(socketTicketRetryDelayMs(1, 0.5)).toBe(60_000);
    expect(socketTicketRetryDelayMs(16, 1)).toBe(SOCKET_TICKET_RETRY_MAX_MS);

    const decision = decideSocketTicketFailure(new TypeError("offline"), 16, 1);
    expect(decision).toEqual({
      kind: "retry",
      delayMs: SOCKET_TICKET_RETRY_MAX_MS,
      nextAttempt: 16,
    });
    expect(
      decideSocketTicketFailure(new TypeError("offline"), Number.NaN, 0.5),
    ).toEqual({
      kind: "retry",
      delayMs: SOCKET_TICKET_RETRY_BASE_MS,
      nextAttempt: 1,
    });
  });

  it("limits degraded capability polling to once every five minutes", () => {
    expect(CAPABILITY_REFRESH_INTERVAL_MS).toBe(5 * 60_000);
  });
});
