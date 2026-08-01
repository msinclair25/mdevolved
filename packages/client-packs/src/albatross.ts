export type OwdAlbatrossCompatibilityProfile = {
  bridge: {
    authBootstrapBinary: string;
    authTimeoutSeconds: number;
    clientName: "Albatross via mcp-remote";
    clientUri: string;
    integrity: string;
    license: "MIT";
    package: "mcp-remote";
    temporary: true;
    transportStrategy: "http-only";
    version: string;
  };
  client: {
    configFile: "agent.config.json";
    consumesInitializeInstructions: false;
    consumesPrompts: false;
    consumesResources: false;
    consumesStructuredContent: false;
    mcpProtocolVersion: "2025-06-18";
    nativeRemoteTransport: false;
    promptFile: ".albatross/prompt.md";
    requestTimeoutSeconds: 30;
    serverName: "owd";
    toolPrefix: "mcp__owd__";
    trustCommand: "/mcp trust owd";
  };
  connection: {
    auth: "oauth-2.1-pkce";
    participantHeader: "X-OWD-Albatross-Participant";
    sourceScopes: readonly string[];
    transport: "stdio-to-streamable-http";
  };
  format: "owd-client-profile-v1";
  id: "albatross";
  identity: {
    defaultParticipantId: "primary";
    independentParticipantRule: string;
    serverAuthority: string;
  };
  projectLifecycle: {
    entryTool: string;
    flow: readonly string[];
    receipt: ".owdignore";
    rule: string;
    waitTimeoutSeconds: 20;
  };
  runtime: {
    approvals: string;
    automation: string;
    checkpoints: string;
    evaluation: string;
    pathForks: string;
    reset: string;
    workspaceWrites: string;
  };
  source: {
    commit: string;
    license: "MIT";
    repository: string;
    reviewedAt: string;
    version: string;
  };
};

export const ALBATROSS_PROFILE_RESOURCE_URI =
  "owd://compatibility-profiles/albatross/v1";

export const ALBATROSS_MCP_REMOTE_VERSION = "0.1.38";
export const ALBATROSS_AUTH_TIMEOUT_SECONDS = 120;
export const ALBATROSS_WAIT_TIMEOUT_SECONDS = 20;
export const ALBATROSS_PARTICIPANT_HEADER = "X-OWD-Albatross-Participant";
export const ALBATROSS_OAUTH_CLIENT_METADATA = JSON.stringify({
  client_name: "Albatross via mcp-remote",
  client_uri: "https://github.com/morganlinton/Albatross",
});

/**
 * Albatross 2.0.3 is a stdio-only MCP client. This profile keeps OWD's
 * standard remote endpoint and puts a pinned, removable transport bridge on
 * the client side until Albatross supports remote authenticated MCP natively.
 */
export const ALBATROSS_COMPATIBILITY_PROFILE = {
  bridge: {
    authBootstrapBinary: "mcp-remote-client",
    authTimeoutSeconds: ALBATROSS_AUTH_TIMEOUT_SECONDS,
    clientName: "Albatross via mcp-remote",
    clientUri: "https://github.com/morganlinton/Albatross",
    integrity:
      "sha512-w+JU4U3CfG29TawXR4JLNQ9d1Un5nT8AGI65f/juCaqUdF/V6fS7wE4o7xNPbB8X58o46hRXEJgYglQMAKQs4w==",
    license: "MIT",
    package: "mcp-remote",
    temporary: true,
    transportStrategy: "http-only",
    version: ALBATROSS_MCP_REMOTE_VERSION,
  },
  client: {
    configFile: "agent.config.json",
    consumesInitializeInstructions: false,
    consumesPrompts: false,
    consumesResources: false,
    consumesStructuredContent: false,
    mcpProtocolVersion: "2025-06-18",
    nativeRemoteTransport: false,
    promptFile: ".albatross/prompt.md",
    requestTimeoutSeconds: 30,
    serverName: "owd",
    toolPrefix: "mcp__owd__",
    trustCommand: "/mcp trust owd",
  },
  connection: {
    auth: "oauth-2.1-pkce",
    participantHeader: ALBATROSS_PARTICIPANT_HEADER,
    sourceScopes: [
      "vault.read",
      "project.initialize.request",
      "project.connect.request",
    ],
    transport: "stdio-to-streamable-http",
  },
  format: "owd-client-profile-v1",
  id: "albatross",
  identity: {
    defaultParticipantId: "primary",
    independentParticipantRule:
      "The non-secret participant header partitions mcp-remote's OAuth cache. Reusing one participant ID represents one OWD OAuth client; an independently attributable Albatross writer or reviewer uses a different participant ID and completes its own authorization.",
    serverAuthority:
      "The participant header is only a local cache-partition label. It never grants access. OWD binds authority to the authenticated OAuth client and rechecks its durable vault and Project grants on every call.",
  },
  projectLifecycle: {
    entryTool: "mcp__owd__open_project",
    flow: [
      "mcp__owd__connection_info",
      "mcp__owd__open_project",
      "mcp__owd__wait_for_project_connection when approval is pending",
      "mcp__owd__resume_project",
    ],
    receipt: ".owdignore",
    rule: "On every fresh task and after /reset, read .owdignore and resume its exact Project before any other OWD action. Keep each wait call below Albatross's 30-second MCP timeout and repeat only the same wait when approval is still pending. Never reconnect OAuth, create a duplicate Project, or infer writer authority from the Albatross session.",
    waitTimeoutSeconds: ALBATROSS_WAIT_TIMEOUT_SECONDS,
  },
  runtime: {
    approvals:
      "Albatross approval gates consent to execute the local MCP bridge or call a tool. It does not replace OWD OAuth, owner approval, vault scope, or Project authority.",
    automation:
      "Keep /auto bounded by the current OWD Work Packet, budget, and deadline. Resume OWD after every automatic reset, stop on a stale or mismatched packet, and submit the final cited Artifact or Handoff rather than every internal turn.",
    checkpoints:
      "Albatross checkpoints and continuation files are private runtime recovery. Promote only distilled, cited results into OWD so another agent receives useful evidence instead of a raw transcript.",
    evaluation:
      "Treat /iterate candidates and critiques as internal Attempts. Publish meaningful alternatives and the selected result as OWD Attempts or Artifacts. Albatross review mode is independently attributable only when it uses a distinct participant ID and OAuth grant.",
    pathForks:
      "Treat /path fork branches as alternative Attempts and Artifacts inside the same OWD Project. A path fork never creates a second OWD Project or a second participant identity.",
    reset:
      "Albatross /reset and .albatross/continue.md preserve one runtime's continuation. OWD .owdignore and resume_project preserve the portable Project identity and current authority across agents.",
    workspaceWrites:
      "Albatross can edit the local workspace directly. Before a vault write, resume OWD and obey the returned localVaultAccess role; MCP Project submissions do not grant filesystem authority.",
  },
  source: {
    commit: "0543226b800ee57659f200c1ef928925868c90c9",
    license: "MIT",
    repository: "https://github.com/morganlinton/Albatross",
    reviewedAt: "2026-07-30",
    version: "2.0.3",
  },
} as const satisfies OwdAlbatrossCompatibilityProfile;

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

function validatedParticipantId(value: string): string {
  if (
    value.length === 0 ||
    value.length > 64 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error(
      "Albatross participant ID must be 1-64 letters, numbers, dots, underscores, or hyphens without whitespace.",
    );
  }
  return value;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function participantHeader(participantId: string): string {
  return `${ALBATROSS_PARTICIPANT_HEADER}:${validatedParticipantId(
    participantId,
  )}`;
}

function bridgeArgs(mcpUrl: string, participantId: string): string[] {
  return [
    "-y",
    `mcp-remote@${ALBATROSS_MCP_REMOTE_VERSION}`,
    normalizedOwdMcpUrl(mcpUrl),
    "--header",
    participantHeader(participantId),
    "--transport",
    "http-only",
    "--auth-timeout",
    String(ALBATROSS_AUTH_TIMEOUT_SECONDS),
    "--static-oauth-client-metadata",
    ALBATROSS_OAUTH_CLIENT_METADATA,
    "--silent",
  ];
}

/**
 * Albatross hard-times-out MCP initialize after 30 seconds, so the first
 * browser OAuth must finish before Albatross starts the stdio bridge.
 */
export function createAlbatrossAuthorizationCommand(
  mcpUrl: string,
  participantId: string = ALBATROSS_COMPATIBILITY_PROFILE.identity
    .defaultParticipantId,
): string {
  const url = normalizedOwdMcpUrl(mcpUrl);
  const header = participantHeader(participantId);
  return [
    "npx",
    "-y",
    "-p",
    `mcp-remote@${ALBATROSS_MCP_REMOTE_VERSION}`,
    "mcp-remote-client",
    shellSingleQuote(url),
    "--header",
    shellSingleQuote(header),
    "--transport",
    "http-only",
    "--auth-timeout",
    String(ALBATROSS_AUTH_TIMEOUT_SECONDS),
    "--static-oauth-client-metadata",
    shellSingleQuote(ALBATROSS_OAUTH_CLIENT_METADATA),
  ].join(" ");
}

/**
 * This is an additive agent.config.json fragment. Callers must merge its
 * `owd` entry and preserve every existing Albatross setting and MCP server.
 */
export function createAlbatrossMcpMergeConfig(
  mcpUrl: string,
  participantId: string = ALBATROSS_COMPATIBILITY_PROFILE.identity
    .defaultParticipantId,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        owd: {
          command: "npx",
          args: bridgeArgs(mcpUrl, participantId),
        },
      },
    },
    null,
    2,
  );
}

export const ALBATROSS_WORKSPACE_PROMPT = `<!-- owd:albatross-profile:v1:start -->
## OWD Project continuity in Albatross

- OWD is the \`owd\` MCP server. Its tools are named \`mcp__owd__<tool>\`.
- At the start of every fresh task and immediately after Albatross \`/reset\`, read \`.owdignore\`. When it exists, call \`mcp__owd__resume_project\` with its exact Project ID and complete context policy before any other OWD action or local vault write. Until it returns, the writer role is unconfirmed.
- When no receipt exists, call \`mcp__owd__connection_info\`, then \`mcp__owd__open_project\` with the visible Project name the owner supplied. Never guess among multiple Projects or create a duplicate to repair a connection.
- If \`open_project\` returns pending, show its one approval URL and call \`mcp__owd__wait_for_project_connection\` with the exact wait key and \`timeoutSeconds: 20\`. Albatross limits each MCP request to 30 seconds, so repeat only that same wait when approval is still pending. Do not reconnect OAuth or repeat setup.
- Albatross 2.0.3 reads MCP text content but ignores server initialize instructions, Resources, Prompts, and \`structuredContent\`. Treat the JSON text returned by OWD as authoritative and keep this managed prompt block installed.
- Albatross \`/reset\` and \`.albatross/continue.md\` preserve runtime continuity only. OWD \`.owdignore\`, Projects, Handoffs, Reviews, Decisions, and provenance are the portable cross-agent record.
- Treat every \`/path fork\` as an alternative Attempt or Artifact inside the same OWD Project, never as a duplicate Project or independent participant.
- Keep \`/auto\` inside the current OWD Work Packet, budget, and deadline. After its automatic \`/reset\`, resume OWD before continuing; stop if the packet or policy is stale.
- Treat \`/iterate\` candidates and critiques as internal Attempts. Submit meaningful alternatives and the selected cited result, not every private turn. Review mode is independent only with a different participant ID and OAuth authorization.
- Albatross approval confirms a local tool execution. It never replaces OWD OAuth, owner consent, vault boundaries, Project grants, or revocation.
- Reusing the configured participant header means this Albatross runtime is the same OWD participant. A genuinely independent writer or reviewer needs a different participant ID and its own OAuth authorization.
- Before any direct Obsidian, shell, skill, or filesystem write, obey the current \`localVaultAccess.role\` returned by OWD. Project submission tools do not grant local write authority.
<!-- owd:albatross-profile:v1:end -->`;

export function createAlbatrossSetupKit(
  mcpUrl: string,
  participantId: string = ALBATROSS_COMPATIBILITY_PROFILE.identity
    .defaultParticipantId,
): string {
  const participant = validatedParticipantId(participantId);
  return `OWD + Albatross setup

Participant: ${participant}

1. Before starting Albatross, run this once and finish OWD authorization in the browser:

${createAlbatrossAuthorizationCommand(mcpUrl, participant)}

2. Merge this \`owd\` entry into agent.config.json. Preserve every existing setting and MCP server:

${createAlbatrossMcpMergeConfig(mcpUrl, participant)}

3. Merge this marked block into .albatross/prompt.md. Preserve instructions outside the block:

${ALBATROSS_WORKSPACE_PROMPT}

4. Start Albatross, run \`/mcp trust owd\`, then say: \`Connect this project to OWD.\`

Use a different participant ID and repeat authorization only for a genuinely independent writer or reviewer. The participant header is not a credential; OWD OAuth and server-side grants remain authoritative.`;
}

export function serializeAlbatrossCompatibilityProfile(): string {
  return `${JSON.stringify(ALBATROSS_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const ALBATROSS_CONTINUITY_GUIDANCE = `### Albatross compatibility

- Use Albatross's \`mcp__owd__<tool>\` names. After \`/reset\`, read \`.owdignore\` and call \`mcp__owd__resume_project\` first; \`.albatross/continue.md\` is runtime continuity only.
- Call Project waits with \`timeoutSeconds: 20\`, below Albatross's 30-second MCP limit. Repeat only the same wait; never reconnect or reopen the Project.
- A \`/path fork\` is another Attempt in the same Project. Reusing \`X-OWD-Albatross-Participant\` is one OAuth participant; an independent reviewer uses another value and authorization. The header grants no authority.
- Before any direct vault write, obey \`localVaultAccess\`; a read-only collaborator proposes or hands off.`;

export const ALBATROSS_PROFILE_PROMPT = `Connect or resume this Albatross workspace with OWD through the configured \`owd\` MCP server.

1. Use \`mcp__owd__<tool>\` names. Read \`.owdignore\` first. If it exists, call \`mcp__owd__resume_project\` with its exact Project ID and complete policy before any other OWD action. Until it returns, the writer role is unconfirmed.
2. If no receipt exists, call \`mcp__owd__connection_info\`, then \`mcp__owd__open_project\` with the visible Project name the owner supplied.
3. If approval is pending, present the one returned URL and call \`mcp__owd__wait_for_project_connection\` with the exact key and \`timeoutSeconds: 20\`. Repeat only that same wait if necessary; never reconnect OAuth, repeat setup, or create a duplicate Project.
4. Persist the returned \`.owdignore\` receipt and marked OWD instruction blocks without replacing unrelated workspace instructions.
5. After Albatross \`/reset\`, resume the OWD receipt first. Treat \`.albatross/continue.md\` and \`/path fork\` as runtime-local continuation and alternative Attempts, while OWD remains the portable Project record.
6. Keep \`/auto\` bounded by the current OWD Work Packet, budget, and deadline. Treat \`/iterate\` candidates and critiques as internal Attempts; submit only meaningful alternatives and the selected cited result.
7. A separate independent writer or reviewer needs a distinct Albatross participant ID and OAuth authorization. Review mode, a renamed session, or a path using the same participant header remains the same OWD participant.
8. Before any direct local vault write, obey the current \`localVaultAccess.role\` returned by OWD.`;
