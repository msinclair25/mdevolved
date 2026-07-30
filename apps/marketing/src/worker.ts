const ALPHA_ACCESS_PATH = "/api/alpha-access";
const SUPPORT_EMAIL = "support@mdevolved.com";
const SENDER_EMAIL = "alpha@mdevolved.com";
const MAX_REQUEST_BYTES = 8_192;

const JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

type JsonRecord = Record<string, unknown>;

export interface AlphaAccessSubmission {
  name: string;
  email: string;
  tools: string;
  testPlan: string;
}

export interface AlphaAccessServices {
  allowRequest(): Promise<boolean>;
  sendEmail(message: EmailMessageBuilder): Promise<void>;
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

function jsonResponse(
  body: JsonRecord,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }

  return Response.json(body, { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    status,
    extraHeaders,
  );
}

function successResponse(): Response {
  return jsonResponse({
    ok: true,
    message: "Request sent. We will reply by email if there is a fit.",
  });
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(request: Request): Promise<JsonRecord> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isFinite(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > MAX_REQUEST_BYTES
    ) {
      throw new RequestFailure(
        413,
        "request_too_large",
        "The request is too large.",
      );
    }
  }

  if (!request.body) {
    throw new RequestFailure(
      400,
      "invalid_request",
      "The request body is required.",
    );
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      byteCount += chunk.value.byteLength;
      if (byteCount > MAX_REQUEST_BYTES) {
        await reader.cancel("Alpha access request exceeded the size limit.");
        throw new RequestFailure(
          413,
          "request_too_large",
          "The request is too large.",
        );
      }

      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestFailure(
      400,
      "invalid_json",
      "The request body must be valid JSON.",
    );
  }

  if (!isJsonRecord(value)) {
    throw new RequestFailure(
      400,
      "invalid_request",
      "The request body must be an object.",
    );
  }

  return value;
}

function normalizeSingleLine(
  value: unknown,
  field: string,
  minimumLength: number,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new RequestFailure(400, "validation_failed", `${field} is required.`);
  }

  const normalized = value.trim().replace(/\s+/gu, " ");
  const length = Array.from(normalized).length;
  if (length < minimumLength || length > maximumLength) {
    throw new RequestFailure(
      400,
      "validation_failed",
      `${field} must be between ${minimumLength} and ${maximumLength} characters.`,
    );
  }

  return normalized;
}

function containsUnsupportedControlCharacters(
  value: string,
  allowTabsAndNewlines = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127) return true;
    if (code < 32 && (!allowTabsAndNewlines || (code !== 9 && code !== 10))) {
      return true;
    }
  }

  return false;
}

function normalizeTestPlan(value: unknown): string {
  if (typeof value !== "string") {
    throw new RequestFailure(
      400,
      "validation_failed",
      "What you want to test is required.",
    );
  }

  const normalized = value.trim().replace(/\r\n?/gu, "\n");
  const length = Array.from(normalized).length;
  if (length < 10 || length > 1_200) {
    throw new RequestFailure(
      400,
      "validation_failed",
      "What you want to test must be between 10 and 1,200 characters.",
    );
  }

  if (containsUnsupportedControlCharacters(normalized, true)) {
    throw new RequestFailure(
      400,
      "validation_failed",
      "What you want to test contains unsupported characters.",
    );
  }

  return normalized;
}

function normalizeEmail(value: unknown): string {
  const email = normalizeSingleLine(value, "Email", 3, 254);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    containsUnsupportedControlCharacters(email)
  ) {
    throw new RequestFailure(
      400,
      "validation_failed",
      "Enter a valid email address.",
    );
  }

  return email;
}

function parseSubmission(body: JsonRecord): AlphaAccessSubmission {
  return {
    name: normalizeSingleLine(body.name, "Name", 1, 100),
    email: normalizeEmail(body.email),
    tools: normalizeSingleLine(body.tools, "AI tools", 2, 200),
    testPlan: normalizeTestPlan(body.testPlan),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildAlphaAccessEmail(
  submission: AlphaAccessSubmission,
): EmailMessageBuilder {
  const name = escapeHtml(submission.name);
  const email = escapeHtml(submission.email);
  const tools = escapeHtml(submission.tools);
  const testPlan = escapeHtml(submission.testPlan).replaceAll("\n", "<br />");

  return {
    to: SUPPORT_EMAIL,
    from: {
      email: SENDER_EMAIL,
      name: "MD Evolved Alpha",
    },
    replyTo: {
      email: submission.email,
      name: submission.name,
    },
    subject: `OWD alpha request — ${submission.name}`,
    text: [
      "New OWD alpha access request",
      "",
      `Name: ${submission.name}`,
      `Email: ${submission.email}`,
      `AI tools: ${submission.tools}`,
      "",
      "What they want to test:",
      submission.testPlan,
    ].join("\n"),
    html: [
      "<h1>New OWD alpha access request</h1>",
      `<p><strong>Name:</strong> ${name}</p>`,
      `<p><strong>Email:</strong> ${email}</p>`,
      `<p><strong>AI tools:</strong> ${tools}</p>`,
      "<p><strong>What they want to test:</strong></p>",
      `<p>${testPlan}</p>`,
    ].join(""),
  };
}

function logFailure(
  event: "alpha_access_rate_limit_failed" | "alpha_access_email_failed",
  requestId: string,
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event,
      requestId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
}

export async function handleAlphaAccessRequest(
  request: Request,
  services: AlphaAccessServices,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(
      405,
      "method_not_allowed",
      "Use POST to submit an alpha access request.",
      { Allow: "POST" },
    );
  }

  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) {
    return errorResponse(
      403,
      "origin_not_allowed",
      "This request must come from the MD Evolved site.",
    );
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "The request body must be JSON.",
    );
  }

  let body: JsonRecord;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestFailure) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(
      400,
      "invalid_request",
      "The request could not be read.",
    );
  }

  if (typeof body.website === "string" && body.website.trim() !== "") {
    return successResponse();
  }

  let submission: AlphaAccessSubmission;
  try {
    submission = parseSubmission(body);
  } catch (error) {
    if (error instanceof RequestFailure) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(
      400,
      "validation_failed",
      "Check the form and try again.",
    );
  }

  const requestId = crypto.randomUUID();

  let allowed: boolean;
  try {
    allowed = await services.allowRequest();
  } catch (error) {
    logFailure("alpha_access_rate_limit_failed", requestId, error);
    return errorResponse(
      503,
      "temporarily_unavailable",
      "Alpha requests are temporarily unavailable. Try again shortly.",
    );
  }

  if (!allowed) {
    return errorResponse(
      429,
      "rate_limited",
      "Too many requests were sent. Try again in a minute.",
      { "Retry-After": "60" },
    );
  }

  try {
    await services.sendEmail(buildAlphaAccessEmail(submission));
  } catch (error) {
    logFailure("alpha_access_email_failed", requestId, error);
    return errorResponse(
      503,
      "email_unavailable",
      "Your request could not be sent. Try again shortly.",
    );
  }

  return successResponse();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === ALPHA_ACCESS_PATH) {
      return handleAlphaAccessRequest(request, {
        allowRequest: async () => {
          const result = await env.ALPHA_ACCESS_RATE_LIMIT.limit({
            key: ALPHA_ACCESS_PATH,
          });
          return result.success;
        },
        sendEmail: async (message) => {
          await env.ALPHA_ACCESS_EMAIL.send(message);
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return errorResponse(404, "not_found", "API route not found.");
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
