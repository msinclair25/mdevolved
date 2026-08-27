# MDevolved agent-native product plan

**Status:** R1-R4 continuity infrastructure is complete and remains a hidden
foundation. M1-M4 are verified, merged, and deployed to the persistent
Community alpha.

**Date:** 2026-08-25

## Product promise

> Connect MDevolved once, and every AI starts with the right project memory,
> preferences, skills, evidence, and next step.

MDevolved should make successful project work compound across sessions and AI tools.
It is not an agent runtime, scheduler, worktree manager, model router, or
replacement for Codex, Claude, Cursor, Hermes, Orca, or future harnesses.

The primary user is a solo builder, researcher, or technical creator who uses
more than one AI tool and keeps meaningful work in Markdown or Obsidian.

## North-star outcome

A fresh agent in a different compatible harness completes the next meaningful
task correctly without the owner reconstructing the project.

The agent must be able to identify:

- the objective and definition of done;
- current state and immediate next action;
- accepted decisions and their evidence;
- failed approaches that should not be repeated;
- relevant owner and Project preferences; and
- useful attached skills.

The lovable moment is not a dashboard. It is the second AI continuing correctly
without copied prompts or repeated explanation.

## One product loop

```text
Resume relevant context
  -> work in the chosen harness
  -> verify the result
  -> checkpoint outcome and evidence
  -> improve the next resume
```

MDevolved exposes this loop through three plain agent operations:

### `owd_resume(project, task?, contextMode?, acceptedContextVersions?)`

Return one compact working context:

- goal and definition of done;
- current state and next action;
- decisions, sources, and artifacts;
- known failed approaches;
- relevant personal and Project preferences; and
- relevant skill names and descriptions.

The frozen version-1 structured response remains unchanged for existing
clients. Clients that discover `owd://agent-memory/capabilities/v2` send
`acceptedContextVersions: [1, 2]` through the same normal operation and receive
the machine-readable working profile in version 2. This is response-version
negotiation, not a provider-specific profile toggle.

`focused` is the default context mode. `independent` returns the shared
objective, scope, sources, constraints, and definition of done while withholding
peer conclusions and provisional results. `synthesis` may include separately
attributable submitted results for comparison. MDevolved records the bounded context
version supplied to the agent; it never treats hidden reasoning as context.

### `owd_find(question)`

Answer a targeted question from durable Project memory with citations. Older or
less relevant material remains searchable instead of filling every context
window.

### `owd_checkpoint(outcome)`

Record what changed, verification evidence, decisions, useful failures, skills
used, remaining work, and the recommended next action. Reuse the existing
durable provenance and continuity services behind this simpler facade. Pass the
opaque checkpoint base and applied context mode from resume back unchanged:
focused and synthesis work remain tip-bound, while independent work remains
bound to the exact frozen packet and stays separately attributable.

These names describe the product contract. Adapters may map them onto existing
versioned services while current clients remain compatible.

## What MDevolved remembers

| Layer                | Purpose                                                    | Typical scope                 |
| -------------------- | ---------------------------------------------------------- | ----------------------------- |
| Personal preferences | Stable ways the owner likes to work                        | All Projects                  |
| Project memory       | Goal, state, decisions, evidence, failures, and next step  | One Project                   |
| Reusable skills      | Portable knowledge, checklists, templates, and workflows   | Personal or attached Projects |
| Learned practices    | Useful facts or methods discovered through successful work | Personal or one Project       |

Current explicit instructions override Project preferences, and Project
preferences override personal defaults. Preferences stay short, editable, and
source-attributed. Credentials, OAuth state, raw transcripts, hidden reasoning,
terminal history, and runtime state are never memory.

## Portable skills

MDevolved uses the open Agent Skills `SKILL.md` format rather than inventing a skill
language. It may import, store, version, attach, retrieve, and export a skill
plus its supporting files.

MDevolved does not execute skill scripts or grant their requested tools. Each harness
decides how a skill is loaded and executed under its own permission model. An
MDevolved adapter may generate disposable `AGENTS.md`, `CLAUDE.md`, Cursor-rule, or
Hermes references, but those formats do not become required durable state.

Only skill descriptions enter the initial resume context. Full skill contents
load on demand when the task needs them.

## Compounding without clutter

MDevolved improves future context from small structured checkpoints, not from storing
entire conversations.

When the same instruction or successful practice recurs, MDevolved may create a
non-blocking draft such as:

> You have asked several agents to use pnpm and avoid new dependencies. Save
> this as a Project preference?

or:

> This research process produced verified results twice. Save it as a reusable
> skill?

Suggestions never interrupt work. The owner can accept, edit, ignore, or later
delete them. MDevolved must not claim that correlation proves a preference or that a
skill caused success.

## Agent experience requirements

- One MCP connection and one Project consent should cover ordinary memory use.
- A short bootstrap instruction tells agents to resume before meaningful work,
  find prior knowledge when needed, and checkpoint before finishing.
- Tool names, descriptions, inputs, outputs, and errors must be understandable
  without MDevolved documentation or internal schema knowledge.
- Resume output must be bounded, predictable, cited, and useful as Markdown as
  well as structured data.
- Writes must be idempotent; retrying a checkpoint cannot duplicate memory.
- Errors must say how the agent can recover.
- Relevant context is preferred over complete history.
- Independent work must remain genuinely independent: an `independent` resume
  cannot expose peer conclusions, while a `synthesis` resume labels every
  included result by its durable provenance.
- Ordinary in-boundary reads and checkpoints require no recurring owner
  ceremony. Revocation, authority expansion, protected paths, credentials, and
  destructive operations retain their existing boundaries.
- Generic MCP and portable files remain the compatibility floor.

## Human experience

The default product has four understandable areas:

- **Projects** — active work and the current brief;
- **Memory** — editable preferences and learned practices;
- **Skills** — reusable portable workflows;
- **Activity** — meaningful changes and their sources.

A Project primarily shows its current brief, attached skills, Project
preferences, recent progress, and **Continue in another AI**.

Runs, Actors, EventBundles, leases, fencing, policy versions, Exceptions,
RPO/RTO, recovery drills, retention tiers, and continuity internals stay out of
the normal path. They may support security, recovery, compatibility, and
advanced diagnostics without becoming product vocabulary.

## Responsibility boundary

| MDevolved owns                               | The execution harness owns                      |
| -------------------------------------------- | ----------------------------------------------- |
| Portable preferences and Project memory      | Model and agent loop                            |
| Skill packages and Project attachments       | Skill selection and execution                   |
| Decisions, evidence, and compact checkpoints | Tools, shell, browser, and credentials          |
| Cross-tool recall and export                 | Scheduling, retries, worktrees, and supervision |
| User-controlled provenance and recovery      | Runtime permissions and ephemeral context       |

## Delivery milestones

### M1 — Agent-native resume loop

**Outcome:** A user connects a Project once, one agent checkpoints meaningful
work, and a fresh agent in another harness continues correctly through the
three-operation facade.

**Build:** Add the smallest compatible facade for `owd_resume`, `owd_find`, and
`owd_checkpoint`; generate focused, independent, and synthesis views of the
compact current brief from existing records; add one short bootstrap
instruction; and reduce the default Project UI and documentation to the resume
loop.

**Acceptance:** Setup takes under five minutes; the second agent becomes
productive within 30 seconds; it accurately reports the goal, definition of
done, decisions, evidence, failed approaches, and next step; its retry-safe
checkpoint improves the following resume; and current clients still work.
Two independent agents must not see each other's provisional conclusions, and
a later synthesis view must return their separately attributable submitted
results without exposing hidden reasoning.

### M2 — Portable working profile and skills

**Outcome:** Relevant preferences and one standard portable skill follow the
owner between at least two compatible harnesses.

**Build:** Add short editable personal and Project preferences; import/export
Agent Skills packages; attach skills to Projects; return relevant descriptions
from resume and full contents on demand; include all new durable data in
portable export and authority-free recovery.

**Acceptance:** A preference and attached skill influence the same bounded task
in two harnesses without copied setup, executing through each harness's native
permissions. Removing either takes effect on the next call.

**Delivery receipt (2026-08-25):** Accepted automatically. Provider-neutral
stateful and stateless clients receive the same bounded preference precedence
and exact-version attached skill description; full inert skill contents load
only on demand, and detach/delete takes effect on the next authorized call.
Legacy context version 1 remains unchanged while version 2 is additive and
negotiated. Mutations are replay-safe, concurrent first-write conflicts return
stable domain errors, and cross-Project, stale-version, credential-shaped, and
oversize inputs fail closed. Encrypted portable export/decrypt/restore was
exercised end to end: live profile records restore only as owner-visible
quarantine with zero grants or live projections, quarantined history is not
captured again, and profile-bearing restore is rejected above the 14-object
Community bound. The exact candidate passed focused M2 validation, the complete
repository test and migration gates, browser E2E, builds, public-source scan,
and Worker/marketing deploy dry runs. A named two-product exercise remains
optional compatibility evidence rather than an unimplemented M2 surface.

### M3 — Evidence-backed compounding

**Outcome:** Successful work leaves the owner with better reusable context,
without accumulating noisy transcripts or blocking prompts.

**Build:** Create derived, non-blocking preference and skill drafts from
repeated attributable checkpoints; show why each suggestion exists; support
accept, edit, ignore, and delete; keep stale or conflicting knowledge out of
the current brief while preserving cited history.

**Acceptance:** A repeated instruction becomes an accurate preference draft; a
repeated successful method becomes an editable skill draft; ignored drafts do
not reappear noisily; conflicts resolve by explicit scope and recency; and the
next fresh-agent task requires fewer owner corrections.

**Delivery receipt (2026-08-25):** Accepted locally. Agents may attach at most
four structured, credential-screened learning signals to a checkpoint. Two
distinct attributable Continuity Points are required before a quiet owner-only
draft appears. Pending drafts never enter resume context; accept/edit-and-accept
reuses the M2 profile and inert-skill services; ignore/delete suppress the exact
fingerprint. Owner routes require session plus CSRF, v1/v2 MCP clients remain
compatible, and v3 negotiation is additive. Compounding history is Unvetted,
portable only under explicit Approved-and-Unvetted selection, dependency-closed,
and restored only as source-labelled authority-free quarantine. Integrated M3
validation passed 167 tests before final crash/race regressions; independent
review accepted the remediated candidate with no open finding.

### M4 — Minimum lovable release

**Outcome:** A new multi-AI user experiences the cross-agent continuation
moment without understanding MDevolved internals.

**Build:** Finish agent-led onboarding, Project brief editing, simple Memory and
Skills surfaces, cross-harness setup recipes, a synthetic demonstration
Project, and privacy-safe product metrics.

**Acceptance:** Automated provider-neutral clients and browser E2E complete
connect, work, switch, and continue without terminal setup or prompt copying;
the default path never requires the advanced continuity surfaces; keyboard,
narrow-width, and accessibility checks pass; and the release has a clear
Community install and upgrade path. Later human feedback may improve the
product but is not a release gate.

**Delivery receipt (2026-08-25):** Accepted locally. The owner can edit the
current Project and Work Item brief through immutable successor versions;
stale or conflicting writes fail closed, same-key retries are stable, and the
next `owd_resume` rotates stale packet context automatically. The Project view
keeps Memory & Skills in the ordinary path and adds collapsed, owner-only,
local outcome evidence using only bounded counts, booleans, and timestamps.
Provider-neutral Codex, Claude-compatible, Hermes, and Orca recipes preserve
the harness boundary. Synthetic desktop and narrow-browser continuation covers
brief editing, Client A evidence, the fresh Client B instruction, generic MCP
setup, and outcome feedback without provider credentials or prompt copying.
No schema migration, telemetry service, executable skill runtime, or restored
authority was added.

**Release receipt (2026-08-25):** M1-M4 merged to `main` after the complete
GitHub gate passed, including the production dependency audit, migrations,
unit and Worker tests, browser E2E, builds, and deploy dry runs. Forward
migrations `0034` and `0035` applied to the persistent Community alpha, the
Worker health check reported `1.0.0-alpha.7`, and no migrations remained
pending. The public-source history scan passes across every reachable public
revision. No paid provider inference, personal vault data, restored authority,
or new managed-service dependency was involved.

## Measures of success

- Time from connection to first useful resume.
- Time for a fresh agent to become productive.
- Correct fresh-agent recall of goal, decisions, evidence, failures, and next
  action.
- First-pass completion of a meaningful task.
- Owner corrections and repeated failed approaches per task.
- Verified checkpoints that improve a later resume.
- Continued use across two or more AI harnesses.

MDevolved should measure outcomes and corrections, not tokens stored, records
created, actors registered, or automation volume.

## Automated acceptance and delivery

Every milestone must pass focused contract, service, MCP, UI, compatibility,
export, restore, and hostile-boundary checks appropriate to its change. A
separate read-only review must challenge context isolation, authorization,
replay, provenance, and product-language claims before the milestone closes.

After M4, run the complete repository check, unit, migration, integration,
browser E2E, build, and deploy-dry-run commands from the exact candidate. Repair
every regression in the same milestone, apply only forward migrations, deploy
the authorized Community candidate, and verify public health and integrity.
Synthetic data is sufficient; paid provider inference and human testing are not
release gates.

## Explicit non-goals

- Building an MDevolved agent, planner, scheduler, model router, terminal, browser,
  worktree manager, or retry engine.
- Competing with Hermes, Codex, Claude, Cursor, Orca, or their memory systems.
- Ingesting raw transcripts, hidden reasoning, terminal history, runtime state,
  or provider credentials.
- Creating an executable-skill runtime or a skill marketplace before portable
  user-owned skills prove useful.
- Adding multi-owner enterprise authorization before the single-owner product
  is lovable.
- Making governance, continuity metrics, or recovery drills part of ordinary
  project work.

## Completed foundation

R1-R4 already proved durable Project identity, cited evidence, provider-neutral
MCP services, lead replacement, bounded agent operations, deterministic policy
enforcement, encrypted export and recovery, authority-free restore, and
Community deployment. Those capabilities remain supported and testable.

They are now infrastructure beneath the product, not the roadmap's organizing
story. Historical R4 acceptance evidence remains in
[`R4-POLICY-CONTINUITY-FREEZE.md`](R4-POLICY-CONTINUITY-FREEZE.md).

## Accepted product boundary

M4 is closed at the boundary where a new user can connect a supported harness,
understand and edit the Project brief, experience a synthetic cross-agent
continuation, review Memory and Skills without learning MDevolved internals, and see
privacy-safe outcome feedback through an accessible Community deployment path.
Further orchestration, policy automation, or managed-service expansion requires
a fresh task and acceptance decision.
