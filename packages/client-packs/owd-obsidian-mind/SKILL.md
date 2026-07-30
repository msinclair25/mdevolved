---
name: owd-obsidian-mind
description: Connect, initialize, resume, or coordinate an Obsidian Mind vault with OWD while preserving its local qmd/om MCP runtime, native note layout, scoped memories, private-note rules, and multi-agent writer safety. Use when a vault-manifest.json identifies template obsidian-mind, when adding OWD beside Obsidian Mind, or when an agent must route work between OWD Project tools and Obsidian Mind knowledge tools.
---

# OWD + Obsidian Mind

Keep one universal OWD server. Apply this profile as client-side conventions;
never change MCP framing, OAuth, or tool schemas for Obsidian Mind.

## Confirm the runtime

1. Read `vault-manifest.json`.
2. Continue only when `template` equals `obsidian-mind`.
3. Read `AGENTS.md` and `CLAUDE.md`.
4. Preserve the existing `.mcp.json` entries. Add OWD beside `qmd` or `om`;
   never replace or proxy them.

Use these distinct roles:

- OWD: remote OAuth boundary, exact Project UUID, owner approval, current Work
  Packet, provenance, Decisions, Artifacts, and handoffs.
- Obsidian Mind `om`: local graph search, scoped recall, reasoning, and
  owner-authorized capture.
- OWD Sync: Markdown transport. Do not use it to distribute Obsidian Mind
  scripts, hooks, settings, or other executable runtime files.

## Connect or resume

Read `.owdignore` first. When present, call `resume_project` with its exact
Project UUID and complete context policy. Never use `.om-project`, a folder
name, or a display label as OWD authority.

When no receipt exists, call `open_project` with the Project name the user
gave. Do not ask the user to copy a prompt, reconnect, or choose New versus
Existing before OWD reports that choice is genuinely required.

For a new Project:

- use `documentationPlan.decision = "keep-current-locations"`;
- keep Obsidian Mind notes in their native folders rather than moving them to
  `docs/`;
- choose the narrowest relevant concrete roots from `work/active`,
  `work/archive`, `work/incidents`, `work/1-1`, `org/people`, `org/teams`,
  `perf/brag`, `perf/evidence`, `perf/competencies`, `brain`, and `reference`;
- never widen `perf/h*-*/` to all of `perf/`; the automatic remote profile
  drops dynamic folder globs, so ask the owner to add an exact needed cycle
  such as `perf/h2-2026` plus every other intended root to
  `mcp_exposed_roots`, which replaces the derived root list; and
- use exact source note paths.

Never include `memories/`, notes with `private: true`, notes tagged `private`,
filenames in `mcp_never_expose`, or runtime/infrastructure files as ordinary
Project source context.

## Route tools

Use Obsidian Mind `search`, `expand`, `recall`, `reason`, and `health` for
local knowledge discovery. Use OWD Project tools for current shared state and
durable multi-agent coordination. Do not duplicate the same record in both
systems unless the owner asks.

Before implementation commits to an approach, carry the relevant Mind
consultation result into the OWD Artifact or Handoff: supporting Decisions,
contrary evidence, or an explicit statement that nothing applicable was
recorded. This preserves the useful result without copying private local
memory into shared Project state.

Treat Obsidian Mind `record_work` and `remember` as direct vault writes. Before
calling either, inspect OWD `localVaultAccess`.

- `primary-writer`: perform only the owner-requested bounded write.
- `read-only-collaborator`: do not call either write tool; propose or hand off.
- explicit bounded handoff: write only after the prior writer stopped and the
  owner named the task and paths.

When `remember` uses `scope: "general"`, include the optional `generality`
rationale. When promoting a lesson into `brain/`, copy it, retain its memory
entry, and preserve the `promoted` marker. Promotion does not bypass OWD's
writer boundary.

The same rule applies to Obsidian CLI, skills, shell, and filesystem writes.

## Preserve continuity

Persist `.owdignore` and replace only OWD's marked block in `AGENTS.md`.
Preserve every Obsidian Mind instruction outside that block. On each new task,
resume OWD before trusting prior Project context, then use Obsidian Mind recall
only within its own declared scope.
