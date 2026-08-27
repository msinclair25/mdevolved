# MDevolved onboarding contract

This is the product contract for Community, managed trial, owner acceptance,
and future trial cells. The same release and state machine must run in every
deployment.

## The model in one sentence

An approved **Source**—a Markdown folder or Obsidian workspace—supplies
explicitly approved knowledge; a **MDevolved Project** supplies the durable objective, context boundary, agents, Work
Packets, and collaboration history.

A Source label is never a Project identity. A Project is recognized only by its
full durable Project ID and exact source/context relationship. Technical
compatibility responses continue to use `vaultId`.

## The single path

| State            | One primary action                                            | Completion proof                                                             |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unclaimed        | Create owner passkey                                          | Owner exists and the owner session is active                                 |
| No Source        | Choose a Markdown folder or install the Obsidian adapter      | Exact compatible sync client is ready for that Source                        |
| Client ready     | Pair this Source                                              | Single-use grant is exchanged for this exact Source                          |
| Paired           | Keep the folder app or Obsidian adapter open                  | Durable reconcile confirms the first sync and current state vector           |
| Synced           | Wait for automatic library build                              | Published generation matches the exact current state vector                  |
| Library current  | Connect an agent                                              | Active grant names the exact Source, folder boundary, and restored sources   |
| Agent connected  | Prepare its first Project in MDevolved                        | One exact agent, Project name, and approved folder handoff is durable        |
| Handoff prepared | Say **Connect this project to MDevolved** in the real client  | Matching `open_project` creates or joins and returns ready on the same token |
| Review fallback  | Review one exact owner link only for a mismatch/later Project | Exact Project grant is approved once; no second Project OAuth flow           |
| Project approved | Keep working in the same agent connection                     | `wait_for_project_connection` returns the ready exact Project                |
| Ready            | Use the three-operation agent loop                            | Resume, targeted find, and checkpoint complete without owner ceremony        |

The plugin-install step is itself stateful and truthful. On macOS it says to
quit Obsidian with **Obsidian → Quit Obsidian** or **⌘Q** because closing
the window does not quit the app. It distinguishes a waiting Chrome folder
picker from an active verified install, reports cancellation as “nothing
changed,” and gives named recovery for permission or write failures. The BRAT
fallback is pinned to the compatible MDevolved Sync version and says that its deep
link opens a form; the user must still choose **Add Plugin**, wait for BRAT,
and enable MDevolved Sync. Direct install and BRAT are never presented as simultaneous
steps.

Recovery is tracked beside this path, not inside it. MDevolved recommends a verified
encrypted recovery point as soon as the library is current, but it does not
block read-only agent authorization. A current verified recovery point is
mandatory before any vault mutation, restore, delete, or other destructive
operation.

The dashboard shows only the next incomplete action for the selected Source.
Verified milestones remain available in a collapsed receipt. Progress from
another Source never completes a step.

## Primary vault writer

The human always remains the vault owner. The first agent that establishes an
MDevolved Project for a Source becomes that Source's primary writer across Projects.
Later agents remain connected as read-only collaborators. Owner consent teaches
this rule before approval, and every successful Project open, connection
completion, or resume returns the calling agent's advisory `localVaultAccess`
role.

Before local Obsidian CLI, skill, shell, or filesystem mutation, the managed
`AGENTS.md` block requires the agent to call `owd_resume` and obey that
role. The primary writer still needs an owner-requested bounded task. A
read-only collaborator warns the owner and hands off changes. A same-client
restart retains the role; a different authorization remains read-only and the
global Agents screen never promotes it. This deters accidental writes but is
not an operating-system or filesystem lock.

A crash, restart, or fresh agent session does not change the vault-wide writer
assignment. When `.owdignore` exists, the agent resumes it as its first MDevolved
action and treats the role as unconfirmed until the current
`localVaultAccess.role` response arrives. The normal path is automatic;
**MDevolved resume project** is the visible fallback. The legacy phrase **OWD
resume project** remains equivalent; neither means reconnect MCP, repeat
consent, or create another Project.

The operational regions follow the same top-to-bottom order as the state
machine: **Source connections → Note library → Agent access**. After the
automatic first library build succeeds and authoritative readiness confirms the
library, MDevolved makes the adjacent Agent access region the next action. Refreshing
an already-current library does not move the owner.

A second passkey is a strongly recommended owner-recovery action in **System
health**, not a content-onboarding gate. Add it on another device before
depending on the cell for long-term recovery.

## Automatic work and repair work

Pairing is followed by durable first-sync confirmation and an automatic first
library build. Every later durable vault change also schedules an automatic
exact-current successor after sync settles. A normal user should not need to
understand “materialization” or service library freshness.

**Build now** and **Refresh now** are immediate repair actions. When retained
history exists but does not match current sync state, the UI labels it stale
while MDevolved prepares the successor automatically. Agents, search tools, Project
initialization, and snapshots cannot treat it as current.

## Ordinary work after setup

The owner gives one short instruction; the compatible agent handles the loop:

1. call `owd_resume` before meaningful work;
2. call `owd_find` for targeted durable recall; and
3. call `owd_checkpoint` before finishing.

Resume returns bounded structured Project context rather than replaying a raw
transcript or provider session. `focused` is the default, `independent`
withholds peer conclusions, and `synthesis` compares separately attributable
durable results. The agent passes `checkpointBase` and `contextMode` from resume
back to checkpoint unchanged. Focused and synthesis stale memory fails closed;
independent work remains bound to the exact frozen packet. These are
agent-handled receipts, never a human approval step.

The owner retains root authority and may revoke immediately. MDevolved does not grant
local shell, skill, Obsidian CLI, or filesystem access. Packet renewal, leases,
fencing, Runs, and continuity internals are advanced compatibility concerns,
not routine owner work.

## Retry behavior

- `open_project` is the primary entry point for create, connect, rejoin, and
  resume. A single compatible Project opens automatically; only genuine
  multiple-Project ambiguity becomes a user question.
- The normal first Project uses the exact agent, label, and folder handoff the
  owner prepared during web onboarding. A matching create or join consumes it
  once and becomes ready without returning the owner to the website.
- A different label, folder, agent, vault, owner action, or later Project cannot
  consume that handoff. It uses the existing exact owner-review path instead.
- Repeating the same Project initialization with any transport idempotency key
  returns the existing pending or approved initialization when client, vault,
  folder, context policy, documentation plan, Project, Work Item, role, and
  requested scopes are semantically identical.
- Separate agent clients keep separate consent and Project grants, but a
  database-enforced vault-wide reservation makes one case-insensitive Project
  name one creation identity. Sequential and concurrent approvals converge on
  the creator's exact durable Project receipt; a later caller cannot create a
  second Project through a race.
- If another request is already creating that identity, MDevolved waits briefly for
  its durable receipt and attaches the caller to the resulting Project. A
  different creation contract fails closed and directs the agent to the
  existing Project instead of guessing or duplicating it.
- A changed semantic request is a new request and requires exact consent.
- A pending request is visible as **Review and approve Project** without a
  reload. MDevolved mints a short-lived owner-only alias after passkey authentication;
  it does not store the raw agent token.
- A one-time request remains open for one hour. Repeating the exact expired
  idempotent request renews it rather than creating a duplicate.
- The agent calls `wait_for_project_connection` on the same MCP connection
  while owner consent is pending. The user never copies a completion prompt,
  opens MCP controls, or performs a second Project OAuth ceremony.
- An approved legacy request that still carries the former
  `client-authorization-pending` marker self-heals to an exact Project grant
  when the same active source connection opens it. The owner is never sent back
  through initialization.
- Routine internal packet expiry never creates an owner step and never hides or
  replaces the Project. A compatible Project remains discoverable; an
  authorized `owd_resume` refreshes the ordinary bounded context after all
  authority and integrity checks. Advanced clients retain `resume_project`.
- An exact expired packet remains immutable and cannot be retrieved for active
  work or used for a new submission.

## Revocation and provenance

Every agent and Project call revalidates the exact live source grant, active
vault, current published generation, and Project grant. Revoking a vault
cascades its Project access and invalidates its old library for agent use.
Active collaboration grants renew their availability window automatically on
authorized use. This never survives explicit revocation, expands scopes, or
changes Project or source identity.

Restored notes remain tagged with their source lineage inside the target vault.
They are excluded by default even when the target vault is active. Access
requires explicit consent to the named restore source and is removed when the
corresponding authorization is revoked.

## Duplicates

MDevolved never silently deletes or merges Projects. The lifecycle dashboard displays
the full Project ID, source vault IDs, record count, active grants, packet
state, and last activity. When historical duplicates are found:

1. compare those exact values;
2. identify the unwanted Project by full ID;
3. archive it, which preserves records and revokes active grants; and
4. reactivate it later if the choice was wrong.

## Trial guarantees

A managed trial enforces two active or pending vaults atomically. It does not
cap agent clients or Projects. At trial expiry, owner authentication, reads,
inspection, diagnostics, and export remain available while sync and other
mutations stop.

Every managed tester receives an isolated, pre-provisioned cell through one
invitation. Managed onboarding never includes the development repository, a
fork, Cloudflare build settings, an operator account, an internal acceptance
Project, private evidence, or an operator runbook. Those are private release
inputs and must not be copied into user instructions, Project source notes,
portable artifacts, or cell seed data.

Every deployed cell exposes its application version, immutable Worker release
ID, and release tag. **Copy redacted diagnostics** returns IDs, versions,
timestamps, counts, and lifecycle state, but excludes names, note paths, note
content, credentials, Project labels, Project objectives, and client origins.

## Release rule

Onboarding changes are incomplete until the same source release, migration
chain, compatible MDevolved Sync package, and verification suite are applied to every
live deployment and retained trial template.
