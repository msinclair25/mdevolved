# Agent-first quick start

This guide describes the agent-first workflow shared by Community deployments
and the invitation-only managed alpha. Community operators deploy from this
public repository; managed users start from a pre-provisioned workspace
invitation. MDevolved Sync synchronizes a selected Markdown folder; its optional
Obsidian adapter retains the frozen `owd-sync` compatibility identity. MDevolved MCP
gives an already-authorized agent explicitly approved access to durable Project
memory. You continue working in your project folder, Obsidian workspace, and
existing agent.

MDevolved keeps four identities separate:

- a **Source** is one approved Markdown folder or Obsidian workspace;
- its **library** is the current searchable publication;
- an **agent connection** grants one selected Source and any optional folder
  limits;
- a **MDevolved Project** is the durable initiative that holds the objective,
  approved context, Work Packets, agents, and collaboration history.

Names may match, but a Source is never implicitly treated as a Project.

## The normal agent loop

After the Project is connected once, the user does not manage packets, leases,
or fencing. Give the agent this instruction:

> Before meaningful work, call `owd_resume` for this Project. Use `owd_find`
> when you need targeted durable recall. Before finishing, call
> `owd_checkpoint` with the resume receipt and verified outcome.

`owd_resume` returns bounded structured Project context, not a transcript or
provider-session replay. `focused` is the default. Use `independent` to withhold
peer conclusions and provisional results, and `synthesis` only to compare
separately attributable durable results.

The agent passes the opaque `checkpointBase` and returned `contextMode` from
`owd_resume` back to `owd_checkpoint` unchanged. Focused and synthesis work
reject stale memory instead of silently overwriting newer progress. Independent
work remains bound to the exact frozen Work Packet, allowing separately working
agents to submit attributable results without seeing peer conclusions. These
receipts are handled by the agent; they are never a human approval gate.

Provider sessions may expire without erasing MDevolved records. Cross-computer
preservation still requires a deployed MDevolved endpoint/account and a verified
backup. Portable preferences, inert skills, and owner-reviewed evidence-backed
suggestions are available in **Memory & Skills**; pending suggestions never
enter a resume until the owner accepts them.

## The cross-agent moment

The smallest useful demonstration is deliberately boring:

1. Client A connects the Project, does a bounded piece of work, and calls
   `owd_checkpoint` with its verified outcome.
2. The owner starts Client B on another computer or in a fresh session.
3. Client B calls `owd_resume` for the exact Project ID and receives the
   objective, current state, cited evidence, rejected approaches, and next
   action. No prompt, transcript, terminal history, or provider session is
   copied.

For an independent review, Client B requests `independent` context. MDevolved keeps
peer conclusions and synthesis out of that view; later synthesis can attribute
the separately submitted results. MDevolved stores the bounded Project evidence and
does not schedule, launch, retry, or supervise either client.

Use the repository fixture
`packages/contracts/fixtures/owd-m4-cross-agent-continuation-v1.json` for a
no-cost local demonstration. It contains synthetic IDs and hashes only.

## Install and pair

For a managed workspace, start at step 1. For Community, deploy from the public
repository, claim the resulting permanent URL, then start at step 2. Choose
either the folder path or the optional Obsidian path:

1. Open the private invitation and claim the pre-provisioned workspace with a
   passkey.
2. For a plain folder, open MDevolved Sync and choose the exact Markdown root.
   For Obsidian, turn on Community plugins, then fully quit the application with
   **Obsidian → Quit Obsidian** or **⌘Q**. Closing a macOS window is not a
   quit.
3. In **Sources**, choose the folder path, or choose **Install MDevolved Sync
   for Obsidian 0.1.7**. For Obsidian, select
   the exact synthetic vault root containing `.obsidian`, not `.obsidian`
   itself, and allow Chrome's write request.
4. Reopen that exact vault and confirm MDevolved Sync for Obsidian `0.1.7` is enabled.
5. Return to MDevolved, create the private pairing request, and approve it from
   the selected folder app or exact open Obsidian workspace.
6. Keep the sync client open while MDevolved automatically publishes the current searchable
   library.
7. Connect your existing agent to the workspace's MDevolved MCP server.

MDevolved Sync for Obsidian is not yet listed in Obsidian Community Plugins, so
that adapter uses the version-matched installer during the alpha. The Project
workflow below is the same for folders and Obsidian workspaces.

Download and reopen the recovery key, then create a verified encrypted snapshot
as an independent safeguard. Read-only agent setup does not wait for it;
MDevolved requires recovery before a future Source mutation, restore, delete, or other
destructive operation.

The dashboard shows these prerequisites for one explicitly named Source at a
time. Progress from another Source never fills its checklist. Agent setup stays
closed until at least one active Source has its own current library.

Branches, commands, migrations, bindings, Cloudflare resources, MCP endpoint
construction, JSON, scopes, and internal IDs are not normal managed setup
choices. Community operators see infrastructure only during deployment and
maintenance. The direct local plugin installer is a temporary desktop-alpha
path. BRAT is the unsupported-browser fallback: its deep link opens a
prefilled form, but the user must still choose **Add Plugin**, wait for BRAT to
finish, and enable MDevolved Sync for Obsidian (legacy plugin ID: `owd-sync`).

## Set up the Project from the agent

Finish the owner choices first in **How MDevolved works**. Select the active agent you
want coordinating this Source, enter the exact first Project name, choose one of
that agent's already-approved folder boundaries, and select **Prepare first
Project**. MDevolved shows a receipt naming the agent, Project, and folder.

In the project folder, tell the agent:

> Connect this project to MDevolved.

The agent starts with `open_project`. That single entry point handles a new
Project, an existing Project, a rejoin, and a resume. If exactly one compatible
Project exists, MDevolved opens it without asking you to choose an internal mode. If
more than one exists, the agent asks which visible Project you mean. If none
exists, it prepares one bounded New Project draft and calls `open_project`
again. A `.owdignore` `projectId` is authoritative. When you name the work and
no receipt exists, the agent passes that exact name as `projectHint`; it never
matches authority by a local folder name or silently opens different work.

Before either request, the agent inventories Markdown files at repository root.
Keep repository control files such as `README.md`, `AGENTS.md`,
`CONTRIBUTING.md`, and `SECURITY.md` at root. For other Project documentation,
the agent proposes exact moves into `docs/` and asks before moving anything.
The owner page shows the retained files and exact moves. MDevolved does not move local
files; after approval, the agent applies only the approved moves, updates
relative links, and verifies that every resulting path exists. If you keep
files at root, the agent must use their actual paths rather than inventing a
`docs/` location.

For a new Project, an agent using the hardened Project contract requests
only:

- the selected paired Source;
- one normalized folder boundary inside that Source;
- an explicit default-deny Project context policy inside that boundary;
- a bounded Project label and objective; and
- `project.initialize.request`, which can request browser consent but cannot
  create or access a Project by itself.

For the matching prepared first Project, `open_project` consumes that exact
single-use handoff and returns ready on the same MCP connection. You do not
return to MDevolved, copy anything, reconnect, or approve the same choices again.

When approval is genuinely needed—a different name or folder, a later Project,
or an advanced/repair action—`open_project` returns one visible owner link, and
the waiting MDevolved dashboard shows the same approval automatically. The agent
immediately calls `wait_for_project_connection` on the same MCP connection
while you review it. The consent page leads with the exact Source, Project, and
objective; detailed client, folder, scopes, egress, preservation, and
included/excluded context remain reviewable. MDevolved does not guess which Markdown
is legitimate Project context. The owner can correct the proposed paths before
approval. Include paths are an allowlist; exclusions win, including for future
notes created under an included folder. The policy affects Project context
only. It does not exclude notes from MDevolved Sync or encrypted recovery.

If the selected Source is a recovery target, agent consent separately lists
each named restore source and leaves it unchecked. Leave it unchecked unless
this agent should read those restored paths. The target Source grant alone does
not include them. Explicitly approved restored reads identify their source in
MCP provenance.

The durable Project and its exact, separately revocable collaboration grant are
created atomically only after exact owner consent—either the matching
single-use handoff prepared during onboarding or the fallback review. The
existing Source-scoped MCP connection is not widened: every Project call
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
Source folders. Internal packet or source-generation changes never hide an
otherwise compatible Project. One compatible Project resumes directly;
multiple compatible Projects require a visible-name choice. When this exact
client has not yet been approved for the Project, the one owner confirmation
shows the client, Project label and ID, Source folders, current work item,
immutable context policy, and requested capabilities. Approval creates the
client's separate Project grant on the existing connection; it does not create
or change the Project.

The second computer does not need the Source on disk. Its agent reaches the
approved server-side context through the legacy-compatible MCP after owner consent. The
durable Project ID—not a label, path, or remembered chat—is how both agents
refer to the same Project.

## Client recipes

Codex: use the dashboard's **Copy setup** command, authenticate the exact MCP
server, then ask the agent to call `owd_resume` before meaningful work.

Claude or another compatible client: add the dashboard's MCP URL to its
project-scoped `mcpServers` configuration. The common HTTP shape is:

```json
{
  "mcpServers": {
    "mdevolved": { "type": "http", "url": "https://YOUR-MDEVOLVED-HOST/mcp" }
  }
}
```

Hermes uses the same generic MCP tools and the inert hands-off mapping in
[`HERMES-HANDS-OFF.md`](HERMES-HANDS-OFF.md). Orca may run the work in its own
worktree, but remains the execution harness: MDevolved records bounded evidence and
continuity only; it does not launch Orca agents or certify their work.

## Continue in a new agent task

After approval, the initializing agent receives two exact continuity artifacts:

- `.owdignore`, a versioned JSON manifest containing the exact `projectId`,
  `includePaths`, and `excludePaths`; and
- a bounded MDevolved-managed block for the project root `AGENTS.md`.

The agent writes the exact `.owdignore` receipt and merges only the marked MDevolved
block into `AGENTS.md`; it must preserve every existing project instruction.
It never asks the owner to copy the receipt, Project ID, policy JSON, or
instruction block.
Codex reads the applicable `AGENTS.md` instruction chain at the start of a new
task. The MDevolved block therefore tells a fresh task to read `.owdignore` and call
`owd_resume` with its exact `projectId` before using prior Project context.

That `owd_resume` call is the first MDevolved action when `.owdignore` exists. Until
it returns, the fresh session's writer role is **unconfirmed**—the agent must
not claim that it is or is not primary from chat history, a new session
identity, or local tool availability. The current `localVaultAccess.role` is
authoritative. A compliant client should perform this automatically. If it
does not after a crash, restart, or context reset, the owner can say
**MDevolved resume project**. The legacy phrase **OWD resume project** remains
equivalent; the agent resumes the existing receipt without reconnecting
MCP or requesting new authorization.

`owd_resume` uses the `projectId` in `.owdignore` rather than inferring a
Project from a label or whichever grant was most recently used. It rechecks the
live client, exact Project grant, scope, revocation, and current durable state.
It returns one bounded cited brief only when they agree. It does not replay raw
conversation history. The lower-level `resume_project` receipt and packet
behavior remain available under advanced compatibility paths.

Do not hand-edit `.owdignore` as a way to change authority. Reinitialize or use
an owner-approved Knowledge Space change so MDevolved can issue a new pinned version.

## When an agent can also edit the vault

An MDevolved connection does not grant write access, even when the same agent has an
Obsidian skill, Obsidian CLI, shell, or filesystem permission. Those local
tools bypass MDevolved's read-only MCP boundary.

The human always remains the vault owner. The first agent that establishes an
MDevolved Project for the vault becomes its primary vault writer across Projects.
Every successful `open_project`, connection completion, and `owd_resume`
returns that caller's advisory `localVaultAccess` role. The managed `AGENTS.md`
block requires an agent to check that role before a local mutation.

The primary writer may create or organize content only for an owner-requested
bounded task or paths. Every later client receives
`read-only-collaborator`, warns the owner before a direct write, and hands off
proposed changes. A restarted session using the same MDevolved client retains the
role after `resume_project`. A different authorization remains read-only; the
global Agents screen never promotes it. Agents do not infer a transfer from
having Obsidian or filesystem tools, and they do not need to be disconnected to
remain read-only.

Never give two agents overlapping write responsibility. The writer targets the
exact vault and paths, putting `vault=<exact vault name>` first in every
Obsidian CLI command instead of falling back to whichever vault was most
recently focused. It then lets MDevolved Sync publish the bounded batch and reports
completion before another bounded task begins. `localVaultAccess` and `AGENTS.md`
warn and coordinate compliant agents; they are not a filesystem lock. If the
role, scope, or overlap is unclear, the agent stops and asks.

## Handoff and independent review

Agent A works against the current Project-scoped Work Packet and creates a durable
Attempt, Artifact, and Handoff. These records remain private until the owner
explicitly shares the selected Handoff and supporting records.

To continue with another agent, connect Agent B to the same MDevolved deployment and
approve its Source/folder connection with `project.connect.request`. Tell it to
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
revocation, recovery, and advanced inspection—not daily project work. MDevolved
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
Source/path boundary, and revocation state. Closing a chat does not revoke
access. Routine token, grant, packet, and source refresh must never become an
owner task. Explicit revocation is final and the next call fails; reconnecting
after revocation requires a new deliberate owner authorization.

## Failure behavior

Agents must stop and report the actionable failure when authorization is
missing, revoked, expired, ambiguous, cross-Project, stale, replayed, or
unsupported. They must never broaden a Source/folder selector, reuse another
Project's identifiers, infer owner approval, or fall back to transcript or model
claims as durable evidence.

`continuity_point_conflict` means another checkpoint advanced the Project after
this agent's resume. The agent calls `owd_resume`, incorporates the latest
durable state, then creates a new checkpoint with a new idempotency key. It
must not ask the owner to renew context or initialize a replacement Project.
Advanced clients using historical packet APIs still handle `work_packet_stale`
through the lower-level `resume_project` compatibility path.

An older `.owdignore` without `projectId` is not permission to guess. The agent
calls `open_project` once; when the same active source authorization still
covers the approved Project, MDevolved repairs the legacy receipt without another
owner approval. A revoked or narrowed source authorization fails closed.

`library_setup_required` or `library_not_ready` means the paired Source has no
exact-current searchable library yet. Keep the folder or Obsidian adapter open
and retry the same bounded request shortly. If MDevolved reports that the
automatic build failed, select **Build now** for that Source and retry after it
completes. Do not repeat pairing,
invent an authorization URL, or substitute the deployment homepage.
