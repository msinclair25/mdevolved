export type OwdEveCompatibilityProfile = {
  connection: {
    auth: "oauth-2.1-pkce";
    connectionFile: string;
    connectionName: string;
    connectorUid: string;
    sourceScopes: readonly string[];
    tokenResource: "OWD MCP URL";
    toolPrefix: string;
    transport: "streamable-http";
    userScoped: true;
  };
  format: "owd-client-profile-v1";
  id: "eve";
  identity: {
    declaredSubagentRule: string;
    independentAgentRule: string;
    rootChildRule: string;
    serverAuthority: string;
  };
  projectLifecycle: {
    entryTool: string;
    flow: readonly string[];
    receipt: string;
    rule: string;
  };
  runtime: {
    credentials: string;
    durableSession: string;
    sandbox: string;
    schedules: string;
  };
  source: {
    commit: string;
    connectVersion: string;
    eveVersion: string;
    license: "Apache-2.0";
    repository: string;
    reviewedAt: string;
  };
};

export const EVE_PROFILE_RESOURCE_URI = "owd://compatibility-profiles/eve/v1";

export const EVE_CONNECTION_DESCRIPTION =
  "OWD owner-approved Obsidian knowledge and durable cross-agent Projects. Use it to connect, resume, read bounded context, and exchange cited handoffs.";

export const EVE_CONNECTION_INSTRUCTIONS =
  "Open OWD, verify this eve agent and the exact vault and folder boundary, then approve to continue.";

/**
 * This profile describes Eve conventions only. OWD still exposes its one
 * standard remote MCP endpoint, OAuth flow, tool catalog, and server-side
 * authorization checks.
 */
export const EVE_COMPATIBILITY_PROFILE = {
  connection: {
    auth: "oauth-2.1-pkce",
    connectionFile: "agent/connections/owd.ts",
    connectionName: "owd",
    connectorUid: "oauth/owd",
    sourceScopes: [
      "vault.read",
      "project.initialize.request",
      "project.connect.request",
    ],
    tokenResource: "OWD MCP URL",
    toolPrefix: "owd__",
    transport: "streamable-http",
    userScoped: true,
  },
  format: "owd-client-profile-v1",
  id: "eve",
  identity: {
    declaredSubagentRule:
      "A declared local subagent discovers its own connections. Reusing the same connector UID still represents the same OWD OAuth client; use a different connector UID only when the subagent must be independently attributable.",
    independentAgentRule:
      "Give every independently attributable Eve agent or reviewer its own connector UID and OAuth registration, such as oauth/owd-reviewer. Sessions and channels that reuse one connector UID are one OWD participant.",
    rootChildRule:
      "Eve's built-in agent child inherits the root agent's connections and therefore shares its OWD identity.",
    serverAuthority:
      "OWD binds grants to the authenticated OAuth client and rechecks the durable grant on every tool call. Eve names, prompts, sessions, and subagent folders do not create OWD authority.",
  },
  projectLifecycle: {
    entryTool: "owd__open_project",
    flow: [
      "owd__connection_info",
      "owd__open_project",
      "owd__wait_for_project_connection when approval is pending",
      "owd__resume_project",
    ],
    receipt: ".owdignore",
    rule: "Use the exact OWD lifecycle. In a fresh session, resume the .owdignore receipt first and treat the writer role as unconfirmed until OWD returns localVaultAccess. Never ask the owner to copy a prompt, start a second OAuth flow, renew a routine packet, or create a duplicate Project.",
  },
  runtime: {
    credentials:
      "Vercel Connect holds OAuth credentials outside model-visible instructions and history.",
    durableSession:
      "Eve session durability preserves one runtime conversation. OWD Projects, packets, handoffs, reviews, Decisions, and provenance remain the portable cross-agent record.",
    sandbox:
      "Eve runs in an isolated /workspace. Local Obsidian files are unavailable unless the owner deliberately mounts or clones them; any direct local write still obeys OWD localVaultAccess.",
    schedules:
      "Top-level schedules run as an app/runtime principal and cannot silently borrow a user's OWD grant. Dispatch scheduled OWD work through a user-authenticated route or require an explicit user action; do not downgrade OWD to app-scoped authorization.",
  },
  source: {
    commit: "85c1dd7a647a04cc1bd74879ba8d27a3ba0bdd9d",
    connectVersion: "0.6.0",
    eveVersion: "0.29.4",
    license: "Apache-2.0",
    repository: "https://github.com/vercel/eve",
    reviewedAt: "2026-07-31",
  },
} as const satisfies OwdEveCompatibilityProfile;

function normalizedOwdMcpUrl(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("OWD MCP requires HTTPS except on localhost.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    throw new Error(
      "OWD MCP URLs cannot contain credentials, query parameters, or fragments.",
    );
  }
  return url.toString();
}

function validatedConnectorUid(value: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.includes("//")
  ) {
    throw new Error(
      "Eve connector UID must be 1-128 URL-safe characters without whitespace.",
    );
  }
  return value;
}

/**
 * Generates the complete Eve connection module. The connection remains
 * user-scoped, requests only OWD's source-grant scopes, and deliberately omits
 * static bearer tokens, app principals, client-side tool allowlists, and
 * per-call Connect validation.
 */
export function createEveConnectionSource(
  mcpUrl: string,
  connectorUid: string = EVE_COMPATIBILITY_PROFILE.connection.connectorUid,
): string {
  const url = normalizedOwdMcpUrl(mcpUrl);
  const connector = validatedConnectorUid(connectorUid);

  return `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const owdMcpUrl = ${JSON.stringify(url)};

export default defineMcpClientConnection({
  url: owdMcpUrl,
  description: ${JSON.stringify(EVE_CONNECTION_DESCRIPTION)},
  auth: connect({
    connector: ${JSON.stringify(connector)},
    principalType: "user",
    tokenParams: {
      scopes: [
        "vault.read",
        "project.initialize.request",
        "project.connect.request",
      ],
      resources: [owdMcpUrl],
    },
    autoProvision: true,
    displayName: "OWD",
    instructions: ${JSON.stringify(EVE_CONNECTION_INSTRUCTIONS)},
  }),
});
`;
}

export function serializeEveCompatibilityProfile(): string {
  return `${JSON.stringify(EVE_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const EVE_CONTINUITY_GUIDANCE = `### Eve compatibility

- When the agent repository uses Eve, configure OWD in \`agent/connections/owd.ts\` with Eve's standard remote MCP connection and user-scoped \`connect()\` OAuth helper. Otherwise ignore this profile. Do not add a proxy, static bearer token, app principal, custom tool schema, or client-side authority.
- Eve qualifies discovered tools with the connection name. For the recommended \`owd.ts\` file, call \`owd__connection_info\`, \`owd__open_project\`, \`owd__wait_for_project_connection\`, and \`owd__resume_project\`.
- Use a unique Vercel Connect connector UID for every independently attributable Eve agent or reviewer. Eve sessions, channels, and the built-in child agent may share one UID only when they intentionally represent the same OWD participant.
- If Eve reports \`principal_required\`, continue from a user-authenticated Eve route. Do not reconnect OWD or switch to an app principal. Top-level schedules cannot borrow a user's OWD grant.
- Persist the OWD receipt in \`.owdignore\` when the workspace is durable. On a later task, resume its exact Project as the first OWD action; treat the writer role as unconfirmed until the current \`localVaultAccess.role\` returns. **MDevolved resume project** and the legacy phrase **OWD resume project** both mean perform this receipt-based resume, not reconnect. Do not treat Eve conversation durability as shared Project authority.
- Eve's sandbox has no automatic access to the owner's Obsidian vault. If files are deliberately mounted or cloned, obey OWD \`localVaultAccess\` before any direct write.`;

export const EVE_PROFILE_PROMPT = `Connect this eve agent to OWD through the existing \`owd\` connection.

1. Confirm this is a user-authenticated eve route. If the runtime reports \`principal_required\`, explain that the route needs a signed-in user; do not switch OWD to app-scoped authentication.
2. Use the discovered \`owd__\` tools. Call \`owd__connection_info\`, then \`owd__open_project\` with the exact Project UUID from \`.owdignore\` or the visible Project name the user supplied.
3. If OWD returns a pending approval, present its one approval URL and immediately call \`owd__wait_for_project_connection\` with the exact returned key. Do not reconnect OAuth, repeat setup, or ask the user to copy a prompt.
4. When ready, persist the continuity receipt if this workspace is durable and call \`owd__resume_project\` as the first OWD action on later tasks. Until it returns, the writer role is unconfirmed; never infer it from session, channel, or sandbox identity. Treat "MDevolved resume project" and the legacy phrase "OWD resume project" as this receipt-based resume, with no reconnect or new approval.
5. Treat the connector UID as the OWD participant identity. A separate independent reviewer needs a separately configured connector UID and authorization; a child or session reusing this connection is the same participant.
6. Use OWD as the durable, portable Project record. Eve conversation state and sandbox files are runtime-local. Before any deliberately mounted or cloned vault write, obey the \`localVaultAccess\` role returned by OWD.
7. Do not run user-scoped OWD tools directly from a top-level app-principal schedule. Route scheduled work through a user-authenticated interaction or request explicit user action.`;
