# Obsidian Mind compatibility profile

OWD remains one client-neutral MCP `2025-11-25` Streamable HTTP server with
OAuth discovery, PKCE, resource indicators, standard Tools, Resources, and
Prompts. Obsidian Mind support is a thin profile over that server—not a second
endpoint, alternate authorization flow, tool-name translation layer, or
forked Project model.

The reviewed upstream is
[`breferrari/obsidian-mind`](https://github.com/breferrari/obsidian-mind) version
`8.2.0` at commit
`216821bbc030211476e68270e287c915d09b4390`, reviewed 2026-07-30. Upstream is
MIT-licensed. OWD copies no upstream executable source; the profile records
observed public conventions and links to the upstream repository.

## Complementary topology

| Layer                               | Authority and best use                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| OWD remote MCP                      | Owner OAuth consent, exact vault boundary, durable Project UUID, Work Packet, provenance, Decisions, Artifacts, and multi-agent handoff |
| Obsidian Mind `om` stdio MCP        | Local graph search, project-scoped memory recall, cross-note reasoning, and owner-authorized local capture                              |
| OWD Sync                            | Markdown content transport and current immutable OWD library                                                                            |
| ShardMind/Git or upstream installer | Obsidian Mind scripts, hooks, templates, settings, Bases, and other runtime files                                                       |

An agent connects to OWD and `om` side by side. OWD does not proxy `om`; `om`
does not mint OWD authority. A raw `qmd` connection is retained inside the
Obsidian Mind vault, while external repositories use `om` so its memory scope
rules remain active.

The dashboard's Claude command uses project scope:

```sh
claude mcp add --transport http --scope project md-evolved 'https://YOUR-OWD/mcp'
```

Claude updates the existing `.mcp.json`; it must preserve the existing `qmd`
entry. Other clients merge the displayed `md-evolved` HTTP entry and use the
same remote endpoint and OAuth metadata.

## Project mapping

The local detector is factual and non-authoritative:

```text
vault-manifest.json
  template = obsidian-mind
```

For a matching vault:

- use `documentationPlan.decision = "keep-current-locations"` rather than
  moving Mind notes into `docs/`;
- use the UUID in `.owdignore` for OWD Project identity and resume;
- use `.om-project` only as Obsidian Mind's local memory-routing identity;
- select the narrowest relevant concrete roots from `work/active`,
  `work/archive`, `work/incidents`, `work/1-1`, `org/people`, `org/teams`,
  `perf/brag`, `perf/evidence`, `perf/competencies`, `brain`, and `reference`;
- never widen `perf/h*-*/` to all of `perf/`; dynamic folder globs are omitted
  from the automatic remote profile, and an owner exposes a needed cycle by
  listing its exact folder plus every other intended root in
  `mcp_exposed_roots`, which replaces the derived list; and
- keep `memories/`, private-tagged notes, `private: true` notes, filenames in
  `mcp_never_expose`, and runtime/infrastructure files out of ordinary Project
  source context.

Profile facts may narrow a proposed context. They never expand an OAuth grant,
select a Project, approve a request, or replace server-side validation.

OWD Sync `0.1.6` reports only a schema-validated descriptor. Once detected, an
ordinary sync that omits the descriptor does not silently clear it. The Worker
intersects its content roots with the owner's OAuth folders and applies that
effective boundary consistently to direct reads, FTS search, recent changes,
new Project source selection, existing Project discovery, packet citations,
repair, and resume. A profile change makes the current library stale until a
fresh projection has classified private frontmatter.

## Force-multiplier routing

Use Mind for fast local cognition and OWD for durable collaboration:

1. call OWD `resume_project` to obtain the current packet, exact provenance,
   and caller-specific `localVaultAccess`;
2. use Mind `search`, `expand`, and `recall` to find related local knowledge;
3. use Mind `reason` when judgment across several local notes is worth the
   extra model call;
4. produce and hand off work through the OWD Project so another client receives
   the same durable state without a transcript; and
5. write a local Mind record only when it adds a distinct vault-side value.

Mind's `record_work` and `remember` are direct filesystem writes even though
they arrive through MCP. They therefore obey OWD's single-writer coordination:
the `primary-writer` may perform an owner-requested bounded write; a
`read-only-collaborator` must propose or hand off. A different Mind client can
take over only after the owner stops the prior writer and selects **Make
primary** in OWD → Agents.

## Distribution surfaces

The same versioned profile is available through:

- the shared `@owd/client-packs` package;
- the portable `owd-obsidian-mind/SKILL.md`;
- the standard MCP Resource
  `owd://compatibility-profiles/obsidian-mind/v1`;
- the standard MCP Prompt `connect-obsidian-mind`;
- the dashboard's additive setup command and generic merge fragment; and
- the managed OWD block inserted into Project `AGENTS.md`.

At owner consent, a detected Mind vault prefills the concrete safe content
roots. The owner may narrow those folders. Entering a broader folder cannot
override the server's profile ceiling.

A client that ignores Resources, Prompts, or skills still uses the complete
universal MCP Tool workflow. Optional profile surfaces improve setup and tool
routing; none is required to understand a different wire protocol.

## Deliberate boundaries

This profile does not:

- sync or execute Obsidian Mind runtime code;
- treat local manifest data as owner consent;
- expose `memories/` as ordinary notes;
- make `.om-project` an authorization identity;
- let a second agent call Mind write tools merely because they are installed;
- duplicate every record into OWD and Mind; or
- claim that advisory writer rules are a filesystem lock.

The MCP transport and authorization requirements remain those in the
[MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Obsidian Mind 8.2 memory lifecycle

Before implementation commits to an approach, carry the useful result of local
Mind consultation into the OWD Artifact or Handoff: supporting Decisions,
contrary evidence, or an explicit statement that nothing applicable was
recorded. That makes consultation durable and reviewable without copying Mind's
private memory store into OWD.

When `remember` declares `scope: "general"`, include the optional `generality`
rationale introduced in 8.2. Promotion into `brain/` is additive: copy the
lesson, retain the memory entry, and preserve its `promoted` marker. These are
Obsidian Mind conventions and remain subject to OWD's advisory
`localVaultAccess` writer boundary.
