---
name: mdevolved-albatross
description: Connect or resume an Albatross workspace with MDevolved through its stdio MCP bridge, preserving runtime-local execution and owner-approved Project authority.
---

# MDevolved + Albatross

Use this pack only for Albatross-side setup. MDevolved remains the universal
remote MCP server and the authority boundary; Albatross still owns its local
agents, tools, workspaces, retries, and `/reset` behavior.

## Setup

1. Preserve every existing Albatross setting and MCP server.
2. Use the exact HTTPS `/mcp` URL (HTTP only for localhost development).
3. Add the generated `mdevolved` entry to `agent.config.json` using the pinned
   `mcp-remote` bridge, then run `/mcp trust mdevolved`.
4. Merge the marked profile into `.albatross/prompt.md`; preserve everything
   outside the marked block.
5. Use a separate participant ID and OAuth authorization only for an
   independently attributable writer or reviewer. A label never grants access.

## Connect or resume

Read `.mdevolvedignore` first. If it is absent, read `.owdignore` as a legacy
fallback. If both exist and disagree, stop and ask the owner to resolve the
conflict; never guess or create a second Project.

With a receipt, call `mcp__mdevolved__mdevolved_resume` first with its exact
Project UUID and policy. Without one, call `mcp__mdevolved__connection_info`,
then `mcp__mdevolved__open_project`. If approval is pending, repeat only the
same `mcp__mdevolved__wait_for_project_connection` request with its exact key.
Until resume returns `localVaultAccess`, the writer role is unconfirmed.

After `/reset`, resume the same receipt before local writes. Submit only cited,
useful results to MDevolved; Albatross transcripts, checkpoints, and private
runtime state remain local.

Before any shell, skill, or filesystem write, obey the returned
`localVaultAccess.role`. Project submissions never grant local write authority.

## Legacy compatibility

Existing pre-MD9 `owd` server/tool configuration and `.owdignore` receipts
remain readable. Preserve them and do not silently re-authorize or delete them;
new setup should use the canonical `mdevolved` names and `.mdevolvedignore`.
