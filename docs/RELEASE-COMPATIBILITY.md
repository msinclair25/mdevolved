# Release compatibility

This page records the explicit compatibility boundary for OWD Platform
`1.0.0-alpha.3` and OWD Sync `0.1.6`. A newer upstream release is not supported
merely because it exists.

## Supported contracts

| Surface               | Reviewed contract                                                                                                                                      | Boundary                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| OWD Sync              | `0.1.6`; vault schema 3; server reads schemas 1–3                                                                                                      | A newer unsupported vault schema fails with update guidance.                                                       |
| YAOS live sync        | Pinned server `0.3.0`; Yjs schema fixtures 1–3                                                                                                         | OWD preserves the pinned upstream contract and carries explicit local adaptations.                                 |
| MCP                   | Streamable HTTP and OAuth 2.1/PKCE against MCP `2025-11-25`                                                                                            | Read-only vault tools are the portable baseline. Project behavior uses ordinary MCP Tools, Resources, and Prompts. |
| Project lifecycle     | `open_project`, `wait_for_project_connection`, and `resume_project`                                                                                    | Create, join, rejoin, and resume converge on one exact Project without a client-specific transport.                |
| Obsidian Mind profile | `8.2.0` at commit `216821bbc030211476e68270e287c915d09b4390`                                                                                           | OWD runs beside `qmd`/`om`, preserves native layout, and never turns local profile data into authority.            |
| Eve.dev profile       | Eve `0.29.2` at commit `7ec1c93ce43488e136a2a043cc3e6a310cd03841`; `@vercel/connect` `0.6.0`                                                           | Uses Eve's native user-scoped MCP connection. Separate attribution requires a distinct connector identity.         |
| Legacy backup import  | `owd-backup-v1`                                                                                                                                        | Remains readable; unknown or malformed formats fail before staging.                                                |
| Workspace snapshot    | `owd-snapshot-v2` with `notes-v1`, explicit target mapping, and age-X25519 encrypted objects                                                           | Unknown required capabilities fail before staging. Credentials and live grants never restore.                      |
| Collaboration records | Knowledge Spaces, Projects, Work Items, Work Packets, Attempts, Artifacts, Handoffs, Reviews, Decisions, provenance, and approved/quarantined recovery | Alpha compatibility does not claim that every third-party client has completed an independent acceptance exercise. |

The machine-readable upstream pins live in
[`compatibility/upstreams.json`](../compatibility/upstreams.json). A daily
monitor compares them with current GitHub releases and npm integrity metadata.
It opens a review issue on drift and never auto-upgrades a claim.

## Platform requirements

- Current desktop Obsidian for OWD Sync alpha use
- A modern browser with WebAuthn/passkey, Web Crypto, and ES module support
- A Cloudflare account for Community self-hosting
- Node.js `24` and pnpm `11.9.0` for local development
- A remote MCP client that supports Streamable HTTP and OAuth for live agent
  access

Client-specific setup helpers are optional. A compliant client may use the
universal MCP endpoint even when it ignores OWD Resources, Prompts, or portable
skills.

## Failure and upgrade behavior

- OWD Sync and the Platform must advertise the same compatible release.
- Unsupported newer schemas fail before mutation.
- Migrations are append-only and run as a deployment prerequisite, never as
  ordinary request-time discovery or repair.
- A Project grant or packet may rotate automatically only after revalidating
  the same client, source grant, Project, context policy, and scopes.
- Explicit revocation denies the next call and is never repaired by automatic
  rotation.
- Restored note sources remain excluded until the owner approves their named
  lineage.
- Snapshots remain independently decryptable with the owner's recovery
  identity; restore never recreates sessions, credentials, OAuth clients, or
  grants.

## Current alpha limits

- One owner per deployment
- Markdown text creation/editing only
- No rename, deletion, attachment writes, or arbitrary `.obsidian` writes
- Snapshot attachment and `.obsidian` sections disabled
- OWD Sync Community Plugin listing pending
- Local writer coordination is advisory, not a filesystem lock
- Obsidian Mind and Eve.dev are source-verified profiles; neither is a vendor
  certification

Before a Community release or compatibility-pin update, run the
[public quality gates](QUALITY-GATES.md) with synthetic data.
