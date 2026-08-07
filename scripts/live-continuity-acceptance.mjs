import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  CONTINUITY_RESOURCE_URI,
  CONTINUITY_TOOLS,
  PROJECT_LEAD_LEASE_SECONDS,
  SUBSTITUTION_BUDGET_MS,
  asRecord,
  checkpointArguments,
  continuityPoint,
  distinctCellOrigin,
  documentationPlan,
  exactHttpsOrigin,
  exactUuid,
  fail,
  freshCellAttestation,
  redactedReceipt,
  sameContinuityPoint,
} from "./live-continuity-acceptance-lib.mjs";

const PROTOCOL_VERSION = "2025-11-25";
const BOOTSTRAP_SCOPES = [
  "vault.read",
  "project.initialize.request",
  "project.connect.request",
];
const REQUIRED_TOOLS = [
  "connection_info",
  "open_project",
  "wait_for_project_connection",
  ...CONTINUITY_TOOLS,
];
const AUTHORIZATION_TIMEOUT_MS = 180_000;
const PROJECT_APPROVAL_TIMEOUT_MS = 180_000;
const OPAQUE_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
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

function resourceText(result, label) {
  const rpcResult = asRecord(result, `${label} result`);
  if (!Array.isArray(rpcResult.contents) || rpcResult.contents.length !== 1) {
    fail(`${label} did not return exactly one resource.`);
  }
  const content = asRecord(rpcResult.contents[0], `${label} content`);
  if (typeof content.text !== "string") {
    fail(`${label} did not return text content.`);
  }
  try {
    return asRecord(JSON.parse(content.text), `${label} profile`);
  } catch {
    fail(`${label} did not return JSON content.`);
  }
}

async function authorize(origin, clientName, authorizationLabel) {
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
      "<!doctype html><meta charset=utf-8><title>OWD authorized</title><style>body{font-family:system-ui;max-width:42rem;margin:5rem auto;padding:0 1rem}</style><h1>OWD authorization received</h1><p>Return to the continuity drill.</p>",
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
      client_name: clientName,
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
  console.log(`${authorizationLabel}=${authorizationUrl.href}`);

  const timeout = setTimeout(
    () => callbackReject(new Error("OAuth authorization timed out.")),
    AUTHORIZATION_TIMEOUT_MS,
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
  return token.access_token;
}

function mcpClient(origin, accessToken, clientName) {
  let requestId = 0;
  async function rpc(method, params, options = {}) {
    requestId += 1;
    const response = await fetch(new URL("/mcp", origin), {
      body: JSON.stringify({ id: requestId, jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      method: "POST",
    });
    if (options.allowDenied === true && !response.ok) {
      await response.body?.cancel();
      return { denied: true, status: response.status };
    }
    const message = asRecord(
      await readJson(response, `MCP ${method}`),
      `MCP ${method}`,
    );
    if (message.error !== undefined) {
      fail(`MCP ${method} returned a JSON-RPC error.`);
    }
    return { denied: false, result: message.result };
  }

  async function notify(method, params) {
    const response = await fetch(new URL("/mcp", origin), {
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      method: "POST",
    });
    if (!response.ok) {
      fail(`MCP ${method} failed with HTTP ${response.status}.`);
    }
    await response.body?.cancel();
  }

  async function initialize() {
    const initialized = await rpc("initialize", {
      capabilities: {},
      clientInfo: { name: clientName, version: "0.1.0" },
      protocolVersion: PROTOCOL_VERSION,
    });
    const result = asRecord(initialized.result, "initialize result");
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      fail("The server did not negotiate the expected MCP protocol version.");
    }
    await notify("notifications/initialized", {});
  }

  async function callTool(name, args) {
    const response = await rpc("tools/call", { arguments: args, name });
    return toolContent(response.result, name);
  }

  return { callTool, initialize, origin, rpc };
}

async function verifyClientContract(client, expectedVaultName) {
  await client.initialize();
  const listed = await client.rpc("tools/list", {});
  const toolList = asRecord(listed.result, "tools/list result");
  if (!Array.isArray(toolList.tools))
    fail("tools/list returned no tool array.");
  const toolNames = new Set(
    toolList.tools.map((tool) => asRecord(tool, "tool").name),
  );
  const missing = REQUIRED_TOOLS.filter((toolName) => !toolNames.has(toolName));
  if (missing.length > 0) {
    fail(`Continuity tools were missing: ${missing.join(", ")}.`);
  }

  const resource = await client.rpc("resources/read", {
    uri: CONTINUITY_RESOURCE_URI,
  });
  const profile = resourceText(resource.result, "lead continuity resource");
  if (
    profile.format !== "owd-lead-continuity-capabilities-v1" ||
    profile.requiredScope !== "project.lead" ||
    profile.schemaVersion !== 1 ||
    !Array.isArray(profile.mcpTools) ||
    CONTINUITY_TOOLS.some((toolName) => !profile.mcpTools.includes(toolName))
  ) {
    fail("The lead continuity capability profile was incompatible.");
  }

  const connection = await client.callTool("connection_info", {});
  if (
    connection.readOnly !== true ||
    connection.vaultName !== expectedVaultName ||
    !Array.isArray(connection.scopes) ||
    BOOTSTRAP_SCOPES.some((scope) => !connection.scopes.includes(scope))
  ) {
    fail("The client was not bound to the expected disposable vault.");
  }
}

function readyProject(value, expectedProjectId, label) {
  if (value.state !== "ready") fail(`${label} did not return a ready Project.`);
  const project = asRecord(value.project, `${label} Project`);
  if (
    exactUuid(project.projectId, `${label} Project ID`) !== expectedProjectId
  ) {
    fail(`${label} returned a different Project.`);
  }
  const resume = asRecord(value.resume, `${label} resume`);
  return {
    contextPolicy: asRecord(resume.contextPolicy, `${label} context policy`),
    packet: asRecord(resume.packet, `${label} Work Packet`),
  };
}

async function openExactProject(
  client,
  projectId,
  projectDocumentationPlan,
  approvalLabel,
) {
  const opened = await client.callTool("open_project", {
    documentationPlan: projectDocumentationPlan,
    projectId,
  });
  if (opened.state === "ready") {
    return readyProject(opened, projectId, "open_project");
  }
  const access = asRecord(opened.access, "open_project access");
  if (
    opened.state !== "owner_approval_required" ||
    typeof opened.accessKey !== "string" ||
    !OPAQUE_KEY_PATTERN.test(opened.accessKey) ||
    typeof access.approvalUrl !== "string"
  ) {
    fail("open_project did not return a bounded owner approval request.");
  }
  const approvalUrl = new URL(access.approvalUrl);
  if (
    approvalUrl.origin !== client.origin.origin ||
    approvalUrl.pathname !== "/connect"
  ) {
    fail("open_project returned an unexpected owner approval boundary.");
  }
  console.log(`${approvalLabel}=${approvalUrl.href}`);
  const deadline = Date.now() + PROJECT_APPROVAL_TIMEOUT_MS;
  do {
    const remainingSeconds = Math.max(
      1,
      Math.min(30, Math.ceil((deadline - Date.now()) / 1_000)),
    );
    const waited = await client.callTool("wait_for_project_connection", {
      accessKey: opened.accessKey,
      timeoutSeconds: remainingSeconds,
    });
    if (waited.state === "ready") {
      return readyProject(waited, projectId, "wait_for_project_connection");
    }
    if (
      waited.state !== "owner_approval_pending" ||
      waited.accessKey !== opened.accessKey
    ) {
      fail("Project approval did not preserve the exact pending request.");
    }
  } while (Date.now() < deadline);
  fail("Project owner approval timed out.");
}

async function resumeExactProject(client, projectId, contextPolicy, label) {
  const resumed = await client.callTool("resume_project", {
    contextPolicy,
    projectId,
  });
  const resume = asRecord(resumed.resume, `${label} resume`);
  const packet = asRecord(resume.packet, `${label} Work Packet`);
  if (
    exactUuid(packet.projectId, `${label} Work Packet Project`) !== projectId
  ) {
    fail(`${label} resumed a different Project.`);
  }
  return {
    contextPolicy: asRecord(resume.contextPolicy, `${label} context policy`),
    latestContinuityPoint: resume.latestContinuityPoint,
    packet,
  };
}

async function claimLead(client, projectId, displayName) {
  const claimed = await client.callTool("claim_project_lead", {
    idempotencyKey: `continuity-claim-${randomUUID()}`,
    leadIdentity: {
      claimedHarness: {
        assertedBy: "client",
        name: "OWD live continuity acceptance",
        verification: "claimed",
        version: "0.1.0",
      },
      claimedModel: null,
      displayName,
    },
    leaseExpiresInSeconds: PROJECT_LEAD_LEASE_SECONDS,
    projectId,
  });
  return asRecord(claimed.lease, "claimed lead lease");
}

async function renewLead(client, lease, projectId) {
  const renewed = await client.callTool("renew_project_lead", {
    fencingToken: lease.fencingToken,
    leaseExpiresInSeconds: PROJECT_LEAD_LEASE_SECONDS,
    leaseId: lease.leaseId,
    projectId,
  });
  const renewedLease = asRecord(renewed.lease, "renewed lead lease");
  if (
    renewedLease.leaseId !== lease.leaseId ||
    renewedLease.fencingToken !== lease.fencingToken ||
    renewedLease.expiresAt < lease.expiresAt
  ) {
    fail("Lead renewal changed the lease identity or shortened its lifetime.");
  }
  return renewedLease;
}

async function checkpointLead(client, input) {
  const checkpointed = await client.callTool(
    "checkpoint_project",
    checkpointArguments(input),
  );
  return continuityPoint(checkpointed.continuityPoint, {
    projectId: input.projectId,
  });
}

async function verifyRevoked(client, label) {
  const result = await client.rpc(
    "tools/call",
    { arguments: {}, name: "list_vaults" },
    { allowDenied: true },
  );
  if (result.denied) return true;
  const rpcResult = asRecord(result.result, `${label} revocation result`);
  const structured = asRecord(
    rpcResult.structuredContent,
    `${label} revocation content`,
  );
  const error = asRecord(structured.error, `${label} revocation error`);
  if (rpcResult.isError !== true || error.code !== "agent_grant_revoked") {
    fail(`${label} still reached a granted tool after revocation.`);
  }
  return true;
}

async function replacementAssessment(point) {
  const objective = asRecord(point.objective, "Continuity Point objective");
  const fieldsPresent =
    typeof objective.project === "string" &&
    objective.project.length > 0 &&
    typeof objective.workItem === "object" &&
    objective.workItem !== null &&
    Array.isArray(point.completedWork) &&
    Array.isArray(point.openWork) &&
    Array.isArray(point.blockers) &&
    Array.isArray(point.knownRejectedApproaches) &&
    Array.isArray(point.risks) &&
    typeof point.nextAction === "string" &&
    point.nextAction.length > 0;
  if (!fieldsPresent) {
    fail("The replacement did not receive the complete operational state.");
  }
  console.log(
    JSON.stringify({
      event: "owd.continuity_r1.operator_assessment_required",
      identifiersRetained: false,
      operationalStatePresent: true,
    }),
  );
  const answer = await readInputLine(
    "Confirm the replacement was materially better prepared than Git plus a runtime backup alone (`yes`): ",
  );
  if (answer !== "yes")
    fail("The operator did not accept the product comparison.");
}

async function runSourceDrill(origin, expectedVaultName, projectId, plan) {
  const sourceToken = await authorize(
    origin,
    "OWD continuity source lead",
    "OWD_CONTINUITY_SOURCE_AUTHORIZATION_URL",
  );
  const source = mcpClient(origin, sourceToken, "OWD continuity source lead");
  await verifyClientContract(source, expectedVaultName);
  const sourceReady = await openExactProject(
    source,
    projectId,
    plan,
    "OWD_CONTINUITY_SOURCE_PROJECT_APPROVAL_URL",
  );
  const sourceResume = await resumeExactProject(
    source,
    projectId,
    sourceReady.contextPolicy,
    "source resume",
  );
  const sourceClaim = await claimLead(
    source,
    projectId,
    "Synthetic source lead",
  );
  const sourceLease = await renewLead(source, sourceClaim, projectId);
  const sourcePoint = await checkpointLead(source, {
    leaseInput: sourceLease,
    packetInput: sourceResume.packet,
    phase: "source",
    previousContinuityPointId:
      sourceResume.latestContinuityPoint === null
        ? null
        : continuityPoint(sourceResume.latestContinuityPoint, { projectId })
            .continuityPointId,
    projectId,
  });
  const sourceAfterCheckpoint = await resumeExactProject(
    source,
    projectId,
    sourceResume.contextPolicy,
    "source checkpoint resume",
  );
  sameContinuityPoint(
    sourceAfterCheckpoint.latestContinuityPoint,
    sourcePoint,
    projectId,
  );

  console.log("OWD_CONTINUITY_REMOVE_SOURCE_NOW=1");
  await readInputLine(
    "Remove the source client/session in OWD, then press Enter: ",
  );
  const substitutionStartedAt = performance.now();
  const sourceRevoked = await verifyRevoked(source, "source client");

  const replacementToken = await authorize(
    origin,
    "OWD continuity replacement lead",
    "OWD_CONTINUITY_REPLACEMENT_AUTHORIZATION_URL",
  );
  const replacement = mcpClient(
    origin,
    replacementToken,
    "OWD continuity replacement lead",
  );
  await verifyClientContract(replacement, expectedVaultName);
  const replacementReady = await openExactProject(
    replacement,
    projectId,
    plan,
    "OWD_CONTINUITY_REPLACEMENT_PROJECT_APPROVAL_URL",
  );
  const replacementResume = await resumeExactProject(
    replacement,
    projectId,
    replacementReady.contextPolicy,
    "replacement resume",
  );
  const resumedSourcePoint = sameContinuityPoint(
    replacementResume.latestContinuityPoint,
    sourcePoint,
    projectId,
  );
  await replacementAssessment(resumedSourcePoint);
  const replacementLease = await claimLead(
    replacement,
    projectId,
    "Synthetic replacement lead",
  );
  if (replacementLease.fencingToken <= sourceLease.fencingToken) {
    fail("The replacement did not receive a higher fencing token.");
  }
  const replacementPoint = await checkpointLead(replacement, {
    leaseInput: replacementLease,
    packetInput: replacementResume.packet,
    phase: "replacement",
    previousContinuityPointId: sourcePoint.continuityPointId,
    projectId,
  });
  const replacementAfterCheckpoint = await resumeExactProject(
    replacement,
    projectId,
    replacementResume.contextPolicy,
    "replacement checkpoint resume",
  );
  sameContinuityPoint(
    replacementAfterCheckpoint.latestContinuityPoint,
    replacementPoint,
    projectId,
  );
  const substitutionElapsedMs = performance.now() - substitutionStartedAt;
  if (substitutionElapsedMs >= SUBSTITUTION_BUDGET_MS) {
    fail("The independent replacement exceeded the five-minute budget.");
  }

  console.log("OWD_CONTINUITY_REMOVE_REPLACEMENT_NOW=1");
  await readInputLine(
    "Remove the replacement client/session in OWD, then press Enter: ",
  );
  const replacementRevoked = await verifyRevoked(
    replacement,
    "replacement client",
  );
  return {
    replacementPoint,
    replacementRevoked,
    sourceRevoked,
    substitutionElapsedMs,
  };
}

async function restoredTargetInput(sourceOrigin, sourceProjectId) {
  console.log(
    JSON.stringify({
      event: "owd.continuity_r1.encrypted_restore_required",
      instructions:
        "Create an approved-intelligence encrypted snapshot, restore it into a fresh disposable cell and blank target, and do not restore any grant or session.",
    }),
  );
  const origin = exactHttpsOrigin(
    await readInputLine("Fresh restored cell HTTPS origin: "),
    "restored cell origin",
  );
  distinctCellOrigin(sourceOrigin, origin);
  const expectedVaultName = await readInputLine(
    "Fresh restored target vault name: ",
  );
  if (
    expectedVaultName.length === 0 ||
    expectedVaultName.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(expectedVaultName)
  ) {
    fail("Restored target vault name was invalid.");
  }
  const attestation = await readInputLine(
    "Confirm this is a separately provisioned fresh cell with a blank target and no pre-existing OAuth clients, grants, sessions, snapshots, or restored content (`fresh-blank`): ",
  );
  freshCellAttestation(attestation);
  return {
    expectedVaultName,
    freshCellOwnerAttested: true,
    origin,
    projectId: sourceProjectId,
    targetOriginDistinct: true,
  };
}

async function runRestoredDrill(target, expectedPoint, plan) {
  const restoredToken = await authorize(
    target.origin,
    "OWD continuity restored-cell lead",
    "OWD_CONTINUITY_RESTORED_AUTHORIZATION_URL",
  );
  const restored = mcpClient(
    target.origin,
    restoredToken,
    "OWD continuity restored-cell lead",
  );
  await verifyClientContract(restored, target.expectedVaultName);
  const restoredReady = await openExactProject(
    restored,
    target.projectId,
    plan,
    "OWD_CONTINUITY_RESTORED_PROJECT_APPROVAL_URL",
  );
  const restoredResume = await resumeExactProject(
    restored,
    target.projectId,
    restoredReady.contextPolicy,
    "restored-cell resume",
  );
  sameContinuityPoint(
    restoredResume.latestContinuityPoint,
    expectedPoint,
    target.projectId,
  );
  const restoredLease = await claimLead(
    restored,
    target.projectId,
    "Synthetic restored-cell lead",
  );
  if (restoredLease.fencingToken !== 1) {
    fail("The fresh restored cell did not start with a fresh fencing token.");
  }
  const restoredPoint = await checkpointLead(restored, {
    leaseInput: restoredLease,
    packetInput: restoredResume.packet,
    phase: "restored",
    previousContinuityPointId: expectedPoint.continuityPointId,
    projectId: target.projectId,
  });
  const afterCheckpoint = await resumeExactProject(
    restored,
    target.projectId,
    restoredResume.contextPolicy,
    "restored-cell checkpoint resume",
  );
  sameContinuityPoint(
    afterCheckpoint.latestContinuityPoint,
    restoredPoint,
    target.projectId,
  );
  console.log("OWD_CONTINUITY_REMOVE_RESTORED_CLIENT_NOW=1");
  await readInputLine(
    "Remove the restored-cell client/session in OWD, then press Enter: ",
  );
  return {
    postRestoreFence: restoredLease.fencingToken,
    restoredClientRevoked: await verifyRevoked(
      restored,
      "restored-cell client",
    ),
  };
}

async function main() {
  if (process.stdin.isTTY !== true) {
    fail("The live continuity drill requires an interactive owner terminal.");
  }
  if (process.argv.length !== 2) {
    fail(
      "Run this harness without arguments so deployment and Project identifiers do not enter shell history.",
    );
  }
  const originInput = await readInputLine(
    "Disposable source cell HTTPS origin: ",
  );
  const origin = exactHttpsOrigin(originInput, "source cell origin");
  const expectedVaultName = await readInputLine(
    "Disposable source vault name: ",
  );
  if (
    expectedVaultName.length === 0 ||
    expectedVaultName.length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(expectedVaultName)
  ) {
    fail("Source vault name was invalid.");
  }
  const projectIdInput = await readInputLine(
    "Disposable source Project UUID: ",
  );
  const projectId = exactUuid(projectIdInput, "source Project ID");
  const plan = documentationPlan(
    await readInputLine(
      "Root-level Markdown in the disposable Project (`none` or comma-separated filenames): ",
    ),
  );
  const source = await runSourceDrill(
    origin,
    expectedVaultName,
    projectId,
    plan,
  );
  const target = await restoredTargetInput(origin, projectId);
  const restored = await runRestoredDrill(
    target,
    source.replacementPoint,
    plan,
  );
  console.log(
    JSON.stringify({
      ...redactedReceipt({
        freshCellOwnerAttested: target.freshCellOwnerAttested,
        postRestoreFence: restored.postRestoreFence,
        restoreVerified: true,
        sourceRevoked: source.sourceRevoked,
        substitutionElapsedMs: source.substitutionElapsedMs,
        successorRevoked:
          source.replacementRevoked && restored.restoredClientRevoked,
        targetOriginDistinct: target.targetOriginDistinct,
      }),
      disposableCellCleanupRequired: true,
    }),
  );
  console.log(
    "Delete the two disposable cells and confirm Worker, D1, R2, KV, routes, and custom domains are absent before issuing the R1 go decision.",
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "owd.continuity_r1.live_drill.failed",
      message: error instanceof Error ? error.message : "Unknown failure.",
    }),
  );
  process.exitCode = 1;
});
