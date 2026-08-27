# MDevolved minimum lovable product plan

**Status:** MD9 active; MD10 and MD11 are queued and cannot close early.
**Date:** 2026-08-27

## Current milestone

**MD9 — Canonical MDevolved identity** is the only active milestone.

The final acceptance decision is binary: a clean installation and every new
normal workflow must write, display, and advertise MDevolved identities, while
the same candidate still reads supported legacy clients and records through a
contained compatibility boundary and never restores or copies live authority.

Planning, implementation, regression repair, adversarial review, and the exact
candidate gate remain in MD9. Publishing, pushing, deploying, migrating a live
cell, or creating an external plugin repository are delivery actions, not proof
of correctness, and require owner authorization at execution time.

## Outcome

MDevolved should become the quiet continuity layer that makes agentic projects
finish more reliably. A person connects a Markdown folder, authorizes an agent,
and gives one ordinary instruction. MDevolved preserves the useful project
state, evidence, preferences, skills, failures, and next action so that the
same agent, a different agent, or an orchestration harness can continue later
without rebuilding context or requiring routine operator work.

The minimum lovable product is accepted only when:

1. a new user encounters **MDevolved**, never the former product name,
   throughout installation,
   setup, agent connection, normal use, recovery, and release material;
2. a new integration writes and advertises canonical MDevolved protocols and
   artifacts, while legacy clients and data remain readable through an
   isolated, deprecated compatibility layer;
3. a stranger can understand the product from one short demonstration and
   complete one public quickstart without learning internal protocol terms; and
4. at least five external alpha users independently complete a fresh-session
   resume with correct, useful context and no owner assistance.

Until those four conditions pass, new feature work is frozen unless it fixes a
security issue, data-loss risk, compatibility regression, or alpha funnel
blocker.

## What “full rename” means

Full rename does **not** mean deleting the string `owd` everywhere. Old names
must remain in fixtures and compatibility code so existing data fails safely
rather than disappearing.

| Surface                   | New canonical behavior                                                | Legacy behavior                                                            |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Product, UI, docs, errors | MDevolved, Sources, Workspaces, Projects                              | the former name appears only in dated history or an explicit legacy notice |
| MCP                       | `mdevolved_*`, `mdevolved://*`                                        | `owd_*` and `owd://*` are accepted aliases, never newly advertised         |
| Pairing                   | a MDevolved pairing scheme and receipt                                | `owd-pair` remains readable                                                |
| Ignore file               | `.mdevolvedignore` is written and documented                          | `.owdignore` remains readable with deterministic conflict rules            |
| Packages                  | `mdevolved` and, where ownership permits, `@mdevolved/*`              | `@owd/*` becomes a deprecated bridge or internal compatibility fixture     |
| Portable records          | new MDevolved version labels for exports and snapshots                | existing backups and snapshots remain importable and quarantined           |
| Obsidian adapter          | canonical MDevolved repository, release, package, and plugin identity | the alpha legacy adapter is archived with a migration notice               |
| Existing deployments      | new installs use MDevolved resource names                             | existing Worker, D1, R2, routes, and stored keys are not renamed in place  |

No grant, credential, actor, lease, OAuth client, session, or other authority is
silently copied during this transition. Moving from an old plugin or connection
to a new canonical identity requires explicit owner authorization. Restore and
import remain data operations, never authority migration.

## Product boundary

MDevolved owns durable Project identity, bounded memory, preferences, reusable
skills, evidence, decisions, continuity, recovery, and revocation. Codex,
Claude, Cursor, Hermes, Orca, LangChain, and other harnesses continue to own
models, prompts, scheduling, supervision, worktrees, tools, retries, and local
runtime context.

MDevolved must not ingest raw transcripts, hidden reasoning, terminal history,
provider credentials, or runtime state. It may store only bounded,
provider-neutral facts and artifacts that improve the next attempt. Agents that
need independent reasoning receive focused context without peer conclusions;
leads and synthesis actors receive the wider view their role requires.

## Delivery sequence

Each milestone is a separate task with one acceptance decision. Planning,
implementation, regression repair, adversarial review, and its complete gate
stay in that task.

### MD9 — Canonical MDevolved identity

**Acceptance decision:** Close MD9 only when a clean installation, Source
connection, agent authorization, MCP resume/checkpoint loop, export, snapshot,
and restore writes and advertises MDevolved identities; the same candidate
still reads legacy data and serves old clients through a contained compatibility
adapter; and restored or migrated data creates no live authority.

Implementation:

- Freeze a machine-readable old-to-new identity matrix before changing code.
- Introduce canonical MDevolved MCP tools, resources, capability discovery,
  pairing receipts, ignore-file behavior, headers, client names, portable
  formats, and public package metadata.
- Advertise only the new interface to new clients. Keep old tool names as
  capability-negotiated aliases with identical authorization and revocation.
- Move unavoidable old identifiers behind one clearly owned compatibility
  boundary. Add a repository check that rejects new former-name usage elsewhere while
  allowing historical receipts and hostile fixtures.
- Use forward-only migrations and dual-read/new-write behavior. Never rename a
  live database table, bucket, binding, hostname, or deployment resource in
  place.
- Create a canonical MDevolved Obsidian adapter identity and release path.
  Archive the old alpha repository/package with a migration notice only after
  the replacement is published and tested.
- Publish one coherent Community alpha release, a human-readable npm package
  page, checksums, supported-version matrix, upgrade notes, and rollback notes.

Required automated evidence:

- new client/new data; old client/old data; old client/new server; and explicit
  unsupported-version failure;
- immediate revocation, expiry, cross-Project and cross-Source denial;
- conflicting old and new receipts, ignore files, and idempotency keys;
- old backup/export/snapshot import, new round trip, quarantine, tamper, and
  no-restored-authority checks;
- plugin clean install and migration, MCP capability negotiation, package clean
  install, deployment dry-runs, accessibility, browser acceptance, and the
  complete repository gate on the exact candidate.

Owner authorization is required at execution time for repository changes,
package publication, plugin distribution, production migration, deployment,
or any paid/signing service. npm scope availability, plugin-store identity, and
external naming conflicts are verified before the implementation freezes names.

#### MD9 execution order

1. **Freeze identities and compatibility.** Record every public, wire, portable,
   package, plugin, deployment, and stored identity in one machine-readable
   matrix. Classify each as canonical, dual-read/new-write, frozen legacy, or
   existing-infrastructure-only. Unknown conflicts fail closed.
2. **Make new behavior canonical.** Update contracts before services, then MCP,
   pairing, receipts, ignore files, headers, client packs, portable formats,
   UI, docs, package metadata, and release automation. New clients discover
   only canonical names.
3. **Contain compatibility.** Route old tools, schemes, cookies, headers,
   formats, files, and client capabilities through explicit adapters. Conflicting
   old and new inputs are errors, not precedence guesses. Do not rename live
   D1 tables, R2 keys, Durable Object identities, bindings, hostnames, grants,
   sessions, OAuth state, or plugin settings in place.
4. **Complete distribution surfaces.** Give the CLI and canonical Obsidian
   adapter human-readable package pages, supported-version metadata, checksums,
   upgrade guidance, and rollback guidance. Keep the old adapter usable until
   the replacement is published and independently verified.
5. **Prove the whole boundary.** Run focused allowed/denied and compatibility
   tests during implementation. Then run static identity guards, clean-install
   checks, migrations, unit/integration tests, browser acceptance, builds, and
   deployment dry-runs once on the exact final candidate. An independent critic
   reviews the final diff before MD9 can close.

MD9 stops and reports an explicit exception for an unsupported legacy version,
identity conflict, authority expansion, protected-path request, destructive
migration, unavailable external name, failed exact-candidate gate, or any
operation requiring ungranted external authority.

### MD10 — Lovable proof and one simple path

**Acceptance decision:** Close MD10 only when a first-time visitor can watch the
complete value loop, then follow a six-step-or-shorter public path using a
disposable Markdown folder and one compatible agent without seeing MCP tool
names, receipt fields, migration concepts, or Obsidian-only instructions.

Implementation:

- Add a 20–30 second, captioned demonstration: agent A works, MDevolved
  checkpoints useful state, a fresh session or agent B resumes the exact goal,
  evidence, useful failure, and next action.
- Show real, synthetic-data product captures for passkey claim, connected
  Source, bounded agent authorization, checkpoint, and successful resume.
- Create one human quickstart: deploy or open MDevolved, claim with passkey,
  connect a disposable folder, authorize an agent, say “MDevolved resume this
  project,” and verify the resumed result.
- Keep the existing technical guide as an agent/protocol reference. Put
  Obsidian, orchestration, recovery internals, and advanced deployment below the
  primary path.
- Reuse the same quickstart in the GitHub README, npm package page, and website.
- Explain in plain language why this is more than `AGENTS.md`, Git history,
  local memory, or a provider session: durable cross-agent identity, bounded
  authority, evidence, selective context, revocation, and recovery.
- State the trust boundary plainly: MDevolved constrains its own MCP channel;
  it cannot constrain unrelated shell or filesystem authority granted directly
  by a harness.

Required automated evidence includes broken-link and install-command checks,
demo fallbacks, mobile and keyboard access, reduced motion, social previews,
clean-install replay from public instructions, and the complete repository gate.
Use the existing site and application; add no analytics dependency, frontend
framework, or speculative onboarding system.

#### MD10 public path

The primary instructions must fit in six user actions:

1. deploy or open MDevolved;
2. claim the owner account with a passkey;
3. connect one disposable Markdown folder;
4. authorize one compatible agent;
5. say **Connect this project to MDevolved**; and
6. start a fresh session and say **MDevolved resume project**.

The website, GitHub README, and npm page use this same path. Tool names,
receipt fields, Obsidian, orchestration, recovery internals, and self-hosting
details remain available, but they do not interrupt the first success.

### MD11 — Unassisted alpha evidence

**Acceptance decision:** Close MD11 only when at least five external users
independently complete the primary path and a fresh-session resume using
synthetic or disposable content, without intervention from the owner. The
resumed context must correctly identify the objective, accepted evidence,
useful failure or constraint, and next action; revocation must deny the next
call.

Alpha protocol:

- Recruit 5–10 people who use at least two relevant interaction shapes: desktop
  apps, IDEs, CLIs, headless agents, or orchestration tools.
- Measure only privacy-safe stage timestamps, result codes, client capability
  shape, and voluntary usability feedback. Never collect project content,
  transcripts, prompts, hidden reasoning, terminal history, or credentials.
- Track product interaction time separately from Cloudflare account/setup time.
  Target first useful resume within ten minutes of opening a ready deployment.
- Classify every failure as discovery, installation, claim, Source connection,
  agent authorization, resume correctness, recovery, or client compatibility.
- Repair security defects, data-loss risks, regressions, and repeated funnel
  blockers in the same milestone. Defer feature requests that do not improve
  completion of the primary loop.
- Test the name rather than debating it: ask users what they think MDevolved
  does, how they pronounce it, and whether “devolved” implies deterioration.
  Reconsider the brand only if confusion repeats across independent users.

Human participation is intrinsic to MD11 and cannot be replaced by automated
tests. Automation may prepare disposable deployments, validate telemetry
redaction, replay the task, and summarize receipts, but it cannot claim an
unassisted-user acceptance result.

## Valid review findings included

The plan treats these findings as product work, not criticism to dismiss:

- the current product is technically substantial but visually under-proven;
- the public quickstart exposes internal protocol concepts too early;
- npm and release presentation do not yet provide one coherent install story;
- self-hosting infrastructure is presented before the user’s payoff;
- actual product screenshots, a short demonstration, external usage evidence,
  and distribution proof are missing;
- visible former-brand identities in the separate plugin/release path undermine the
  completed display rename; and
- adding features before observing unassisted users increases scope and bus
  factor without proving loveability.

These claims are not adopted as requirements: deleting technical architecture,
hiding orchestration compatibility, forcing every component to share one
version number, inferring product failure from repository stars, or renaming
MDevolved again without user evidence.

## Review triage

| Review point                                          | Decision                           | Planned response                                                                                                           |
| ----------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The rename is visibly incomplete                      | Valid blocker                      | MD9 makes MDevolved canonical on every new/public path and isolates legacy names.                                          |
| The value is described but not shown                  | Valid blocker                      | MD10 adds the short handoff demonstration and real synthetic-data captures.                                                |
| The first-run path exposes protocol ceremony          | Valid blocker                      | MD10 freezes one six-action folder path and moves technical material below it.                                             |
| npm, releases, and the adapter tell different stories | Valid blocker                      | MD9 aligns discovery, compatibility, checksums, package pages, and upgrade guidance without forcing one component version. |
| External usage proof is missing                       | Valid blocker for alpha confidence | MD11 requires five unassisted successful resumes and a revocation check.                                                   |
| The architecture is too broad to maintain             | Valid risk, not a rewrite order    | Freeze new surface through MD11; repair only security, data safety, compatibility, and funnel blockers.                    |
| Low stars prove the product is failing                | Unsupported                        | Measure successful independent use, not popularity during a new alpha.                                                     |
| Delete the security and recovery depth                | Rejected                           | Keep the trust model; hide implementation detail from the normal path.                                                     |
| Rename the product again now                          | Premature                          | Test comprehension and pronunciation with MD11 users before another identity change.                                       |

## Explicit non-goals through MD11

- No new agent scheduler, supervisor, model router, tool runtime, worktree
  manager, vector database, or transcript ingestion.
- No R3/R4 expansion, policy autopilot, scheduled drills, team account model,
  managed cloud control plane, or additional Source type.
- No global former-name search-and-replace and no destructive down-migration.
- No production-resource rename merely for cosmetic consistency.
- No promise that every named AI product is certified. Compatibility is based
  on transport, authorization, capability, and context-isolation behavior.
- No paid promotion, installer signing, app-store fee, or external cost without
  explicit owner approval.

## Recovery and delivery rules

- Every durable change is forward-only, exportable, snapshot-covered,
  restorable into quarantine, and tested without restored authority.
- Application rollback may ignore additive fields; it never runs a destructive
  schema rollback.
- Existing deployments keep their resource identifiers until an owner chooses
  a separately tested migration. New deployments receive canonical names.
- Every milestone receipt records outcome, files and contracts, migrations,
  focused and full gates, adversarial findings and rework, costs, cleanup,
  unresolved risks, and commit/PR/deploy state.
- A local green gate does not authorize commit, push, publication, migration,
  or deployment.

## Next action

Finish **MD9 — Canonical MDevolved identity** in this task. The identity matrix,
dual-read/new-write boundary, runtime and portable contracts, canonical client
discovery, plugin release candidate, migrations, UI, docs, and focused
acceptance suite are implemented. Freeze the exact candidate, run the complete
repository/browser/build/deployment-dry-run gate once, then request explicit
owner authorization for commit, push, canonical plugin-repository creation,
publication, and deployment. Do not archive the legacy plugin or migrate a live
cell until the replacement repository, release assets, checksums, installer,
and rollback path are independently verified. MD10 begins only after MD9
passes; MD11 begins only after the public MD9/MD10 candidate is available to
testers. The final milestone receipt, rather than this planning document,
records the exact-candidate gate and delivery result.
