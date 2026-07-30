import type { ApiError, HealthResponse } from "@owd/contracts";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { ApiProblem } from "./api-problem";
import { registerBackupRoutes } from "./backup-routes";
import { registerAgentAccessRoutes } from "./agent-access-routes";
import { registerAuthRoutes } from "./auth-routes";
import { registerContentRoutes } from "./content-routes";
import { registerCollaborationRoutes } from "./collaboration-routes";
import { registerDiagnosticsRoutes } from "./diagnostics-routes";
import { registerPairingRoutes } from "./pairing-routes";
import { registerMaterializationRoutes } from "./materialization-routes";
import { registerRestoreRoutes } from "./restore-routes";
import { registerSnapshotRoutes } from "./snapshot-routes";
import { registerProjectInitializationRoutes } from "./project-initialization-routes";
import { registerSetupReadinessRoutes } from "./setup-readiness-routes";
import type { AppBindings } from "./types";

export const app = new Hono<AppBindings>();

const applySecureHeaders = secureHeaders({
  contentSecurityPolicyReportOnly: {
    baseUri: ["'none'"],
    connectSrc: [
      "'self'",
      (context) => {
        const url = new URL(context.req.url);
        return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
      },
    ],
    defaultSrc: ["'self'"],
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", "data:"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'"],
    styleSrcAttr: ["'none'"],
    workerSrc: ["'none'"],
  },
});

app.use("*", (context, next) => {
  // A WebSocket upgrade response returned by a Durable Object has immutable
  // headers. HTTP security headers protect rendered documents, not the 101
  // handshake, so avoid mutating that response on the way back through Hono.
  if (context.req.header("Upgrade")?.toLowerCase() === "websocket") {
    return next();
  }

  return applySecureHeaders(context, next);
});

app.use("*", async (context, next) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  context.set("requestId", requestId);
  context.header("X-Request-Id", requestId);

  await next();

  console.log(
    JSON.stringify({
      level: "info",
      event: "request.complete",
      requestId,
      method: context.req.method,
      route: context.req.routePath || "unmatched",
      status: context.res.status,
      durationMs: Date.now() - startedAt,
    }),
  );
});

app.get("/healthz", (context) => {
  const releaseTag = context.env.WORKER_VERSION?.tag;
  const response: HealthResponse = {
    ok: true,
    service: "owd-platform",
    version: context.env.APP_VERSION,
    releaseId: context.env.WORKER_VERSION?.id ?? "local-development",
    releaseTag:
      releaseTag === undefined || releaseTag.length === 0 ? null : releaseTag,
    environment: context.env.APP_ENVIRONMENT,
    requestId: context.get("requestId"),
  };

  return context.json(response);
});

registerAuthRoutes(app);
registerSetupReadinessRoutes(app);
registerDiagnosticsRoutes(app);
registerPairingRoutes(app);
registerMaterializationRoutes(app);
registerAgentAccessRoutes(app);
registerProjectInitializationRoutes(app);
registerBackupRoutes(app);
registerSnapshotRoutes(app);
registerRestoreRoutes(app);
registerContentRoutes(app);
registerCollaborationRoutes(app);

app.notFound((context) => {
  const response: ApiError = {
    error: {
      code: "route_not_found",
      message: "The requested API route does not exist.",
      requestId: context.get("requestId"),
    },
  };

  return context.json(response, 404);
});

app.onError((error, context) => {
  const requestId = context.get("requestId") ?? crypto.randomUUID();
  const problem =
    error instanceof ApiProblem
      ? error
      : new ApiProblem(
          500,
          "internal_error",
          "The request could not be completed.",
        );

  console.error(
    JSON.stringify({
      level: "error",
      event: "request.failed",
      requestId,
      route: context.req.routePath || "unmatched",
      error: error instanceof Error ? error.name : "UnknownError",
      code: problem.code,
    }),
  );

  const response: ApiError = {
    error: {
      code: problem.code,
      message: problem.publicMessage,
      requestId,
    },
  };

  return context.json(response, problem.status);
});
