# Albatross compatibility

OWD supports [Albatross](https://github.com/morganlinton/Albatross) as an
optional execution client. Albatross keeps its models, operator modes, local
tools, approvals, checkpoints, resets, path forks, and workspace memory. OWD
keeps the remote authorization boundary, exact vault scope, durable Project
identity, cited handoffs, owner Decisions, provenance, and revocation.

The reviewed profile is pinned to:

| Contract                | Reviewed value                             |
| ----------------------- | ------------------------------------------ |
| Albatross               | `2.0.3`                                    |
| Albatross source commit | `0543226b800ee57659f200c1ef928925868c90c9` |
| Temporary MCP bridge    | `mcp-remote` `0.1.38`                      |
| Licenses                | MIT / MIT                                  |
| Reviewed                | July 30, 2026                              |

This is a source-verified compatibility profile. It does not claim vendor
certification or a completed live Albatross acceptance run.

Albatross `2.0.3` supports MCP tools through child-process stdio only. OWD does
not add an Albatross-only endpoint or change its standard remote Streamable
HTTP MCP server. The client profile temporarily uses the pinned, experimental
`mcp-remote` package to bridge Albatross stdio to OWD HTTP and OAuth. Remove
that bridge when Albatross supports authenticated remote MCP natively.

## Architecture

```text
Albatross workspace
  ├── agent.config.json
  ├── .albatross/prompt.md
  ├── .owdignore
  └── mcp__owd__<tool>
             │
             │ stdio
             ▼
     mcp-remote 0.1.38
             │
             │ Streamable HTTP + OAuth 2.1/PKCE
             ▼
          OWD /mcp
             │
             ├── exact vault and folder grant
             └── Project, Artifact, Handoff, Review, Decision, provenance
```

The bridge translates transport only. It does not translate OWD tools, hold
server authority, create Projects, bypass consent, or add static bearer
tokens.

## Why authorization happens first

Albatross hard-limits every MCP request, including `initialize`, to 30 seconds.
A first browser OAuth approval can legitimately take longer, and Albatross
discards the child process's stderr. Starting the browser flow inside
Albatross would therefore produce a confusing timeout with little diagnostic
context.

The OWD dashboard creates a fresh `agent-<random>` participant ID for each
setup kit so separate workspaces do not silently reuse one OAuth identity, then
generates a one-time pre-authorization command. The manual examples below use
`primary` only for readability.

```sh
npx -y -p mcp-remote@0.1.38 mcp-remote-client 'https://YOUR-OWD-HOST/mcp' --header 'X-OWD-Albatross-Participant:primary' --transport http-only --auth-timeout 120 --static-oauth-client-metadata '{"client_name":"Albatross via mcp-remote","client_uri":"https://github.com/morganlinton/Albatross"}'
```

Run it before Albatross starts and finish the OWD browser approval. The same
URL, participant header, transport strategy, and client metadata appear in the
generated Albatross configuration, so the stdio bridge reuses the authorized
client. OAuth material stays in the bridge's private user configuration
directory, not the repository or model-visible prompt.

The static client metadata gives the OWD authorization page and connection
list an honest **Albatross via mcp-remote** label. It is metadata, not a
credential or grant.

## Install without replacing configuration

Use the authenticated dashboard's **Copy Albatross setup kit** action. It
contains three matching pieces and the final trust step:

1. the pre-authorization command;
2. an additive `agent.config.json` fragment;
3. a marked `.albatross/prompt.md` block; and
4. `/mcp trust owd`.

Use **New participant ID** before copying a kit for another workspace or an
independently attributable reviewer.

Merge the generated fragment into the existing config:

```json
{
  "mcpServers": {
    "owd": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.1.38",
        "https://YOUR-OWD-HOST/mcp",
        "--header",
        "X-OWD-Albatross-Participant:primary",
        "--transport",
        "http-only",
        "--auth-timeout",
        "120",
        "--static-oauth-client-metadata",
        "{\"client_name\":\"Albatross via mcp-remote\",\"client_uri\":\"https://github.com/morganlinton/Albatross\"}",
        "--silent"
      ]
    }
  }
}
```

Never replace `agent.config.json`; preserve its backend, model, modes, local
tools, approvals, hooks, and other MCP servers. Never use `@latest`, put a
bearer token in the config, or commit bridge credentials.

Merge the generated
`<!-- owd:albatross-profile:v1:start -->` block into
`.albatross/prompt.md`, preserving every instruction outside the markers.
Albatross prepends that file to its system prompt on each turn.

Then start Albatross and run:

```text
/mcp trust owd
```

Albatross scopes trust to the canonical workspace and the exact MCP config
hash. A later config change correctly requires the user to inspect and trust
the changed process definition again.

## Why the workspace prompt is required

Albatross `2.0.3`:

- sends MCP protocol version `2025-06-18`;
- discovers and calls Tools;
- qualifies each tool as `mcp__<server>__<tool>`;
- reads text content from tool results;
- does not consume the server's initialize instructions;
- does not expose MCP Resources or Prompts to the model;
- ignores `structuredContent`; and
- ignores tool-list-change notifications.

OWD remains compatible because every important tool result also carries JSON
as text. The marked workspace prompt supplies only Albatross-specific
continuity rules that the client cannot receive through initialize, Resources,
or Prompts. It does not define new tools or authority.

## Normal Project flow

For server name `owd`, Albatross sees:

1. `mcp__owd__connection_info`;
2. `mcp__owd__open_project`;
3. `mcp__owd__wait_for_project_connection`; and
4. `mcp__owd__resume_project`.

When `.owdignore` exists, Albatross reads it and calls
`mcp__owd__resume_project` as the first OWD action in a fresh task. It passes
the exact Project UUID and complete context policy. The local writer role is
unconfirmed until OWD returns the current `localVaultAccess`.

When no receipt exists, Albatross calls `connection_info`, then `open_project`
with the exact visible Project name supplied by the owner. It never guesses
among multiple Projects or creates a duplicate as a repair.

If `open_project` returns pending, Albatross shows the single approval URL and
calls `wait_for_project_connection` with the exact returned key and
`timeoutSeconds: 20`. This stays below the client's 30-second hard limit. If
approval is still pending, Albatross repeats only the same wait. It does not
restart OAuth, rerun setup, repeat `open_project`, or ask the owner to copy a
prompt.

## Participant identity and independent review

The generated config uses the non-secret header:

```text
X-OWD-Albatross-Participant:primary
```

The pinned bridge includes the server URL and custom headers in its OAuth cache
key. This produces explicit identity behavior without changing the OAuth
resource:

| Albatross shape                                       | OWD identity                  |
| ----------------------------------------------------- | ----------------------------- |
| New session, model, `/reset`, or path using `primary` | Same participant              |
| Another workspace using the same URL and `primary`    | Same participant              |
| Config using `reviewer` plus separate authorization   | Independent OAuth participant |
| Header text without completed OAuth                   | No authority                  |

Use a distinct safe participant ID for every writer or reviewer that must be
independently attributable. The setup generator accepts letters, numbers,
dots, underscores, and hyphens only. The participant header partitions local
bridge state; OWD still binds grants and submissions to the authenticated
OAuth client and rechecks the durable grant on every call.

Changing only an Albatross display name, backend, model, session, or path does
not create an independent reviewer.

## Resets, paths, and portable continuity

Albatross `/reset` writes `.albatross/continue.md` so one runtime can continue
with a smaller context. Immediately after reset, the first OWD action is still
receipt-based `resume_project`. The two files have different jobs:

| File                        | Authority and purpose                          |
| --------------------------- | ---------------------------------------------- |
| `.albatross/continue.md`    | Albatross runtime continuation                 |
| `.owdignore`                | Exact portable OWD Project identity and policy |
| OWD Artifact/Handoff/Review | Cited cross-agent work and evaluation          |
| OWD owner Decision          | Accepted Project direction                     |

Albatross `/path fork` creates alternative execution branches. Treat those
branches as Attempts and Artifacts inside one OWD Project. A path fork does
not create a second Project, second grant, or independent participant.

## Execution force multiplier

OWD and Albatross should preserve different layers of the work:

| Albatross capability      | OWD mapping                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| Current task              | Start from the current owner-approved Work Packet                   |
| `/iterate` and `critique` | Internal candidates; publish meaningful Attempts and selected proof |
| `/path fork`              | Alternative Attempts inside one Project                             |
| `/auto`                   | Bounded execution under the current packet, budget, and deadline    |
| Checkpoint or `/reset`    | Runtime recovery; resume `.owdignore` before continuing             |
| Winning implementation    | Cited Artifact                                                      |
| Work another agent needs  | Handoff with sources, result, open questions, and next action       |
| Independent evaluation    | Review from a distinct participant ID and OAuth authorization       |

Do not copy every Albatross turn, checkpoint, or raw critique into OWD.
Promote the smallest useful evidence: meaningful alternatives, test results,
contrary findings, the selected approach, and a resumable handoff.

`/auto` must remain bounded by the current OWD Work Packet. After its automatic
context reset, Albatross resumes OWD before continuing. It stops rather than
silently working from runtime memory when the packet is stale, the grant is
revoked, or the Project policy no longer matches.

Albatross review mode and its built-in critic are self-evaluation when they
reuse the writer's participant ID. They become an independently attributable
OWD Review only when a separate reviewer configuration uses a distinct
participant ID and completes its own OAuth authorization.

## Local writes and approvals

Albatross can mutate its local workspace with built-in file and shell tools.
That access is separate from OWD's read-only vault MCP surface.

Before any direct Obsidian, shell, filesystem, or skill-driven vault write,
Albatross resumes the Project and obeys `localVaultAccess`:

- `primary-writer` may perform only the owner-requested bounded task;
- `read-only-collaborator` proposes or hands off instead of writing; and
- a different client takes over only after the owner stops the prior writer and
  selects **Make primary** in OWD → Agents.

Albatross tool approval confirms that the local process or call may execute.
It never replaces OWD OAuth, owner consent, vault scope, Project grants, or
revocation. OWD Project submission tools append collaboration records; they
do not grant local filesystem authority.

## Distribution and upgrade boundary

The same versioned profile ships through:

- package export `@owd/client-packs`;
- script-free skill `@owd/client-packs/owd-albatross`;
- MCP Resource `owd://compatibility-profiles/albatross/v1`;
- MCP Prompt `connect-albatross`; and
- the authenticated dashboard's copy-ready setup kit.

Albatross itself cannot consume the Resource or Prompt in `2.0.3`; they remain
standard discovery surfaces for other clients, operators, and future native
support. The installed workspace prompt is the active Albatross surface.

The upstream tracker watches Albatross MCP config, protocol handling, result
parsing, workspace prompts, reset continuation, path forks, hooks, release
notes, and the pinned bridge dependency. A newer Albatross or `mcp-remote`
release opens a review issue; it never silently advances this compatibility
claim.
