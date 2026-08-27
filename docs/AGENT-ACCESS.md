# Agent Access Architecture

## Purpose

MDevolved exposes portable, owner-controlled Project memory so compatible clients can
continue work from durable objectives, evidence, decisions, useful failures,
and next steps. It complements each client's native harness. It is not an
inference gateway, scheduler, worktree manager, or agent supervisor, and it
never grants local shell, skill, Obsidian CLI, or filesystem authority.

The read-only vault boundary, collaboration ledger, agent-first Project
connection, M1 three-operation memory facade, portable preferences and skills,
and evidence-backed owner-reviewed compounding are released on `main` and the
persistent Community alpha. A compatible protocol implementation still does
not imply a named-client acceptance claim.

The collaboration model and future durable-intelligence layers are defined in
[`PORTABLE-INTELLIGENCE.md`](PORTABLE-INTELLIGENCE.md). The current alpha makes
the deployed Project, Work Item, Work Packet, Handoff, Review, and Decision
records usable from the owner's working agent before generalized memory or
skill automation.

## Ordinary Project memory contract

One MCP connection and one Project consent cover the normal loop:

1. `owd_resume(projectId, task?, contextMode?)` returns a bounded, cited,
   structured brief. It does not replay raw transcripts or provider sessions.
   `focused` is the default; `independent` withholds peer conclusions,
   provisional results, and record bodies; `synthesis` includes only separately
   attributable durable shared results.
2. `owd_find(projectId, question)` searches the current brief, recent durable
   Project memory, and authorized current library within explicit ceilings.
3. `owd_checkpoint(...)` appends a compact outcome, verification evidence,
   useful failures, remaining work, and next action. The agent passes the
   opaque `checkpointBase` and `contextMode` returned by `owd_resume` unchanged.
   Focused and synthesis stale bases fail closed; independent bases remain
   bound to the exact frozen Work Packet. Exact retries are idempotent.

`checkpointBase` and `contextMode` are agent-handled receipts, not a recurring
owner gate.
Provider-session expiry does not erase MDevolved records. Cross-computer preservation
requires a deployed endpoint/account plus backup; revocation remains effective
on the next call.

## Protocol boundary

- Serve authenticated MCP `2026-07-28` Streamable HTTP at `/mcp`, with
  stateless `2025-11-25` compatibility, from the existing integrated Worker.
  The exact claim and fail-closed matrix are frozen in
  [`MCP-COMPATIBILITY.md`](MCP-COMPATIBILITY.md).
- Start with Cloudflare's stateless MCP handler. Conversation and reasoning
  state belong to the client; ordinary tool calls do not justify a Durable
  Object per MCP session.
- Use the existing vault Durable Object only when a future approved mutation
  must enter canonical Yjs state. Ordinary reads use published D1/R2
  materializations and must not wake the live vault object.
- Keep Hermes optional. Hermes may consume MDevolved as an MCP client and provide
  schedules, messaging, or long-running execution, but MDevolved cannot depend on a
  Hermes installation.
- Keep Orca ADE optional. An agent CLI launched inside Orca may consume MDevolved
  through the same public OAuth/MCP contract as when it runs directly. The
  OAuth client and grant remain authoritative; an Orca name, worktree, task,
  dispatch, terminal, session, or model label is unverified context and never
  grants authority. MDevolved does not invoke the Orca CLI, control agent processes,
  import terminal transcripts, or inherit Orca permission settings.
- Keep Hoplon separate. Hoplon may route models and consume MDevolved tools, but MDevolved
  remains responsible for vault authorization, content provenance, and owner
  approval. Hoplon connects through the same public OAuth/MCP contract as other
  clients and never receives a YAOS credential or privileged data-plane path.

## Authorization model

MDevolved acts as both the MCP protected resource and its OAuth authorization server.
The existing passkey session authenticates the owner during authorization and
consent. The OAuth provider library handles protocol artifacts in a dedicated
KV namespace; D1 stores the authoritative MDevolved grant and policy record.

Every tool call must re-evaluate the active D1 grant. Token validity alone is
not authorization. This makes client, vault, folder, and scope revocation
effective on the next tool call even if protocol storage has not yet expired.

Each initial grant binds:

- one OAuth client identity and redirect URI set;
- an audience identifying this MDevolved deployment's MCP resource;
- exactly one vault;
- allowed path prefixes and excluded namespaces;
- named scopes;
- zero or more exact recovery restore sources, each disabled unless separately
  selected by the owner; and
- grant, access-token, and refresh-token lifecycle metadata.

Authorization uses PKCE, state and redirect validation, resource indicators,
short-lived access tokens, revocable refresh grants, and per-client consent.
MDevolved never accepts token passthrough to another service. The consent screen
shows the client name, redirect domain, verified or unverified status, exact
vault names, path boundaries, and requested capabilities.

An active recovery target does not imply agent access to data copied into it.
Applied restore paths remain a separate authorization class. Consent lists
each named restore source for the selected target and leaves every one
unchecked. Existing grants have no restore-source approval. Search, recent
changes, direct reads, Project source selection, and Project discovery all
fail closed for those paths until the owner reconnects and approves the exact
restore ID. Approved reads preserve both target-vault and restored-source
provenance. The lineage is path-bound rather than hash-bound so later edits do
not silently erase it.

Protected-resource metadata advertises only the minimum initial connection
scopes: `vault.read`, `project.initialize.request`, and
`project.connect.request`. General MCP clients may request every scope listed
there when the initial `WWW-Authenticate` challenge does not name a narrower
set. MDevolved never grants collaboration scopes in that source token, and mixed
initial scope requests remain invalid rather than being normalized into broader
authority. After exact owner Project approval, MDevolved stores a separate
collaboration grant and resolves it through the still-active source connection
for the explicit Project ID. This preserves the separate authorization record
without a second client OAuth flow.

The current beta lifetime contract is one hour for an access token, 30 days for
its renewable OAuth window, a 30-day sliding availability window for an active
separately authoritative Project grant, and 90 days for a dynamic client
registration. These are availability windows, not delegated authority by
themselves. Every call still rechecks the active source and Project grants,
exact audience and client, scopes, Project, pinned Knowledge Space version, and
revocation. A fresh chat reuses only the client's protected OAuth state and
refresh flow; credentials are never copied into a prompt. Authorized use renews
routine Project-grant availability automatically. Explicit revocation denies
the next call and cannot self-heal.

### Knowledge spaces

The one-vault grant remains the simple default. A Knowledge Space is a named,
versioned selector over explicit vault IDs, allowed path prefixes, and excluded
namespaces. It is authorization policy, not a copy of the notes.

- A grant binds one evaluated space version and records its exact vault/path
  members at consent time.
- Removing a vault or path denies it on the next tool call.
- Adding a vault or widening a path creates a new space version and requires
  fresh owner consent; existing grants never expand silently.
- Renaming a display label does not change authority. Vault and path identities
  remain explicit in every result and audit event.
- A client may receive several separately consented grants, but MDevolved never infers
  a global current space or merges their results without an explicit request.

This lets one owner expose a deliberate cross-vault working set to several
agents without weakening the exact-vault safety model already proven in V1.

### Agent-first Project connection

An existing consented source connection may carry the request-only
`project.initialize.request` and `project.connect.request` capabilities,
distinct from `vault.read` and every approved collaboration scope. They can ask
for browser consent but cannot grant Project authority by themselves.
`open_project` is the primary entry point for create, connect, rejoin, and
resume. It opens one compatible Project automatically, asks only when several
compatible Projects make identity ambiguous, and prepares a bounded New Project
draft when none exists.
A local `.owdignore` `projectId` is authoritative. When the user names work
without a local receipt, the agent passes that exact name as `projectHint`; no
differently named Project may be selected silently.

For the normal first Project, the owner chooses the exact active agent, visible
Project name, and already-approved folder during web onboarding.
`connection_info.preparedProjectHandoff` exposes those machine-ready values,
and `open_project` applies that prepared identity even if a client supplies no
explicit identity. The matching first create or join consumes the handoff once
and returns ready on the same MCP connection without another browser loop.

When a handoff does not match, has already been consumed, or an advanced repair
is needed, `open_project` returns one self-contained approval envelope as both
JSON text and MCP `structuredContent`, plus a standard `resource_link`; the
waiting owner dashboard detects the same request automatically. The two JSON
representations are identical so a wrapper that preserves only text still
receives the approval URL, public request ID, visible Project and vault labels,
exact Project ID when one exists, and the opaque `accessKey` or
`initializationKey`. The `wait` object names `wait_for_project_connection` and
carries that exact key. The agent calls it on the same MCP connection rather
than asking the user to paste a prompt or reconnect.

New Project requests use `/initialize?requestId=…`; existing-Project requests
use `/connect?requestId=…`. The path communicates intent but grants no
authority, and historical `/initialize` links continue to load the same
server-validated consent record. The request UUID in either URL is public owner
handoff state. It is never the private wait key and cannot approve itself.

The normal client algorithm is fixed:

1. Read `connection_info` when no local receipt exists. If it contains
   `preparedProjectHandoff`, use its exact label and folder; an empty folder is
   the entire approved vault boundary.
2. Call `open_project` with a local receipt ID, the prepared or user-named
   identity, or one bounded New Project draft.
3. If the result is ready, persist its continuity files and continue.
4. If owner approval is required, present the one `approvalUrl` and immediately
   call the tool and key named by `wait`.
5. Repeat only that bounded wait while approval remains pending.
6. In a fresh task, read `.owdignore` and call `owd_resume` with its exact
   Project ID.

When `.owdignore` exists, step 6 is the first MDevolved action. The session's writer
role remains unconfirmed until `owd_resume` returns
`localVaultAccess.role`; a fresh chat, process, or context window does not
change the durable assignment. Clients must not report “not primary,” reconnect
MCP, or seek new Project approval based only on missing conversation memory.
If automatic startup is missed, **MDevolved resume project** is the human fallback
phrase for that same resume call.

If a wrapper or context compaction loses the pending envelope before the wait,
the client repeats the exact same `open_project` arguments once. Idempotent
recovery returns the same durable request, approval URL, and wait key; it does
not create a second Project or owner action. This is the only pending-state
recovery exception to the rule against restarting an approved workflow.

MDevolved does not infer which Markdown is legitimate and cannot inspect or move the
client-local repository. The agent must inventory root Markdown, retain
conventional repository control files, ask about exact `docs/` moves for the
remaining Project documentation, and use actual root paths if the owner
declines. The owner may narrow or otherwise correct the context proposal, but
cannot broaden it beyond the active source vault grant or original folder
boundary. Only that browser action invokes the transport-neutral owner service
that appends Project/Knowledge Space/Work Item records and atomically creates
the separately scoped collaboration grant. The source grant and existing
access token are never widened in place, and no second OAuth authorization is
required.

The approved selector is returned as a canonical `.owdignore` JSON receipt
containing the exact `projectId`, `includePaths`, and `excludePaths`, plus a
marked Project-continuity block for the root `AGENTS.md`. The agent preserves
all existing instructions and merges only that marked block. On every fresh
task, the block requires the agent to read `.owdignore` and call
`resume_project` with that exact identity and policy. The tool returns durable
context only after the supplied manifest exactly matches the active grant's
pinned Knowledge Space selector hash. Missing, malformed, changed, broadened,
or stale policy fails closed. `.owdignore` affects Project context selection
only; it does not silently remove notes from vault synchronization or recovery.
`resume_project` also returns the current receipt and managed block so an
existing Project replaces only that marked block when MDevolved hardens its
instructions; no reconnect or new owner approval is needed.

Local Obsidian CLI, skill, shell, and filesystem permissions remain separate
from MDevolved authorization. The human remains the owner. The first client that
establishes an MDevolved Project for a vault becomes that vault's primary writer
across Projects; later clients receive the advisory
`read-only-collaborator` role. Every open, completed connection, and resume
returns `localVaultAccess`, and the managed `AGENTS.md` block requires checking
that role before local mutation.

The primary writer still needs an explicit owner instruction for a bounded
task. Other agents warn the owner and report or hand off proposed changes. The
same authorized MDevolved client retains the assignment across session restarts. A
different authorization stays read-only. The global Agents screen never moves
the vault-wide role between clients; any future handoff must be explicitly
Project-scoped rather than inferred from a connection card.
Every local operation names the exact vault and path; Obsidian CLI puts
`vault=<exact vault name>` first rather than using the most-recently-focused
vault. No two agents write overlapping paths. This `AGENTS.md` policy
and `localVaultAccess` warning coordinate well-behaved clients; they are not a
technical filesystem lock and MDevolved must not describe them as one.

The request is expiring, idempotent, replay-resistant, and non-authoritative.
An exact retry after expiry renews the same request instead of creating a
duplicate. An older approved request that still has the former
`client-authorization-pending` marker may self-heal to a real collaboration
grant only when the same active source connection still covers its exact
Project and context.

The server never infers a current vault, persists a local absolute project path,
trusts claimed harness/model metadata as identity, or widens access when local
context is absent or ambiguous. MDevolved Sync contributes only the normal paired-
vault and synchronization state; it is not the agent or Project protocol.
Pending, rejected, and expired requests are operational bootstrap state
excluded from snapshots and exports; redacted lifecycle audit remains, and
scheduled or explicit maintenance removes expired payloads.

### Existing Project discovery from another computer

A separately consented vault connection may carry
`project.connect.request`. This request-only scope does not grant access to any
Project. It allows `list_projects` to return only active Projects after the
Knowledge Space selector is verified, the exact connected vault is proven to be
a member, and that member fits inside the connection's vault/folder grant.
Projects from other vaults are invisible. Routine Work Packet expiry does not
hide an otherwise compatible Project.

`open_project` opens one compatible result automatically and asks the user only
when more than one result is genuinely compatible. New Project remains
available for different work when no compatible identity exists. It must not
infer identity from a local folder name or Project label. For an existing
selection, the access request binds the stable Project ID, active Knowledge
Space version, current Work Packet and Work Item, immutable context policy,
OAuth client, resource, and requested Project scopes into one expiring owner
request. Routine packet expiry or a newer source-library generation triggers an
automatic successor after source-context and integrity revalidation; it does
not hide the Project.

The owner confirmation displays the client, authorized vault folders, Project
label and ID, objective, current Work Item, context policy, local documentation
plan, and capabilities. MDevolved revalidates every pinned identifier and the active
source grant at approval. If the Project or packet changed, the request fails
and the client must list again. Approval records the exact Project decision and
atomically creates the new, separately revocable Project grant.
`wait_for_project_connection` returns ready on the same connection. It does not
create a second Project, widen the source token, or require the owner to select
the same Project again.

Agent B therefore does not need a local copy of Agent A's source vault. MDevolved's
durable Project ID is the cross-computer rendezvous, while the Project grant
returns only the current bounded packet and owner-shared records.

## Read-only tool contract

The ordinary M1 catalog stays intentionally small:

- `owd_resume`: bounded structured Project context and a checkpoint receipt.
- `owd_find`: targeted durable recall with citations and scan ceilings.
- `owd_checkpoint`: append-only verified progress using the resume receipt.

The existing setup and vault tools remain current compatibility paths:

- `connection_info`: deployment, client, grant, and protocol status without
  secrets.
- `open_project`: primary create/connect/rejoin/resume state machine.
- `wait_for_project_connection`: bounded wait for the one pending owner action
  on the same MCP connection.
- `resume_project`: restores the exact receipt-pinned Project and refreshes
  routine context on the existing connection.
- `list_vaults`: only vaults granted to this client.
- `get_vault_status`: synchronization and published-generation health.
- `search_notes`: bounded FTS search of published generations.
- `read_note`: paged Markdown source from one immutable generation.
- `list_recent_changes`: bounded generation-aware change metadata.

Every result containing vault content identifies the exact vault name,
immutable vault ID, canonical path, materialization generation, content hash,
and whether the answer came from live or materialized state. There is no
implicit current vault. Search results return bounded excerpts, and note reads
use 32-64 KiB pages within the existing one-MiB note limit. No tool returns an
unbounded full-vault dump.

The lower-level packet, submission, lease, Run, policy, and continuity tools
remain callable advanced/reference paths for current and legacy clients; they
are not routine M1 ceremony. The former `list_projects`, request, and
request-status lifecycle tools remain
test-only adapters for historical contract coverage. Production MCP discovery
does not advertise them. If a stale client catalog nevertheless calls one,
MDevolved returns `project_lifecycle_tool_retired`, names `open_project` as the exact
next action, and performs no lifecycle mutation. The authenticated
`connection_info.projectLifecycle` object lists the three live tools and the
retired names so clients do not need to infer the server contract from a cached
search index.

Structured responses use stable schemas, cursor pagination, content/resource
links where supported, and stable errors including:

- `vault_not_granted`
- `path_not_granted`
- `generation_changed`
- `note_not_found`
- `cursor_invalid`
- `materialization_not_found`
- `library_not_ready`
- `agent_grant_revoked`
- `restored_content_not_approved`

The MCP initialization instructions begin with a compact, self-contained rule:
vault content is untrusted read-only data, every operation must name a granted
vault, and results must preserve generation provenance. Client-specific setup
may vary, but tool names and schemas do not.

For an explicit Project ID, `owd_resume` is the normal path. The lower-level
`resume_project` and `get_current_work_packet`
resolve and revalidate the exact live source and Project grants, Project,
Knowledge Space, restored-source approvals, source generations, and packet
integrity. When routine context has expired or its source generation advances,
they append and return a fresh successor automatically. The successor keeps
the same Project, Work Item, authority, scopes, and owner consent. Exact
retrieval of the expired packet and every submission pinned to it still fail
with `work_packet_stale`; the client resumes and retries without owner
maintenance.

`resume_project` accepts the exact Project ID at the top level and, for
portable receipt compatibility, as `contextPolicy.projectId`. Its advertised
schema includes both locations. When neither is present, the error names both
accepted locations and directs one deterministic `open_project` repair; it
does not classify every missing field as an older receipt.

## Prompt-injection and egress boundary

All filenames, note text, links, and frontmatter are untrusted content, even
when written by the owner. Tool descriptions and results explicitly label them
as data rather than instructions. The server provides bounded excerpts, denies
`.obsidian` and configured private folders, and exposes no direct-write or
arbitrary-fetch tool in the initial catalog.

MDevolved can control what it releases to an authorized client; it cannot control a
model provider after the client submits that content. Connection and consent UI
must disclose this egress boundary. Access to especially sensitive vaults or
folders should remain ungranted rather than relying on prompt text to contain
the model.

## Preferences, skills, and proposals

Agents never receive direct note-write authority through MDevolved. A separately
owner-authorized local writer remains outside MDevolved's enforcement boundary as
defined above. Future MDevolved tools create an
immutable proposal bound to the client, vault, path, base version, content
hash, and expiry. The owner reviews a diff in MDevolved and approves with an owner
session, CSRF protection, and passkey step-up where policy requires. The
proposing client cannot approve its own proposal. Accepted note proposals enter
the existing expected-version Yjs write path; stale proposals fail closed.

Portable preferences, skills, and evidence-backed compounding are shipped alpha
capabilities. Their boundary is:

- Working memory remains local to each agent session.
- Accepted durable memories live in MDevolved with source provenance, confidence,
  review state, expiry, and supersession history.
- Skills are versioned Markdown procedures with provenance and evaluation
  history. A skill can guide an agent but cannot expand its MDevolved grant.
- Agents may propose memories and skill revisions. Only accepted records become
  shared defaults for other clients.

The promotion lifecycle is:

1. an agent produces a bounded observation or handoff with source evidence;
2. a candidate durable record or skill revision preserves the producing
   client, model, grant, knowledge space, source versions, and evaluation plan;
3. an independent harness or owner-approved evaluator tests the candidate
   against versioned cases and records successes, failures, cost, and scope;
4. the owner promotes, quarantines, deprecates, or rejects the version; and
5. stable clients resolve only accepted compatible versions, with an immediate
   rollback path to a prior stable version.

Skill states are `experimental`, `stable`, `quarantined`, and `deprecated`.
Neither the proposing model nor an evaluation score can promote a version
automatically. A model cannot rewrite the evaluation cases used to approve its
own change, and retrieved vault content never becomes a skill merely because it
contains procedural language.

Project packet/submission tools arrived before generalized memory tools. The
hardened adapter adds convergent Project entry points before expanding the
collaboration catalog:

- Project lifecycle: `open_project`, `wait_for_project_connection`, and
  `resume_project`; the lower-level request/status tools remain compatibility
  and diagnostic adapters rather than user workflow;
- reads: the deployed `get_work_packet`, followed by `list_projects`,
  `get_project`, `list_work_items`, `get_handoff`, and `list_reviews`;
- append-only submissions: the deployed `submit_attempt`, `submit_artifact`,
  `submit_handoff`, and `submit_review`; and
- owner-status reads: `get_submission_status`.

After that ledger and its recovery contract pass, add
`list_accepted_knowledge`, `propose_knowledge`, `list_skills`, `get_skill`,
`propose_skill_revision`, and `submit_evaluation`. Proposed note creation and
updates remain separate immutable proposal types that enter the existing
expected-version path only after owner approval.

These tools are MCP adapters over transport-neutral application services. The
same versioned Work Packet and submission contracts support a portable
Markdown/JSON file fallback for clients without MCP mutation tools. MDevolved does not
depend on MCP Tasks, A2A, a vendor-specific skill API, or a fixed sequence of
agent roles.

## Hoplon connector boundary

Hoplon's first MDevolved integration is one user, one private Project, and one
disposable vault authorized through normal MDevolved consent. Hoplon stores the
connection ownership and OAuth client state inside an isolated connector
boundary. MDevolved stores only its ordinary client/grant records and does not learn a
Hoplon organization membership, provider key, budget, conversation, or model
selection.

Live federation is the default:

1. the signed-in Hoplon user asks a Project question;
2. Hoplon rechecks user, organization, Project, and connection ownership;
3. Hoplon calls bounded MDevolved search/read tools under that user's active grant;
4. Hoplon freezes one immutable, cited evidence packet; and
5. every selected model receives that same packet through Hoplon's existing
   governed provider path.

MDevolved is not automatically mirrored into Hoplon R2, D1, or Vectorize. A later
explicit snapshot import may make selected evidence available to Project
members, but it creates a new Hoplon-owned artifact with visible scope,
generation, retention, revocation, export, and deletion behavior. Project
membership never inherits the connecting owner's live MDevolved grant, and removing
that owner from a Project does not transfer the grant to remaining members.

Once the proposal ledger exists, Hoplon may submit knowledge, note, or skill
candidates and may act as an evaluation workbench. MDevolved remains the only place
that can record owner promotion or apply a vault mutation. Hoplon cannot approve
its own proposal, widen a knowledge space, or turn a Project role into MDevolved
authority.

## Storage, backup, and restore

The versioned backup format supports optional **Approved Intelligence** and
**Unvetted Intelligence** sections for the deployed
Project/Handoff/Review/Decision ledger and its provenance. Later Knowledge,
Skill, and Evaluation records enter those same classifications only after
their own schemas and recovery gates pass.

Snapshot creation selects **Approved Intelligence** by default and may
explicitly add **Unvetted Intelligence**. Unvetted selection requires Approved
selection and restores only into owner-visible quarantine. It cannot reactivate
sharing, proposal execution, recall, stable Skills, clients, or grants. Access
and refresh tokens, authorization codes, browser sessions, protocol KV
contents, credentials, live grants, and harness conversations are excluded in
every mode.

Approved Knowledge and Skills are owner data and receive the same encryption,
integrity, retention, and staged-restore guarantees as vault materializations.
Unvetted records receive the same cryptographic and integrity guarantees but
not trusted status. Ephemeral agent conversations are not MDevolved backup content.

## R3 elastic Run access and Orca compatibility

R3 capability negotiation is additive at
`owd-lead-operation-capabilities-v2`. A client that does not advertise it
continues to use the R2 seven-tool profile and `get_run_context` snapshot
response. An opt-in elastic Run is limited to 32 active actors and 64 actor
records, with actor registration batches of 16, bundle batches of 8, and delta
pages of 100.

The two batch calls require one exact Project/Run/Work Item and the current
lead lease/fence. Exact retries return the same durable receipt; a different
payload under the same key returns `idempotency_conflict`. Capacity pressure
is bounded backpressure with retry metadata, not server-side scheduling.
`get_run_context` delta mode uses an opaque, expiring cursor bound to grant,
Project, Run, query, and monotonic Run sequence. Cursor pages are stable and
cross-Run use fails closed. Solo clients can omit elastic negotiation and keep
the same API path without actor-count ceremony.

An expired or abandoned actor can be replaced only by a fresh actor with a
subset of the old scopes. The old actor is never revived, and recovery cannot
restore authority or expand Project, Knowledge Space, vault, folder, or
protected-path boundaries. Harnesses report logical units and cost microunits;
MDevolved records a blocking budget Exception at exhaustion and does not own provider
meters, scheduling, or retries.

Observability is aggregate and privacy-safe: counts, retries, rejections,
bounded latency percentiles, and measurement timestamps. Do not send or log
raw transcripts, hidden reasoning, terminal history, credentials, OAuth state,
provider runtime, or production/customer logs. R3 records carry retention
tiers and are included in portable export/snapshot/quarantine restore without
recreating actors, grants, leases, receipts, credentials, OAuth state, or live
authority.

The Orca adapter is inert and provider-neutral. It maps optional worktree,
branch, commit, pull-request, and session references into generic Run/Actor
evidence with authority flags false. MDevolved does not invoke Orca, control its
agents, import terminal/session state, or trust its metadata as identity. If
Orca state is unavailable, a non-Orca lead resumes from the generic Run
snapshot/delta with fresh authorization.

## R4 deterministic policy and continuity access

R4 negotiation is additive at `owd-lead-operation-capabilities-v3`. R2 and R3
clients retain their v1 and v2 profiles. An R4 lead may use
`evaluate_run_policy` and `get_policy_operations` under the exact current
Project lead grant, lease, and fence. The fixed research/coding gates revalidate
the owner-authored policy and evidence bodies and never consume model
confidence, raw transcripts, hidden reasoning, terminal history, provider
credentials, or runtime state.

The v3 `complete_continuity_drill` tool is narrowly fenced: it accepts only the
exact pending scheduled drill request, exact non-restored source Continuity
Point, a distinct current replacement lead lease, and the matching Project.
The receipt and request completion commit atomically and exact replay is
idempotent. The tool cannot create or restore a grant, lease, actor, credential,
OAuth state, policy authority, scheduler authority, or provider state.

Policy activation and permitted Exception resolution remain owner-only web
operations with owner session and CSRF protection. A lead may surface an
Exception but cannot resolve it, edit policy, approve itself, expand authority,
perform destructive work, or bypass evidence, budget, integrity, protected-path,
upgrade, or rollback failures. The inert policy-continuity adapter describes
external harness sequencing without executable code or provider behavior; the
harness still owns agents, scheduling, retries, tools, worktrees, and inference.

## Performance and abuse budgets

The implementation is designed around these acceptance targets, measured as
Worker server time under a synthetic multi-vault load:

- MCP initialize and tool listing p95 below 300 ms.
- FTS search across 20 maximum-count synthetic vaults p95 below 500 ms.
- One paged note read p95 below 500 ms.
- Normal client connection and passkey consent in under two minutes.
- Grant revocation effective on the next tool call.

The future connector additionally targets one bounded MDevolved retrieval per Hoplon
evidence packet, no automatic whole-vault embedding pass, and no duplicate
provider retrieval during Compare. Connector latency and MDevolved request counts are
measured separately from model latency so slow providers do not disguise an
inefficient knowledge path.

These are engineering targets, not public latency guarantees. The read path
queries D1 FTS before fetching only selected R2 objects, keys safe caches by
content hash, never places plaintext note bodies in a shared public edge cache,
and moves optional embedding, consolidation, and evaluation jobs off the
request path through Queues or Workflows. Hybrid FTS plus Vectorize search is a
later, opt-in feature because it adds privacy, cost, and indexing tradeoffs.

Tool calls are bounded by result count, bytes, execution time, grant, and
client-specific rate limits. Repeated denials and abnormal loops produce
redacted audit events without query text, note bodies, or raw filenames.

## Owner experience

The dashboard provides one **AI agent access** flow:

1. Choose the generated Cursor, Antigravity, or universal remote MCP setup.
2. OAuth opens MDevolved and requires the existing owner passkey session.
3. Review the unverified client name and exact callback origin.
4. Select one vault, then optionally narrow access to named folders.
5. Approve the single `vault.read` permission or deny the request.

Connection management shows client identity, callback origin, granted vault,
folders, and last use. It includes per-client revocation and **Revoke all
agents**. Normal setup never requires copying a static API key.

### Client setup helpers

The helpers are generated inside the authenticated dashboard because every
Community installation has a different MCP URL. They do not weaken or bypass
the protocol boundary:

- **Cursor** receives a one-click `install-mcp` link containing a base64-encoded
  server configuration with only the deployment's public MCP URL. The owner
  must click it, and Cursor must still complete MDevolved's OAuth and vault consent.
- **Antigravity** receives a copy-ready `mcpServers` entry using the current
  remote-server `serverUrl` field. The UI tells owners to merge the entry into
  an existing configuration rather than overwrite other servers, then choose
  Authenticate inside Antigravity.
- **Obsidian Mind** receives a project-scoped Claude command that adds MDevolved
  without replacing its existing `qmd` entry, plus a generic merge fragment,
  the standard MCP Resource
  `owd://compatibility-profiles/obsidian-mind/v1`, the standard MCP Prompt
  `connect-obsidian-mind`, and a script-free skill. The profile keeps native
  note locations, separates `.om-project` routing from the `.owdignore`
  Project UUID, and classifies Mind's `record_work` and `remember` as direct
  vault writes subject to `localVaultAccess`.
- **Eve** receives a complete `agent/connections/owd.ts` module using Eve's
  standard Streamable HTTP connection and user-scoped Vercel Connect OAuth,
  plus the Resource `owd://compatibility-profiles/eve/v1`, Prompt
  `connect-eve`, and a script-free skill. Eve qualifies the connection's tools
  as `owd__<tool>`. A separately attributable Eve reviewer uses a distinct
  connector UID and OAuth registration; a session, channel, or child that
  inherits the same connector remains the same MDevolved participant. Top-level
  app-principal schedules cannot borrow the user's grant.
- **Albatross** receives a copy-ready setup kit containing one pre-authorization
  command, an additive `agent.config.json` fragment, a marked
  `.albatross/prompt.md` block, and `/mcp trust owd`. Albatross `2.0.3` is
  stdio-only, so the profile pins the temporary `mcp-remote` `0.1.38` bridge
  while MDevolved remains standard remote Streamable HTTP MCP plus OAuth. Tools are
  qualified as `mcp__owd__<tool>`; Project waits stay below the client's
  30-second request limit. A distinct non-secret participant header partitions
  bridge OAuth state for an independently authorized reviewer but never grants
  server authority.
- **Orca ADE compatibility profile (planned)** follows
  [Orca's public MCP and skills path](https://www.onorca.dev/docs/cli/skills)
  and receives the public MCP URL, exact **Settings → Integrations → MCP**
  navigation, a vault-scoped connection-test prompt, and an optional script-free MDevolved
  Team skill. The underlying agent client still completes MDevolved OAuth and
  exact-scope consent. MDevolved never adds an agent, changes its launch flags, or
  edits Orca, Codex, Claude, or other local configuration automatically.
- **Other clients** receive the same universal `/mcp` URL and four short steps:
  add a remote Streamable HTTP server, authenticate, approve one vault and
  optional folders, and revoke in MDevolved when finished.

The setup payloads never contain an access token, refresh token, authorization
code, session cookie, passkey material, vault credential, vault ID, folder
grant, or note content. Cursor learns the deployment hostname only after the
owner clicks its installer. Antigravity configuration is copied locally through
the browser clipboard. Live acceptance in each vendor client remains a release
test; generating the documented format does not claim vendor certification.

For collaboration records, a repository URL, commit hash, pull request, or
content digest produced in an Orca worktree may be stored as an inert Artifact
reference under the normal schema. Orca task, dispatch, terminal, and session
identifiers remain optional claimed metadata. They never replace the MDevolved
Project, Work Item, Work Packet, Attempt, Artifact, Handoff, Review, Decision,
participant, or grant identities.

## Current implementation status

The Worker, consent UI, dashboard management UI, migrations, read-only vault
tools, Project collaboration tools, and the three-operation M1 facade are
implemented on `main` and deployed to the persistent Community alpha. This does
not claim named-client certification or completion of the separately authorized
live release exercises. Clients may use
public-only Client ID Metadata Documents or dynamic registration. Automated
Worker-runtime coverage performs real dynamic registration, PKCE
authorization-code exchange, bearer-authenticated MCP calls, SQL-level folder
filtering, cross-vault denial, prompt-injection fixtures, bounded UTF-8 paging,
generation invalidation, immediate D1 denial, Project lifecycle convergence,
and OAuth grant revocation.

The reusable generic client command is:

```sh
pnpm acceptance:agent:production https://deployment.example/ disposable-test-vault "known search term"
```

It keeps the PKCE verifier, authorization code, and tokens in memory, performs
initialize, initialized notification, exact tool discovery, one-vault search,
bounded note read, recent changes, provenance, Project connection, and
revocation checks. Run it only against an owner-approved disposable deployment
and retain no token, hostname, vault name, Project ID, or diagnostic log in
public evidence.

## Acceptance matrix

Protocol compatibility is covered by the local dual-era conformance matrix.
Named-client validation is a separate release-evidence gate and is complete
only when:

- MCP Inspector and current supported versions of Codex, Claude Code, Grok
  Build, and one generic Streamable HTTP client complete authorization;
- every client can list only granted vaults, search, page a note, and observe
  generation provenance;
- cross-client, cross-vault, excluded-folder, insufficient-scope, expired,
  and revoked calls fail with the stable error contract;
- prompt-injection fixtures remain inert tool data and no logging path contains
  content or query text;
- performance and rate-limit tests cover the documented bounds; and
- a fresh owner connects one client in under two minutes without a terminal
  secret.

## Normative references

- [Cloudflare remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Cloudflare MCP security](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/)
- [MCP 2026-07-28 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2025-11-25 Streamable HTTP compatibility](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers)
- [Cursor MCP configuration](https://docs.cursor.com/en/tools/mcp)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
