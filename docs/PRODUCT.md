# Product Definition

## Problem

People move project files between plain Markdown folders, Obsidian workspaces,
computers, and AI tools. Existing sync and provider sessions do not provide one
owner-controlled Project memory, cited continuity, or portable recovery across
those boundaries.

The Minimum Lovable Product centers a smaller promise: connect a Project once,
then let a fresh compatible agent resume durable owner-controlled memory,
retrieve targeted evidence, and leave a verified checkpoint for the next tool.
MDevolved complements execution harnesses; it does not run, schedule, route, or
supervise agents.

## Primary user

The V1 user is one technically curious owner with Markdown folders, optional
Obsidian workspaces, and multiple AI subscriptions. They want Cloudflare-managed infrastructure without
operating a server, and they want to move work among the native agent harnesses
they already pay for without repeatedly reconstructing context, provenance, and
decisions by hand.

## Distribution

MDevolved Community is the complete Apache-2.0 product deployed into a user's own
Cloudflare account. The invitation-only managed alpha runs that same single-owner data
plane in operator-provisioned, isolated managed cells. Managed hosting sells
convenience—onboarding, upgrades, monitoring, retention, and operations—not
access to otherwise withheld core vault capabilities.

The invitation-only managed alpha is an acceptance program, not a public MDevolved
Cloud launch or service-level promise. A generally available managed service
still requires the account, billing, automated provisioning, export, deletion,
operator-access, recovery, and commercial gates in
[`DEPLOYMENT-MODES.md`](DEPLOYMENT-MODES.md). Current public status lives in
[`ALPHA-STATUS.md`](ALPHA-STATUS.md).

## Release ladder

- **M1 shipped on `main`:** the agent-native `owd_resume` → `owd_find` →
  `owd_checkpoint` loop over existing durable Project records.
- **M2 shipped on `main`:** portable owner and Project preferences plus inert
  portable skills across compatible harnesses.
- **M3 shipped on `main`:** evidence-backed, owner-reviewed compounding without
  raw transcript ingestion or automatic promotion.
- **M4 shipped on `main`:** a new user can edit the current brief, review Memory
  and Skills, follow provider-neutral client recipes, run a synthetic
  cross-client continuation, and inspect local-only outcome evidence.

- **Community `v1.0-alpha` foundation checkpoint:** accepted snapshot-first
  recovery, owner authentication, bounded vault sync and libraries, remote MCP,
  and the reviewed release path.
- **Current private-alpha candidate:** deployed agent-first Project
  initialization, versioned Knowledge Spaces, Projects, Work Items, frozen
  Work Packets, immutable Attempts/Artifacts/Handoffs/Reviews, owner Decisions,
  provenance, portable fallback, Obsidian projection, and approved-record
  snapshot recovery with optional quarantined Unvetted history. One clean,
  unassisted two-agent acceptance run remains before wider tester expansion.
- **Community `v1.0` public-usability gate:** publish the sanitized
  self-service deployment path and representative MDevolved Sync installation only
  after the private-alpha collaboration proof, personal-vault safety gate, and
  public packaging gates pass.
- **Community `v1.x`:** add reviewed durable knowledge, proposal workflows,
  evolving inert Markdown skills, frozen evaluations, promotion/rollback, and
  thin native harness packs. MDevolved remains the portable intelligence and approval
  layer; each agent harness remains the execution layer.
- **MDevolved Cloud `v2.0`:** begin only after the isolated-cell control-plane,
  security, cost, operations, and commercial contracts are build-ready. Hosted
  service code cannot become a dependency of Community.

Hoplon is a separate product and an optional MDevolved client. Its connector uses the
same public OAuth/MCP contract as other clients. Hoplon adds organization and
Project policy, budgets, fixed-evidence multi-model work, and optional
evaluation; it does not become MDevolved's control plane or vault source of truth.

## V1 outcomes

- Connect a Project once, then let an agent call `owd_resume` before meaningful
  work, `owd_find` for targeted durable recall, and `owd_checkpoint` before
  finishing.
- Return bounded structured resume context rather than a raw transcript or
  provider-session replay. Default to `focused`; withhold peer conclusions in
  `independent`; compare separately attributable durable results in
  `synthesis`.
- Have the agent pass `checkpointBase` and `contextMode` from resume to
  checkpoint so focused/synthesis stale memory fails closed while independent
  work remains bound to the exact packet, without becoming a human approval
  gate.
- Preserve owner root authority and immediate revocation while granting no
  local shell, skill, Obsidian CLI, or filesystem authority.

- Deploy an isolated instance to the user's Cloudflare account in under 10 minutes.
- Claim the instance with a passkey.
- Follow one state-aware setup path that clearly separates Source sync
  pairing, encrypted recovery, agent connection, and agent-first Project
  initialization.
- Pair the first Markdown folder or Obsidian workspace in under 5 additional minutes without copying long-lived credentials.
- Browse and search the current materialized Markdown library across paired
  Sources.
- Edit Markdown text and create notes with a clear sync status.
- Observe last sync, last library refresh, retained snapshot history, and
  failure state.
- Produce timestamped, owner-key-encrypted, independently restorable snapshots
  outside the live sync layer, with all active Sources as the safe default.
- Connect a supported AI agent to one explicitly selected Source with passkey
  consent and read-only, generation-grounded access.
- In guided onboarding, select that agent, the exact first Project name, and
  its already-approved folder boundary once.
- From the supported agent already working in the project folder/workspace, say
  **Connect this project to MDevolved**. `open_project` creates, connects, rejoins, or
  resumes it. The matching prepared first Project completes in that agent
  without another website approval; a mismatch or later Project uses one exact
  owner review while the agent waits on the same MCP connection. MDevolved requires
  no copied prompt, second OAuth flow, manual ID, scope, JSON, or endpoint URL.
- Give any supported agent a frozen, cited Work Packet through MCP or a
  no-executable portable file.
- Share one agent Handoff with another agent without sharing hidden
  conversation context or silently accepting the Handoff as truth.
- Record an owner Decision that appears in a later agent's Work Packet with
  complete source and review provenance.
- Recover approved Project, Handoff, Review, and Decision records through the
  same encrypted, provider-neutral snapshot boundary as their source notes.
- Let one explicitly authorized Project lead acknowledge a bounded Continuity
  Point, then let a separately authorized replacement resume from its exact
  objective, accepted Decisions, Artifacts, evidence, open work, risks, and
  next action without restoring the prior lead's authority.
- Optionally include Unvetted Intelligence in a snapshot and restore it as
  owner-only quarantine without reactivating sharing, proposals, clients, or
  experimental Skills.

## V1 scope

- Single owner, multiple vaults.
- YAOS-compatible real-time synchronization.
- Markdown, supported attachments, and a conservative `.obsidian` backup allowlist.
- D1 full-text search over materialized Markdown.
- R2 storage for rebuildable library objects and encrypted snapshot objects.
- Optional encrypted GitHub Release export.
- Responsive web UI with keyboard-accessible core flows.
- Agent-neutral Streamable HTTP MCP access to vault- and folder-scoped search
  and note reads.
- Versioned cross-vault Knowledge Spaces, owner-directed Projects and Work
  Items, frozen cited Work Packets, and append-only agent submissions.
- Separate private/shared/accepted states, owner Decisions, complete
  provenance, and encrypted recovery for accepted Project records.
- Additive `project.lead` leases with fencing tokens, immutable Continuity
  Points, generic MCP resume/checkpoint tools, and a no-executable portable
  continuity bundle.
- A no-executable Markdown/JSON packet and submission fallback plus an
  explicitly consented Obsidian Markdown Project-notebook projection.

## R3 elastic Run outcome

R3 extends the hands-off R2 protocol for an opt-in elastic Run. One lead can
register and submit bounded batches for up to 32 active actors and 64 actor
records while a solo client keeps the same R2 API and ceremony. Cursor deltas
provide stable, Run-bound progress; exact retries are idempotent and payload
conflicts are explicit. Capacity pressure returns actionable retry metadata,
while the execution harness retains scheduling, supervision, worktrees,
branches, retries, and concurrency.

Expired or abandoned actors can be replaced with fresh, narrower scopes; the
predecessor is never revived. Harness-reported logical units and cost
microunits produce durable accounting and blocking budget Exceptions. MDevolved
exposes only aggregate privacy-safe observations and never raw transcript,
hidden-reasoning, terminal, credential, OAuth, provider-runtime, or
production/customer log data.

The inert Orca adapter maps optional worktree, branch, commit, pull-request,
and session references into generic Run/Actor evidence. Orca is optional and
non-authoritative: if its state is unavailable, a provider-neutral lead with
fresh authorization resumes from MDevolved's Run snapshot/delta. No Orca scheduling,
session, worktree, branch, pull request, or credential is imported or restored.

Every R3 record participates in encrypted portable export, snapshot, quarantine
restore, and hot/warm/cold/quarantine retention with reference-aware cleanup.
Restore never recreates authority, grants, leases, actors, credentials, OAuth
state, or live execution state.

R3 local acceptance is synthetic and automated where possible. The human-
authorized live disposable exercise remains outside this build until run; this
product definition does not claim that live gate has passed.

## R4 policy autopilot and operational continuity outcome

R4 adds an owner-authored immutable policy binding and deterministic research
and coding completion Decisions. The fixed gates use exact accepted evidence,
reviews, Continuity Points, budgets, Exceptions, Project versions, leases, and
fences. They do not use model confidence, hidden reasoning, raw transcripts,
terminal history, provider state, or production logs. A lead cannot author or
approve the policy that judges its work. Self-approval, policy editing,
authority expansion, destructive action, protected paths, conflicting or
missing evidence, budget exhaustion, integrity failure, and unsupported
upgrade or rollback remain explicit Exceptions or owner-only actions.

The existing Worker scheduled event is only a bounded, idempotent trigger for
Continuity Point and disposable drill requests. External provider-neutral
harnesses still own agents, planning, retries, tools, worktrees, inference, and
scheduling. A fenced replacement lead may complete only the exact scheduled
drill request and source Continuity Point, producing an immutable redacted
receipt with measured RPO, RTO, continuity age, recovery quality, and runtime
independence.

All five R4 durable record kinds participate in dependency-complete portable
export, encrypted snapshot inventory, reference-aware retention, integrity
monitoring, and quarantine-only fresh Community restore. Recovery recreates no
grant, lease, actor, credential, OAuth state, policy authority, scheduler
authority, or other live authority. R4 local evidence is synthetic and incurs
no provider or remote-infrastructure cost; live deployment and provider drills
remain separate human-authorized gates.

## Explicit exclusions

- Teams, sharing, per-note ACLs, or multiple owner accounts.
- A shared multi-tenant vault database or shared runtime secrets between
  managed owners.
- Full Obsidian rendering parity.
- Canvas editing, attachment editing, note rename/delete, or arbitrary `.obsidian` writes.
- Server-side possession of a GitHub account password or backup decryption private key.
- Claims that synchronization alone is a backup.
- Automatic destructive restore.
- An embedded model, inference gateway, or required agent runtime.
- Direct autonomous agent writes, unreviewed shared memory, or executable
  skills before backup and recovery are proven.
- A fixed planner, builder, reviewer, or vendor-specific agent sequence.
- Automatic agent routing, subscription control, conversation scraping, or
  server-side possession of model-provider credentials.
- An embedded scheduler or agent supervisor remains excluded. R4 emits only
  bounded provider-neutral operational requests and receipts.
- Automatic promotion of inferred preferences or skills, or treating a
  correlation as proof; M3 suggestions remain owner-reviewed drafts.
- Claims that a local candidate is deployed to production, or that data survives
  across computers without a deployed MDevolved endpoint/account and backup.

## Product principles

- Keep users oriented. Selections update the relevant panel without resetting
  the page. MDevolved preserves scroll position, focus, and stable layout while
  dependent content loads; it clears only data made invalid by the new choice.
  Source vault, target vault, and backup identity remain visible throughout
  sensitive workflows, and stale responses from earlier selections never
  replace the current state.
- Recovery is a product feature, not a runbook footnote.
- Safe defaults beat maximum configurability.
- The interface distinguishes live sync, the current searchable library, and
  retained encrypted snapshots. It never calls an ordinary library refresh a
  backup.
- Every snapshot is logically complete and independently restorable; storing
  only changed objects is automatic and never presented as a risky
  full-versus-incremental choice.
- Snapshot creation selects **Approved Intelligence** by default and offers
  **Unvetted Intelligence** as an explicit nested option. The latter restores
  only into owner-visible quarantine. The UI shows exact intelligence classes,
  counts, and bytes and never describes a vault-only snapshot as complete
  intelligence recovery.
- "Everything" means the current portable owner state in every selected active
  vault, not credentials, device caches, or the complete internal sync journal.
  An unavailable selected vault fails visibly instead of being omitted.
- Portable snapshot exports restore across compatible Community, SaaS, local
  file, and future local-runtime contexts without contacting the source
  installation. Provider convenience never becomes owner lock-in.
- Advanced Cloudflare controls may enhance the deployment but cannot break sync.
- Self-hosting should feel like installing an app, not assembling infrastructure.
- First run is a guided, resumable path—not a feature index. Show one truthful
  next action, explain what MDevolved will access in plain language, derive completion
  from authoritative state, and collapse finished steps into a compact
  readiness summary.
- Daily agent work stays in the owner's existing project folder, Obsidian
  vault, and agent harness. The MDevolved website handles setup, consent, visibility,
  owner Decisions, revocation, recovery, and advanced inspection; it is not a
  mandatory project workspace.
- MDevolved Sync synchronizes only the explicitly paired vault. Agent access and
  collaboration use the separately consented remote MCP boundary.
- Project is a durable provenance and authorization identity, not routine
  setup labor. The normal dashboard empty state directs the owner to initialize
  from an agent; manual Project construction is an advanced fallback.
- Vault identity is always explicit; no agent operation relies on a current or
  inferred vault.
- Agent suggestions and owner authority are separate capabilities.
- Shared agent intelligence is promoted, not passively accumulated: evidence
  becomes a candidate, candidates are evaluated, and only owner-reviewed
  versions become stable defaults.
- Visibility and truth are separate: an owner may share a Handoff for review
  without accepting it as a Decision, durable Knowledge, or a stable Skill.
- Roles belong to individual Attempts, not agent brands. Any compatible client
  may plan, research, build, review, or perform a custom role.
- MDevolved reduces repeated explanation through frozen Work Packets and accepted
  Project history; it does not require agents to expose their complete hidden
  conversations.
- A Continuity Point is acknowledged operational state, not a new owner
  Decision or accepted truth. It carries provenance but never a live grant,
  lease, credential, transcript, hidden reasoning, or runtime state.
- Adding a vault or folder to a future knowledge space never silently broadens
  an existing client grant; new content requires new consent.
- Open-source Community deployments never depend on billing or a hosted
  control plane.

## Success metrics

- Median deployment-to-dashboard time under 10 minutes.
- Median first-vault pairing time under 5 minutes.
- At every clean-install setup state, the landing page presents one
  unambiguous primary action and resumes correctly after reload, denial,
  expiry, or disconnect.
- Every surfaced snapshot has a verified manifest, an explicit scope and
  capture window, intelligence selection, section counts/bytes, and recovery
  instructions.
- No user must expose a long-lived sync secret during normal pairing.
- A failed library projection or snapshot is visible without inspecting Worker
  logs.
- A first AI client connects in under two minutes without copying a static API
  key, bearer token, raw scope, internal ID, JSON, or manually transcribed
  endpoint; revocation denies its next tool call.
- After vault and client setup, the owner initializes MDevolved and receives the first
  Work Packet from the working agent in under one minute, with at most one
  browser confirmation, no second MCP authorization, and no manual Project
  form, IDs, raw scopes, JSON, copied prompt, or endpoint URL.
- The owner can make one shared Handoff available to another authorized agent
  in under one minute without manually recreating the Project history.
- The dashboard identifies authorization-bound agent clients and their durable
  interactions/contributions separately from claimed harness/model metadata,
  without ingesting hidden conversations or presenting a quality leaderboard.
- Every accepted Decision identifies its producing packet, sources, artifacts,
  reviews, and owner action, and appears in a compatible later packet.
- In a disposable replacement drill, a newly authorized lead can regain the
  latest bounded Project context in under five minutes while stale fencing
  tokens and restored authority remain unusable.
- After one owner instruction to use MDevolved, an authorized lead can create a Work
  Item, start a bounded Run, delegate to at least three claimed actors, share a
  provisional result, route an independent review, checkpoint, and close the
  Work Item without routine dashboard action. Privileged requests, exhausted
  budgets, and conflicting evidence stop as explicit visible Exceptions.
- In the R3 synthetic gate, a solo client and a 20-plus-actor Run use the same
  generic services; all Run deltas are stable and Run-scoped; retries produce
  no duplicate records; and owner action remains exception-driven rather than
  proportional to actor count. The live disposable exercise is human-
  authorized and not yet a local automated result.
