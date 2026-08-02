---
name: owd-albatross
description: Connect, initialize, resume, or coordinate OWD Projects from Albatross using its agent.config.json stdio MCP surface, a pinned OAuth bridge, qualified tool names, workspace prompt continuity, path forks, resets, and independently attributable participant identities. Use when a repository runs Albatross, contains .albatross or agent.config.json, needs OWD MCP setup, or must resume OWD safely after /reset.
---

# OWD + Albatross

Keep one universal OWD server. Apply this profile only as Albatross-side
configuration and instructions; never change OWD framing, OAuth, tool schemas,
Project lifecycle, or server-side authority.

## Confirm the runtime

1. Confirm the repository uses Albatross and inspect `agent.config.json`,
   `.albatross/prompt.md`, `.owdignore`, and `AGENTS.md` when present.
2. Preserve every existing Albatross option and MCP server.
3. Use the deployment's exact HTTPS `/mcp` URL. Plain HTTP is allowed only for
   localhost development.
4. Use MCP server name `owd`; Albatross exposes its tools as
   `mcp__owd__<tool>`.

Albatross `2.0.3` supports child-process stdio MCP only. Use the profile's
pinned `mcp-remote@0.1.38` bridge with `--transport http-only`. This is a
temporary client adapter, not an OWD proxy or protocol fork. Remove it when
Albatross supports authenticated remote Streamable HTTP natively.

Do not add a static bearer token, custom Project call, translated tool schema,
client-side authorization rule, or a second OWD endpoint.

## Preserve participant identity

The bridge configuration includes a non-secret
`X-OWD-Albatross-Participant` header. The pinned bridge includes custom headers
in its OAuth cache key:

- Reusing `primary` means the Albatross sessions are one OWD OAuth participant.
- A genuinely independent writer or reviewer uses another safe ID such as
  `reviewer` and completes a separate authorization.
- A new session, `/reset`, path fork, model, or display name using the same ID
  is still the same OWD participant.

The header partitions local credential storage; it is not a credential and
grants no access. OWD OAuth identity and live server-side grants remain
authoritative.

## Install without overwriting

Prefer the authenticated OWD dashboard's **Copy Albatross setup kit** action.
It generates one fresh, internally consistent participant ID across these
steps. Choose **New participant ID** before copying a kit for another workspace
or independently attributable reviewer.

1. Before Albatross starts, run the generated `mcp-remote-client`
   authorization command and complete the browser flow. Albatross
   hard-times-out MCP initialize after 30 seconds, so first OAuth cannot safely
   wait inside startup.
2. Merge only the generated `mcpServers.owd` entry into
   `agent.config.json`. Never replace the file.
3. Merge only the marked `owd:albatross-profile:v1` block into
   `.albatross/prompt.md`. Create the file when absent; otherwise preserve
   every instruction outside the block.
4. Start Albatross and run `/mcp trust owd`. Trust is scoped to the canonical
   workspace and the exact MCP configuration hash.
5. Ask Albatross: `Connect this project to OWD.`

Do not put bridge credentials in the repository. The pinned bridge stores
OAuth material outside the workspace.

## Connect or resume

Albatross ignores MCP initialize instructions, Resources, Prompts, and
`structuredContent`, so `.albatross/prompt.md` carries the client-specific
workflow and OWD text responses remain the compatible result surface.

On a fresh task:

1. Read `.owdignore`.
2. If it exists, call `mcp__owd__resume_project` with its exact Project UUID
   and complete context policy before any other OWD action.
3. Until resume returns, treat the writer role as unconfirmed.
4. If no receipt exists, call `mcp__owd__connection_info`, then
   `mcp__owd__open_project` with the visible Project name supplied by the
   owner.
5. If approval is pending, show the one returned approval URL and call
   `mcp__owd__wait_for_project_connection` with the exact key and
   `timeoutSeconds: 20`.
6. If still pending, repeat only the same wait. Never reconnect OAuth, repeat
   setup, rerun `open_project`, or create a duplicate Project.
7. Persist the returned `.owdignore` receipt and replace only OWD's marked
   instruction blocks.

After Albatross `/reset`, repeat the receipt-based resume as the first OWD
action. `.albatross/continue.md` restores one Albatross runtime; it does not
replace portable OWD Project continuity.

## Turn Albatross execution into portable work

Keep Albatross's private execution machinery local and promote only useful,
cited results into OWD:

- Start from the current OWD Work Packet before implementation.
- Treat `/iterate` candidates and `critique` results as internal Attempts.
  Submit meaningful alternatives and the selected result as OWD Attempts or
  Artifacts; do not upload every private turn.
- Keep `/auto` inside the current Work Packet, configured budget, and deadline.
  Its automatic `/reset` must resume OWD before work continues. Stop if OWD
  reports a stale packet, revoked grant, or policy mismatch.
- Treat `/path fork` branches as alternative Attempts inside the same Project.
  Carry the winning path and contrary evidence into a cited Artifact.
- Use an OWD Handoff when another agent should continue. Albatross checkpoints
  and `.albatross/continue.md` remain runtime recovery, not the cross-agent
  record.
- Albatross review mode and built-in critique are self-evaluation when they use
  the same participant ID. Submit an independent OWD Review only from a
  separately authorized reviewer identity.

## Coordinate paths and writes

Treat each `/path fork` as an alternative Attempt or Artifact within the same
OWD Project. Do not create one OWD Project per path. Carry useful results into
an OWD Artifact or Handoff so another independent agent can resume them.

Albatross tool approval confirms local execution only. It never replaces OWD
OAuth, owner consent, exact vault and folder boundaries, Project grants, or
revocation.

Before Albatross writes through shell, filesystem, an Obsidian CLI, or another
skill, resume OWD and obey the returned `localVaultAccess.role`:

- `primary-writer`: perform only the owner-requested bounded write;
- `read-only-collaborator`: propose or hand off instead of writing; and
- restarted process: resume the exact Project through the same authorized OWD
  client to retain its role; a different authorization remains read-only and
  hands proposed changes to the human owner.

OWD collaboration submissions are append-only Project records. They do not
grant local filesystem authority.
