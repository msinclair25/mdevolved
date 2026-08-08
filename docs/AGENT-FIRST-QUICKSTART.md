# Agent-first quick start

This guide describes the agent-first workflow shared by Community deployments
and the invitation-only managed alpha. Community operators deploy from this
public repository; managed users start from a pre-provisioned workspace
invitation. OWD Sync synchronizes the selected Obsidian vault. OWD MCP gives an
already-authorized agent explicitly approved access to OWD collaboration. You
continue working in your project folder, Obsidian vault, and existing agent.

OWD keeps four identities separate:

- an **Obsidian vault** is an approved knowledge source;
- its **library** is the current searchable publication;
- an **agent connection** grants one selected vault and any optional folder
  limits;
- an **OWD Project** is the durable initiative that holds the objective,
  approved context, Work Packets, agents, and collaboration history.

Names may match, but a vault is never implicitly treated as a Project.

## Install and pair

For a managed workspace, start at step 1. For Community, deploy from the public
repository, claim the resulting permanent URL, then start at step 2:

1. Open the private invitation and claim the pre-provisioned workspace with a
   passkey.
2. In Obsidian, turn on Community plugins, then fully quit the application with
   **Obsidian → Quit Obsidian** or **⌘Q**. Closing a macOS window is not a
   quit.
3. In **Vaults**, choose **Choose vault and install OWD Sync 0.1.7**. Select
   the exact synthetic vault root containing `.obsidian`, not `.obsidian`
   itself, and allow Chrome's write request.
4. Reopen that exact vault and confirm OWD Sync `0.1.7` is enabled.
5. Return to OWD, create the private pairing request, and approve it from that
   exact open vault.
6. Keep Obsidian open while OWD automatically publishes the current searchable
   library.
7. Connect your existing agent to the workspace's OWD MCP server.

OWD Sync is not yet listed in Obsidian Community Plugins, so both modes use the
version-matched desktop installer during the alpha. The Project workflow below
is the same in both modes.

Download and reopen the recovery key, then create a verified encrypted snapshot
as an independent safeguard. Read-only agent setup does not wait for it; OWD
requires recovery before a future vault mutation, restore, delete, or other
destructive operation.

The dashboard shows these prerequisites for one explicitly named vault at a
time. Progress from another vault never fills its checklist. Agent setup stays
closed until at least one active vault has its own current library.

Branches, commands, migrations, bindings, Cloudflare resources, MCP endpoint
construction, JSON, scopes, and internal IDs are not normal managed setup
choices. Community operators see infrastructure only during deployment and
maintenance. The direct local plugin installer is a temporary desktop-alpha
path. BRAT is the unsupported-browser fallback: its deep link opens a
prefilled form, but the user must still choose **Add Plugin**, wait for BRAT to
finish, and enable OWD Sync.

## Set up the Project from the agent

Finish the owner choices first in **How OWD works**. Select the active agent you
want coordinating this vault, enter the exact first Project name, choose one of
that agent's already-approved folder boundaries, and select **Prepare first
Project**. OWD shows a receipt naming the agent, Project, and folder.

In the project folder, tell the agent:

> Connect this project to OWD.

The agent starts with `open_project`. That single entry point handles a new
Project, an existing Project, a rejoin, and a resume. If exactly one compatible
Project exists, OWD opens it without asking you to choose an internal mode. If
more than one exists, the agent asks which visible Project you mean. If none
exists, it prepares one bounded New Project draft and calls `open_project`
again. A `.owdignore` `projectId` is authoritative. When you name the work and
no receipt exists, the agent passes that exact name as `projectHint`; it never
matches authority by a local folder name or silently opens different work.

Before either request, the agent inventories Markdown files at repository root.
Keep repository control files such as `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, and `SECURITY.md` at root. For other Project documentation,
the agent proposes exact moves into `docs/` and asks before moving anything.
The owner page shows the retained files and exact moves. OWD does not move local
files; after approval, the agent applies only the approved moves, updates
relative links, and verifies that every resulting path exists. If you keep
files at root, the agent must use their actual paths rather than inventing a
`docs/` location.

For a new Project, an agent using the hardened Project contract requests
only:

- the selected paired vault;
- one normalized folder boundary inside that vault;
- an explicit default-deny Project context policy inside that boundary;
- a bounded Project label and objective; and
- `project.initialize.request`, which can request browser consent but cannot
  create or access a Project by itself.

For the matching prepared first Project, `open_project` consumes that exact
single-use handoff and returns ready on the same MCP connection. You do not
return to OWD, copy anything, reconnect, or approve the same choices again.

When approval is genuinely needed—a different name or folder, a later Project,
or an advanced/repair action—`open_project` returns one visible owner link, and
the waiting OWD dashboard shows the same approval automatically. The agent
immediately calls `wait_for_project_connection` on the same MCP connection
while you review it. The consent page leads with the exact vault, Project, and
objective; detailed client, folder, scopes, egress, preservation, and
included/excluded context remain reviewable. OWD does not guess which Markdown
is legitimate Project context. The owner can correct the proposed paths before
approval. Include paths are an allowlist; exclusions win, including for future
notes created under an included folder. The policy affects Project context
only. It does not exclude notes from OWD Sync or encrypted recovery.

If the selected vault is a recovery target, agent consent separately lists
each named restore source and leaves it unchecked. Leave it unchecked unless
this agent should read those restored paths. The target vault grant alone does
not include them. Explicitly approved restored reads identify their source in
MCP provenance.

The durable Project and its exact, separately revocable collaboration grant are
created atomically only after exact owner consent—either the matching
single-use handoff prepared during onboarding or the fallback review. The
existing vault-scoped MCP connection is not widened: every Project call
resolves and rechecks that separate D1 grant behind the same connection. There
is no second OAuth ceremony. Denial, expiry of the one-time request, an
OAuth-client mismatch, out-of-bound paths, an excluded source note, ambiguous
input, and replay fail closed.

If approval is still pending, keep the original request and call
`wait_for_project_connection` again after opening its existing link. Do not
repeat setup or create another Project. Existing approved records from releases
that used the older two-step authorization flow are repaired automatically
when the same still-authorized client opens the Project; the owner is not sent
through initialization again.

If the client cannot open a browser, it must present the exact authorization URL
for the owner to open. It must not claim that initialization completed while
consent is pending.

Manual Project creation is available only under **Advanced/manual setup** on the
website.

For an existing Project—such as Agent B on another computer—the connection
uses the separate `project.connect.request` capability. `open_project` sees only
Projects whose active context is fully covered by that connection's approved
vault folders. Internal packet or source-generation changes never hide an
otherwise compatible Project. One compatible Project resumes directly;
multiple compatible Projects require a visible-name choice. When this exact
client has not yet been approved for the Project, the one owner confirmation
shows the client, Project label and ID, vault folders, current work item,
immutable context policy, and requested capabilities. Approval creates the
client's separate Project grant on the existing connection; it does not create
or change the Project.

The second computer does not need the source vault on disk. Its agent reaches
the approved server-side context through OWD MCP after owner consent. The
durable Project ID—not a label, path, or remembered chat—is how both agents
refer to the same Project.

## Continue in a new agent task

After approval, the initializing agent receives two exact continuity artifacts:

- `.owdignore`, a versioned JSON manifest containing the exact `projectId`,
  `includePaths`, and `excludePaths`; and
- a bounded OWD-managed block for the project root `AGENTS.md`.

The agent writes the exact `.owdignore` receipt and merges only the marked OWD
block into `AGENTS.md`; it must preserve every existing project instruction.
It never asks the owner to copy the receipt, Project ID, policy JSON, or
instruction block.
Codex reads the applicable `AGENTS.md` instruction chain at the start of a new
task. The OWD block therefore tells a fresh task to read `.owdignore` and call
`resume_project` before using prior Project context.

That resume is the first OWD action when `.owdignore` exists. Until it returns,
the fresh session's writer role is **unconfirmed**—the agent must not claim that
it is or is not primary from chat history, a new session identity, or local
tool availability. The current `localVaultAccess.role` response is
authoritative. A compliant client should perform this automatically. If it
does not after a crash, restart, or context reset, the owner can say **OWD
resume project**; the agent resumes the existing receipt without reconnecting
MCP or requesting new authorization.

`resume_project` uses the `projectId` in `.owdignore` rather than inferring a
Project from a label or whichever grant was most recently used. It rechecks the
live OAuth client, audience, Project scopes, authoritative D1 grant, revocation,
pinned Knowledge Space version, selector hash, and the complete local policy.
It returns the current Work Packet only when all of them agree. OWD
automatically appends a successor when routine packet context expires or its
source library advances, and it slides an active collaboration grant's
availability window on authorized use. None of those maintenance actions can
change the Project, scope, source boundary, or owner consent. A missing,
changed, malformed, or broadened policy still fails closed and requires owner
attention; the agent must not continue from chat memory.

Do not hand-edit `.owdignore` as a way to change authority. Reinitialize or use
an owner-approved Knowledge Space change so OWD can issue a new pinned version.

## When an agent can also edit the vault

An OWD connection does not grant write access, even when the same agent has an
Obsidian skill, Obsidian CLI, shell, or filesystem permission. Those local
tools bypass OWD's read-only MCP boundary.

The human always remains the vault owner. The first agent that establishes an
OWD Project for the vault becomes its primary vault writer across Projects.
Every successful `open_project`, connection completion, and `resume_project`
returns that caller's advisory `localVaultAccess` role. The managed `AGENTS.md`
block requires an agent to check that role before a local mutation.

The primary writer may create or organize content only for an owner-requested
bounded task or paths. Every later client receives
`read-only-collaborator`, warns the owner before a direct write, and hands off
proposed changes. A restarted session using the same OWD client retains the
role after `resume_project`. A different authorization remains read-only; the
global Agents screen never promotes it. Agents do not infer a transfer from
having Obsidian or filesystem tools, and they do not need to be disconnected to
remain read-only.

Never give two agents overlapping write responsibility. The writer targets the
exact vault and paths, putting `vault=<exact vault name>` first in every
Obsidian CLI command instead of falling back to whichever vault was most
recently focused. It then lets OWD Sync publish the bounded batch and reports
completion before another bounded task begins. `localVaultAccess` and `AGENTS.md`
warn and coordinate compliant agents; they are not a filesystem lock. If the
role, scope, or overlap is unclear, the agent stops and asks.

## Handoff and independent review

Agent A works against the current Project-scoped Work Packet and creates a durable
Attempt, Artifact, and Handoff. These records remain private until the owner
explicitly shares the selected Handoff and supporting records.

To continue with another agent, connect Agent B to the same OWD deployment and
approve its vault/folder connection with `project.connect.request`. Tell it to
connect to the Project. Agent B calls `open_project`; it opens the single
compatible Project automatically or asks only when more than one is compatible.
After the one exact owner approval, ask it to review the shared Handoff. Agent B
receives only the current Project-scoped packet and explicitly shared records.
It creates its own Attempt and Review under its independently authorized client
identity.

Only the owner can accept, reject, supersede, or record a Decision. A later Work
Packet carries accepted Decisions and shared Handoffs and Reviews with exact
content hashes and provenance links. Dashboard counts derive from grants and
durable records, never transcripts, chain-of-thought, token volume, or claimed
model identity.

## Continuity and recovery

The website is for setup, consent, activity and provenance, owner Decisions,
revocation, recovery, and advanced inspection—not daily project work. OWD
projects accepted collaboration records into the paired Obsidian notebook and
can export a portable exchange when an agent cannot use MCP directly.

Revocation is immediate for subsequent MCP calls. Recovery supports:

- **Approved only**, which restores accepted owner-approved intelligence; and
- **Approved plus Unvetted**, which also restores untrusted records in
  quarantine for owner review.

Initialization requests and live authorization grants are not portable recovery
authority. Restore never silently re-authorizes an agent.

The current alpha uses short-lived access tokens with normal client-managed
OAuth refresh and a separate collaboration grant whose availability window
slides on authorized use. Token possession is never sufficient: every tool call
rechecks the authoritative application grant, source grant, exact Project,
vault/path boundary, and revocation state. Closing a chat does not revoke
access. Routine token, grant, packet, and source refresh must never become an
owner task. Explicit revocation is final and the next call fails; reconnecting
after revocation requires a new deliberate owner authorization.

## Failure behavior

Agents must stop and report the actionable failure when authorization is
missing, revoked, expired, ambiguous, cross-Project, stale, replayed, or
unsupported. They must never broaden a vault/folder selector, reuse another
Project's identifiers, infer owner approval, or fall back to transcript or model
claims as durable evidence.

`work_packet_stale` means the exact historical task packet can no longer accept
work. The agent calls `resume_project`, receives OWD's automatically refreshed
current packet, and retries against that packet. It must not ask the owner to
renew routine context or initialize a replacement Project.

An older `.owdignore` without `projectId` is not permission to guess. The agent
calls `open_project` once; when the same active source authorization still
covers the approved Project, OWD repairs the legacy receipt without another
owner approval. A revoked or narrowed source authorization fails closed.

`library_setup_required` or `library_not_ready` means the paired vault has no
exact-current searchable library yet. Keep Obsidian open and retry the same
bounded request shortly. If OWD reports that the automatic build failed, select
**Build now** for that vault and retry after it completes. Do not repeat pairing,
invent an authorization URL, or substitute the deployment homepage.
