---
name: owd-eve
description: Connect, initialize, resume, or coordinate OWD Projects from an Eve agent using Eve's standard remote MCP connection, user-scoped Vercel Connect OAuth, qualified tool names, durable Project continuity, and independently attributable agent identities. Use when an Eve repository has agent/connections, when adding OWD to Eve, or when routing OWD work through Eve sessions, subagents, sandboxes, or schedules.
---

# OWD + Eve

Keep one universal OWD server. Apply this profile as Eve-side configuration and
instructions; never change MCP framing, OAuth, tool schemas, or OWD authority
for Eve.

## Confirm the runtime

1. Confirm the repository uses Eve and has an `agent/` directory.
2. Read the repository's `AGENTS.md` and local agent instructions.
3. Add `agent/connections/owd.ts`; its filename makes the Eve connection name
   `owd`.
4. Use `defineMcpClientConnection` with the deployment's standard remote
   Streamable HTTP `/mcp` URL.
5. Use `connect()` from `@vercel/connect/eve` with
   `principalType: "user"`, `autoProvision: true`, the OWD MCP URL as the token
   resource, and only these source-grant scopes:
   `vault.read`, `project.initialize.request`, and
   `project.connect.request`.

Do not add a proxy, static bearer token, app principal, custom tool schema,
client-side Project authority, or a second OWD endpoint. Do not pin a local
tool allowlist: OWD's advertised catalog and server-side grant remain
authoritative.

Eve `0.29.4` can install integrations from its registry with `eve add` or
interactive `/add`. OWD is not represented as registry-installed until Eve's
upstream registry accepts it. Until then, use the generated
`agent/connections/owd.ts` module from the OWD dashboard; do not claim that
`eve add owd` is available.

## Authenticate in the right context

Eve's user-scoped connection requires a signed-in user route. Let Eve pause the
tool call, open its connection flow, and resume after the owner approves the
exact OWD vault and folder boundary. Credentials stay in Vercel Connect rather
than model-visible history.

If Eve reports `principal_required`, use a user-authenticated Eve route. This
is not an OWD revocation and is not repaired by reconnecting OWD or changing to
`principalType: "app"`.

Top-level Eve schedules run with an app/runtime principal and cannot silently
borrow a user's OWD grant. Dispatch scheduled OWD work through a
user-authenticated route or require an explicit user action. Never weaken the
OWD connection to app-scoped authorization merely to make a schedule run.

## Preserve identity

OWD attributes grants and collaboration records to the authenticated OAuth
client.

- Eve sessions and channels that reuse one connector UID are one OWD
  participant.
- Eve's built-in `agent` child inherits the root connection and is the same OWD
  participant.
- A declared local subagent discovers its own connections, but it is still the
  same OWD participant if it reuses the same connector UID.
- Give every genuinely independent writer, reviewer, or agent a separate
  connector UID and OAuth registration, such as `oauth/owd-reviewer`.
- Prefer a separate top-level Eve agent or deployment when independent
  attribution matters.

Never describe a renamed Eve agent, fresh session, or subagent directory as
independently authorized unless its connector identity is actually distinct.
OWD remains single-owner even when Eve exposes multi-user routes.

## Connect or resume

Eve qualifies discovered tools with the connection name. For `owd.ts`, use:

1. `owd__connection_info`;
2. `owd__open_project`;
3. `owd__wait_for_project_connection` only when OWD returns a pending approval;
   and
4. `owd__resume_project` on later work.

Read `.owdignore` first when it exists and pass its exact Project UUID and
context policy. Otherwise pass the visible Project name the user supplied.

In a fresh Eve session, the writer role is unconfirmed until
`owd__resume_project` returns the current `localVaultAccess.role`. Never infer
that a session reset changed the durable role from the agent name, channel,
sandbox, or prior conversation. Treat **OWD resume project** as a direct request
to perform this receipt-based resume without reconnecting or asking for new
authorization.

If `owd__open_project` returns pending, show its one owner approval URL and call
`owd__wait_for_project_connection` with the exact returned key. Do not start a
second OAuth flow, ask the owner to copy a prompt, renew a routine packet,
repeat an approved request, or create a duplicate Project. If the pending
envelope is lost, repeat only the exact same `owd__open_project` call once so
OWD can recover the same durable request.

Persist the continuity receipt in `.owdignore` and replace only OWD's marked
`AGENTS.md` block, preserving all other instructions.

## Separate runtime state from Project truth

Eve's durable session preserves one runtime conversation. OWD remains the
portable record for the Project, Work Packet, Attempts, Artifacts, Handoffs,
Reviews, owner Decisions, citations, and provenance. Resume OWD at the start of
later work rather than treating old Eve conversation state as current shared
authority.

Eve's sandbox is isolated at `/workspace` and does not automatically expose the
owner's Obsidian vault. If the owner deliberately mounts or clones vault files,
inspect OWD `localVaultAccess` before a direct write:

- `primary-writer`: perform only the owner-requested bounded write;
- `read-only-collaborator`: propose or hand off instead of writing; and
- restarted process: resume the exact Project through the same authorized OWD
  client to retain its role; a different authorization remains read-only and
  hands proposed changes to the human owner.

The same rule applies to shell, filesystem, Obsidian CLI, and skill-driven
writes. OWD Project submission tools are append-only collaboration paths; they
do not grant authority to mutate the local vault.
