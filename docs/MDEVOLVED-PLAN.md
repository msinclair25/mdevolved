# MDevolved source-independent product plan

**Status:** MD1–MD6 are complete. MD7 brand completion is active.<br />
**Date:** 2026-08-26

## Milestone boundary

MD0 planning and MD1 through MD6 delivery are complete. MD7 is the only active
milestone. The source-neutral
architecture, compatibility rules, rollout order, security boundaries, and
independent acceptance decisions below remain explicit. MD5's final candidate
passed its exact complete gate and authoritative legacy-repository redirect
check. Its required PR checks, merge, and post-merge `main` health complete the
recorded delivery workflow. MD7 completes the human- and agent-facing naming
transition without changing frozen compatibility identities. Later product
expansion requires a fresh milestone and acceptance decision.

## Product promise

> MDevolved gives every AI the right project memory, regardless of where the
> project files live.

MDevolved is durable, owner-controlled Project memory for people who move work
between AI tools, computers, and local workspaces. A plain folder is the
compatibility floor. Obsidian becomes an optional, deeply integrated source
adapter instead of a prerequisite.

The lovable moment remains unchanged: a fresh agent on another computer or in
another compatible harness continues correctly without copied prompts or a
reconstructed provider session.

## Decisions frozen now

1. **MDevolved is the human-facing product and umbrella brand.** The spelling is
   `MDevolved`; URLs and package slugs use lowercase `mdevolved`.
2. **A selected Markdown folder is the first generic source.** Version 1 does
   not mirror an entire code repository, scrape conversations, or become a
   general cloud-drive replacement.
3. **Obsidian remains first-class.** Existing vault behavior, plugin identity,
   settings, and updater compatibility stay intact while the plugin becomes an
   adapter over the shared core.
4. **The first desktop shell uses Electron.** It reuses the existing TypeScript,
   Yjs, WebSocket, pairing, retry, and reconciliation code. Tauri is reconsidered
   only if measured package size or patching cost outweighs a Rust bridge and
   cross-webview test burden.
5. **The protocol is not renamed.** Existing `owd_*` MCP operations,
   `owd-pair`, `vaultId`, `@owd/*` packages, migrations, exports, and stored
   records remain compatible throughout the first MDevolved release.
6. **No local sync client gains agent authority.** Source synchronization and
   agent authorization remain separate boundaries.

The MDevolved name still needs ordinary trademark and store-listing clearance
before paid promotion or app-store publication. A preliminary web search found
no prominent software collision; that is not legal clearance and does not
block local implementation.

## Gates

There is no human or external gate before MD1. Source-core extraction,
compatibility work, hostile fixtures, and local automated acceptance can begin
from the current repository.

The later external gates are deliberately narrow:

- preserve owner control of the published `mdevolved` npm package and require
  publishing 2FA for every release;
- obtain ordinary trademark and store-listing clearance before paid promotion
  or app-store publication;
- obtain signing credentials and approve any fees before distributing signed
  macOS or Windows installers; unsigned synthetic builds remain testable; and
- obtain explicit owner authorization at execution time before package
  publication, production deployment, repository renaming, or paid services.

Human usability feedback is valuable but is not a prerequisite for MD1-MD6
implementation or automated validation. Each milestone's automated acceptance
decision remains mandatory.

## Product shape

```text
Selected local source
  ├─ Markdown folder adapter
  └─ Obsidian adapter
          ↓
Source-neutral sync core
  pairing · path policy · reconciliation · Yjs · retries · receipts
          ↓
Existing OWD-compatible wire protocol
          ↓
MDevolved Community Worker
  durable Projects · memory · evidence · skills · recovery · MCP
          ↓
Codex · Claude · Hermes · Orca · Cursor · other compatible harnesses
```

The execution harness still owns its model, tools, shell, browser, worktrees,
retries, and runtime context. MDevolved owns durable Project identity, bounded
memory, evidence, continuity, recovery, and revocation.

## Source-neutral sync boundary

The shared core depends on four small ports instead of Obsidian classes:

- **Workspace files:** enumerate, stat, read, write, and watch paths inside one
  explicitly selected root.
- **Local state:** persist derived indexes, pending work, source identity, and
  non-secret runtime settings outside the synchronized folder.
- **Credential custody:** store pairing material in the operating system's
  protected credential facility; never in Project files or logs.
- **User interaction:** show consent, status, conflict, update, and repair
  actions without exposing sync-engine internals.

The core retains the existing Yjs schema and Worker protocol. Obsidian-only
editor bindings, notices, commands, status bars, and runtime-profile discovery
remain in the Obsidian adapter.

### Generic folder contract

Version 1 synchronizes Markdown under one selected root. It excludes symlinks,
paths outside the resolved root, hidden control directories, dependency/build
trees, credentials, secret-shaped configuration, application state, and its own
local metadata. Attachments and arbitrary source-code mirroring require a later
accepted milestone.

Local and remote Markdown edits use the existing expected-version,
reconciliation, conflict, durability-receipt, and retry boundaries. The app
must stop permanently after authoritative revocation until the owner pairs it
again.

## Durable model and server compatibility

The first implementation adds an additive source descriptor rather than
renaming the current vault model:

- `sourceKind`: `folder` or `obsidian`;
- human-readable source label;
- source capabilities such as Markdown, attachment, and editor integration;
- client version and sync-schema version; and
- immutable provenance for the pairing and later capability changes.

Existing records without a descriptor resolve to `obsidian`. Existing table
names, `vaultId` fields, grants, snapshots, exports, restore manifests, and MCP
responses remain readable. New fields must be optional for old clients and
included in portable export, encrypted snapshot, restore, quarantine, and
retention coverage. Restore never recreates credentials, active device
connections, sessions, grants, or live authority.

The ordinary UI gradually says **Sources** and **Workspaces** where it means
both folders and vaults. Technical compatibility surfaces may continue to say
`vault` until a future major protocol version earns a migration.

## Desktop application

**MDevolved Sync** is a small tray/menu-bar application for macOS, Windows, and
Linux. Its normal path is:

1. install and open the app;
2. choose one Markdown folder;
3. open a short pairing link from the owner-controlled deployment;
4. review the exact folder and file boundary;
5. let the current library publish; and
6. close the window while background sync continues.

No terminal, Node installation, Cloudflare vocabulary, copied token, or manual
binding is part of that path. Start-at-login is explicit and optional. The
renderer receives no direct Node or credential access; filesystem and keychain
operations stay behind a narrow privileged process boundary.

Agents and developers with Node installed get a one-command path over the same
sync core:

```sh
npx mdevolved@latest sync .
```

The command treats the current directory as the selected Markdown root, opens
or prints the owner-controlled pairing step, and stays attached while it
synchronizes. It emits concise human output by default and machine-readable
JSON when requested. It must never accept pairing secrets as command-line
arguments or print credentials to output. Re-running it for an already paired
source is idempotent. This is a thin entry point, not a second sync engine or a
requirement that desktop users install Node.

Unsigned synthetic builds are sufficient for automated alpha validation.
Apple notarization, Windows signing, store publication, and any associated fees
are delivery gates, not prerequisites for building or testing the product.

## Obsidian migration

The existing companion becomes **MDevolved Sync for Obsidian** only after the
shared core and folder adapter pass independently.

- Keep the current Obsidian plugin ID and persisted settings schema.
- Preserve `owd-pair` deep links and accepted package/update manifests.
- Reuse the same core ports through Obsidian's public vault, request, storage,
  notice, command, and status APIs.
- Keep Obsidian Mind detection and editor-aware behavior inside this adapter.
- Require an upgrade test proving existing users reconnect without re-pairing,
  losing indexes, widening paths, or duplicating a source.

Obsidian remains the richer knowledge-workspace integration. The folder adapter
is the universal floor, not a reason to remove vault-specific value.

## Brand transition

The public rename happens additively:

1. introduce **MDevolved, formerly OWD** in product copy after the generic
   folder alpha works;
2. rename the desktop display name to **MDevolved Sync** while retaining old
   protocol and package identities;
3. update docs, artwork, install links, and deployment copy with redirects;
4. rename repositories only after GitHub redirects, Deploy-to-Cloudflare links,
   release automation, checksums, and updater tests pass; and
5. keep `owd_*` MCP names and existing stored identifiers for at least the full
   1.x compatibility line.

Existing owners should not need to migrate data, reconnect agents, re-pair
Obsidian, or edit `.owdignore` merely because the display name changes.

## Delivery milestones

Each milestone is a fresh task with one final acceptance decision.

### MD1 — Source-neutral core

**Outcome:** The existing Obsidian client behavior runs through a small shared
sync core that has no Obsidian import.

**Build:** Extract the minimum filesystem, state, credential, and UI ports;
reuse the current pairing, Yjs, reconciliation, retry, exclusion, and receipt
logic; add source-capability contracts without changing the wire schema.

**Acceptance decision:** Close only when the shared core passes hostile path,
replay, conflict, restart, revocation, and bounded-scan tests, while the existing
Obsidian package, bundle guards, fixtures, and updater compatibility remain
unchanged.

### MD2 — Generic folder desktop alpha

**Outcome:** A user can install MDevolved Sync, select a Markdown folder, pair
it, and receive a current searchable library without installing Obsidian.

**Build:** Add the Electron shell, native folder chooser, protected credential
storage, background lifecycle, status/repair UI, folder adapter, thin
`npx mdevolved@latest sync .` entry point, and signed update-manifest format.
Add the source descriptor through a forward-only migration and
transport-neutral service.

**Acceptance decision:** Close only when macOS, Windows, and Linux CI packages
exercise a synthetic folder through pair, initial publish, edits in both
directions, restart, offline retry, conflict, upgrade, revocation, export, and
authority-free restore. Traversal, symlinks, hidden/generated trees,
credential-shaped files, oversized files, and out-of-root writes must fail
closed. A clean Node environment must also reach the pairing step with the one
documented command, provide machine-readable next actions, avoid secrets in
arguments and output, and reconnect idempotently on a second run.

### MD3 — Obsidian as an adapter

**Outcome:** Plain folders and Obsidian vaults use the same reviewed sync core,
while Obsidian retains its richer editor integration.

**Build:** Replace Obsidian-coupled core imports with adapter implementations;
retain editor binding, commands, notices, status, runtime profiles, and plugin
packaging.

**Acceptance decision:** Close only when the same Markdown fixture produces the
same durable hashes and library through both adapters, existing plugin settings
upgrade without re-pairing, and the complete Obsidian product/installer gates
remain green.

### MD4 — Cross-computer source continuity

**Outcome:** A user can resume the same Project from another computer even when
the original local sync client is offline.

**Build:** Make source/device state explicit, support an owner-approved second
device for an existing source, preserve exact source boundaries, and show which
device last published without treating device state as Project authority.

**Acceptance decision:** Close only when two disposable devices reconcile the
same source without duplicate Projects, stale overwrite, cross-source access,
or restored device credentials; a fresh agent can resume while both local
clients are offline.

### MD5 — MDevolved brand transition

**Outcome:** New users encounter MDevolved as source-independent Project memory,
and existing OWD users continue without migration work.

**Build:** Apply the dual-brand copy, Sources UI, artwork, docs, installer and
update metadata, repository redirects, and compatibility notices.

**Acceptance decision:** Close only when old bookmarks, deep links, MCP names,
plugin identity, stored exports, backup restores, deploy links, and update paths
still work; new users can start with either a folder or Obsidian without seeing
the old product model in the normal path.

### MD6 — Source-independent minimum lovable release

**Outcome:** A new user on a second computer continues a real Project through a
different compatible AI without Obsidian or copied context.

**Acceptance decision:** Close only when the complete folder and Obsidian paths,
cross-harness resume/checkpoint loop, accessibility, narrow-width UI, encrypted
recovery, clean upgrade, public-source scan, full repository gate, and deployed
Community health all pass from the exact candidate. Paid inference and human
testing may improve confidence but are not release gates.

### MD7 — MDevolved naming completion

**Outcome:** MDevolved is the only product name in normal user and agent
workflows. OWD appears only inside frozen compatibility identifiers or an
explicit legacy compatibility explanation.

**Build:** Clean web, marketing, desktop, CLI, Obsidian, MCP guidance, client
packs, repository instructions, documentation, package descriptions, and
release metadata. Add a repository-wide allowlist test that rejects new visible
OWD branding while preserving the existing wire, storage, plugin, update,
backup, export, deployment, and bookmark identities.

**Acceptance decision:** Close only when a new user can discover, install,
pair, authorize, resume, collaborate, recover, and revoke through MDevolved
without encountering OWD as the product name; existing clients require no data
migration, re-pairing, reconnect, plugin reinstall, bookmark edit, or restored
authority; the exact candidate passes focused brand/compatibility checks, the
complete repository gate, cross-platform packaging, independent review, and
non-deploying release validation.

## Required verification matrix

- Shared-core contract tests run against in-memory, folder, and Obsidian ports.
- Filesystem fixtures cover case collisions, Unicode, traversal, symlinks,
  rapid rename/write bursts, partial writes, permissions, offline recovery, and
  very large trees under explicit ceilings.
- Worker tests cover old-client compatibility, source-kind isolation, immediate
  revocation, export/snapshot/restore, quarantine, and no restored authority.
- Desktop E2E runs on current macOS, Windows, and Linux GitHub runners.
- Obsidian E2E keeps the pinned plugin, direct-installer, and updater paths.
- Release gates keep the complete public-history scan and existing Community
  build/deploy checks.

## Explicit non-goals

- A Dropbox, Git, Google Drive, OneDrive, or iCloud replacement.
- Mirroring arbitrary code, binaries, dependency trees, or an entire home
  directory in the first folder release.
- Executing skills, agents, shell commands, or provider APIs.
- Importing chats, hidden reasoning, terminal history, runtime state, browser
  state, or credentials.
- Renaming durable tables, MCP tools, package scopes, or plugin identity merely
  for visual consistency.
- Adding team accounts, shared administration, or a multi-tenant vault
  database.
- Requiring the managed service for Community sync or Project memory.

## MD1 execution capsule

The next task owns only the source-neutral-core extraction. It should begin by
freezing current Obsidian behavior as adapter contract fixtures, map every
direct `obsidian` import in the sync engine, extract only the four ports above,
and keep the production bundle and wire output unchanged. It must not add the
desktop shell, rename public surfaces, change the Worker schema, or begin MD2.

## MD1 delivery receipt

Completed on 2026-08-25. The Obsidian client now routes bounded Markdown
enumeration, reads, conflict artifacts, and CRDT writeback through the shared
`@owd/yaos-core` boundary. The core contains no Obsidian import and owns path
confinement, bounded scans, lifecycle state, credential metadata, immediate
revocation/expiry checks, and fail-closed recovery from malformed local state.

The four frozen MD1 ports remain enumerate/stat/read/write/watch, local state,
credential custody, and UI. Obsidian-specific editor events and remote
rename/delete mechanics remain inside the adapter because rename/delete are not
part of that frozen port contract; making the entire plugin a replaceable
adapter is the explicit MD3 outcome. Attachments continue through the existing
Obsidian subsystem and are not advertised by the text-only MD1 source adapter.

No Worker contract, D1 migration, R2 object, MCP operation, pairing wire shape,
plugin identity, updater identifier, credential store, deployment, or live data
changed. Focused core, plugin, Worker compatibility, production bundle, and
full repository gates are recorded in the milestone handoff.

## MD2 delivery receipt

The generic Markdown-folder vertical slice is implemented locally. It includes
the source-neutral folder adapter, the real Yjs/receipt runtime, protected
platform credential custody, the `mdevolved` CLI, the Electron tray shell,
deferred deep-link pairing, offline retry and repair states, additive source
descriptors, forward-only migration `0036`, portable snapshot/export metadata,
and authority-free quarantine on restore.

`pnpm test:md2:acceptance` is the named cross-platform candidate gate. It
exercises pairing and initial publication, disk and remote edits, restart,
offline receipts, conflicts, revocation, second-run idempotency, source
descriptor negotiation and upgrade, encrypted export/quarantine semantics,
hostile folder boundaries, protected desktop state, and a dependency-free
clean-tarball pairing smoke. The complete repository check, 636 unit and
service tests, 20 focused migration checks, 74 browser tests, production
builds, Cloudflare deployment dry-runs, public-source history scan, and local
macOS arm64 Electron packaging have passed from the candidate lineage.

The same named gate and Electron packaging passed on GitHub's current macOS,
Windows, and Linux runners for the merged candidate lineage. The release
candidate now adds an exact-version tag guard and reproducible unsigned desktop
archives with SHA-256 checksums; its tag workflow refuses commits not already
on `main` and requires all three platform artifacts before creating a
prerelease.

MD2 closed on 2026-08-26. Forward-only migration `0036` was applied with no
remaining migrations, its schema-only verification wrote no records, and the
exact tagged `main` commit was deployed healthy. The tag-triggered GitHub
workflow passed the named MD2 gate and packaged checksum-verified unsigned
archives on macOS, Windows, and Linux before publishing the prerelease.

`mdevolved@0.1.0-alpha.1` is published to npm under `latest` with publishing
2FA. A real `npx mdevolved@latest sync . --json` run from a fresh synthetic
directory returned the bounded `provide_pairing` next action, accepted no
credential argument, requested the pairing link through protected stdin, and
printed no secret. The disposable directory was removed. Desktop code
signing/notarization, repository renaming, trademark/store clearance, and paid
services remain later delivery gates; they are not MD2 acceptance criteria. No
production or personal source was used during validation, and no external cost
was incurred.

## MD3 delivery receipt

The Obsidian source implementation now lives in the product adapter at
`packages/obsidian-plugin/src/obsidian-adapter.ts`. The pinned YAOS
orchestration requests that implementation through a source-neutral port and
continues to retain Obsidian editor bindings, commands, notices, status,
runtime-profile discovery, attachment behavior, plugin identity, pairing deep
links, settings storage, direct-installer assets, and updater compatibility.

The frozen MD3 synthetic fixture runs through both the folder and Obsidian
adapters and proves identical Markdown library contents and SHA-256 durable
baseline hashes while excluding hidden, generated, and credential-shaped
paths. A populated legacy plugin-state fixture proves the existing host,
credential, `vaultId`, disk index, and source-core state upgrade in place and
start without re-pairing.

`pnpm test:md3:acceptance` is the named adapter, plugin-product, packaging,
direct-installer, updater, and release-regression gate. MD3 changes no Worker
contract, migration, deployed resource, published package version, plugin ID,
wire name, stored identifier, or user data. It requires no deployment or
package publication; no production or personal source is used for validation.

## MD4 delivery receipt

MD4 closed on 2026-08-26 in PR #41 at merge commit `801aede`. The additive
`owd-source-device-v1` contract and forward-only migration
`0037_source_devices.sql` make source/device state explicit, bind every device
to the exact source root and boundary, require owner approval for additional
devices, prevent duplicate Project creation and stale publication, and record
last-publisher provenance without granting or expanding Project authority.
Existing clients retain their prior pairing path and capability negotiation.

Two disposable synthetic devices reconciled one source through enrollment,
publication, restart, offline retry, conflict, expiry, revocation, and rejoin
without duplicate Projects, cross-source access, stale overwrite, or credential
reuse. A fresh compatible agent resumed the same durable Project while both
local clients were offline. Focused MD4 acceptance covered 112 tests; the exact
candidate also passed 89 repository test files with 537 tests, 74 browser E2E
tests, clean CLI installation, the Obsidian product/installer/updater gates,
and desktop/CLI packaging on macOS, Windows, and Linux. Required PR checks and
post-merge `main` checks were green.

Export and encrypted snapshot/restore preserve the new device history only as
inert recovery evidence and quarantine it without restoring device credentials,
grants, sessions, leases, connections, actors, OAuth state, or live authority.
Critic rework added durable fully bound replay receipts, atomic concurrency and
stale-write guards, explicit source-root persistence across CLI, desktop, and
Obsidian clients, snapshot-to-quarantine forwarding, restrictive device-history
foreign keys, and repaired migration-fixture coverage; all findings were
retested before merge.

Validation used only synthetic and disposable data. MD4 required no deployment,
package publication, release, paid service, or external cost.

## MD5 delivery receipt

MD5 changes the human-facing product
to MDevolved and the normal model to Sources, Workspaces, and durable Projects
across the web app, marketing site, folder and Obsidian onboarding, recovery,
Collaboration, snapshots, installer/update metadata, client packs, release
contracts, and public documentation. It adds the `#sources` navigation alias and
MDevolved resume/connect wording while preserving the legacy `#vaults` bookmark,
`OWD resume project`, and every frozen compatibility identifier.

No wire contract, migration, stored record, package scope, MCP tool, `vaultId`,
plugin ID, settings schema, updater path, archive format, deployment resource,
or authority boundary was renamed or widened. Existing users require no data
migration, re-pairing, reconnect, plugin reinstall, or manual edit. Folder and
Obsidian Sources share neutral normal-path copy because the strict existing
readiness contract does not expose source kind; technical vault/OWD names remain
only in explicit Advanced or compatibility details.

The candidate's focused evidence includes the 4-case MD5 static contract, 112
Worker compatibility cases, folder, CLI, desktop, Obsidian, web, marketing, and
release/package suites, plus all 74 desktop/narrow Playwright cases. Independent
critic rework corrected resume phrase delivery, source-neutral onboarding and
recovery, exact MDevolved artwork and marketing copy, Albatross generated
prompts, stale browser assertions, recovery-key filename guidance, and visible
App, Collaboration, Snapshot, and README terminology. Independent focused
testing found no remaining code regression. Exact candidate `ba40d21` passed the
complete repository gate: frozen install and audit, format/lint/types/policy and
release checks, 21 migration tests, 537 repository tests, all 74 desktop/narrow
Playwright cases, builds, and both non-deploying Cloudflare dry-runs. Required
GitHub checks and post-merge `main` health are verified in PR #43's delivery
record.

The legacy repository gate is green. On 2026-08-26, GitHub's API resolved
`msinclair25/owd-platform` to repository identity `mdevolved`, and uncached
redirect-following checks returned HTTP 200 at the renamed effective root,
`/tree/main/docs`, and `/blob/main/README.md` URLs. The earlier distinct-repo
browser/search view was stale. No production deployment, npm/plugin/desktop
publication, new repository mutation, paid service, or external cost was
performed.

## MD6 delivery receipt

MD6 closes the source-independent minimum lovable release. A Markdown folder
can now be selected through the packaged desktop bridge, published through the
shared folder adapter, resumed as the same durable Project from a fresh OAuth
authorization, checkpointed, and denied immediately after exact owner
revocation. Obsidian remains an optional compatibility adapter over the same
shared core rather than a required storage or runtime dependency.

The final live exercise used only the disposable Source
`mdevolved-md6-live.Fu6hE0` and Project `MD6 Synthetic Lantern Continuity`. A
fresh dynamically registered client received only the selected Source and one
owner-approved Project, searched and read cited Markdown, resumed a predecessor
Continuity Point written under an earlier authorization, claimed a bounded lead
lease, wrote a successor checkpoint, and re-resumed that exact successor. The
current and legacy MCP protocols both passed. The owner then revoked the exact
immutable authorization ID; its next Source call returned HTTP 401 and its
dependent Project resume was denied. No chat, transcript, hidden reasoning,
terminal history, provider runtime, credential, or local agent state entered
durable Project context.

Adversarial rework corrected packaged-desktop restore cleanup, required a real
successor checkpoint in the production harness, lengthened only the harness's
owner-review windows, and removed ambiguous duplicate-authorization ordinals.
`connection_info` now returns the existing non-secret authorization UUID, the
owner UI shows immutable IDs for duplicate labels, and focused tests prove that
revoking one same-name authorization denies only that bearer while leaving the
other authorized. This is additive and changes no durable identity, protocol
name, authority boundary, or old-client response requirement.

The named MD6 gate covers the in-memory, folder, and Obsidian adapters; hostile
filesystem fixtures; offline/restart behavior; current and legacy MCP;
encrypted export/snapshot/restore with zero restored authority; clean install
and upgrade; plugin packaging/updater compatibility; packaged desktop behavior;
accessibility at desktop and 360 px; complete repository tests; the public
history scan; builds; and both non-deploying Cloudflare dry-runs. Current
macOS, Windows, and Linux GitHub runners passed the bounded client gate; Linux
uses the documented portal-neutral preload/IPC path because its headless XDG
portal cannot accept the in-process native-picker stub.

MD6 adds no migration and required no new Cloudflare resource. The acceptance
candidate was deployed to the existing Community Worker with zero pending D1
migrations, a retained previous version for rollback, and projected
incremental cost of $0. The synthetic authorizations were revoked, the Project
was archived, every disposable Source registration was disconnected, and the
local fixture was deleted. Immutable archived/disconnected provenance remains
inert and restores no grants, credentials, actors, sessions, leases, devices,
OAuth state, or other live authority. No npm package, plugin, desktop release,
GitHub Release, paid service, R3 work, or later milestone was started.

## MD7 local candidate receipt

MD7 completes the human- and agent-facing transition to MDevolved across the
web app, marketing site, recovery and collaboration workflows, MCP guidance,
client packs, public documentation, release metadata, and the optional
Obsidian adapter. Normal workflows use MDevolved, Sources, Workspaces, and
Projects. The Obsidian product label is **MDevolved Sync for Obsidian**, while
the generic folder client remains **MDevolved Sync**.

The transition is deliberately additive. It changes no schema, migration,
stored record, authority boundary, Cloudflare resource, route, package scope,
MCP tool, plugin identity, pairing scheme, bookmark, updater path, archive
format, recovery format, or conflict filename. Existing users keep the frozen
`owd_*`, `owd://*`, `owd-pair`, `.owdignore`, `vaultId`, `@owd/*`,
`X-OWD-*`, `owd-sync`, backup, snapshot, deployment, and storage identities.
The phrases `OWD resume project` and `Connect this project to OWD.` remain
accepted compatibility language, without presenting OWD as the product.

The repository-wide MD7 contract rejects visible OWD branding on normal user,
agent, contract-error, documentation, plugin, and release surfaces while
asserting the frozen identities and both current and legacy natural-language
phrases. Independent review found and drove repairs for generated Albatross
phrase parity, source-neutral sync guidance, the recovery-key name, public
documentation, marketing artwork and spelling, consent and recovery labels,
and the complete Obsidian product name. The exact local candidate passes the
focused brand, Worker, web, plugin, packaging, browser, compatibility,
migration, build, public-history, continuity, and non-deploying release gates.
Validation uses only synthetic or disposable data and projects $0 incremental
cost.

Local acceptance does not publish the branch. MD7 remains active until the
candidate is pushed with owner authorization and the configured macOS,
Windows, and Linux GitHub checks pass on that exact commit. No production
deployment, migration, package publication, plugin release, paid service, or
external resource mutation is part of this local receipt.
