# OWD continuity-first product plan

**Status:** R4 policy-autopilot and operational-continuity implementation and local automated acceptance complete; Community `1.0.0-alpha.7` is the forward-only release for the authorized persistent test cell, while live provider-agent acceptance remains a separate human gate

**Date:** 2026-08-06

**Normative effect:** The strategy and rapid milestone order are approved for
planning and implementation. Existing runtime authority changes only through
the additive contracts, tests, and migrations delivered inside each accepted
vertical slice.

## Direction

OWD will evolve from an owner-operated handoff ledger into a
business-continuity control plane that an authorized Project lead agent can
operate autonomously inside standing owner policy.

The proposed product thesis is:

> OWD preserves the recoverable operating state of agent-assisted Projects so
> the work can survive and resume across agent sessions, harnesses, providers,
> machines, personnel, and company-policy changes.

Hermes Agent, an Orca-hosted agent, Codex, or another compatible harness may
act as the Project lead. OWD does not embed a model or duplicate their
execution runtimes.

## Findings behind the proposal

The current OWD design works best for a deliberate owner-directed sequence:
one agent receives a frozen packet, submits immutable work, the owner shares
it, another agent reviews it, and the owner records a Decision. That flow is a
good provenance and recovery proof, but its routine cost grows with every
agent, handoff, packet, and approval.

Fast agent environments have a different operating shape:

- Orca can run many isolated worktrees and agent sessions concurrently.
- Hermes can delegate to subagents and run scheduled autonomous work.
- A lead agent needs to create work, distribute context, exchange provisional
  findings, route reviews, retry failures, and checkpoint progress without
  asking the owner to operate OWD between steps.
- The difficult migration problem is not preserving Git files. It is
  preserving the Project objective, decisions, evidence, failed approaches,
  unresolved work, policy, and next action in a form another lead understands.
- Agent session availability is not a continuity contract. Claude Code's
  `cleanupPeriodDays` defaults local transcripts and other application files
  to 30 days and an enterprise administrator can shorten it; OpenAI currently
  documents that retained Codex chats remain until the user deletes them. The
  exact windows vary, but access remains controlled by a provider, product,
  workspace administrator, local cleanup rule, account, and user action rather
  than by the Project owner. See Anthropic's
  [Claude Code enterprise settings](https://support.claude.com/en/articles/14128775-claude-code-on-console-to-enterprise-migration)
  and OpenAI's
  [Codex chat retention overview](https://help.openai.com/en/articles/20001333-how-to-archive-and-delete-codex-chats-in-the-chatgpt-app).
- A runtime-native backup can restore that runtime. OWD is valuable only if a
  different runtime can resume the Project without reconstructing its history.

OWD should therefore not compete with Hermes or Orca as a scheduler,
delegation engine, worktree manager, terminal, browser, or model router. It
should let those tools control OWD through a provider-neutral Project API while
OWD owns durable continuity, authority, provenance, recovery, and substitution.

## North-star experience

After one installation and one standing authorization for an exact workspace
boundary, the owner says:

> Use OWD for this project.

The active lead then:

1. adopts or resumes the exact Project;
2. claims a renewable, fenced Project-lead lease;
3. creates work and Runs;
4. registers subordinate actors without separate owner ceremonies;
5. distributes pinned, cited context;
6. shares provisional results inside the Run;
7. applies standing quality and retention policy;
8. checkpoints durable Project state continuously at meaningful work
   boundaries rather than relying on session shutdown; and
9. surfaces only exceptions that require new authority or human judgment.

If the lead disappears, an independently authorized replacement lead resumes
from the last durable continuity point without access to the former lead's raw
conversation or credentials.

## Responsibility boundary

| Execution harness owns                            | OWD owns                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Planning and task decomposition                   | Stable Project and Work identity                                       |
| Launching and supervising agents                  | Standing owner policy and delegated capability limits                  |
| Models, tools, terminals, browsers, and worktrees | Lead leases, actor attribution, revocation, and audit                  |
| Runtime retries and schedules                     | Portable context, evidence, checkpoints, and open work                 |
| Conversation context and compression              | Durable Decisions and policy-derived state transitions                 |
| Applying code changes in its authorized workspace | Obsidian knowledge boundary, encrypted recovery, and lead substitution |

OWD remains complete without any specific harness. A compatibility adapter may
improve setup and mapping but cannot become required durable state.

## Preserve and change

### Preserve

- Single-owner root authority and exact vault/folder boundaries.
- Immediate authoritative revocation.
- Provider-neutral domain services, MCP control, and portable Markdown/JSON.
- Immutable records, content hashes, cited evidence, and complete provenance.
- Separate live sync, searchable libraries, and retained encrypted snapshots.
- No hidden-conversation or chain-of-thought ingestion.
- No restored credentials, OAuth state, or live grants.
- No embedded model, provider credentials, or required runtime.
- Recovery coverage in the same milestone as every new durable record type.

### Supersede through additive vertical slices

| Current assumption                                                              | Proposed continuity contract                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner conducts routine handoffs                                             | The owner defines policy; a delegated lead operates the Project                                                                                         |
| Each separately attributable worker needs its own owner-authorized OAuth client | One authorized coordinator may create narrower, short-lived actor capabilities inside its Project boundary                                              |
| Work is private until the owner shares it                                       | Bounded `run-shared-unvetted` work is automatically visible only inside its Run                                                                         |
| One record is submitted per operation                                           | An idempotent bundle may atomically contain an Attempt and its dependent outputs                                                                        |
| An expired Work Packet rejects later submission                                 | A Context Lease preserves the exact historical input until a bounded submission deadline; explicit revocation still denies the next call                |
| Only a direct owner action changes accepted state                               | `OwnerDecision` and `PolicyDecision` remain distinct; policy automation must cite the standing owner rule and evidence it evaluated                     |
| The first Project client is the durable local writer across Projects            | Repository work remains the harness's worktree concern; future vault mutations require proposals or exact path-scoped authority and recovery safeguards |

## Rapid delivery strategy

The shortest path is one thin lead-substitution spine, not a complete new
agent-control architecture. Each milestone delivers a working vertical slice:
its contract changes, additive migration, domain service, MCP surface,
authorization failures, recovery coverage, compatibility behavior, and
acceptance exercise stay together.

### Delivery rules

1. **Reuse before inventing.** Extend the deployed Project model instead of
   replacing it.
2. **Add before refactoring.** Add versioned fields, records, scopes, and tools;
   keep current clients and restored records readable.
3. **Prove substitution first.** Do not block on actor delegation, policy
   autopilot, a full Run protocol, or 20-agent infrastructure.
4. **Checkpoint during work.** Provider session shutdown and export are never
   required capture events.
5. **Keep one generic API.** Hermes is the first reference lead, not a durable
   dependency or a special server path.
6. **Measure before scaling.** Use current D1/R2 services for R1 and R2; choose
   queueing or additional serialization only after R3 load evidence.
7. **Ship coherent candidates.** Run focused checks continuously, then the
   complete repository gate once from the exact release candidate. Production
   deployment remains an explicit owner action.

### Reuse map

| Required behavior                                  | Fastest safe substrate                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Project adoption and replacement-client connection | Existing `open_project`, `wait_for_project_connection`, and `resume_project`              |
| Lead authority                                     | Existing Project grant plus an additive `project.lead` scope                              |
| Pinned source context                              | Existing Work Packet and Knowledge Space version                                          |
| Durable work and evidence                          | Existing Attempt, Artifact, Handoff, Review, Decision, and provenance records             |
| Lead checkpoint                                    | One new `ContinuityPoint` assembled from existing records plus explicit open-state fields |
| Exclusive active lead                              | One new fenced `LeadLease` record; explicit revocation or expiry permits takeover         |
| Portable recovery                                  | Existing Approved/Unvetted snapshot, export, import, and quarantine boundaries            |
| Harness identity                                   | Existing authorization-bound client plus claimed harness/model metadata                   |

R1 adds only the minimum new durable semantics: `project.lead`, `LeadLease`,
and `ContinuityPoint`. `ProjectLeadGrant` is initially the existing Project
grant carrying the new scope. Hermes subagents remain internal to Hermes in R1;
the authorized lead submits the consolidated checkpoint. `Run`, `Actor`,
`ContextLease`, `EventBundle`, `PolicyDecision`, and `Exception` become new
records only when R2 requires them.

## Rapid milestones

### R1 — Lead-substitution continuity spine

**Outcome:** Hermes can checkpoint a real OWD Project, disappear, and Codex or
another independently authorized client can resume productive work from the
same durable state.

**Build:**

- Amend only the product, collaboration, security, recovery, and architecture
  clauses required by `project.lead`, `LeadLease`, and `ContinuityPoint`.
- Define `owd-continuity-point-v1` with objective, exact Project and Work Item,
  packet/context identity, accepted Decisions, cited evidence, rejected
  approaches, completed and open work, blockers, risks, and next action.
- Add an append-only migration for a fenced Project lead lease and continuity
  metadata/body reference. Reuse content-addressed R2 bodies.
- Add transport-neutral claim, renew, checkpoint, read, revoke/takeover, and
  continuity-assembly services.
- Expose the minimum MCP changes: `claim_project_lead`,
  `renew_project_lead`, and `checkpoint_project`; extend `resume_project` to
  return the latest valid Continuity Point.
- Add capability negotiation so old clients continue to see the current
  collaboration surface.
- Include Continuity Points in portable export and Approved/optional-Unvetted
  snapshot recovery without restoring a lease or grant.
- Package a minimal script-free Hermes instruction only after the generic
  surface passes.

**Not in R1:** Child capability issuance, Run-shared visibility, automatic
promotion, bundled event ingestion, direct vault writes, 20-agent load,
scheduled drills, or an Orca-specific adapter.

**Acceptance:**

- Hermes connects through the normal public MCP path, claims the lead lease,
  performs bounded work, and acknowledges one Continuity Point.
- Stale fencing tokens, simultaneous lead claims, replay, cross-Project
  checkpointing, oversize bodies, expired grants, and explicit revocation fail
  closed.
- Hermes and its live session are removed from the disposable environment.
- A separately authorized Codex or generic client claims the released or
  expired lease and becomes productive within five minutes.
- The replacement accurately reports objective, authority, accepted Decisions,
  evidence, rejected approaches, open work, risks, and next action without a
  Hermes transcript, memory provider, backup, credential, or runtime.
- No acknowledged Continuity Point, accepted Decision, cited Artifact, or open
  Work Item is lost.
- Export and encrypted restore into a fresh isolated installation preserve the
  Continuity Point but restore no authority.
- Existing Project clients and records remain compatible.

**Product go/no-go:** If the replacement lead is not materially better prepared
than it would be with Git plus a Hermes backup, reassess the product before
adding orchestration volume.

### R2 — Hands-off lead operation

**Outcome:** After **Use OWD for this project**, the authorized lead manages
routine Project work without dashboard babysitting.

**Build:** Add standing Project policy plus the smallest useful `Run`, `Actor`,
`EventBundle`, and `Exception` contracts. Add `create_work_item`, `start_run`,
`register_actor`, `get_run_context`, `submit_bundle`, `complete_work_item`, and
`list_project_exceptions`. Add bounded `run-shared-unvetted` visibility and an
inert Hermes adapter over the generic services.

**Acceptance:** Hermes delegates to at least three claimed actors, shares
provisional results, routes an independent review, checkpoints, and closes one
research or coding Work Item with no routine owner action after the initial
instruction. Authority expansion, destructive action, protected-path access,
budget exhaustion, and conflicting evidence produce explicit exceptions.

### R3 — Elastic 20-plus-actor plane and Orca

**Outcome:** The R2 protocol remains efficient for a solo agent and for more
than twenty concurrent actors.

**Build:** Add bounded batching, cursor-based deltas, idempotent retries,
backpressure, abandoned-actor recovery, retention tiers, cost budgets, and
measured observability. Add an Orca adapter that maps worktrees, branches,
commits, pull requests, and sessions into the generic Run/Actor model without
making Orca state authoritative.

**Acceptance:** The local automated decision uses synthetic solo and true
concurrent 20-plus-actor load without lost or duplicated durable records,
cross-Run leakage, authority widening, or owner-action growth proportional to
actor count. A non-Orca lead resumes after Orca state is unavailable, and the
solo path uses the same API without swarm-level ceremony. Any live disposable
provider/Cloudflare exercise remains a separate human-authorized rollout gate;
it is not required or claimed by this local R3 build.

### R4 — Policy autopilot and operational continuity

**Outcome:** OWD continuously proves that Projects can survive lead loss rather
than relying on a one-time demonstration.

**Build:** Add versioned `PolicyDecision`, deterministic evidence gates,
exception-only owner workflows, scheduled Continuity Points, drill automation,
RPO/RTO and continuity-age reporting, retention, integrity monitoring,
upgrade/rollback evidence, and managed-cell operations that preserve complete
Community independence.

**Acceptance:** One research Run and one coding Run complete without routine
owner action; unsupported self-approval and policy editing fail closed. A
scheduled disposable drill replaces a lead, restores into a fresh Community
installation, and emits a redacted continuity receipt with measured RPO, RTO,
recovery quality, and runtime independence.

## Non-blocking current-workflow evidence

The former two-agent private-alpha exercise may run when useful as regression
and comparison evidence. Its failure does not block R1, and no additional
owner-workflow polish should delay the continuity spine.

## Work deferred until R1 proves differentiation

- An OWD-native planner, model router, scheduler, terminal, browser, or
  worktree manager.
- Server-side model-provider keys or prompt routing.
- Raw transcript, chain-of-thought, or complete terminal-history ingestion.
- Multi-owner/team authorization.
- Automatic destructive vault writes.
- General executable-skill distribution.
- Broad native adapters before the lead-substitution proof.
- A high-volume event architecture selected before load measurement.

Existing durable Knowledge and Skill work resumes after R1 shows that a
replacement lead can consume the Continuity Point. Those records then use the
same provenance, recovery, and substitution boundary.

## Rapid release loop

For each rapid milestone:

1. freeze the minimum schema, invariants, hostile fixtures, and compatibility
   decision needed by that vertical slice;
2. add a forward-only migration and recovery notes;
3. implement transport-neutral services and the generic MCP adapter;
4. add allowed and denied runtime tests plus snapshot/export coverage;
5. run focused checks while building;
6. perform the milestone's disposable cross-runtime acceptance exercise;
7. run the complete repository release gate once from the exact candidate;
8. deploy only after explicit owner authorization; and
9. record the acceptance, rollback point, known risks, and cleanup receipt.

Planning, implementation, validation, regression repair, and required rework
remain in the same task for the active milestone. Documentation work does not
become a separate blocking phase.

## Measures of success

- One owner instruction adopts a Project inside a preauthorized boundary.
- Routine Project operation requires no dashboard babysitting after R2.
- Explicit revocation denies the next call at every authority level.
- A replacement lead resumes within five minutes and loses no acknowledged
  continuity state in the R1 drill.
- No provider retention window, local transcript-cleanup setting, or workspace
  history is part of the continuity guarantee.
- A solo agent and a twenty-plus-actor Run use the same Project model after R3.
- Accepted truth never derives from unlabeled agent confidence or hidden
  conversation state.
- OWD recovery requires no specific harness, model provider, or memory service.
- Community remains independently deployable and complete.

## Principal risks

1. **R1 grows into the final architecture:** Enforce its explicit exclusions;
   add later primitives only in the milestone that proves their need.
2. **Duplicating Hermes or Orca:** Keep execution and agent supervision outside
   OWD.
3. **Delegation confused with ownership:** A lead is a bounded operator; only
   the owner can expand policy or source authority.
4. **Split-brain leads:** Fence every lead mutation, expire leases, and make
   revocation authoritative on the next call.
5. **Provider-session expiry before capture:** Checkpoint at acknowledged work
   boundaries and report continuity age; never wait for shutdown or export.
6. **False continuity claims:** Test RPO, RTO, recovery quality, and runtime
   independence rather than equating backup completion with resumability.
7. **Migration complexity:** Keep existing records readable, introduce formats
   additively, and restore no authority.
8. **Event-volume cost:** Retain checkpoints and meaningful evidence rather
   than raw tool streams; select infrastructure only after R3 measurement.

## Prior R2 execution capsule

**Milestone:** R2 — hands-off lead operation.

**Goal:** After the owner says “Use OWD for this project,” an authorized Hermes
lead creates and closes one bounded research or coding Work Item through at
least three claimed actors, provisional evidence, independent review, and a
durable checkpoint without routine owner action.

**Scope:** Standing Project-version policy; provider-neutral Run, Actor,
EventBundle, Exception, and Run-context formats; seven generic MCP tools;
commit-time grant/lease fencing; exact Run-shared-unvetted visibility; portable
context; owner exception visibility; inert Hermes guidance; and quarantine-only
snapshot restore for every new record format.

**Constraints:** Reuse the accepted R1 lead lease, Continuity Point, Project,
Work Item, Work Packet, collaboration, provenance, and recovery services.
Preserve owner root authority, exact vault/folder boundaries, authoritative
revocation, provider neutrality, Community independence, and the ban on raw
transcripts, hidden reasoning, terminal history, credentials, OAuth state, and
runtime state. Execution harnesses retain scheduling, supervision, tools,
worktrees, and retries. Do not implement R3 load infrastructure or R4 policy
autopilot/scheduled drills.

**Acceptance:** The synthetic automated slice creates a fresh Work Item, starts
one coding or research Run, registers at least three actors, shares a
provisional result, routes and receives an independent passing review, requires
a fresh checkpoint, and closes the exact Work Item. Authority expansion,
destructive action, protected-path access, exhausted budgets, and conflicting
evidence become explicit blocking Exceptions. Cross-boundary, scope, expiry,
replay-conflict, malformed/oversize, stale-fence, and restored-authority paths
fail closed.

**Validation:** Focused contract/migration, service, generic-MCP,
owner-visibility, snapshot/export/restore, compatibility, and adversarial tests
during development; then the complete repository gate once from the exact
candidate. A live disposable Hermes/Cloudflare exercise requires a separately
confirmed zero-cost cell and explicit deployment authorization.

**Risk boundary:** No personal vault data, secrets, production mutation,
deployment, branch push, pull request, paid service, or release without explicit
owner authorization. Existing R1 changes remain uncommitted and intact.

**Historical next action at R2 handoff:** Complete independent adversarial
review and the exact full repository gate, repair every R2 regression in the
R2 task, then issue the R2 milestone receipt and stop before R3.

## Current R3 execution capsule

**Milestone:** R3 — elastic 20-plus-actor plane and Orca.

**Starting baseline:** Work began directly on dirty branch
`codex/continuity-r1`, which already contained the complete uncommitted R1/R2
candidate and this plan as an untracked file. Those files remain in place;
nothing was reset, discarded, committed, pushed, deployed, or remotely
migrated.

**Goal:** Keep the R2 protocol efficient for one actor and at least 20
concurrent claimed actors while preserving exact Project/Run authority,
durability, portability, privacy, and provider-neutral lead substitution.

**Implemented scope:** Opt-in elastic Runs; batches of up to 16 actor
registrations and 8 EventBundles; 32 active/64 historical actor slots; stable
Run-bound delta cursors; exact replay/conflict behavior; bounded retry
metadata; immutable budget-version accounting and budget Exceptions;
expired/abandoned actor replacement without scope restoration; aggregate
privacy-safe observations; bounded reference-aware volume retention; inert
Orca evidence; additive MCP v2 negotiation; owner status UI; canonical portable
elastic export; snapshot inventory; quarantine-only restore; and forward-only
migration `0032_elastic_actor_plane_r3.sql`.

**Compatibility:** R1/R2 capability resources and the seven-tool R2 profile
remain unchanged. R2 Runs keep their original mutation behavior. An opt-in R3
Run retains the legacy snapshot read and generic completion path, but rejects
legacy single-actor/single-bundle mutations so they cannot bypass elastic
slots, deltas, or accounting.

**Local acceptance evidence:** Hostile contracts and service tests exercise
solo parity, true concurrent registration and bundle retry waves, 24 durable
actors, multi-entry atomic budgets, duplicate/replay conflicts, capacity
backpressure, stable/cross-Run cursors, expiry and abandonment, revocation at
commit, budget and review Exceptions, Orca loss with non-Orca resumption,
canonical portable export, quarantine-only restore, and tier cleanup. Wrangler
`unstable_splitSqlQuery` is exercised by the release-contract check; the
migration uses transport-safe constraints and immutable version tables rather
than triggers. Final pass/fail counts belong to the exact milestone receipt so
this plan does not claim a gate before it runs.

**Risk and authorization boundary:** No deployment, remote migration, paid
service, provider session, production/customer data, credential, OAuth state,
commit, push, or pull request is part of this local candidate. Live Hermes/Orca
rollout remains unrun and requires separate authorization. R4 policy autopilot
is not implemented.

**Acceptance decision:** Close local R3 only if the exact candidate passes
`pnpm check`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and
`pnpm deploy:dry-run` after independent validation and adversarial rework.

## Completed R4 execution capsule

**Milestone:** R4 — policy autopilot and operational continuity. This is the
only active milestone and the final planned rapid implementation milestone.

**Starting baseline:** Work continued on dirty branch `codex/continuity-r1`
without resetting, discarding, committing, pushing, deploying, or remotely
migrating the complete R1/R2/R3 candidate. The exact accepted R3 gate receipt
is recorded in [`R4-POLICY-CONTINUITY-FREEZE.md`](R4-POLICY-CONTINUITY-FREEZE.md).

**Implemented candidate:** Additive v3 policy capability negotiation;
owner-authored immutable Policy bindings; deterministic research and coding
evidence gates; immutable allow/Exception Decisions; commit-time completion
fencing; fixed exception-only actions; bounded idempotent scheduled Continuity
Point and drill requests; overlap backpressure; bounded R1–R4 integrity scans;
exact RPO, RTO, continuity-age, recovery-quality, and runtime-independence
receipts; managed-cell/Community health plus forward-only upgrade and
application-only rollback evidence; owner operations UI and portable export;
reference-aware retention; encrypted snapshot inventory; quarantine-only fresh
restore; an inert script-free generic adapter; and a disposable no-provider
local drill with exact cleanup.

**Compatibility and authority:** Migration
`0033_policy_autopilot_r4.sql` is forward-only, STRICT, trigger-free, and has
no down-migration. R1–R3 clients and capability resources remain unchanged;
R4 is opt-in. Execution and scheduling engines remain outside OWD. Restores
create no grants, leases, actors, credentials, OAuth state, policy authority,
scheduler authority, or live operational projections.

**Local acceptance evidence:** Frozen fixtures cover the truth tables,
exception actions, redaction, metrics, hostile inputs, recovery invariants, and
compatibility rules. Contract and Worker coverage includes research/coding
allow paths, self-approval and policy-edit denial, cross-Project/Run access,
revocation/fence races, missing/conflicting/tampered evidence, partial-integrity
failure, last-known-good retention, schedule replay/overlap, exact-request drill
completion by a replacement lead, receipt math/redaction, dependency-complete
export, snapshot recovery, and fresh authority-free restore.
`pnpm acceptance:continuity:local` passed the relevant local Worker paths and
emitted a redacted synthetic receipt: research and coding gates completed,
lead replacement and fresh Community recovery passed 8/8 checks, recovery
quality was 10,000 basis points, RPO was 10 seconds, RTO was 28 seconds,
continuity age was 45 seconds, runtime independence was true, all four
temporary objects were removed, and no live authority was restored. The exact
candidate also passed independent adversarial review and validation plus
`pnpm check`, `pnpm test`, `pnpm test:integration`, `pnpm build`, and
`pnpm deploy:dry-run`.

**Authorized Community cutover:** Before the remote change, a private D1 Time
Travel bookmark and the prior Worker version were recorded. Forward-only,
trigger-free migrations `0030` through `0033` then applied in order with no
pending migration, the existing Community Worker and owner UI first deployed
as `1.0.0-alpha.4`, then advanced without schema changes to `1.0.0-alpha.5` so
Community and OWD Sync tag namespaces are independently validated, and to
`1.0.0-alpha.7` with the patched Undici 7.x development-tooling dependency.
Its
scheduled bounded trigger was installed, the public
health response reported the expected version, and D1 `quick_check` returned
`ok`. No destructive down-migration or automatic rollback was used.

The two prior disposable tester cells were separately confirmed to contain no
owner, session, vault, Project, collaboration, or active-grant state and were
fully deprovisioned by exact resource inventory. No production or customer
content was exported. Future tester provisioning requires the versioned build
manifest, account-scoped rate-limit reservation, explicit data-disposition
receipts, and verified absence receipt in
[`CELL-LIFECYCLE.md`](CELL-LIFECYCLE.md).

**Remaining human gates:** Live Hermes/provider execution and any paid
inference exercise remain unrun and separately authorized. The deployed
Community path does not depend on them, and no managed tester cell remains.

**Final acceptance decision:** Local R4 is closed. The exact candidate passed
independent review, the scheduled disposable drill, the complete repository
gate, the forward-only Community cutover, and post-deploy health and integrity
checks without routine owner action.
