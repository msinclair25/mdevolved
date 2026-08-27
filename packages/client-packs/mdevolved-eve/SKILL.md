---
name: mdevolved-eve
description: Connect or resume an Eve agent with MDevolved through a user-scoped remote MCP connection while preserving Eve runtime identity and MDevolved Project continuity.
---

# MDevolved + Eve

Use this pack only for Eve-side configuration. Eve owns sessions, channels,
sandboxes, schedules, and child-agent runtime behavior. MDevolved owns the
portable Project, owner approval, source boundary, packets, provenance, and
cross-agent handoff.

## Setup

1. Add `agent/connections/mdevolved.ts` with Eve's standard
   `defineMcpClientConnection` and `connect()` helpers.
2. Use the deployment's HTTPS `/mcp` URL and `principalType: "user"`.
3. Request only the existing source-read and Project-initialization scopes.
   Keep credentials in Eve's connection store, never in prompts or files.
4. Preserve every other connection and local agent instruction.

Eve qualifies the connection's tools as
`mdevolved__connection_info`, `mdevolved__open_project`,
`mdevolved__wait_for_project_connection`, and `mdevolved__mdevolved_resume`.
Top-level schedules cannot borrow a user's grant; route them through a
user-authenticated interaction or require explicit owner action.

## Connect or resume

Read `.mdevolvedignore` first. If it is absent, read `.owdignore` as a legacy
fallback. If both exist and disagree, stop and ask the owner to resolve the
conflict. Never guess a Project or create a duplicate.

With a receipt, call `mdevolved__mdevolved_resume` first using its exact Project
UUID and context policy. Without one, call `mdevolved__connection_info`, then
`mdevolved__open_project` with the owner's visible Project name. For pending
approval, repeat only the same wait request and exact wait key. Until resume
returns `localVaultAccess`, the writer role is unconfirmed.

A new session, channel, or child reusing one connector UID is the same
MDevolved participant. Independent writers and reviewers need distinct
connector IDs and authorization. Before any deliberately mounted workspace or
source write, obey `localVaultAccess`; MCP submissions do not grant filesystem
authority.

## Legacy compatibility

Existing pre-MD9 `owd` connections/tools and `.owdignore` receipts remain
readable. Preserve them and do not silently re-authorize or delete them; new
setup should use the canonical MDevolved connection and receipt names.
