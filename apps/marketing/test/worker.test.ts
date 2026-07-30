import { describe, expect, it, vi } from "vitest";

import {
  handleAlphaAccessRequest,
  type AlphaAccessServices,
} from "../src/worker";

const origin = "https://mdevolved.com";

function makeRequest(
  body: Record<string, unknown>,
  init?: { method?: string; origin?: string; contentType?: string },
): Request {
  return new Request(`${origin}/api/alpha-access`, {
    method: init?.method ?? "POST",
    headers: {
      "Content-Type": init?.contentType ?? "application/json",
      Origin: init?.origin ?? origin,
    },
    body: (init?.method ?? "POST") === "GET" ? undefined : JSON.stringify(body),
  });
}

function makeServices(options?: { allowed?: boolean; sendError?: Error }): {
  services: AlphaAccessServices;
  sent: EmailMessageBuilder[];
} {
  const sent: EmailMessageBuilder[] = [];
  return {
    services: {
      allowRequest: async () => options?.allowed ?? true,
      sendEmail: async (message) => {
        if (options?.sendError) throw options.sendError;
        sent.push(message);
      },
    },
    sent,
  };
}

const validSubmission = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  tools: "Claude Code and Codex",
  testPlan:
    "I would test handoffs between two agents on a real Obsidian project.",
  website: "",
};

describe("marketing alpha access endpoint", () => {
  it("sends one escaped email to the fixed support address", async () => {
    const { services, sent } = makeServices();
    const response = await handleAlphaAccessRequest(
      makeRequest({
        ...validSubmission,
        name: "Ada & Co",
        testPlan:
          "I would test <script>alert('no')</script> handoffs between agents.",
      }),
      services,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "support@mdevolved.com",
      from: {
        email: "alpha@mdevolved.com",
        name: "MD Evolved Alpha",
      },
      replyTo: {
        email: "ada@example.com",
        name: "Ada & Co",
      },
      subject: "OWD alpha request — Ada & Co",
    });
    expect(sent[0]?.html).toContain("Ada &amp; Co");
    expect(sent[0]?.html).toContain("&lt;script&gt;");
    expect(sent[0]?.html).not.toContain("<script>");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects cross-origin submissions before using a binding", async () => {
    const allowRequest = vi.fn(async () => true);
    const sendEmail = vi.fn(async () => undefined);
    const response = await handleAlphaAccessRequest(
      makeRequest(validSubmission, { origin: "https://attacker.example" }),
      { allowRequest, sendEmail },
    );

    expect(response.status).toBe(403);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects invalid submissions without sending email", async () => {
    const { services, sent } = makeServices();
    const response = await handleAlphaAccessRequest(
      makeRequest({ ...validSubmission, email: "not-an-email" }),
      services,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(sent).toHaveLength(0);
  });

  it("silently drops honeypot submissions", async () => {
    const allowRequest = vi.fn(async () => true);
    const sendEmail = vi.fn(async () => undefined);
    const response = await handleAlphaAccessRequest(
      makeRequest({ ...validSubmission, website: "https://spam.example" }),
      { allowRequest, sendEmail },
    );

    expect(response.status).toBe(200);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rate limits valid-looking bursts before sending email", async () => {
    const { services, sent } = makeServices({ allowed: false });
    const response = await handleAlphaAccessRequest(
      makeRequest(validSubmission),
      services,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(sent).toHaveLength(0);
  });

  it("returns a stable retryable error when email delivery is unavailable", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { services } = makeServices({
      sendError: new Error("provider detail must stay private"),
    });

    const response = await handleAlphaAccessRequest(
      makeRequest(validSubmission),
      services,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "email_unavailable",
        message: "Your request could not be sent. Try again shortly.",
      },
    });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).not.toContain(
      "provider detail must stay private",
    );
    consoleError.mockRestore();
  });

  it("rejects oversized request bodies", async () => {
    const { services, sent } = makeServices();
    const response = await handleAlphaAccessRequest(
      makeRequest({
        ...validSubmission,
        testPlan: "x".repeat(9_000),
      }),
      services,
    );

    expect(response.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it("rejects methods other than POST", async () => {
    const { services, sent } = makeServices();
    const response = await handleAlphaAccessRequest(
      makeRequest({}, { method: "GET" }),
      services,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(sent).toHaveLength(0);
  });
});
