# Release compatibility

This page records the explicit compatibility boundary for MDevolved Community
`1.0.0-alpha.7` and MDevolved Sync for Obsidian `0.2.0-alpha.1`. A newer
upstream release is not supported merely because it exists. The canonical
prerelease is published but is not yet listed in Obsidian Community Plugins;
existing `owd-sync` installations remain the supported compatibility path.

## Supported contracts

| Surface                     | Reviewed contract                                                                                                                                      | Boundary                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MDevolved Sync              | `0.1.0-alpha.4` folder client and one-command agent connector; source schema 3; server reads schemas 1–3                                               | A newer unsupported source schema fails with update guidance.                                                                                                     |
| MDevolved Sync for Obsidian | Public prerelease `0.2.0-alpha.1`; plugin ID `mdevolved-sync`                                                                                          | Plugin-store listing and broader live client acceptance are pending; old `owd-sync` remains readable.                                                             |
| YAOS live sync              | Pinned server `0.3.0`; Yjs schema fixtures 1–3                                                                                                         | MDevolved preserves the pinned upstream contract and carries explicit local adaptations.                                                                          |
| MCP                         | Authenticated Streamable HTTP against MCP `2026-07-28`, with stateless `2025-11-25` compatibility                                                      | Read-only vault tools are the portable baseline. Project behavior uses ordinary MCP Tools, Resources, and Prompts. See [MCP compatibility](MCP-COMPATIBILITY.md). |
| Project lifecycle           | `open_project`, `wait_for_project_connection`, and `mdevolved_resume`; lower-level `resume_project` remains compatible                                 | Create, join, rejoin, and resume converge on one exact Project without a client-specific transport.                                                               |
| Obsidian Mind profile       | `8.4.0` at commit `af615d100a1d04561409ab9a1e71e615efa1d87b`                                                                                           | MDevolved runs beside `qmd`/`om`, preserves native layout, and never turns local profile data into authority.                                                     |
| Eve.dev profile             | Eve `0.65.0` at commit `7bcc0d16e3f41d44fadfd06b5bac3515a82d441d`; `@vercel/connect` `2.3.2`                                                           | Uses Eve's native user-scoped MCP connection. Separate attribution requires a distinct connector identity.                                                        |
| Albatross profile           | Albatross `2.5.0` at commit `e458e4277f463a4688f127ea6ea61f5a344b64b8`; `mcp-remote` `0.14.3`                                                          | Uses a pinned stdio bridge while MDevolved remains standard remote Streamable HTTP MCP with OAuth.                                                                |
| Hermes hands-off adapter    | Hermes `0.21.5` at commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`                                                                                   | Uses Hermes's native remote MCP/OAuth client; MDevolved stores bounded evidence and never becomes its scheduler or runtime.                                       |
| LangChain recipe            | LangChain `1.4.2` at commit `a18de590e7ccf5c647fbf3d689e5f1a15f78e9f5`; built-in `langchain.mcp` beta                                                  | Uses `MCPAdapter` over FastMCP OAuth. Tools are the baseline; Prompts and Resources remain available through the underlying FastMCP client.                       |
| Portable backup             | New writes use `mdevolved-backup-v1`; `owd-backup-v1` remains readable                                                                                 | Unknown or malformed formats fail before staging; credentials and live grants never restore.                                                                      |
| Workspace snapshot          | New writes use `mdevolved-snapshot-v3`; `owd-snapshot-v2` remains readable                                                                             | Unknown required capabilities fail before staging. Credentials and live grants never restore.                                                                     |
| Collaboration records       | Knowledge Spaces, Projects, Work Items, Work Packets, Attempts, Artifacts, Handoffs, Reviews, Decisions, provenance, and approved/quarantined recovery | Alpha compatibility does not claim that every third-party client has completed an independent acceptance exercise.                                                |
| Lead operations             | Additive MCP capability resources v1 (R2), v2 (R3), and v3 (R4); policy, Decision, schedule, evidence, and continuity-receipt contracts                | Older clients keep their original profiles. R4 is opt-in, generic, and cannot restore or widen authority.                                                         |
| Agent Plugins package       | Agent Plugins `1.0.0`; per-deployment `plugin.json`, `mcp.json`, and one inert Project skill                                                           | The downloaded archive contains the exact public MCP URL and no credentials. OpenClaw installs it locally; the client owns OAuth and execution.                   |
| Native CLI connectors       | OpenCode `1.18.32`, Gemini CLI `0.60.0`, and GitHub Copilot CLI `1.0.87`; reviewed `2026-09-21`                                                        | The public `mdevolved` CLI invokes native installers without a shell or static token. Browser OAuth and runtime state remain client-owned.                        |

The machine-readable upstream pins live in
[`compatibility/upstreams.json`](../compatibility/upstreams.json). A daily
monitor compares them with current GitHub releases and npm integrity metadata.
It opens a review issue on drift and never auto-upgrades a claim.

The exact tagged source receipts for the portable package and native commands
are recorded in [portable agent compatibility](PORTABLE-AGENT-COMPATIBILITY.md).

The monorepo `mdevolved-sync-v*` workflow is a packaging gate, not a publisher:
it produces the reviewed release files as a CI artifact. Owner-authorized
promotion creates the actual release in `msinclair25/mdevolved-sync`, which is
the repository used by the direct-installer, BRAT, checksum, and future
Community Plugin links. This prevents a monorepo tag from publishing assets at
a URL no installer consumes.

## Platform requirements

- Current desktop Obsidian for MDevolved Sync alpha use
- A modern browser with WebAuthn/passkey, Web Crypto, and ES module support
- A Cloudflare account for Community self-hosting
- Node.js `24` and pnpm `11.9.0` for local development
- A remote MCP client that supports Streamable HTTP and OAuth for live agent
  access

Client-specific setup helpers are optional. A compliant client may use the
universal MCP endpoint even when it ignores MDevolved Resources, Prompts, or portable
skills.

## Failure and upgrade behavior

- MDevolved Sync and the Platform must advertise the same compatible release.
- Unsupported newer schemas fail before mutation.
- Migrations are append-only and run as a deployment prerequisite, never as
  ordinary request-time discovery or repair.
- A Project grant or packet may rotate automatically only after revalidating
  the same client, source grant, Project, context policy, and scopes.
- Explicit revocation denies the next call and is never repaired by automatic
  rotation.
- Restored note sources remain excluded until the owner approves their named
  lineage.
- Restored R1–R4 operational records remain quarantined evidence. Restore does
  not recreate grants, leases, actors, credentials, OAuth state, policy or
  scheduler authority, or live operation projections.
- Snapshots remain independently decryptable with the owner's recovery
  identity; restore never recreates sessions, credentials, OAuth clients, or
  grants.
- Canonical upgrades are additive and forward-only. They do not rename an
  existing cell or copy its authority. A fresh deployment may import a
  provider-neutral export, but restored grants, leases, actors, credentials,
  OAuth state, sessions, and live execution state remain disabled or absent.

## Current alpha limits

- One owner per deployment
- Markdown text creation/editing only
- No rename, deletion, attachment writes, or arbitrary `.obsidian` writes
- Snapshot attachment and `.obsidian` sections disabled
- MDevolved Sync Community Plugin listing pending
- Local writer coordination is advisory, not a filesystem lock
- Obsidian Mind, Eve.dev, and Albatross are source-verified profiles; none is a
  vendor certification

Before a Community release or compatibility-pin update, run the
[public quality gates](QUALITY-GATES.md) with synthetic data.
