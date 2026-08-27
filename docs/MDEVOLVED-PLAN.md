# MDevolved source-independent product plan

**Status:** MD1–MD8 are complete; MD9 is active; MD10–MD11 are queued in the MLP plan.<br />
**Date:** 2026-08-27

> **Next execution plan:** [MDevolved minimum lovable product plan](MDEVOLVED-MLP-PLAN.md).
> This document remains the historical MD1–MD8 architecture and delivery
> record. Its decisions to retain OWD as the canonical protocol and plugin
> identity are superseded for new writes and new installations by the active
> MD9 candidate. They
> remain binding compatibility requirements for existing users and data until
> MD9 passes its exact-candidate and owner-authorized delivery gates.

## Milestone boundary

MD0 planning and MD1 through MD7 delivery are complete. The source-neutral
architecture, compatibility rules, rollout order, security boundaries, and
independent acceptance decisions below remain explicit. MD5's final candidate
passed its exact complete gate and authoritative legacy-repository redirect
check. Its required PR checks, merge, and post-merge `main` health complete the
recorded delivery workflow. MD7 completed the human- and agent-facing naming
transition without changing frozen compatibility identities. MD8 passed its
exact local acceptance and repository gates; commit, push, PR, deployment, and
named proprietary-client certification remain separate delivery actions.

## Product promise

> MDevolved gives every AI the right project memory, regardless of where the
> project files live.

MDevolved is durable, owner-controlled Project memory for people who move work
between AI tools, computers, and local workspaces. A plain folder is the
compatibility floor. Obsidian becomes an optional, deeply integrated source
adapter instead of a prerequisite.

The lovable moment expands from continuity into autonomous delivery: after one
owner instruction, a single agent or a harness-managed group of agents receives
the right bounded work, verifies it, preserves useful evidence, and continues
from the exact next action without copied prompts, reconstructed provider
sessions, or routine owner coordination.

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
7. **Autonomy must reduce owner work.** The normal path is one initial Project
   instruction and consent followed by machine-managed resume, bounded
   delegation, verification, checkpoint, review when required by the selected
   completion policy, and continuation. The owner returns only for an explicit
   exception or a decision that exceeds previously granted authority.
8. **MDevolved coordinates but does not execute.** Harnesses retain agent
   spawning, scheduling, supervision, tools, worktrees, retries, and test
   execution. MDevolved retains durable Project identity, scoped Work Items and
   Work Packets, actor claims, evidence, review, continuity, recovery,
   revocation, and exceptions.
9. **Compatibility is capability-negotiated, not brand-coded.** Apps, IDEs,
   CLIs, headless agents, agent managers, and orchestration frameworks use the
   same versioned services according to the tools, transports, identity,
   context-isolation, and lifecycle signals they actually support. A provider
   name never changes Project truth or authority.
10. **Workers may connect directly or through their lead.** A compatible actor
    may call MDevolved itself, or an authorized harness lead may register actors
    and submit their bounded evidence. Subagents are not required to share one
    MCP connection, credential, conversation, or runtime.

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

Human usability feedback is valuable but is not a prerequisite for MD1-MD8
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

## Autonomous Project Loop

The normal path begins with **Connect this project to MDevolved** and should not
create a second planning job for the owner.

For one agent in focused mode, the current unit is the latest valid Continuity
Point's `nextAction`, falling back to the active Work Packet objective when no
point exists. The agent works with its native harness, performs
task-appropriate verification, checkpoints bounded evidence, and receives the
next unit. Compatible-client behavior keeps the same semantic unit active after
failed verification and records the useful failure; MDevolved does not claim
that an arbitrary client-reported sentence proves the check ran.

For an orchestration, the harness or its authorized lead delegates bounded
units inside one Run and registers multiple claimed actors against that Run's
Work Packet. Each actor receives only the context and authority required for
its role. Focused actors receive current accepted state, independent actors omit
peer conclusions, and synthesis actors receive permitted provisional results.
An independent reviewer receives the target provisional result and its rubric,
but not hidden reasoning, runtime state, or unrelated context supplied by the
harness. MDevolved records actor claims, bounded results, review routing,
conflicts, checkpoints, and the next eligible work; the harness decides which
agent runs and when.

Verification evidence is concise, provider-neutral, and reported by the client.
MDevolved does not claim to execute or independently prove a test, and it does
not ingest raw logs, transcripts, hidden reasoning, terminal history, runtime
state, or credentials. Coding units may use focused tests, type checks, builds,
or smoke checks. Research units use cited evidence and an explicit acceptance
rubric rather than a fake shell test.

Routine expiry and exact-context renewal remain machine-managed. Authority
expansion, destructive action, protected-path access, budget exhaustion, and
conflicting evidence produce the existing explicit Project Exceptions.
Revocation produces an immediate authoritative denial. Other blockers remain
durable in the Continuity Point and halt compatible-client continuation instead
of being mislabeled as a Project Exception or silently treated as completion.

## Client and orchestration compatibility

MDevolved supports integration shapes rather than maintaining a separate
workflow engine for every agent product:

- **Direct MCP hosts:** desktop apps, IDE agents, and terminal agents that can
  connect to remote HTTP MCP with OAuth call the normal resume, context,
  checkpoint, Run, evidence, review, and exception tools directly.
- **Lead-mediated harnesses:** agent managers, multi-agent workbenches, and
  graph runtimes may keep one authorized lead connection. The lead registers
  scoped actors, gives each worker a bounded unit through its native mechanism,
  and submits provider-neutral results and review evidence without copying
  credentials or raw runtime state into the workers.
- **Portable fallback:** clients without usable remote MCP receive the same
  bounded Work Packet and return a versioned Markdown/JSON handoff through the
  existing inert skill or file boundary. This remains less automatic than MCP
  but preserves Project identity and compatibility.

The representative compatibility matrix includes interactive apps such as
Codex, Claude, Cursor, and Antigravity; their CLI or headless counterparts;
native agent harnesses such as Grok Build and Hermes Agent; provider-CLI
managers such as T3 Code; multi-agent workbenches such as Orca ADE; and
framework runtimes such as LangChain/LangGraph. These names are acceptance
fixtures and live-smoke targets, not durable enum values or required runtime
dependencies.

Capability negotiation must establish the supported protocol and context
version, direct or lead-mediated operation, OAuth and mutation availability,
focused/independent/synthesis context modes, actor and bundle ceilings,
idempotency behavior, and bounded evidence formats. Unsupported optional
capabilities degrade to the next compatible integration shape instead of
silently widening access or failing the whole Project.

MDevolved never changes a client's sandbox, tool approval, permission, network,
or background-execution settings. Hands-off operation means no repeated
MDevolved-specific owner work after the owner has configured and consented to
that client's ordinary trusted-tool policy. A client that requires approval for
every MCP call remains supported, but cannot truthfully be advertised as
hands-off until its owner enables a bounded native auto-approval mode.

The compatibility rule applies across the complete product, not only MD8:

| Product surface            | Cross-client requirement                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source sync                | Folder and Obsidian adapters publish the same durable library without knowing which agent, app, CLI, or orchestrator will consume it.                                                                                                                                |
| Setup                      | The dashboard always offers one universal remote-MCP path, then optional generated helpers for clients whose native installer or configuration format materially reduces owner work. Helpers contain no token or authority.                                          |
| Identity and consent       | Every direct client has its own OAuth identity and exact grant. Lead-mediated workers have distinct claimed actor identities but receive no copied OAuth credential or implied authority.                                                                            |
| Context and memory         | Focused, independent, and synthesis context; working preferences; attached Skills; citations; and Continuity Points remain provider-neutral, bounded, and attributable. Skills remain inert until a compatible harness chooses to load them.                         |
| Autonomous work            | Direct MCP, lead-mediated MCP, and portable handoff use the same Project, Work Item, evidence, review, checkpoint, and exception semantics.                                                                                                                          |
| Evidence and observability | Apps may report different native test, build, review, and lifecycle events, but MDevolved stores only bounded normalized evidence and redacted receipts, never raw transcripts, logs, or runtime state.                                                              |
| Export and recovery        | Portable export, encrypted snapshot, restore, and quarantine preserve Project truth and compatibility metadata without restoring client credentials, sessions, actors, leases, grants, scheduler state, or provider runtime.                                         |
| Owner UI                   | Activity and revocation show the actual client, grant, actor, Run, capability, and provenance while normal Project concepts remain the same across brands.                                                                                                           |
| Release evidence           | Protocol conformance is universal. Named clients receive separate dated receipts recording exact app/CLI version, transport, capabilities, approval mode, tested operations, limitations, and last verification date. A generated setup helper is not certification. |

Client drift is expected. A newer client version that removes or changes a
capability falls back safely or loses its dated supported status; it never
causes a durable Project migration. Add a client-specific pack only when a
universal connection plus capability negotiation cannot provide a usable path,
and keep that pack optional, generated, script-free where possible, and covered
by the same authority and recovery invariants.

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

### MD8 — Autonomous Project Loop

**Outcome:** After one initial instruction, either one compatible agent or a
harness-managed orchestration can keep a coding or research Work Item moving
through bounded work, verification, review, checkpoint, and exact continuation
without routine owner coordination.

**Build:** First freeze synthetic baseline evaluations for premature
completion, wrong-unit resume, failed-verification advance, repeated owner
action, context leakage, redundant calls, latency, and cost. Then reuse the
existing Project, Work Item, Work Packet, Run, Actor, Event Bundle, Review,
Continuity Point, and Exception services to present one deterministic current
unit and next unit through the existing transport-neutral services, MCP
guidance, and compatible client packs.

Freeze contract fixtures for direct MCP, lead-mediated MCP, and portable
handoff clients before changing behavior. Test representative interactive,
terminal/headless, provider-manager, workbench, and graph-runtime adapters
without embedding product names in durable schemas. A client pack may explain
native installation or lifecycle integration, but it must remain inert,
optional, generated from the same provider-neutral contract, and unable to
expand authority.

The current completion contract always requires three claimed actors and an
independent passing review, so it cannot close a genuinely single-agent Work
Item. MD8 must add the smallest additive, versioned completion-policy choice:
the existing contract remains the default **orchestrated reviewed** mode, while
an explicitly owner-consented **solo verified** mode may close only after
task-appropriate evidence, a fresh fenced checkpoint, a current deterministic
policy allow Decision, and no blocking exception. Old records and clients map
to orchestrated reviewed mode. Any new durable field receives forward-only
migration, export, snapshot, restore, quarantine, retention, and no-restored-
authority coverage. Add no scheduler, executor, stop hook, GLRP artifact,
per-actor planning subsystem, or separate planning UI.

**Acceptance decision:** Close only when the same synthetic coding and research
fixtures prove both paths from only **Connect this project to MDevolved**:

- one authorized agent under the owner-consented solo verified policy resumes,
  performs, verifies, checkpoints, continues through successive deterministic
  units, and closes one Work Item without claiming independent review;
- one authorized lead delegates to at least three claimed actors, shares only
  permitted provisional results, routes an independent review, checkpoints the
  accepted evidence, and closes one Work Item through the existing orchestrated
  reviewed policy;
- compatible-client evaluation proves failed or malformed verification retains
  the same semantic unit; server-side completion rejects missing required
  evidence, policy, checkpoint, review when applicable, or blocking-exception
  gates; stale and changed replays conflict, exact replay remains idempotent,
  and a fresh compatible client on another computer resumes the exact next
  unit;
- the happy paths require no owner action after initial consent, while authority
  expansion, destructive action, protected paths, exhausted budgets,
  conflicting evidence surface as Project Exceptions, revocation fails closed,
  and other blockers halt continuation with an explicit next action; and
- old clients remain compatible, independent actors do not receive forbidden
  shared conclusions, no raw harness state enters durable context, restore
  creates no authority, and the candidate improves the frozen autonomy
  baseline without a material operator-work, latency, call-count, or cost
  regression;
- the same Project completes through direct MCP and lead-mediated MCP fixtures,
  resumes through the portable fallback, and passes disposable live smokes on
  at least one interactive app, one terminal/headless agent, and one
  orchestration or agent-management host when those clients are available at
  zero projected cost. Unavailable proprietary clients remain an explicit
  compatibility risk rather than a false acceptance claim.

## Required verification matrix

- Shared-core contract tests run against in-memory, folder, and Obsidian ports.
- Filesystem fixtures cover case collisions, Unicode, traversal, symlinks,
  rapid rename/write bursts, partial writes, permissions, offline recovery, and
  very large trees under explicit ceilings.
- Worker tests cover old-client compatibility, source-kind isolation, immediate
  revocation, export/snapshot/restore, quarantine, and no restored authority.
- Autonomous-loop evaluations cover single-agent and three-actor orchestration,
  deterministic unit selection, failed-verification retention, isolated review,
  replay conflicts, exact cross-client resume, bounded evidence, explicit
  exceptions, and zero routine owner action on the happy path.
- Client-shape fixtures cover direct MCP, lead-mediated MCP, portable handoff,
  interactive app, CLI/headless, provider-manager, workbench, and graph-runtime
  integrations. Live smokes are representative and additive; no proprietary
  client is allowed to become a Community runtime dependency.
- Desktop E2E runs on current macOS, Windows, and Linux GitHub runners.
- Obsidian E2E keeps the pinned plugin, direct-installer, and updater paths.
- Release gates keep the complete public-history scan and existing Community
  build/deploy checks.

## Explicit non-goals

- A Dropbox, Git, Google Drive, OneDrive, or iCloud replacement.
- Mirroring arbitrary code, binaries, dependency trees, or an entire home
  directory in the first folder release.
- Executing skills, agents, shell commands, or provider APIs.
- Owning agent scheduling, supervision, worktrees, retries, test execution, or
  a harness stop/continue loop.
- Reimplementing Codex, Claude, Cursor, Antigravity, Grok Build, Hermes, T3 Code,
  Orca, LangChain/LangGraph, or any other harness's runtime, thread store,
  checkpoint graph, permissions, or agent manager.
- Adding a durable provider-name switch or requiring one client-specific plugin
  when capability negotiation, lead mediation, or the portable fallback works.
- Requiring owners to maintain a duplicate plan, manually create every unit,
  copy context between actors, interpret raw agent logs, or choose the next
  routine action.
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

## MD7 delivery receipt

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

The validated candidate was pushed with owner authorization to PR #45. Its
configured macOS, Windows, and Linux package checks passed, along with the
complete GitHub verification job on the exact candidate. No production
deployment, migration, package publication, plugin release, paid service, or
external resource mutation was part of MD7 delivery.

## MD8 delivery receipt

MD8 implements the Autonomous Project Loop without making MDevolved an agent
runtime. An owner may retain the existing **orchestrated reviewed** policy or
explicitly activate **solo verified** completion. The reviewed path requires an
authorized lead, at least three claimed actors, independently routed review,
accepted evidence, a fresh fenced checkpoint, a current policy allow Decision,
and no blocking exception. The solo path requires one actor, explicit active
owner consent, task-appropriate reported evidence, the same checkpoint and
Decision fences, and no false independent-review claim. Revoking or replacing
solo consent immediately prevents an in-flight solo Run from completing.

The versioned contracts and generic MCP surface negotiate direct MCP,
lead-mediated MCP, and portable-handoff operation. Representative fixtures
cover interactive applications, terminal and headless agents, provider
managers, multi-agent workbenches, and graph runtimes without making any
product name a durable enum or runtime dependency. Explicit
`sourceWorkPacketId` inheritance records same-Project accepted packet and
evidence dependencies; omission inherits nothing. Focused, independent,
run-shared-unvetted, reviewer, and synthesis contexts retain their documented
visibility boundaries. MDevolved stores bounded provider-neutral evidence and
provenance, never raw transcripts, hidden reasoning, terminal history,
credentials, scheduler state, or provider runtime.

Forward-only migration `0038_autonomous_completion_mode.sql` adds the Run
completion mode and owner policy-consent flag with reviewed-safe defaults. Old
records and clients remain orchestrated reviewed. New durable values participate
in portable export, encrypted snapshot, staged restore, quarantine, retention,
and no-restored-authority checks. Restore never revives grants, actors, leases,
credentials, OAuth state, sessions, or live consent; rollback code ignores the
additive columns rather than attempting a destructive down-migration.

Focused acceptance covers solo coding and research, the actual three-actor
lead-mediated MCP loop, direct MCP, portable continuity, explicit evidence
inheritance, old-client compatibility, replay and idempotency conflicts,
cross-Run and cross-Project denial, revocation and expiry, context isolation,
malformed and oversized bundles, evidence conflict, budget exhaustion,
protected paths, destructive requests, and restore without authority. The
complete repository gate additionally covers contracts, Workers services,
web UI, source adapters, CLI, desktop, Obsidian, migrations, public-source
history, builds, browser acceptance, and non-deploying Cloudflare dry-runs.
The exact named MD8 gate passes 8 test files and 157 tests plus both
client-shape contract checks. The complete repository evidence passes 91 core
test files and 551 tests plus the YAOS, folder, CLI, desktop, Obsidian,
marketing, continuity, and lifecycle package suites; 74 browser cases; 20
migration files and 23 migration tests; builds; public-history inspection; both
non-deploying Cloudflare dry-runs; and the final format, lint, type, policy,
release, and 33-migration managed-cell checks.

Adversarial review found and drove repairs for strict v1 operational-overview
compatibility, a missing real lead-mediated MCP exercise, implicit evidence
inheritance without explicit provenance, ambiguous Run context visibility,
owner consent replacement, and migration-ledger fixtures. The remaining
compatibility risk is empirical rather than architectural: synthetic fixtures
prove integration shapes, but unavailable proprietary client releases are not
claimed as dated live certification. Harness-reported verification remains
reported evidence; MDevolved does not execute or independently attest the
underlying tests.

All MD8 validation uses synthetic local data and projects $0 incremental cost.
It creates no external Cloudflare resource and performs no production mutation,
package publication, repository push, or deployment. The accepted local
candidate remains uncommitted on `codex/md8-autonomous-project-loop`; repository
and release actions require separate owner authorization.
