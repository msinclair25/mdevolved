import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("normal product surfaces lead with MDevolved and Sources", async () => {
  const [
    app,
    navigation,
    webHtml,
    marketing,
    manifest,
    readme,
    quickstart,
    agentAuthorize,
    projectInitialize,
    restorePanel,
    onboarding,
    alphaStatus,
    product,
    collaboration,
    snapshot,
    snapshotRestore,
    albatross,
  ] = await Promise.all([
    read("apps/web/src/App.tsx"),
    read("apps/web/src/WorkspaceNavigation.tsx"),
    read("apps/web/index.html"),
    read("apps/marketing/index.html"),
    read("apps/marketing/public/site.webmanifest"),
    read("README.md"),
    read("docs/AGENT-FIRST-QUICKSTART.md"),
    read("apps/web/src/AgentAuthorize.tsx"),
    read("apps/web/src/ProjectInitialize.tsx"),
    read("apps/web/src/RestorePanel.tsx"),
    read("docs/ONBOARDING-CONTRACT.md"),
    read("docs/ALPHA-STATUS.md"),
    read("docs/PRODUCT.md"),
    read("apps/web/src/CollaborationPanel.tsx"),
    read("apps/web/src/SnapshotPanel.tsx"),
    read("apps/web/src/SnapshotRestorePanel.tsx"),
    read("packages/client-packs/src/albatross.ts"),
  ]);

  assert.match(webHtml, /<title>MDevolved<\/title>/u);
  assert.match(app, /Set up MDevolved/u);
  assert.match(app, /Markdown folder or Obsidian workspace/u);
  assert.match(app, /heading="Source connections"/u);
  assert.match(app, /<span className="vault-kind">Source<\/span>/u);
  assert.match(app, /Ready with the exact Source you want to pair/u);
  assert.match(app, /Loading Sources…/u);
  assert.match(app, /No active or pending Sources/u);
  assert.match(app, /Active Source/u);
  assert.match(app, /Live Source/u);
  assert.match(app, /Source access/u);
  assert.match(navigation, /label: "Sources"/u);
  assert.match(navigation, /candidate === "sources"/u);
  assert.match(marketing, /Every AI\. One durable Project memory\./u);
  assert.match(marketing, /src="\/og-mdevolved\.png"/u);
  assert.doesNotMatch(
    marketing,
    /og-head-start|MD EVOLVED|MD Evolved|>MD<|>Evolved<|Choose vault/u,
  );
  assert.match(marketing, /Choose a Markdown folder or Obsidian/u);
  assert.match(manifest, /"name": "MDevolved"/u);
  assert.match(readme, /^# MDevolved$/mu);
  assert.match(readme, /MDevolved was formerly called \*\*OWD\*\*/u);
  assert.match(readme, /Markdown folder or Obsidian workspace you choose/u);
  assert.match(readme, /Choose the agent, Project name, Source, and/u);
  assert.match(readme, /MDevolved derives one next action/u);
  assert.match(readme, /MDevolved automates the routine coordination/u);
  assert.match(
    readme,
    /technical compatibility protocol retains the OWD name/u,
  );
  assert.match(
    quickstart,
    /Choose\s+either the folder path or the optional Obsidian path/u,
  );
  assert.match(agentAuthorize, /Connect a Markdown source first/u);
  assert.match(agentAuthorize, /Source workspace/u);
  assert.doesNotMatch(agentAuthorize, /Connect an Obsidian vault first/u);
  assert.match(projectInitialize, /You remain the Source owner/u);
  assert.match(restorePanel, /mdevolved-recovery-key-date\.txt/u);
  assert.match(restorePanel, /legacy OWD[\s\S]*owd-recovery-key-date\.txt/u);
  assert.match(onboarding, /Connect this project to MDevolved/u);
  assert.match(alphaStatus, /Connect this project to MDevolved/u);
  assert.match(product, /Connect this project to MDevolved/u);
  assert.match(collaboration, /Source workspace/u);
  assert.match(collaboration, /Open Source setup/u);
  assert.match(collaboration, /Agent Source/u);
  assert.match(collaboration, /Project Source/u);
  assert.match(collaboration, /MDevolved Project/u);
  assert.doesNotMatch(collaboration, /Agent vault|Project vault|OWD Project/u);
  assert.match(snapshot, /All active Sources/u);
  assert.match(snapshotRestore, /Every mapped Source was restored/u);
  assert.match(snapshotRestore, /Restore mapped Sources and intelligence/u);
  assert.match(albatross, /Connect this project to MDevolved/u);
  assert.match(albatross, /MDevolved resume project/u);

  const normalSurfaces = [
    app,
    agentAuthorize,
    projectInitialize,
    restorePanel,
    collaboration,
    snapshot,
    snapshotRestore,
    marketing,
  ].join("\n");
  for (const forbidden of [
    "One quiet place for",
    "every Obsidian vault",
    "Vaults first.",
    "Set up OWD once.",
    "Obsidian vault",
    "Waiting for Obsidian",
    "Vault required first",
    "Restore a vault",
    "Saved in OWD",
    "Every mapped vault",
    "Markdown Source",
    "Ready in the exact vault",
    "Loading vaults",
    "No active or pending vaults",
    "Active vault",
    "Live vault",
    "Path and vault cannot change",
    "Vault access",
    "Vault status failed",
    "Restore mapped vaults and intelligence",
    "Agent vault",
  ]) {
    assert.equal(normalSurfaces.includes(forbidden), false);
  }
});

test("legacy protocol, data, plugin, update, and deploy identities stay frozen", async () => {
  const [
    rootPackage,
    pluginManifest,
    pluginPackage,
    pluginLinks,
    pairingProtocol,
    mcpServer,
    backupRoutes,
    compatibilityContracts,
    pluginWorkflow,
    desktopManifest,
    brandContract,
  ] = await Promise.all([
    read("package.json"),
    read("packages/obsidian-plugin/manifest.json"),
    read("packages/obsidian-plugin/package.json"),
    read("apps/web/src/obsidian-plugin-links.ts"),
    read("packages/obsidian-plugin/src/main.ts"),
    read("apps/worker/src/mcp-server.ts"),
    read("apps/worker/src/backup-store.ts"),
    read("packages/contracts/src/index.ts"),
    read(".github/workflows/release-plugin.yml"),
    read("apps/desktop/src/updateManifest.ts"),
    read("docs/BRAND-COMPATIBILITY.md"),
  ]);

  const plugin = JSON.parse(pluginManifest);
  const pluginPkg = JSON.parse(pluginPackage);
  assert.equal(plugin.id, "owd-sync");
  assert.equal(plugin.version, "0.1.7");
  assert.equal(pluginPkg.name, "@owd/obsidian-plugin");
  assert.match(plugin.name, /^MDevolved Sync for Obsidian$/u);
  assert.match(pluginLinks, /msinclair25\/owd-sync/u);
  assert.match(pluginLinks, /obsidian:\/\/show-plugin\?id=owd-sync/u);
  assert.match(pluginLinks, /owd-sync-\$\{OWD_SYNC_REQUIRED_VERSION\}\.zip/u);
  assert.match(pairingProtocol, /registerObsidianProtocolHandler\("owd-pair"/u);
  assert.match(mcpServer, /owd_resume/u);
  assert.match(mcpServer, /owd_find/u);
  assert.match(mcpServer, /owd_checkpoint/u);
  assert.match(backupRoutes, /owd-backup-v1/u);
  assert.match(compatibilityContracts, /owd-snapshot-v2/u);
  assert.match(pluginWorkflow, /owd-sync-v\*/u);
  assert.match(
    pluginWorkflow,
    /packages\/obsidian-plugin\/release\/owd-sync-\*\.zip/u,
  );
  assert.match(desktopManifest, /mdevolved-update\/v1/u);
  assert.match(rootPackage, /@owd\//u);
  assert.match(
    brandContract,
    /Existing users require no migration, data edit, re-pairing, MCP reconnect/u,
  );
});

test("new and legacy resume phrases are both delivered to agents", async () => {
  const [mcpServer, contextPolicy, mind, eve] = await Promise.all([
    read("apps/worker/src/mcp-server.ts"),
    read("apps/worker/src/project-context-policy.ts"),
    read("packages/client-packs/src/obsidian-mind.ts"),
    read("packages/client-packs/src/eve.ts"),
  ]);
  for (const surface of [mcpServer, contextPolicy, mind, eve]) {
    assert.match(surface, /MDevolved resume project/u);
    assert.match(surface, /OWD resume project/u);
  }
});

test("release and repository links use the renamed repository without changing paths", async () => {
  const [readme, alphaStatus, releaseContract, pluginSettings] =
    await Promise.all([
      read("README.md"),
      read("docs/ALPHA-STATUS.md"),
      read("scripts/check-release-contract.mjs"),
      read("packages/obsidian-plugin/vendor/yaos-src/settings/settingsTab.ts"),
    ]);
  const repository = "https://github.com/msinclair25/mdevolved";
  const deploy = `https://deploy.workers.cloudflare.com/?url=${repository}`;
  assert.match(readme, new RegExp(repository, "u"));
  assert.match(readme, new RegExp(deploy.replace(/[?]/gu, "\\?"), "u"));
  assert.match(alphaStatus, new RegExp(deploy.replace(/[?]/gu, "\\?"), "u"));
  assert.match(releaseContract, new RegExp(repository, "u"));
  assert.match(pluginSettings, new RegExp(deploy.replace(/[?]/gu, "\\?"), "u"));
});
