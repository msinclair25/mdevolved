import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app";
import { oauthGrantPropsSchema } from "./agent-oauth-props";
import { mcpHandler } from "./mcp-server";
import { runScheduledMaintenance } from "./maintenance";
import { guardOAuthAbuse } from "./oauth-abuse";
import { guardSocketTicketAbuse } from "./socket-ticket-abuse";
import {
  enforceManagedTrialAccess,
  enforceRuntimeRouting,
} from "./runtime-config";

export { VaultCoordinator } from "./vault-coordinator";

const defaultHandler = {
  fetch(request: Request, env: Env, context: ExecutionContext) {
    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<Env>;

const oauthProvider = new OAuthProvider<Env>({
  accessTokenTTL: 60 * 60,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  allowTokenExchangeGrant: false,
  apiHandler: mcpHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  clientRegistrationTTL: 90 * 24 * 60 * 60,
  clientIdMetadataDocumentEnabled: true,
  defaultHandler,
  disallowPublicClientRegistration: false,
  onError(error) {
    console.error(
      JSON.stringify({
        code: error.code,
        event: "oauth.request_failed",
        level: "error",
        status: error.status,
      }),
    );
  },
  refreshTokenTTL: 30 * 24 * 60 * 60,
  resourceMetadata: {
    bearer_methods_supported: ["header"],
    resource_name: "MDevolved vault and Project collaboration access",
    scopes_supported: [
      "vault.read",
      "project.initialize.request",
      "project.connect.request",
    ],
  },
  scopesSupported: [
    "vault.read",
    "project.initialize.request",
    "project.connect.request",
    "project.read",
    "project.lead",
    "collaboration.submit",
    "review.submit",
    "proposal.status",
  ],
  tokenEndpoint: "/token",
  tokenExchangeCallback(options) {
    const props = oauthGrantPropsSchema.parse(options.props);
    return {
      accessTokenProps: {
        ...props,
        tokenScopes: options.requestedScope,
      },
    };
  },
});

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const routingResponse = enforceRuntimeRouting(request, env);
    if (routingResponse !== null) return routingResponse;
    const trialResponse = await enforceManagedTrialAccess(request, env);
    if (trialResponse !== null) return trialResponse;

    const abuseResponse = await guardOAuthAbuse(request, env);
    if (abuseResponse !== null) return abuseResponse;
    const socketTicketAbuseResponse = await guardSocketTicketAbuse(
      request,
      env,
    );
    if (socketTicketAbuseResponse !== null) return socketTicketAbuseResponse;
    return oauthProvider.fetch(
      request as Request<unknown, IncomingRequestCfProperties<unknown>>,
      env,
      context,
    );
  },
  scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): void {
    context.waitUntil(
      runScheduledMaintenance(
        env,
        Math.floor(controller.scheduledTime / 1_000),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
