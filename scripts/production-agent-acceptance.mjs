import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  checkpointArguments,
  continuityPoint,
} from "./live-continuity-acceptance-lib.mjs";

const CURRENT_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const BOOTSTRAP_SCOPES = [
  "vault.read",
  "project.initialize.request",
  "project.connect.request",
];
const PROJECT_LIFECYCLE_TOOLS = [
  "open_project",
  "wait_for_project_connection",
  "resume_project",
];
const REQUIRED_TOOLS = [
  "connection_info",
  "checkpoint_project",
  "claim_project_lead",
  "get_vault_status",
  "list_recent_changes",
  "list_vaults",
  "open_project",
  "read_note",
  "resume_project",
  "search_notes",
  "wait_for_project_connection",
];
const FORBIDDEN_PROJECT_LIFECYCLE_TOOLS = [
  "get_project_access_status",
  "get_project_initialization_status",
  "list_projects",
  "request_project_access",
  "request_project_initialization",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const ROOT_MARKDOWN_PATTERN = /^[^/\\\p{Cc}\p{Cf}]+\.md$/iu;
const OAUTH_APPROVAL_TIMEOUT_MS = 600_000;
const PROJECT_APPROVAL_TIMEOUT_MS = 600_000;

function fail(message) {
  throw new Error(message);
}

function asRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} was not an object.`);
  }
  return value;
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    fail(`${label} failed with HTTP ${response.status}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned invalid JSON.`);
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("The loopback callback did not receive a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readInputLine(prompt) {
  return new Promise((resolve) => {
    if (prompt) process.stdout.write(prompt);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (value) => {
      process.stdin.pause();
      resolve(value.trim());
    });
  });
}

function documentationPlan(rootMarkdownInput) {
  const input = rootMarkdownInput.trim();
  if (input === "none") {
    return {
      decision: "no-root-markdown",
      proposedMoves: [],
      retainedRootPaths: [],
      rootMarkdownPaths: [],
    };
  }
  const rootMarkdownPaths = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const normalizedPaths = rootMarkdownPaths.map((value) =>
    value.toLocaleLowerCase("en-US"),
  );
  if (
    rootMarkdownPaths.length === 0 ||
    rootMarkdownPaths.length > 128 ||
    rootMarkdownPaths.some(
      (value) => value.length > 1_024 || !ROOT_MARKDOWN_PATTERN.test(value),
    ) ||
    new Set(normalizedPaths).size !== rootMarkdownPaths.length
  ) {
    fail(
      "Root Markdown inventory must be `none` or a unique comma-separated list of root-level .md filenames.",
    );
  }
  return {
    decision: "keep-current-locations",
    proposedMoves: [],
    retainedRootPaths: rootMarkdownPaths,
    rootMarkdownPaths,
  };
}

function toolContent(result, toolName) {
  const rpcResult = asRecord(result, `${toolName} result`);
  const structured = asRecord(
    rpcResult.structuredContent,
    `${toolName} structured content`,
  );
  if (rpcResult.isError === true || structured.ok !== true) {
    const error = asRecord(structured.error, `${toolName} error`);
    fail(
      `${toolName} failed with ${typeof error.code === "string" ? error.code : "unknown_error"}.`,
    );
  }
  return structured;
}

function resourceLinks(result, toolName) {
  const rpcResult = asRecord(result, `${toolName} result`);
  if (!Array.isArray(rpcResult.content)) {
    fail(`${toolName} did not return MCP content.`);
  }
  return rpcResult.content
    .map((item) => asRecord(item, `${toolName} content item`))
    .filter((item) => item.type === "resource_link");
}

function textEnvelope(result, toolName) {
  const rpcResult = asRecord(result, `${toolName} result`);
  if (!Array.isArray(rpcResult.content)) {
    fail(`${toolName} did not return MCP content.`);
  }
  const textItem = rpcResult.content
    .map((item) => asRecord(item, `${toolName} content item`))
    .find((item) => item.type === "text");
  if (typeof textItem?.text !== "string") {
    fail(`${toolName} did not return its structured contract as text.`);
  }
  try {
    return asRecord(JSON.parse(textItem.text), `${toolName} text envelope`);
  } catch {
    fail(`${toolName} returned a non-JSON text envelope.`);
  }
}

function exactProjectId(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} did not contain an exact Project UUID.`);
  }
  return value.toLocaleLowerCase("en-US");
}

function projectReadyContent(value, expectedProjectId, label) {
  if (value.state !== "ready") {
    fail(`${label} did not return the ready Project.`);
  }
  const project = asRecord(value.project, `${label} Project`);
  const projectId = exactProjectId(project.projectId, `${label} Project`);
  if (projectId !== expectedProjectId) {
    fail(`${label} returned a different Project.`);
  }
  const resume = asRecord(value.resume, `${label} resume`);
  const contextPolicy = asRecord(
    resume.contextPolicy,
    `${label} context policy`,
  );
  const packet = asRecord(resume.packet, `${label} Work Packet`);
  if (
    exactProjectId(packet.projectId, `${label} Work Packet`) !==
    expectedProjectId
  ) {
    fail(`${label} returned context for a different Project.`);
  }
  return { contextPolicy, packet, project, resume };
}

async function main() {
  const [
    originInput,
    expectedVaultName,
    searchQuery,
    exactProjectIdInput,
    rootMarkdownArgument,
  ] = process.argv.slice(2);
  const usage =
    "Usage: node scripts/production-agent-acceptance.mjs https://deployment.example/ disposable-test-vault known-search-term exact-existing-project-id [none|README.md,AGENTS.md]";
  if (
    !originInput ||
    !expectedVaultName ||
    expectedVaultName.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(expectedVaultName) ||
    !searchQuery ||
    searchQuery.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(searchQuery) ||
    !exactProjectIdInput ||
    !UUID_PATTERN.test(exactProjectIdInput)
  ) {
    fail(usage);
  }
  let origin;
  try {
    origin = new URL(originInput);
  } catch {
    fail(usage);
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    fail(usage);
  }
  origin.search = "";
  origin.hash = "";
  const projectId = exactProjectIdInput.toLocaleLowerCase("en-US");
  let rootMarkdownInput = rootMarkdownArgument;
  if (!rootMarkdownInput) {
    if (process.stdin.isTTY !== true) {
      fail(`${usage}\nProvide the factual root Markdown inventory explicitly.`);
    }
    rootMarkdownInput = await readInputLine(
      "Root-level Markdown in the disposable Project (`none` or comma-separated filenames): ",
    );
  }
  const projectDocumentationPlan = documentationPlan(rootMarkdownInput);

  const state = randomUUID();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash("sha256").update(verifier, "utf8").digest(),
  );
  let callbackResolve;
  let callbackReject;
  const callbackPromise = new Promise((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    });
    response.end(
      "<!doctype html><meta charset=utf-8><title>OWD authorized</title><style>body{font-family:system-ui;max-width:42rem;margin:5rem auto;padding:0 1rem}</style><h1>OWD authorization received</h1><p>Return to Codex while the acceptance client finishes its checks.</p>",
    );
    if (requestUrl.searchParams.get("state") !== state) {
      callbackReject(new Error("OAuth state validation failed."));
      return;
    }
    const error = requestUrl.searchParams.get("error");
    if (error !== null) {
      callbackReject(new Error(`OAuth authorization returned ${error}.`));
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      callbackReject(new Error("OAuth callback did not include a code."));
      return;
    }
    callbackResolve(code);
  });

  const port = await listen(server);
  server.unref();
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const registrationResponse = await fetch(new URL("/register", origin), {
    body: JSON.stringify({
      client_name: "OWD loopback production acceptance",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const registration = asRecord(
    await readJson(registrationResponse, "OAuth client registration"),
    "OAuth client registration",
  );
  if (typeof registration.client_id !== "string") {
    fail("OAuth client registration did not return a client ID.");
  }

  const authorizationUrl = new URL("/authorize", origin);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", registration.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", BOOTSTRAP_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", new URL("/mcp", origin).href);
  console.log(`OWD_ACCEPTANCE_AUTHORIZATION_URL=${authorizationUrl.href}`);

  const timeout = setTimeout(
    () => callbackReject(new Error("OAuth authorization timed out.")),
    OAUTH_APPROVAL_TIMEOUT_MS,
  );
  let code;
  try {
    code = await callbackPromise;
  } finally {
    clearTimeout(timeout);
    await close(server);
  }

  const tokenResponse = await fetch(new URL("/token", origin), {
    body: new URLSearchParams({
      client_id: registration.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      resource: new URL("/mcp", origin).href,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const token = asRecord(
    await readJson(tokenResponse, "OAuth token exchange"),
    "OAuth token exchange",
  );
  if (typeof token.access_token !== "string") {
    fail("OAuth token exchange did not return an access token.");
  }

  let requestId = 0;
  const timings = {};
  async function rpc(method, params, options = {}) {
    requestId += 1;
    const startedAt = performance.now();
    const response = await fetch(new URL("/mcp", origin), {
      body: JSON.stringify({ id: requestId, jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": LEGACY_PROTOCOL_VERSION,
      },
      method: "POST",
    });
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (options.allowDenied === true && !response.ok) {
      return { denied: true, durationMs, status: response.status };
    }
    const message = asRecord(
      await readJson(response, `MCP ${method}`),
      `MCP ${method}`,
    );
    if (message.error !== undefined) {
      fail(`MCP ${method} returned a JSON-RPC error.`);
    }
    const timingKey =
      method === "tools/call" && typeof params.name === "string"
        ? `${method}:${params.name}`
        : method;
    timings[timingKey] = durationMs;
    return { denied: false, durationMs, result: message.result };
  }

  async function notify(method, params) {
    const response = await fetch(new URL("/mcp", origin), {
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": LEGACY_PROTOCOL_VERSION,
      },
      method: "POST",
    });
    if (!response.ok) {
      fail(`MCP ${method} failed with HTTP ${response.status}.`);
    }
    await response.body?.cancel();
  }

  async function currentRpc(method, params, name) {
    requestId += 1;
    const startedAt = performance.now();
    const response = await fetch(new URL("/mcp", origin), {
      body: JSON.stringify({
        id: requestId,
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "OWD production acceptance",
              version: "0.2.0",
            },
            "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL_VERSION,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": CURRENT_PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(name === undefined ? {} : { "Mcp-Name": name }),
      },
      method: "POST",
    });
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const message = asRecord(
      await readJson(response, `current MCP ${method}`),
      `current MCP ${method}`,
    );
    if (message.error !== undefined) {
      fail(`Current MCP ${method} returned a JSON-RPC error.`);
    }
    const timingKey =
      method === "tools/call" && typeof params.name === "string"
        ? `current:${method}:${params.name}`
        : `current:${method}`;
    timings[timingKey] = durationMs;
    return message.result;
  }

  const discovery = asRecord(
    await currentRpc("server/discover", {}),
    "server/discover result",
  );
  if (
    !Array.isArray(discovery.supportedVersions) ||
    !discovery.supportedVersions.includes(CURRENT_PROTOCOL_VERSION)
  ) {
    fail("The server did not advertise the current MCP protocol version.");
  }
  for (const method of ["tools/list", "resources/list", "prompts/list"]) {
    const result = asRecord(
      await currentRpc(method, {}),
      `current ${method} result`,
    );
    const collection =
      method === "tools/list"
        ? result.tools
        : method === "resources/list"
          ? result.resources
          : result.prompts;
    if (!Array.isArray(collection) || collection.length === 0) {
      fail(`Current ${method} did not return its MCP collection.`);
    }
  }
  toolContent(
    await currentRpc(
      "tools/call",
      { arguments: {}, name: "connection_info" },
      "connection_info",
    ),
    "current connection_info",
  );

  const initialized = await rpc("initialize", {
    capabilities: {},
    clientInfo: { name: "OWD production acceptance", version: "0.1.0" },
    protocolVersion: LEGACY_PROTOCOL_VERSION,
  });
  const initializeResult = asRecord(initialized.result, "initialize result");
  if (initializeResult.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
    fail("The server did not negotiate the expected MCP protocol version.");
  }
  await notify("notifications/initialized", {});

  const toolList = await rpc("tools/list", {});
  const toolListResult = asRecord(toolList.result, "tools/list result");
  if (!Array.isArray(toolListResult.tools)) {
    fail("tools/list did not return a tool array.");
  }
  const toolNames = toolListResult.tools
    .map((tool) => asRecord(tool, "tool").name)
    .sort();
  const missingTools = REQUIRED_TOOLS.filter(
    (toolName) => !toolNames.includes(toolName),
  );
  const exposedLegacyTools = FORBIDDEN_PROJECT_LIFECYCLE_TOOLS.filter(
    (toolName) => toolNames.includes(toolName),
  );
  if (missingTools.length > 0 || exposedLegacyTools.length > 0) {
    fail(
      `tools/list failed the production Project workflow contract (missing: ${missingTools.join(", ") || "none"}; legacy: ${exposedLegacyTools.join(", ") || "none"}).`,
    );
  }

  const connection = toolContent(
    (
      await rpc("tools/call", {
        arguments: {},
        name: "connection_info",
      })
    ).result,
    "connection_info",
  );
  if (
    connection.readOnly !== true ||
    connection.vaultName !== expectedVaultName
  ) {
    fail(
      "The acceptance connection was not bound to the disposable read-only vault.",
    );
  }
  const authorizationId = exactProjectId(
    connection.authorizationId,
    "connection_info authorization",
  );
  if (
    !Array.isArray(connection.scopes) ||
    BOOTSTRAP_SCOPES.some((scope) => !connection.scopes.includes(scope))
  ) {
    fail(
      "The initial OAuth token did not include every bootstrap Project scope; a second OAuth ceremony would be required.",
    );
  }
  const projectLifecycle = asRecord(
    connection.projectLifecycle,
    "connection_info Project lifecycle",
  );
  if (
    projectLifecycle.entryTool !== "open_project" ||
    projectLifecycle.waitTool !== "wait_for_project_connection" ||
    projectLifecycle.resumeTool !== "resume_project" ||
    !Array.isArray(projectLifecycle.liveTools) ||
    PROJECT_LIFECYCLE_TOOLS.some(
      (toolName) => !projectLifecycle.liveTools.includes(toolName),
    )
  ) {
    fail("connection_info did not identify the exact live Project lifecycle.");
  }

  const vaults = toolContent(
    (
      await rpc("tools/call", {
        arguments: {},
        name: "list_vaults",
      })
    ).result,
    "list_vaults",
  );
  if (!Array.isArray(vaults.vaults) || vaults.vaults.length !== 1) {
    fail("list_vaults did not return exactly one granted vault.");
  }
  const vault = asRecord(vaults.vaults[0], "granted vault");
  if (typeof vault.id !== "string") {
    fail("The granted vault did not include an ID.");
  }

  const status = toolContent(
    (
      await rpc("tools/call", {
        arguments: { vaultId: vault.id },
        name: "get_vault_status",
      })
    ).result,
    "get_vault_status",
  );
  const generation = asRecord(status.generation, "vault generation");
  if (typeof generation.generationId !== "string") {
    fail("get_vault_status did not return generation provenance.");
  }

  const search = toolContent(
    (
      await rpc("tools/call", {
        arguments: { limit: 5, query: searchQuery, vaultId: vault.id },
        name: "search_notes",
      })
    ).result,
    "search_notes",
  );
  if (!Array.isArray(search.results) || search.results.length === 0) {
    fail("search_notes did not find the disposable acceptance note.");
  }
  const searchResult = asRecord(search.results[0], "search result");
  if (typeof searchResult.path !== "string") {
    fail("search_notes did not return a note path.");
  }

  const note = toolContent(
    (
      await rpc("tools/call", {
        arguments: { path: searchResult.path, vaultId: vault.id },
        name: "read_note",
      })
    ).result,
    "read_note",
  );
  if (
    typeof note.content !== "string" ||
    typeof note.contentSha256 !== "string" ||
    asRecord(note.provenance, "note provenance").generationId !==
      generation.generationId
  ) {
    fail(
      "read_note did not return bounded content with current-generation provenance.",
    );
  }

  const recent = toolContent(
    (
      await rpc("tools/call", {
        arguments: { limit: 5, vaultId: vault.id },
        name: "list_recent_changes",
      })
    ).result,
    "list_recent_changes",
  );
  if (!Array.isArray(recent.notes) || recent.notes.length === 0) {
    fail("list_recent_changes did not return the disposable snapshot notes.");
  }

  const openArguments = {
    documentationPlan: projectDocumentationPlan,
    projectId,
  };
  const firstOpenCall = await rpc("tools/call", {
    arguments: openArguments,
    name: "open_project",
  });
  const firstOpen = toolContent(firstOpenCall.result, "open_project");
  const firstOpenProject = asRecord(firstOpen.project, "open_project Project");
  if (
    firstOpen.state !== "owner_approval_required" ||
    exactProjectId(firstOpenProject.projectId, "open_project Project") !==
      projectId ||
    typeof firstOpen.accessKey !== "string" ||
    !OPAQUE_KEY_PATTERN.test(firstOpen.accessKey) ||
    firstOpen.initializationKey !== undefined
  ) {
    fail(
      "open_project did not request one exact existing-Project approval on the bootstrap connection.",
    );
  }
  const firstAccess = asRecord(firstOpen.access, "open_project access");
  if (
    (firstAccess.status !== "pending" && firstAccess.status !== "approving") ||
    typeof firstAccess.approvalUrl !== "string"
  ) {
    fail("open_project did not return a pending owner approval.");
  }
  const firstOpenText = textEnvelope(firstOpenCall.result, "open_project");
  const firstWait = asRecord(firstOpen.wait, "open_project wait contract");
  const firstRecovery = asRecord(
    firstOpen.recovery,
    "open_project recovery contract",
  );
  if (
    JSON.stringify(firstOpenText) !== JSON.stringify(firstOpen) ||
    firstOpen.approvalUrl !== firstAccess.approvalUrl ||
    firstOpen.requestId !== firstAccess.accessRequestId ||
    firstOpen.projectLabel !== firstOpenProject.label ||
    firstOpen.vaultName !== expectedVaultName ||
    firstWait.tool !== "wait_for_project_connection" ||
    firstWait.accessKey !== firstOpen.accessKey ||
    firstRecovery.tool !== "open_project" ||
    firstRecovery.rule !== "repeat-exact-open-project-arguments" ||
    firstRecovery.idempotent !== true
  ) {
    fail(
      "open_project did not mirror a key-complete Project, vault, approval, and wait contract for text-only clients.",
    );
  }
  const firstLinks = resourceLinks(firstOpenCall.result, "open_project");
  if (firstLinks.length !== 1 || typeof firstLinks[0]?.uri !== "string") {
    fail("open_project did not return exactly one owner approval link.");
  }
  const approvalUrl = new URL(firstLinks[0].uri);
  if (
    approvalUrl.origin !== origin.origin ||
    approvalUrl.pathname !== "/connect" ||
    typeof firstAccess.accessRequestId !== "string" ||
    approvalUrl.searchParams.get("requestId") !== firstAccess.accessRequestId ||
    approvalUrl.href !== firstAccess.approvalUrl
  ) {
    fail("open_project returned an unexpected owner approval boundary.");
  }

  const repeatedOpenCall = await rpc("tools/call", {
    arguments: openArguments,
    name: "open_project",
  });
  const repeatedOpen = toolContent(
    repeatedOpenCall.result,
    "repeated open_project",
  );
  const repeatedLinks = resourceLinks(
    repeatedOpenCall.result,
    "repeated open_project",
  );
  if (
    repeatedOpen.state !== "owner_approval_required" ||
    repeatedOpen.accessKey !== firstOpen.accessKey ||
    repeatedOpen.initializationKey !== undefined ||
    repeatedLinks.length !== 1 ||
    repeatedLinks[0]?.uri !== approvalUrl.href ||
    JSON.stringify(
      textEnvelope(repeatedOpenCall.result, "repeated open_project"),
    ) !== JSON.stringify(repeatedOpen)
  ) {
    fail(
      "Repeating open_project created or exposed a different Project approval instead of recovering the existing request.",
    );
  }

  console.log(`OWD_ACCEPTANCE_PROJECT_APPROVAL_URL=${approvalUrl.href}`);
  console.log("OWD_ACCEPTANCE_PROJECT_APPROVAL_REQUIRED=1");
  const approvalDeadline = Date.now() + PROJECT_APPROVAL_TIMEOUT_MS;
  let ready = null;
  let readyCall = null;
  do {
    const remainingSeconds = Math.max(
      1,
      Math.min(30, Math.ceil((approvalDeadline - Date.now()) / 1_000)),
    );
    readyCall = await rpc("tools/call", {
      arguments: {
        accessKey: firstOpen.accessKey,
        timeoutSeconds: remainingSeconds,
      },
      name: "wait_for_project_connection",
    });
    const waited = toolContent(readyCall.result, "wait_for_project_connection");
    if (resourceLinks(readyCall.result, "wait_for_project_connection").length) {
      fail(
        "wait_for_project_connection returned another owner link instead of continuing the existing request.",
      );
    }
    if (waited.state === "ready") {
      ready = waited;
      break;
    }
    if (
      waited.state !== "owner_approval_pending" ||
      waited.accessKey !== firstOpen.accessKey
    ) {
      fail(
        "wait_for_project_connection did not preserve the exact pending Project request.",
      );
    }
  } while (Date.now() < approvalDeadline);
  if (ready === null || readyCall === null) {
    fail("Project owner approval timed out.");
  }
  const readyProject = projectReadyContent(
    ready,
    projectId,
    "wait_for_project_connection",
  );

  const reopenedCall = await rpc("tools/call", {
    arguments: { projectId },
    name: "open_project",
  });
  const reopened = toolContent(reopenedCall.result, "rejoined open_project");
  if (
    resourceLinks(reopenedCall.result, "rejoined open_project").length !== 0 ||
    reopened.accessKey !== undefined ||
    reopened.initializationKey !== undefined
  ) {
    fail(
      "Rejoining the approved Project reopened owner approval instead of restoring it.",
    );
  }
  projectReadyContent(reopened, projectId, "rejoined open_project");

  async function resumeExactProject(contextPolicy, label) {
    const resumedCall = await rpc("tools/call", {
      arguments: { contextPolicy, projectId },
      name: "resume_project",
    });
    const resumed = toolContent(resumedCall.result, label);
    if (resourceLinks(resumedCall.result, label).length !== 0) {
      fail(`${label} returned an owner or OAuth link.`);
    }
    const resume = asRecord(resumed.resume, `${label} resume`);
    const packet = asRecord(resume.packet, `${label} Work Packet`);
    if (
      exactProjectId(packet.projectId, `${label} Work Packet`) !== projectId
    ) {
      fail(`${label} resumed a different Project.`);
    }
    return {
      contextPolicy: asRecord(resume.contextPolicy, `${label} context policy`),
      latestContinuityPoint: resume.latestContinuityPoint,
      packet,
    };
  }

  const firstResume = await resumeExactProject(
    readyProject.contextPolicy,
    "resume_project",
  );
  const repeatedResume = await resumeExactProject(
    firstResume.contextPolicy,
    "repeated resume_project",
  );
  if (
    typeof firstResume.packet.packetId !== "string" ||
    firstResume.packet.packetId !== repeatedResume.packet.packetId
  ) {
    fail(
      "Repeated resume_project did not converge on one current Work Packet.",
    );
  }

  const claimedLead = toolContent(
    (
      await rpc("tools/call", {
        arguments: {
          idempotencyKey: `md6-replacement-claim-${randomUUID()}`,
          leadIdentity: {
            claimedHarness: {
              assertedBy: "client",
              name: "MDevolved MD6 production acceptance",
              verification: "claimed",
              version: "0.1.0",
            },
            claimedModel: null,
            displayName: "MD6 independent replacement",
          },
          leaseExpiresInSeconds: 180,
          projectId,
        },
        name: "claim_project_lead",
      })
    ).result,
    "claim_project_lead",
  );
  const leadLease = asRecord(claimedLead.lease, "claim_project_lead lease");
  const previousContinuityPointId =
    firstResume.latestContinuityPoint === null ||
    firstResume.latestContinuityPoint === undefined
      ? null
      : continuityPoint(firstResume.latestContinuityPoint, { projectId })
          .continuityPointId;
  const checkpointed = toolContent(
    (
      await rpc("tools/call", {
        arguments: checkpointArguments({
          leaseInput: leadLease,
          packetInput: repeatedResume.packet,
          phase: "replacement",
          previousContinuityPointId,
          projectId,
        }),
        name: "checkpoint_project",
      })
    ).result,
    "checkpoint_project",
  );
  const successorPoint = continuityPoint(checkpointed.continuityPoint, {
    projectId,
  });
  const afterCheckpoint = await resumeExactProject(
    repeatedResume.contextPolicy,
    "post-checkpoint resume_project",
  );
  const resumedPoint = continuityPoint(afterCheckpoint.latestContinuityPoint, {
    continuityPointId: successorPoint.continuityPointId,
    projectId,
  });
  if (resumedPoint.continuityPointId !== successorPoint.continuityPointId) {
    fail(
      "The replacement client did not resume its exact successor checkpoint.",
    );
  }

  console.log(
    JSON.stringify({
      event: "owd.agent_acceptance.ready_for_revocation",
      generation: generation.generationId.slice(0, 8),
      oauthTokenExchangeCount: 1,
      replacementCheckpointVerified: true,
      protocols: [CURRENT_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
      projectId,
      projectState: "ready",
      readOnly: true,
      searchResultCount: search.results.length,
      toolCount: toolNames.length,
      timingsMs: timings,
      vaultCount: vaults.vaults.length,
    }),
  );
  console.log(`OWD_ACCEPTANCE_AUTHORIZATION_ID=${authorizationId}`);
  console.log("OWD_ACCEPTANCE_REVOKE_NOW=1");
  await readInputLine(
    "Revoke the acceptance agent connection in OWD, then press Enter: ",
  );

  const afterRevocation = await rpc(
    "tools/call",
    { arguments: {}, name: "list_vaults" },
    { allowDenied: true },
  );
  let revoked = afterRevocation.denied;
  if (!revoked) {
    const rpcResult = asRecord(afterRevocation.result, "revocation result");
    const structured = asRecord(
      rpcResult.structuredContent,
      "revocation structured content",
    );
    if (rpcResult.isError === true) {
      const error = asRecord(structured.error, "revocation error");
      revoked = error.code === "agent_grant_revoked";
    }
  }
  if (!revoked) {
    fail("The access token still reached a granted tool after revocation.");
  }

  const projectAfterRevocation = await rpc(
    "tools/call",
    {
      arguments: {
        contextPolicy: repeatedResume.contextPolicy,
        projectId,
      },
      name: "resume_project",
    },
    { allowDenied: true },
  );
  let projectRevoked = projectAfterRevocation.denied;
  if (!projectRevoked) {
    const rpcResult = asRecord(
      projectAfterRevocation.result,
      "Project revocation result",
    );
    const structured = asRecord(
      rpcResult.structuredContent,
      "Project revocation structured content",
    );
    if (rpcResult.isError === true) {
      const error = asRecord(structured.error, "Project revocation error");
      projectRevoked = error.code === "agent_grant_revoked";
    }
  }
  if (!projectRevoked) {
    fail(
      "The same bootstrap token still resumed its dependent Project after source-connection revocation.",
    );
  }
  console.log(
    JSON.stringify({
      deniedStatus: afterRevocation.denied ? afterRevocation.status : 200,
      event: "owd.agent_acceptance.complete",
      projectRevocationEffectiveNextCall: true,
      revocationEffectiveNextCall: true,
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "owd.agent_acceptance.failed",
      message: error instanceof Error ? error.message : "Unknown failure.",
    }),
  );
  process.exitCode = 1;
});
