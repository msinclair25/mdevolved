# Eve compatibility

MDevolved supports [Eve](https://github.com/vercel/eve) as an optional,
standards-based agent client. Eve keeps its native runtime, durable sessions,
subagents, sandbox, connections, and schedules. MDevolved keeps one remote MCP
Streamable HTTP endpoint, OAuth authority, exact vault grants, durable Project
identity, provenance, and owner Decisions.

The reviewed profile is pinned to:

| Contract          | Reviewed value                             |
| ----------------- | ------------------------------------------ |
| Eve               | `0.29.4`                                   |
| Eve source commit | `85c1dd7a647a04cc1bd74879ba8d27a3ba0bdd9d` |
| `@vercel/connect` | `0.6.0`                                    |
| License           | Apache-2.0                                 |
| Reviewed          | July 31, 2026                              |

This is a source-verified compatibility profile. It does not yet claim that a
live Eve deployment has completed MDevolved's independent two-agent acceptance run.
Unknown future Eve connection or identity changes fall back to MDevolved's universal
MCP setup until the profile is reviewed again.

Eve 0.29 replaces its retired `/connect` setup command with `eve add` and
`/add` registry installation. MDevolved's generated `agent/connections/owd.ts`
module remains a supported authored MCP connection. Until MDevolved is accepted into
an Eve registry, use the dashboard-generated module rather than claiming an
`eve add` package that does not exist.

Eve 0.29.4 leaves its authored MCP definition, runtime MCP client, and
`@vercel/connect` contract unchanged. It adds trusted setup for official
connection registry items, which creates a path to a future
`eve add connection/owd` installer. Eve executes declared connector setup only
for its official registry, so MDevolved will not advertise that command until an
upstream registry contribution is accepted. The dashboard-generated module
below remains the complete supported setup in the meantime.

## Architecture

```text
Signed-in person
     │
     ▼
Eve user route ── Vercel Connect OAuth custody
     │
     │ standard Streamable HTTP MCP + OAuth 2.1/PKCE
     ▼
MDevolved /mcp ── exact source grant ── vault / approved folders
     │
     └── durable Project, packet, handoff, review, Decision, provenance
```

There is no Eve-specific MDevolved endpoint, proxy, bearer-token bridge, tool
translation layer, or custom Project call. Eve discovers MDevolved's ordinary tools
and qualifies them with its connection name.

## Install the connection

Create `agent/connections/owd.ts`:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const mdevolvedMcpUrl = "https://YOUR-MDEVOLVED-HOST/mcp";

export default defineMcpClientConnection({
  url: mdevolvedMcpUrl,
  description:
    "MDevolved owner-approved Obsidian knowledge and durable cross-agent Projects. Use it to connect, resume, read bounded context, and exchange cited handoffs.",
  auth: connect({
    connector: "oauth/mdevolved",
    principalType: "user",
    tokenParams: {
      scopes: [
        "vault.read",
        "project.initialize.request",
        "project.connect.request",
      ],
      resources: [mdevolvedMcpUrl],
    },
    autoProvision: true,
    displayName: "MDevolved",
    instructions:
      "Open MDevolved, verify this eve agent and the exact vault and folder boundary, then approve to continue.",
  }),
});
```

The authenticated MDevolved dashboard generates this module with the deployment's
exact MCP URL. The reusable generator is
`createEveConnectionSource(mcpUrl, connectorUid?)` from
`@mdevolved/client-packs`.

The profile deliberately does not set a client-side tool allowlist. MDevolved's live
advertised catalog and server-side grant are the authority. It also does not
force a Vercel Connect validation round trip on every call: MDevolved rechecks its
durable grant on every tool call and immediately denies revoked access.

## The normal user flow

The connection filename `mdevolved.ts` gives Eve the connection name
`mdevolved`, so its discovered tools are qualified as `mdevolved__<tool>`.

1. The user asks Eve to connect this Project to MDevolved.
2. Eve calls `mdevolved__connection_info`.
3. Eve calls `mdevolved__open_project` with the exact Project UUID from `.mdevolvedignore`
   or the visible name the user supplied.
4. When OAuth is needed, Eve pauses the call and opens its user-scoped
   connection flow. The owner signs in to MDevolved and approves the exact vault and
   optional folder boundary.
5. When Project approval is still needed, Eve presents the single returned
   approval URL and calls `mdevolved__wait_for_project_connection` with the exact
   returned key.
6. Eve persists the continuity receipt in a durable workspace and uses
   `mdevolved__resume_project` on later tasks.

No step asks the owner to copy a prompt, reconnect a working OAuth connection,
renew a routine 24-hour packet, or create a duplicate Project. If a wrapper
loses a pending envelope, Eve repeats only the exact same `mdevolved__open_project`
call once so MDevolved can recover the same durable request.

An initial Eve connection authorization and a later exact Project approval are
different consent boundaries. The latter is not a second OAuth setup. During
MDevolved's prepared first-Project onboarding, the exact matching Project request can
become ready without another browser round trip.

## User routes and `principal_required`

The recommended connection is intentionally `principalType: "user"`. Eve can
therefore use MDevolved only in a route with an authenticated user principal. If Eve
reports `principal_required`, continue from a signed-in user route. Do not:

- reconnect or revoke MDevolved;
- change the connection to `principalType: "app"`; or
- embed a static MDevolved bearer token.

Those actions would either fail to repair the Eve route or weaken MDevolved's
per-person consent boundary.

## Agent identity and independent review

MDevolved attributes a grant and every collaboration submission to the OAuth client
identity. An Eve display name, prompt, session, channel, or directory name is
not authority.

| Eve shape                                                              | MDevolved identity                            |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| Multiple sessions or channels using `oauth/mdevolved`                  | One participant                               |
| Eve's built-in `agent` child                                           | Inherits the root connection; one participant |
| Declared local subagent with the same connector UID                    | Still one participant                         |
| Separate agent/reviewer using `oauth/mdevolved-reviewer` and new OAuth | Independently attributable participant        |

Use a unique connector UID and OAuth registration for every agent that must be
independently attributable, especially a reviewer. Prefer a separate top-level
Eve agent or deployment for a genuinely independent review. Merely spawning a
child and renaming it does not satisfy MDevolved's independent-review boundary.

Eve may expose multi-user application routes, but MDevolved Community remains a
single-owner authorization system. The profile does not add team ownership or
shared administration.

## Sandbox and Obsidian writes

Eve's sandbox is isolated at `/workspace`; it does not automatically have the
owner's local Obsidian vault. MDevolved's remote MCP tools remain the default bounded
knowledge and collaboration path.

If the owner deliberately mounts or clones vault files into Eve's runtime,
direct shell, filesystem, Obsidian CLI, or skill-driven edits must obey the
`localVaultAccess` returned by MDevolved:

- `primary-writer` may perform only the owner-requested bounded write;
- `read-only-collaborator` warns and proposes or hands off instead; and
- a restarted process retains its role only when it resumes through the same
  authorized MDevolved client; a different authorization remains read-only.

MDevolved submission tools append collaboration records. They never grant local
filesystem authority.

## Durable sessions, Projects, and schedules

Eve's durable session preserves a runtime conversation. MDevolved is the portable
cross-agent record for Project identity, current Work Packets, Artifacts,
Handoffs, Reviews, owner Decisions, citations, and provenance. Resume the MDevolved
Project on later work instead of treating an old Eve conversation as current
shared truth.

Top-level Eve schedules run as an application/runtime principal and cannot
silently borrow the user's MDevolved grant. Scheduled MDevolved work must be dispatched
through a user-authenticated route or wait for explicit user action. The
profile does not downgrade MDevolved to app-scoped access for unattended execution.

## Distribution surfaces

The same versioned profile is available through:

- package export `@mdevolved/client-packs`;
- script-free skill `@mdevolved/client-packs/mdevolved-eve`;
- MCP Resource `mdevolved://compatibility-profiles/eve/v1`;
- MCP Prompt `connect-eve`; and
- the authenticated dashboard's copy-ready connection module.

A client that ignores Resources, Prompts, or skills can still use the same
universal MDevolved `/mcp` URL and tool workflow.
