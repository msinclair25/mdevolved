# Eve compatibility

OWD supports [Eve](https://github.com/vercel/eve) as an optional,
standards-based agent client. Eve keeps its native runtime, durable sessions,
subagents, sandbox, connections, and schedules. OWD keeps one remote MCP
Streamable HTTP endpoint, OAuth authority, exact vault grants, durable Project
identity, provenance, and owner Decisions.

The reviewed profile is pinned to:

| Contract          | Reviewed value                             |
| ----------------- | ------------------------------------------ |
| Eve               | `0.29.2`                                   |
| Eve source commit | `7ec1c93ce43488e136a2a043cc3e6a310cd03841` |
| `@vercel/connect` | `0.6.0`                                    |
| License           | Apache-2.0                                 |
| Reviewed          | July 30, 2026                              |

This is a source-verified compatibility profile. It does not yet claim that a
live Eve deployment has completed OWD's independent two-agent acceptance run.
Unknown future Eve connection or identity changes fall back to OWD's universal
MCP setup until the profile is reviewed again.

Eve 0.29 replaces its retired `/connect` setup command with `eve add` and
`/add` registry installation. OWD's generated `agent/connections/owd.ts`
module remains a supported authored MCP connection. Until OWD is accepted into
an Eve registry, use the dashboard-generated module rather than claiming an
`eve add` package that does not exist.

## Architecture

```text
Signed-in person
     │
     ▼
Eve user route ── Vercel Connect OAuth custody
     │
     │ standard Streamable HTTP MCP + OAuth 2.1/PKCE
     ▼
OWD /mcp ── exact source grant ── vault / approved folders
     │
     └── durable Project, packet, handoff, review, Decision, provenance
```

There is no Eve-specific OWD endpoint, proxy, bearer-token bridge, tool
translation layer, or custom Project call. Eve discovers OWD's ordinary tools
and qualifies them with its connection name.

## Install the connection

Create `agent/connections/owd.ts`:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const owdMcpUrl = "https://YOUR-OWD-HOST/mcp";

export default defineMcpClientConnection({
  url: owdMcpUrl,
  description:
    "OWD owner-approved Obsidian knowledge and durable cross-agent Projects. Use it to connect, resume, read bounded context, and exchange cited handoffs.",
  auth: connect({
    connector: "oauth/owd",
    principalType: "user",
    tokenParams: {
      scopes: [
        "vault.read",
        "project.initialize.request",
        "project.connect.request",
      ],
      resources: [owdMcpUrl],
    },
    autoProvision: true,
    displayName: "OWD",
    instructions:
      "Open OWD, verify this eve agent and the exact vault and folder boundary, then approve to continue.",
  }),
});
```

The authenticated OWD dashboard generates this module with the deployment's
exact MCP URL. The reusable generator is
`createEveConnectionSource(mcpUrl, connectorUid?)` from
`@owd/client-packs`.

The profile deliberately does not set a client-side tool allowlist. OWD's live
advertised catalog and server-side grant are the authority. It also does not
force a Vercel Connect validation round trip on every call: OWD rechecks its
durable grant on every tool call and immediately denies revoked access.

## The normal user flow

The connection filename `owd.ts` gives Eve the connection name `owd`, so its
discovered tools are qualified as `owd__<tool>`.

1. The user asks Eve to connect this Project to OWD.
2. Eve calls `owd__connection_info`.
3. Eve calls `owd__open_project` with the exact Project UUID from `.owdignore`
   or the visible name the user supplied.
4. When OAuth is needed, Eve pauses the call and opens its user-scoped
   connection flow. The owner signs in to OWD and approves the exact vault and
   optional folder boundary.
5. When Project approval is still needed, Eve presents the single returned
   approval URL and calls `owd__wait_for_project_connection` with the exact
   returned key.
6. Eve persists the continuity receipt in a durable workspace and uses
   `owd__resume_project` on later tasks.

No step asks the owner to copy a prompt, reconnect a working OAuth connection,
renew a routine 24-hour packet, or create a duplicate Project. If a wrapper
loses a pending envelope, Eve repeats only the exact same `owd__open_project`
call once so OWD can recover the same durable request.

An initial Eve connection authorization and a later exact Project approval are
different consent boundaries. The latter is not a second OAuth setup. During
OWD's prepared first-Project onboarding, the exact matching Project request can
become ready without another browser round trip.

## User routes and `principal_required`

The recommended connection is intentionally `principalType: "user"`. Eve can
therefore use OWD only in a route with an authenticated user principal. If Eve
reports `principal_required`, continue from a signed-in user route. Do not:

- reconnect or revoke OWD;
- change the connection to `principalType: "app"`; or
- embed a static OWD bearer token.

Those actions would either fail to repair the Eve route or weaken OWD's
per-person consent boundary.

## Agent identity and independent review

OWD attributes a grant and every collaboration submission to the OAuth client
identity. An Eve display name, prompt, session, channel, or directory name is
not authority.

| Eve shape                                                        | OWD identity                                  |
| ---------------------------------------------------------------- | --------------------------------------------- |
| Multiple sessions or channels using `oauth/owd`                  | One participant                               |
| Eve's built-in `agent` child                                     | Inherits the root connection; one participant |
| Declared local subagent with the same connector UID              | Still one participant                         |
| Separate agent/reviewer using `oauth/owd-reviewer` and new OAuth | Independently attributable participant        |

Use a unique connector UID and OAuth registration for every agent that must be
independently attributable, especially a reviewer. Prefer a separate top-level
Eve agent or deployment for a genuinely independent review. Merely spawning a
child and renaming it does not satisfy OWD's independent-review boundary.

Eve may expose multi-user application routes, but OWD Community remains a
single-owner authorization system. The profile does not add team ownership or
shared administration.

## Sandbox and Obsidian writes

Eve's sandbox is isolated at `/workspace`; it does not automatically have the
owner's local Obsidian vault. OWD's remote MCP tools remain the default bounded
knowledge and collaboration path.

If the owner deliberately mounts or clones vault files into Eve's runtime,
direct shell, filesystem, Obsidian CLI, or skill-driven edits must obey the
`localVaultAccess` returned by OWD:

- `primary-writer` may perform only the owner-requested bounded write;
- `read-only-collaborator` warns and proposes or hands off instead; and
- a different client takes over only after the owner stops the prior writer and
  selects **Make primary** in OWD → Agents.

OWD submission tools append collaboration records. They never grant local
filesystem authority.

## Durable sessions, Projects, and schedules

Eve's durable session preserves a runtime conversation. OWD is the portable
cross-agent record for Project identity, current Work Packets, Artifacts,
Handoffs, Reviews, owner Decisions, citations, and provenance. Resume the OWD
Project on later work instead of treating an old Eve conversation as current
shared truth.

Top-level Eve schedules run as an application/runtime principal and cannot
silently borrow the user's OWD grant. Scheduled OWD work must be dispatched
through a user-authenticated route or wait for explicit user action. The
profile does not downgrade OWD to app-scoped access for unattended execution.

## Distribution surfaces

The same versioned profile is available through:

- package export `@owd/client-packs`;
- script-free skill `@owd/client-packs/owd-eve`;
- MCP Resource `owd://compatibility-profiles/eve/v1`;
- MCP Prompt `connect-eve`; and
- the authenticated dashboard's copy-ready connection module.

A client that ignores Resources, Prompts, or skills can still use the same
universal OWD `/mcp` URL and tool workflow.
