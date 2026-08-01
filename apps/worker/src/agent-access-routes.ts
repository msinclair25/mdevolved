import {
  PROJECT_CONNECTION_SCOPE,
  PROJECT_INITIALIZATION_SCOPE,
  agentConsentDecisionRequestSchema,
  agentConsentDenyRequestSchema,
  agentVaultScopesSchema,
  collaborationScopeSchema,
  prepareProjectHandoffRequestSchema,
  prepareProjectHandoffResponseSchema,
  transferVaultLocalWriterRequestSchema,
  transferVaultLocalWriterResponseSchema,
  type AgentConnectionListResponse,
  type AgentConsentContext,
  type AgentVaultScopes,
  type CollaborationScope,
  type OAuthRedirectResponse,
} from "@owd/contracts";
import type {
  GrantSummary,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Hono } from "hono";
import { ApiProblem } from "./api-problem";
import {
  activateAgentGrant,
  consumeConsentFlow,
  createConsentFlow,
  createPendingAgentGrant,
  listAppliedRestoredSources,
  listAgentConnections,
  readActiveAgentGrant,
  revokeAgentGrant,
  revokeAllAgentGrants,
  validateRestoredSourceSelection,
} from "./agent-access-store";
import { requireOwnerSession } from "./owner-session";
import { getCollaborationDashboard } from "./collaboration-service";
import {
  activateCollaborationGrant,
  createPendingCollaborationGrant,
  revokeCollaborationGrant,
  revokeAllCollaborationGrants,
} from "./collaboration-store";
import { listVaults } from "./pairing-store";
import { parseJsonBody, requestOrigin } from "./security";
import {
  normalizePreparedProjectHandoff,
  prepareProjectHandoff,
} from "./prepared-project-handoff-store";
import type { AppBindings } from "./types";
import { transferVaultLocalWriter } from "./vault-local-writer-store";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";
import {
  completeProjectAuthorization,
  readBoundProjectAuthorization,
  readPendingProjectAuthorization,
  type PendingProjectAuthorization,
} from "./project-initialization-store";

const REQUIRED_SCOPE = "vault.read";
const COLLABORATION_GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const OWNER_USER_ID = "owner";

export type RequestedAuthorization =
  | { kind: "vault"; scopes: AgentVaultScopes }
  | { kind: "collaboration"; scopes: CollaborationScope[] };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

async function vaultReadyForReadOnlyAgent(
  db: D1Database,
  vaultId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ready
       FROM current_materializations current
       JOIN materialization_generations generation
         ON generation.id = current.generation_id
       JOIN vaults ON vaults.id = current.vault_id
       JOIN vault_sync_states sync ON sync.vault_id = current.vault_id
       WHERE current.vault_id = ? AND vaults.status = 'active'
         AND generation.status = 'published'
         AND sync.initial_sync_at IS NOT NULL
         AND sync.library_stale = 0
         AND sync.current_state_vector_sha256 =
           generation.source_state_vector_sha256
       LIMIT 1`,
    )
    .bind(vaultId)
    .first<{ ready: number }>();
  return row?.ready === 1;
}

function isOAuthHelpers(value: unknown): value is OAuthHelpers {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "parseAuthRequest") === "function" &&
    typeof Reflect.get(value, "lookupClient") === "function" &&
    typeof Reflect.get(value, "completeAuthorization") === "function" &&
    typeof Reflect.get(value, "listUserGrants") === "function" &&
    typeof Reflect.get(value, "revokeGrant") === "function"
  );
}

export function oauthHelpers(env: object): OAuthHelpers {
  const value: unknown = Reflect.get(env, "OAUTH_PROVIDER");
  if (!isOAuthHelpers(value)) {
    throw new ApiProblem(
      503,
      "oauth_unavailable",
      "Agent authorization is temporarily unavailable.",
    );
  }
  return value;
}

export function safeClientName(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    return "Unnamed agent client";
  }
  return value.normalize("NFC");
}

export function clientOrigin(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.origin === "null" ? `${url.protocol}//local-client` : url.origin;
}

export function validateClientRedirect(redirectUri: string): void {
  const url = new URL(redirectUri);
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  ) {
    return;
  }
  if (
    !["http:", "javascript:", "data:", "file:", "blob:", "about:"].includes(
      url.protocol,
    )
  ) {
    return;
  }
  throw new ApiProblem(
    400,
    "oauth_redirect_unsafe",
    "The agent client uses an unsafe callback URL.",
  );
}

export function requestedResource(
  resource: string | string[] | undefined,
): string {
  if (typeof resource === "string") return resource;
  if (resource?.length === 1 && resource[0] !== undefined) return resource[0];
  throw new ApiProblem(
    400,
    "authorization_request_invalid",
    "The agent must request this deployment's MCP resource.",
  );
}

export function validateAuthorizationRequest(
  request: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>,
  audience: string,
): RequestedAuthorization {
  const uniqueScopes = [...new Set(request.scope)];
  const vaultScopeSet = new Set(uniqueScopes);
  const normalizedVaultScopes =
    vaultScopeSet.has(REQUIRED_SCOPE) &&
    uniqueScopes.every((scope) =>
      [
        REQUIRED_SCOPE,
        PROJECT_INITIALIZATION_SCOPE,
        PROJECT_CONNECTION_SCOPE,
      ].includes(scope),
    )
      ? [
          REQUIRED_SCOPE,
          ...(vaultScopeSet.has(PROJECT_INITIALIZATION_SCOPE)
            ? [PROJECT_INITIALIZATION_SCOPE]
            : []),
          ...(vaultScopeSet.has(PROJECT_CONNECTION_SCOPE)
            ? [PROJECT_CONNECTION_SCOPE]
            : []),
        ]
      : uniqueScopes;
  const vaultRequest = agentVaultScopesSchema.safeParse(normalizedVaultScopes);
  const collaborationScopes = collaborationScopeSchema
    .array()
    .min(1)
    .max(4)
    .safeParse(uniqueScopes);
  if (
    request.responseType !== "code" ||
    request.codeChallengeMethod !== "S256" ||
    !request.codeChallenge ||
    uniqueScopes.length !== request.scope.length ||
    (!vaultRequest.success && !collaborationScopes.success) ||
    requestedResource(request.resource) !== audience
  ) {
    throw new ApiProblem(
      400,
      "authorization_request_invalid",
      "The agent requested an unsupported authorization flow or permission.",
    );
  }
  return vaultRequest.success
    ? { kind: "vault", scopes: vaultRequest.data }
    : {
        kind: "collaboration",
        scopes: collaborationScopes.success ? collaborationScopes.data : [],
      };
}

function normalizePathPrefixes(values: string[]): {
  pathKeyPrefixes: string[];
  pathPrefixes: string[];
} {
  if (values.length === 0 || values.includes("")) {
    return { pathKeyPrefixes: [], pathPrefixes: [] };
  }

  const unique = new Map<string, string>();
  try {
    for (const raw of values) {
      const directory = raw.endsWith("/") ? raw.slice(0, -1) : raw;
      const sentinel = validateMarkdownVaultPath(
        `${directory}/__owd_agent_scope__.md`,
      );
      const pathPrefix = sentinel.path.slice(
        0,
        -"__owd_agent_scope__.md".length,
      );
      const pathKeyPrefix = sentinel.pathKey.slice(
        0,
        -"__owd_agent_scope__.md".length,
      );
      unique.set(pathKeyPrefix, pathPrefix);
    }
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new ApiProblem(
        400,
        "folder_scope_invalid",
        "One of the allowed folders is not a safe vault folder.",
      );
    }
    throw error;
  }

  const pathKeyPrefixes = [...unique.keys()].sort();
  const minimalKeys = pathKeyPrefixes.filter(
    (candidate, index) =>
      !pathKeyPrefixes.some(
        (other, otherIndex) =>
          otherIndex !== index && candidate.startsWith(other),
      ),
  );
  return {
    pathKeyPrefixes: minimalKeys,
    pathPrefixes: minimalKeys.map((key) => unique.get(key) ?? key),
  };
}

function metadataGrantId(grant: GrantSummary): string | null {
  const metadata: unknown = grant.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const value: unknown = Reflect.get(metadata, "owdGrantId");
  return typeof value === "string" ? value : null;
}

export async function revokeOAuthGrants(
  helpers: OAuthHelpers,
  appGrantIds?: ReadonlySet<string>,
): Promise<void> {
  let cursor: string | undefined;
  const oauthGrantIds: string[] = [];
  do {
    const page = await helpers.listUserGrants(OWNER_USER_ID, {
      cursor,
      limit: 100,
    });
    for (const grant of page.items) {
      const appGrantId = metadataGrantId(grant);
      if (
        appGrantId !== null &&
        (appGrantIds === undefined || appGrantIds.has(appGrantId))
      ) {
        oauthGrantIds.push(grant.id);
      }
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (const oauthGrantId of oauthGrantIds) {
    await helpers.revokeGrant(oauthGrantId, OWNER_USER_ID);
  }
}

export function registerAgentAccessRoutes(app: Hono<AppBindings>): void {
  app.get("/api/agent/oauth/context", async (context) => {
    const session = await requireOwnerSession(context, { csrf: false });
    const helpers = oauthHelpers(context.env);
    let authRequest: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;
    try {
      authRequest = await helpers.parseAuthRequest(context.req.raw);
    } catch {
      throw new ApiProblem(
        400,
        "authorization_request_invalid",
        "The agent authorization request is invalid or expired.",
      );
    }

    const audience = `${requestOrigin(context).origin}/mcp`;
    const authorization = validateAuthorizationRequest(authRequest, audience);
    validateClientRedirect(authRequest.redirectUri);
    const activeVaults =
      authorization.kind === "vault"
        ? (await listVaults(context.env.DB)).filter(
            (vault) => vault.status === "active",
          )
        : null;
    if (activeVaults !== null && activeVaults.length === 0) {
      throw new ApiProblem(
        409,
        "vault_setup_required",
        "Pair an Obsidian vault before connecting an agent.",
      );
    }
    const eligibleVaults =
      activeVaults === null
        ? null
        : (
            await Promise.all(
              activeVaults.map(async (vault) => ({
                eligible: await vaultReadyForReadOnlyAgent(
                  context.env.DB,
                  vault.id,
                ),
                vault,
              })),
            )
          )
            .filter((candidate) => candidate.eligible)
            .map((candidate) => candidate.vault);
    if (eligibleVaults !== null && eligibleVaults.length === 0) {
      throw new ApiProblem(
        409,
        "vault_protection_required",
        "OWD does not yet have an exact-current searchable library for this vault. Keep Obsidian open and retry shortly; if library status reports a failure, use Build now.",
      );
    }
    const client = await helpers.lookupClient(authRequest.clientId);
    if (client === null) {
      throw new ApiProblem(
        400,
        "oauth_client_unknown",
        "The requesting agent client is not registered.",
      );
    }
    const name = safeClientName(client.clientName);
    let projectAuthorization: PendingProjectAuthorization | null = null;
    if (authorization.kind === "collaboration") {
      const pending = await readPendingProjectAuthorization(context.env.DB, {
        audience,
        oauthClientId: authRequest.clientId,
        requestedScopes: authorization.scopes,
      });
      if (pending === "ambiguous") {
        throw new ApiProblem(
          409,
          "project_authorization_ambiguous",
          "More than one approved Project is waiting for this client. Open OWD, archive the unwanted duplicate, then retry authorization.",
        );
      }
      if (pending === null) {
        throw new ApiProblem(
          409,
          "project_authorization_required",
          "Approve one exact Project initialization or connection request before requesting Project scopes.",
        );
      }
      projectAuthorization = pending;
    }
    const flow = await createConsentFlow(context.env.DB, {
      clientName: name,
      now: nowSeconds(),
      ownerSessionHash: session.token_hash,
      projectInitializationRequestId: projectAuthorization?.initializationId,
      request: authRequest,
    });
    const base = {
      client: {
        id: authRequest.clientId,
        name,
        origin: clientOrigin(authRequest.redirectUri),
        redirectUri: authRequest.redirectUri,
        verified: false as const,
      },
      expiresAt: flow.expiresAt,
      flowToken: flow.flowToken,
      resource: audience,
    };
    const response: AgentConsentContext =
      authorization.kind === "vault"
        ? {
            ...base,
            authorizationKind: "vault",
            restoredSources: await listAppliedRestoredSources(context.env.DB),
            scopes: authorization.scopes,
            vaults: eligibleVaults ?? [],
          }
        : {
            ...base,
            authorizationKind: "collaboration",
            projects: (
              await getCollaborationDashboard(
                context.env.DB,
                context.env.VAULT_STORAGE,
              )
            ).projects.filter(
              (project) =>
                project.status === "active" &&
                project.projectId === projectAuthorization?.projectId,
            ),
            scopes: authorization.scopes,
          };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/agent/oauth/approve", async (context) => {
    const session = await requireOwnerSession(context, { csrf: true });
    const parsed = agentConsentDecisionRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "consent_decision_invalid",
        "Choose one vault and valid folder access.",
      );
    }
    const now = nowSeconds();
    const flow = await consumeConsentFlow(context.env.DB, {
      decision: "approved",
      flowToken: parsed.data.flowToken,
      now,
      ownerSessionHash: session.token_hash,
    });
    if (flow === null) {
      throw new ApiProblem(
        400,
        "consent_flow_invalid",
        "This approval request is expired or has already been used.",
      );
    }
    const audience = requestedResource(flow.request.resource);
    const authorization = validateAuthorizationRequest(flow.request, audience);
    if (parsed.data.authorizationKind !== authorization.kind) {
      throw new ApiProblem(
        400,
        "consent_decision_invalid",
        "The approval does not match the requested permission.",
      );
    }
    let grantId: string;
    if (parsed.data.authorizationKind === "vault") {
      if (authorization.kind !== "vault") {
        throw new ApiProblem(
          400,
          "consent_decision_invalid",
          "The approval does not match the requested permission.",
        );
      }
      if (
        !(await vaultReadyForReadOnlyAgent(context.env.DB, parsed.data.vaultId))
      ) {
        throw new ApiProblem(
          409,
          "vault_protection_required",
          "OWD does not yet have an exact-current searchable library for this vault. Keep Obsidian open and retry shortly; if library status reports a failure, use Build now.",
        );
      }
      const prefixes = normalizePathPrefixes(parsed.data.pathPrefixes);
      if (
        !(await validateRestoredSourceSelection(context.env.DB, {
          restoreIds: parsed.data.approvedRestoreIds,
          vaultId: parsed.data.vaultId,
        }))
      ) {
        throw new ApiProblem(
          400,
          "restored_source_invalid",
          "One of the selected restored sources is not available in this vault.",
        );
      }
      const pending = await createPendingAgentGrant(context.env.DB, {
        audience,
        approvedRestoreIds: parsed.data.approvedRestoreIds,
        clientName: flow.clientName,
        now,
        oauthClientId: flow.oauthClientId,
        pathKeyPrefixes: prefixes.pathKeyPrefixes,
        pathPrefixes: prefixes.pathPrefixes,
        redirectUri: flow.redirectUri,
        requestId: context.get("requestId"),
        scopes: authorization.scopes,
        vaultId: parsed.data.vaultId,
      });
      if (pending === null) {
        throw new ApiProblem(
          404,
          "vault_not_found",
          "The selected vault is not active.",
        );
      }
      grantId = pending;
    } else {
      if (authorization.kind !== "collaboration") {
        throw new ApiProblem(
          400,
          "consent_decision_invalid",
          "The approval does not match the requested permission.",
        );
      }
      if (flow.projectInitializationRequestId === null) {
        throw new ApiProblem(
          409,
          "project_authorization_required",
          "This authorization is not bound to an approved Project request.",
        );
      }
      const projectAuthorization = await readBoundProjectAuthorization(
        context.env.DB,
        {
          audience,
          initializationId: flow.projectInitializationRequestId,
          oauthClientId: flow.oauthClientId,
          requestedScopes: authorization.scopes,
        },
      );
      if (
        projectAuthorization === null ||
        parsed.data.projectId !== projectAuthorization.projectId
      ) {
        throw new ApiProblem(
          409,
          "project_authorization_mismatch",
          "This approval does not match the exact Project request that started authorization.",
        );
      }
      const project = await context.env.DB.prepare(
        `SELECT active_knowledge_space_version_id
         FROM collaboration_projects
         WHERE project_id = ? AND status = 'active'
           AND agent_visibility = 'discoverable'`,
      )
        .bind(parsed.data.projectId)
        .first<{ active_knowledge_space_version_id: string }>();
      if (project === null) {
        throw new ApiProblem(
          404,
          "project_reference_invalid",
          "The selected Project is not active.",
        );
      }
      const sourceGrant = await context.env.DB.prepare(
        `SELECT id, client_name, client_origin
         FROM agent_grants
         WHERE id = ? AND oauth_client_id = ? AND audience = ?
           AND status = 'active'`,
      )
        .bind(
          projectAuthorization.sourceAgentGrantId,
          flow.oauthClientId,
          audience,
        )
        .first<{
          client_name: string;
          client_origin: string;
          id: string;
        }>();
      if (sourceGrant === null) {
        throw new ApiProblem(
          409,
          "agent_grant_revoked",
          "The vault connection that approved this Project is no longer active.",
        );
      }
      try {
        grantId = await createPendingCollaborationGrant(context.env.DB, {
          audience,
          clientId: flow.oauthClientId,
          expiresAt: now + COLLABORATION_GRANT_LIFETIME_SECONDS,
          issuedAt: now,
          knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
          projectId: parsed.data.projectId,
          scopes: authorization.scopes,
          source: {
            agentGrantId: sourceGrant.id,
            clientName: sourceGrant.client_name,
            clientOrigin: sourceGrant.client_origin,
          },
        });
      } catch {
        throw new ApiProblem(
          404,
          "project_reference_invalid",
          "The selected Project is not active.",
        );
      }
    }

    const helpers = oauthHelpers(context.env);
    let redirectTo: string;
    try {
      const completed = await helpers.completeAuthorization({
        metadata: { owdGrantId: grantId },
        props: {
          audience,
          clientId: flow.oauthClientId,
          grantId,
          grantKind: authorization.kind,
          ownerId: 1,
        },
        request: flow.request,
        revokeExistingGrants: false,
        scope: authorization.scopes,
        userId: OWNER_USER_ID,
      });
      redirectTo = completed.redirectTo;
    } catch {
      if (authorization.kind === "vault") {
        await revokeAgentGrant(context.env.DB, {
          grantId,
          now,
          requestId: context.get("requestId"),
        });
      } else {
        await revokeCollaborationGrant(context.env.DB, { grantId, now });
      }
      throw new ApiProblem(
        503,
        "authorization_failed",
        "The agent connection could not be authorized.",
      );
    }

    const active =
      authorization.kind === "vault"
        ? await activateAgentGrant(context.env.DB, {
            grantId,
            now,
            requestId: context.get("requestId"),
          })
        : await activateCollaborationGrant(context.env.DB, { grantId, now });
    if (!active) {
      await revokeOAuthGrants(helpers, new Set([grantId]));
      if (authorization.kind === "collaboration") {
        await revokeCollaborationGrant(context.env.DB, { grantId, now });
      }
      throw new ApiProblem(
        503,
        "authorization_failed",
        "The agent connection could not be activated.",
      );
    }
    if (
      authorization.kind === "collaboration" &&
      (flow.projectInitializationRequestId === null ||
        !(await completeProjectAuthorization(context.env.DB, {
          collaborationGrantId: grantId,
          initializationId: flow.projectInitializationRequestId,
        })))
    ) {
      await revokeOAuthGrants(helpers, new Set([grantId]));
      await revokeCollaborationGrant(context.env.DB, { grantId, now });
      throw new ApiProblem(
        503,
        "authorization_failed",
        "The exact Project authorization could not be finalized.",
      );
    }
    const response: OAuthRedirectResponse = { redirectTo };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/agent/oauth/deny", async (context) => {
    const session = await requireOwnerSession(context, { csrf: true });
    const parsed = agentConsentDenyRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "consent_decision_invalid",
        "The consent decision is invalid.",
      );
    }
    const flow = await consumeConsentFlow(context.env.DB, {
      decision: "denied",
      flowToken: parsed.data.flowToken,
      now: nowSeconds(),
      ownerSessionHash: session.token_hash,
    });
    if (flow === null) {
      throw new ApiProblem(
        400,
        "consent_flow_invalid",
        "This approval request is expired or has already been used.",
      );
    }
    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set(
      "error_description",
      "The vault owner denied access.",
    );
    redirect.searchParams.set("state", flow.request.state);
    const response: OAuthRedirectResponse = {
      redirectTo: redirect.toString(),
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/agent/connections", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response: AgentConnectionListResponse = {
      connections: await listAgentConnections(context.env.DB),
      mcpUrl: `${requestOrigin(context).origin}/mcp`,
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post(
    "/api/agent/connections/:grantId/prepare-first-project",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const grantId = context.req.param("grantId");
      if (!/^[-0-9a-f]{36}$/iu.test(grantId)) {
        throw new ApiProblem(
          404,
          "agent_grant_not_found",
          "Connection not found.",
        );
      }
      const parsed = prepareProjectHandoffRequestSchema.safeParse(
        await parseJsonBody(context),
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "project_handoff_invalid",
          "Enter one Project name and a safe folder inside this agent's approved boundary.",
        );
      }
      const identity = await context.env.DB.prepare(
        `SELECT oauth_client_id, audience
         FROM agent_grants
         WHERE id = ? AND owner_id = 1 AND status = 'active'`,
      )
        .bind(grantId)
        .first<{ audience: string; oauth_client_id: string }>();
      if (identity === null) {
        throw new ApiProblem(
          404,
          "agent_grant_not_found",
          "Connection not found.",
        );
      }
      const grant = await readActiveAgentGrant(context.env.DB, {
        audience: identity.audience,
        clientId: identity.oauth_client_id,
        grantId,
      });
      if (grant === null) {
        throw new ApiProblem(
          404,
          "agent_grant_not_found",
          "Connection not found.",
        );
      }
      let normalized: ReturnType<typeof normalizePreparedProjectHandoff>;
      try {
        normalized = normalizePreparedProjectHandoff(grant, parsed.data);
      } catch (error) {
        throw new ApiProblem(
          400,
          "project_handoff_invalid",
          error instanceof Error
            ? error.message
            : "The first Project handoff is invalid.",
        );
      }
      const handoff = await prepareProjectHandoff(context.env.DB, {
        agentGrantId: grant.id,
        folderPath: normalized.folderPath,
        folderPathKey: normalized.folderPathKey,
        now: nowSeconds(),
        projectLabel: normalized.projectLabel,
        projectLabelKey: normalized.projectLabelKey,
        requestId: context.get("requestId"),
        vaultId: grant.vaultId,
      });
      if (handoff === null) {
        throw new ApiProblem(
          409,
          "project_handoff_unavailable",
          "OWD could not prepare this active agent for the first Project.",
        );
      }
      context.header("Cache-Control", "private, no-store");
      return context.json(
        prepareProjectHandoffResponseSchema.parse({ handoff }),
      );
    },
  );

  app.post(
    "/api/agent/connections/:grantId/make-primary-writer",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const grantId = context.req.param("grantId");
      if (!/^[-0-9a-f]{36}$/iu.test(grantId)) {
        throw new ApiProblem(
          404,
          "agent_grant_not_found",
          "Connection not found.",
        );
      }
      const parsed = transferVaultLocalWriterRequestSchema.safeParse(
        await parseJsonBody(context),
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "primary_writer_transfer_confirmation_required",
          "Confirm that the previous primary writer has stopped before moving the role.",
        );
      }
      const transferred = await transferVaultLocalWriter(context.env.DB, {
        now: nowSeconds(),
        requestId: context.get("requestId"),
        targetAgentGrantId: grantId,
      });
      if (transferred === null) {
        throw new ApiProblem(
          409,
          "primary_writer_transfer_unavailable",
          "This connection is already primary, is not an active Project participant, or its vault has no writer assignment yet.",
        );
      }
      context.header("Cache-Control", "private, no-store");
      return context.json(
        transferVaultLocalWriterResponseSchema.parse({
          connectionId: transferred.target_agent_grant_id,
          transferredAt: transferred.transferred_at,
          vaultId: transferred.vault_id,
          writerRole: "primary-writer",
        }),
      );
    },
  );

  app.post("/api/agent/connections/revoke-all", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await revokeAllAgentGrants(context.env.DB, {
      now: nowSeconds(),
      requestId: context.get("requestId"),
    });
    await revokeAllCollaborationGrants(context.env.DB, nowSeconds());
    try {
      await revokeOAuthGrants(oauthHelpers(context.env));
    } catch {
      console.error(
        JSON.stringify({
          event: "agent.oauth_cleanup_failed",
          level: "error",
          requestId: context.get("requestId"),
        }),
      );
    }
    return context.body(null, 204);
  });

  app.post("/api/agent/connections/:grantId/revoke", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const grantId = context.req.param("grantId");
    if (!/^[-0-9a-f]{36}$/iu.test(grantId)) {
      throw new ApiProblem(
        404,
        "agent_grant_not_found",
        "Connection not found.",
      );
    }
    const revoked = await revokeAgentGrant(context.env.DB, {
      grantId,
      now: nowSeconds(),
      requestId: context.get("requestId"),
    });
    if (!revoked) {
      throw new ApiProblem(
        404,
        "agent_grant_not_found",
        "Connection not found.",
      );
    }
    try {
      await revokeOAuthGrants(oauthHelpers(context.env), new Set([grantId]));
    } catch {
      console.error(
        JSON.stringify({
          event: "agent.oauth_cleanup_failed",
          level: "error",
          requestId: context.get("requestId"),
        }),
      );
    }
    return context.body(null, 204);
  });
}
