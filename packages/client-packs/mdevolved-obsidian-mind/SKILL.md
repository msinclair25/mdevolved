---
name: mdevolved-obsidian-mind
description: Connect an Obsidian Mind workspace to MDevolved while preserving Mind's local graph and memory runtime, native note layout, and owner-controlled write boundary.
---

# MDevolved + Obsidian Mind

Use this pack only when `vault-manifest.json` has
`"template": "obsidian-mind"`. Keep Obsidian Mind's local `qmd`/`om` MCP
servers beside MDevolved; never replace or proxy them.

MDevolved provides the remote OAuth boundary, exact Project, current Work
Packet, owner decisions, provenance, and handoffs. Obsidian Mind provides local
search, scoped recall, reasoning, and owner-authorized capture. Do not upload
raw Mind memories, private notes, scripts, or runtime state as ordinary
Project context.

## Connect or resume

Read `.mdevolvedignore` first. If it is absent, read `.owdignore` as a legacy
fallback. If both exist and disagree, stop and ask the owner to resolve the
conflict. Never substitute `.om-project`, a folder name, or a display label for
the MDevolved Project UUID.

For a receipt, call `mdevolved__mdevolved_resume` first and treat
`localVaultAccess.role` as unconfirmed until it returns. Without a receipt,
call `mdevolved__open_project` with the owner's visible Project name. Keep
native note locations and select only concrete, relevant source roots.

Use Mind read tools for local discovery and MDevolved tools for shared durable
state. Before an implementation decision, carry the cited Mind result or an
explicit “nothing applicable” statement into the MDevolved Artifact or
Handoff. Direct Mind writes (`record_work`, `remember`), shell, and filesystem
writes require the returned owner-authorized writer role.

## Legacy compatibility

Existing pre-MD9 `owd` MCP entries, protocol names, and `.owdignore` receipts
remain readable. Preserve them and do not silently re-authorize or delete them;
new setup should use the canonical `mdevolved` server and receipt names.
