import { access, readFile } from "node:fs/promises";

const ledger = JSON.parse(await readFile("release-regressions.json", "utf8"));
const expectedIds = Array.from(
  { length: 47 },
  (_, index) => `MTR-${String(index + 1).padStart(3, "0")}`,
);
const allowedKinds = new Set(["manual", "static", "test"]);

if (
  ledger.schemaVersion !== 1 ||
  ledger.findingRange !== "MTR-001..MTR-047" ||
  !Array.isArray(ledger.findings)
) {
  throw new Error("The release regression ledger header is invalid.");
}

const actualIds = ledger.findings.map((finding) => finding.id);
if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
  throw new Error(
    `The release regression ledger must cover ${expectedIds.join(", ")} exactly once and in order.`,
  );
}

for (const finding of ledger.findings) {
  if (
    typeof finding.title !== "string" ||
    finding.title.trim() === "" ||
    !Array.isArray(finding.controls) ||
    finding.controls.length === 0
  ) {
    throw new Error(`${finding.id} has no title or control.`);
  }
  if (
    finding.id !== "MTR-003" &&
    !finding.controls.some((control) => control.kind !== "manual")
  ) {
    throw new Error(`${finding.id} needs an automated test or static control.`);
  }
  for (const control of finding.controls) {
    if (
      !allowedKinds.has(control.kind) ||
      typeof control.path !== "string" ||
      control.path.trim() === ""
    ) {
      throw new Error(`${finding.id} contains an invalid control.`);
    }
    await access(control.path);
  }
}

const [
  agents,
  app,
  backupPanel,
  collaborationPanel,
  migration,
  mcpServer,
  pluginManifestSource,
  projectContextPolicy,
  projectInitializationService,
  projectLocalVaultAccess,
  qualityGates,
  setupReadinessRoutes,
  onboardingContract,
  obsidianPluginInstaller,
  pluginSetupGuide,
  obsidianPluginLinks,
  vaultPrimaryWriterMigration,
  vaultCoordinator,
  viteConfig,
  workspaceNavigation,
  zodAdapter,
] = await Promise.all(
  [
    "AGENTS.md",
    "apps/web/src/App.tsx",
    "apps/web/src/BackupPanel.tsx",
    "apps/web/src/CollaborationPanel.tsx",
    "migrations/0018_invited_owner_claim.sql",
    "apps/worker/src/mcp-server.ts",
    "packages/obsidian-plugin/manifest.json",
    "apps/worker/src/project-context-policy.ts",
    "apps/worker/src/project-initialization-service.ts",
    "apps/worker/src/project-local-vault-access.ts",
    "docs/QUALITY-GATES.md",
    "apps/worker/src/setup-readiness-routes.ts",
    "docs/ONBOARDING-CONTRACT.md",
    "apps/web/src/ObsidianPluginInstaller.tsx",
    "apps/web/src/PluginSetupGuide.tsx",
    "apps/web/src/obsidian-plugin-links.ts",
    "migrations/0026_vault_primary_writer.sql",
    "apps/worker/src/vault-coordinator.ts",
    "apps/web/vite.config.ts",
    "apps/web/src/WorkspaceNavigation.tsx",
    "packages/contracts/src/zod.ts",
  ].map((path) => readFile(path, "utf8")),
);
const pluginManifest = JSON.parse(pluginManifestSource);
const [
  preparedProjectHandoffMigration,
  preparedProjectHandoffService,
  preparedProjectHandoffStore,
  vaultPrimaryWriterTransferMigration,
  vaultLocalWriterStore,
  agentAccessRoutes,
] = await Promise.all([
  readFile("migrations/0028_prepared_project_handoffs.sql", "utf8"),
  readFile("apps/worker/src/prepared-project-handoff-service.ts", "utf8"),
  readFile("apps/worker/src/prepared-project-handoff-store.ts", "utf8"),
  readFile("migrations/0029_vault_primary_writer_transfer.sql", "utf8"),
  readFile("apps/worker/src/vault-local-writer-store.ts", "utf8"),
  readFile("apps/worker/src/agent-access-routes.ts", "utf8"),
]);
const [
  socketTicketRetry,
  vaultSync,
  pluginMain,
  capabilityPolicy,
  socketTicketAbuse,
  pairingRoutes,
  wranglerConfig,
  syncRequestBudget,
] = await Promise.all([
  readFile(
    "packages/obsidian-plugin/vendor/yaos-src/sync/socketTicketRetry.ts",
    "utf8",
  ),
  readFile(
    "packages/obsidian-plugin/vendor/yaos-src/sync/vaultSync.ts",
    "utf8",
  ),
  readFile("packages/obsidian-plugin/vendor/yaos-src/main.ts", "utf8"),
  readFile(
    "packages/obsidian-plugin/vendor/yaos-src/runtime/capabilityPolicy.ts",
    "utf8",
  ),
  readFile("apps/worker/src/socket-ticket-abuse.ts", "utf8"),
  readFile("apps/worker/src/pairing-routes.ts", "utf8"),
  readFile("wrangler.jsonc", "utf8"),
  readFile("docs/SYNC-REQUEST-BUDGET.md", "utf8"),
]);
const normalizedAgents = agents.replace(/\s+/gu, " ");
const normalizedOnboardingContract = onboardingContract.replace(/\s+/gu, " ");
const normalizedPluginSetupGuide = pluginSetupGuide.replace(/\s+/gu, " ");
const normalizedQualityGates = qualityGates.replace(/\s+/gu, " ");
const acceptedPluginBaseline = [0, 1, 5];

function versionAtLeast(value, minimum) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value)) {
    return false;
  }
  const parts = value.split(".").map(Number);
  return (
    parts.some(
      (part, index) =>
        part > minimum[index] &&
        parts.slice(0, index).every((prior, priorIndex) => {
          return prior === minimum[priorIndex];
        }),
    ) || parts.every((part, index) => part === minimum[index])
  );
}

const forbiddenCopy = [
  "One vault per bounded agent connection.",
  "Renew 24-hour packet",
];
for (const value of forbiddenCopy) {
  if (app.includes(value) || collaborationPanel.includes(value)) {
    throw new Error(
      `Owner-facing source reintroduced forbidden copy: ${value}`,
    );
  }
}

if (
  normalizedAgents.includes("build its current searchable library") ||
  normalizedOnboardingContract.includes(
    "Follow MDevolved's next action to build the note library",
  ) ||
  normalizedQualityGates.includes("Build this vault's library") ||
  !normalizedAgents.includes(
    "wait for MDevolved to publish its current searchable library automatically",
  ) ||
  !normalizedQualityGates.includes(
    "wait for its library to publish automatically",
  ) ||
  !normalizedQualityGates.includes(
    "read-only agent access does not require a recovery point",
  )
) {
  throw new Error(
    "First-run documentation must keep automatic library preparation and recovery-independent read-only agent access.",
  );
}

if (/^\s*CREATE\s+TRIGGER\b/imu.test(migration)) {
  throw new Error(
    "MTR-001 regression: managed owner claim migration must remain trigger-free.",
  );
}
if (!versionAtLeast(pluginManifest.version, acceptedPluginBaseline)) {
  throw new Error(
    `MTR-008 regression: MDevolved Sync must not move below the accepted 0.1.5 baseline; found ${String(pluginManifest.version)}.`,
  );
}
if (!zodAdapter.includes("z.config({ jitless: true });")) {
  throw new Error(
    "MTR-021 regression: Zod must remain jitless in the browser.",
  );
}
if (
  !projectInitializationService.includes("newProjectAllowed: true") ||
  !vaultCoordinator.includes("automatic-materialization-retry-count") ||
  !app.includes("automatically rebuilds")
) {
  throw new Error(
    "Project discovery or automatic library lifecycle markers are missing.",
  );
}
if (
  !projectContextPolicy.includes("first agent that establishes a Project") ||
  !projectContextPolicy.includes("current \\`localVaultAccess.role\\`") ||
  !projectContextPolicy.includes(
    "A \\`read-only-collaborator\\` must warn the owner",
  ) ||
  !projectContextPolicy.includes("writer role is **unconfirmed**") ||
  !projectContextPolicy.includes("**MDevolved resume project**") ||
  !projectContextPolicy.includes("**OWD resume project**") ||
  !projectContextPolicy.includes("Target the exact vault and path") ||
  !projectContextPolicy.includes("vault=<exact vault name>") ||
  !projectContextPolicy.includes("not a filesystem lock") ||
  !mcpServer.includes("OWD_LOCAL_VAULT_WRITE_SUMMARY") ||
  !mcpServer.includes("continuity: projectContinuityReceipt(") ||
  !mcpServer.includes("projectLocalVaultAccess") ||
  !mcpServer.includes("“MDevolved resume project”") ||
  !mcpServer.includes("legacy phrase “OWD resume project”") ||
  !mcpServer.includes('"resume-owd-project"') ||
  !mcpServer.includes("No MCP reconnect or new owner authorization")
) {
  throw new Error(
    "MTR-039 regression: generated Project continuity must preserve local single-writer safety and refresh it during resume.",
  );
}
if (
  !vaultPrimaryWriterMigration.includes(
    "CREATE TABLE IF NOT EXISTS vault_local_writer_assignments",
  ) ||
  !vaultPrimaryWriterMigration.includes("INSERT OR IGNORE") ||
  !projectLocalVaultAccess.includes('role: "primary-writer"') ||
  !projectLocalVaultAccess.includes('role: "read-only-collaborator"') ||
  !projectLocalVaultAccess.includes('scope: "vault"') ||
  !projectLocalVaultAccess.includes('"owner-requested-bounded-task-only"') ||
  !projectLocalVaultAccess.includes('"same-client-resume-only"') ||
  !projectLocalVaultAccess.includes("collaborationGrantId") ||
  !projectLocalVaultAccess.includes("JOIN agent_grants source")
) {
  throw new Error(
    "MTR-040 regression: the first Project agent must retain one durable vault-wide writer role while later agents receive advisory read-only warnings.",
  );
}
if (
  !vaultPrimaryWriterTransferMigration.includes(
    "CREATE TABLE IF NOT EXISTS vault_local_writer_transfers",
  ) ||
  !vaultPrimaryWriterTransferMigration.includes(
    "CHECK (from_oauth_client_id != to_oauth_client_id)",
  ) ||
  !vaultLocalWriterStore.includes("vault_local_writer_transfers") ||
  vaultLocalWriterStore.includes("transferVaultLocalWriter") ||
  agentAccessRoutes.includes("make-primary-writer") ||
  app.includes("confirmedPreviousWriterStopped") ||
  app.includes("Make primary") ||
  !app.includes("authorized-client-inventory") ||
  !app.includes("Chats and processes can disappear") ||
  !app.includes("Copy resume instruction") ||
  !projectLocalVaultAccess.includes(
    "does not promote a different client from the global Agents screen",
  )
) {
  throw new Error(
    "MTR-045 regression: authorized clients must stay compact, preserve same-client resume, and expose no global writer promotion.",
  );
}
if (
  !mcpServer.includes("project_lifecycle_tool_retired") ||
  !mcpServer.includes("JSON.stringify(envelope)") ||
  !mcpServer.includes("projectLifecycle") ||
  !mcpServer.includes('requestKind: "connect"') ||
  !projectInitializationService.includes(
    'requestKind === "join" ? "connect" : "initialize"',
  )
) {
  throw new Error(
    "MTR-041 regression: pending Project connection must remain key-complete for text-only clients and stale lifecycle catalogs.",
  );
}
if (
  !preparedProjectHandoffMigration.includes(
    "prepared_project_handoffs_vault_active_idx",
  ) ||
  !preparedProjectHandoffMigration.includes(
    "prepared_project_handoffs_agent_active_idx",
  ) ||
  !preparedProjectHandoffStore.includes(
    "preparedProjectHandoffClaimInProgress",
  ) ||
  !mcpServer.includes("folderBoundaryLabel") ||
  !preparedProjectHandoffService.includes("preparedProjectHandoffId") ||
  !setupReadinessRoutes.includes("pending_project_request_count > 0") ||
  !setupReadinessRoutes.includes('return "approve-project"') ||
  !app.includes("Prepare first Project") ||
  !app.includes("Change the prepared first Project")
) {
  throw new Error(
    "MTR-042 regression: onboarding must retain one exact, single-use, revocable first-Project handoff without a second website loop.",
  );
}
if (
  !workspaceNavigation.includes("workspace-mobile-menu-panel") ||
  !workspaceNavigation.includes("Current folder") ||
  !workspaceNavigation.includes("closeMobileMenu") ||
  !app.includes("const BackupPanel = lazy(loadBackupPanel)") ||
  !app.includes("const CollaborationPanel = lazy(loadCollaborationPanel)") ||
  !app.includes('visitedWorkspaceSections.has("recovery")') ||
  !app.includes('visitedWorkspaceSections.has("collaboration")') ||
  !app.includes('autoOpen={activeWorkspaceSection === "recovery"}') ||
  !app.includes('autoOpen={activeWorkspaceSection === "collaboration"}') ||
  !backupPanel.includes("autoOpen ||") ||
  !collaborationPanel.includes("autoOpen ||") ||
  !viteConfig.includes("sourcemap: false")
) {
  throw new Error(
    "MTR-043 regression: narrow navigation must keep every folder discoverable while heavy private tools and production source maps stay off the critical path.",
  );
}
if (
  !app.includes("Returning after a crash or new session?") ||
  !app.includes("<q>MDevolved resume project</q>") ||
  !collaborationPanel.includes("New session, same Project") ||
  !mcpServer.includes('"resume-owd-project"') ||
  !projectContextPolicy.includes("writer role is **unconfirmed**")
) {
  throw new Error(
    "MTR-044 regression: fresh sessions must resume the durable Project and writer role before reporting access or asking for reconnection.",
  );
}
if (
  !obsidianPluginInstaller.includes("Obsidian → Quit Obsidian") ||
  !obsidianPluginInstaller.includes("Closing the Mac window is not enough") ||
  !obsidianPluginInstaller.includes("No folder selected; nothing changed") ||
  !obsidianPluginInstaller.includes("Waiting for Chrome’s folder picker") ||
  !normalizedPluginSetupGuide.includes("it does not finish the install") ||
  !pluginSetupGuide.includes("BRAT: Plugins: Add a beta plugin for testing") ||
  !pluginSetupGuide.includes("Use either the direct installer or BRAT") ||
  !obsidianPluginLinks.includes("&version=${OWD_SYNC_REQUIRED_VERSION}")
) {
  throw new Error(
    "MTR-046 regression: clean-macOS installation must retain explicit quit semantics, truthful picker states, and a pinned deterministic BRAT fallback.",
  );
}
if (
  !socketTicketRetry.includes("SOCKET_TICKET_RETRY_BASE_MS = 30_000") ||
  !socketTicketRetry.includes("SOCKET_TICKET_RETRY_MAX_MS = 30 * 60_000") ||
  !socketTicketRetry.includes("error.status === 401 || error.status === 403") ||
  !vaultSync.includes("this.markFatalAuth(msg)") ||
  !vaultSync.includes("this.clearSocketTicketRefreshTimer()") ||
  !vaultSync.includes("this._socketTicketRefreshInFlight") ||
  !vaultSync.includes("this._socketTicketRetryPausedProvider") ||
  !pluginMain.includes("authRetryBlocked") ||
  !capabilityPolicy.includes("5 * 60_000") ||
  !socketTicketAbuse.includes("SOCKET_TICKET_IP_LIMITER") ||
  !socketTicketAbuse.includes("SOCKET_TICKET_VAULT_LIMITER") ||
  !socketTicketAbuse.includes("socket_ticket.rate_limited") ||
  !socketTicketAbuse.includes("sha256Hex") ||
  !socketTicketAbuse.includes("status: 429 | 503") ||
  !pairingRoutes.includes(
    'enforcePairingRateLimit(context, "socket_ticket", 10)',
  ) ||
  !/"name": "SOCKET_TICKET_IP_LIMITER"[\s\S]*?"limit": 4/u.test(
    wranglerConfig,
  ) ||
  !/"name": "SOCKET_TICKET_VAULT_LIMITER"[\s\S]*?"limit": 2/u.test(
    wranglerConfig,
  ) ||
  !syncRequestBudget.includes("one refresh per connected device") ||
  !syncRequestBudget.includes("compare the ticket request/error rate") ||
  !normalizedQualityGates.includes(
    "permanently stops ticket refresh, reconnect, and degraded capability polling",
  )
) {
  throw new Error(
    "MTR-047 regression: sync control-plane retries must remain terminal for rejected credentials, bounded for transient failures, and independently contained by redacted Worker limits.",
  );
}

console.log(
  `Release regression ledger verified: ${ledger.findings.length} alpha findings and fixed onboarding invariants.`,
);
