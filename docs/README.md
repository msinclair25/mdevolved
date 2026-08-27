# MDevolved documentation

Start with the product path, then use the technical references for the boundary
you are changing.

## Start here

| I want to…                                | Read                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| Understand what MDevolved does            | [Product overview](../README.md)                               |
| See what the alpha includes               | [Alpha status](ALPHA-STATUS.md)                                |
| Connect an agent to a Project             | [Agent-first quick start](AGENT-FIRST-QUICKSTART.md)           |
| Deploy Community or compare hosted modes  | [Deployment modes](DEPLOYMENT-MODES.md)                        |
| See what is next                          | [Public roadmap](ROADMAP.md)                                   |
| Review the MDevolved source plan          | [MDevolved plan](MDEVOLVED-PLAN.md)                            |
| Review brand compatibility invariants     | [Brand compatibility](BRAND-COMPATIBILITY.md)                  |
| Review MD5 requirement-to-test evidence   | [MD5 acceptance matrix](MD5-TEST-MATRIX.md)                    |
| Review MD6 requirement-to-evidence gates  | [MD6 acceptance matrix](MD6-TEST-MATRIX.md)                    |
| Review MD2 migration and recovery         | [MD2 recovery](MD2-RECOVERY.md)                                |
| Review supported versions and limits      | [Release compatibility](RELEASE-COMPATIBILITY.md)              |
| Audit monitored upstream integration pins | [Compatibility manifest](../compatibility/upstreams.json)      |
| Install the Obsidian companion            | [MDevolved Sync README](../packages/obsidian-plugin/README.md) |

## Product and trust

- [Product definition](PRODUCT.md) — users, outcomes, exclusions, and
  principles
- [MDevolved plan](MDEVOLVED-PLAN.md) — source-independent sync, Obsidian
  adapter, brand compatibility, milestones, and acceptance decisions
- [MD2 recovery](MD2-RECOVERY.md) — folder-source migration, quarantine, and
  authority-free restore behavior
- [Architecture](ARCHITECTURE.md) — components, data flow, canonical and
  derived state, and deployment boundaries
- [Security model](SECURITY-MODEL.md) — threats, authorization, redaction, and
  required security tests
- [Backup and recovery](BACKUP-RECOVERY.md) — encrypted recovery points,
  custody, staged restore, and failure behavior
- [Storage and performance](STORAGE-PERFORMANCE.md) — storage tiers,
  compaction, caching, limits, and scale gates

## Agents, Projects, and portability

- [Agent access](AGENT-ACCESS.md) — remote MCP, OAuth grants, revocation,
  local-writer guidance, and client boundaries
- [Onboarding contract](ONBOARDING-CONTRACT.md) — the one-path setup state
  machine and repair behavior
- [Collaboration contracts](COLLABORATION-CONTRACTS.md) — schemas, invariants,
  authorization rules, and compatibility fixtures
- [Portable intelligence](PORTABLE-INTELLIGENCE.md) — Project records, Work
  Packets, Handoffs, Reviews, Decisions, provenance, and portable fallback
- [Obsidian Mind compatibility](OBSIDIAN-MIND-COMPATIBILITY.md) — two-server
  topology, Project mapping, memory boundaries, and force-multiplier workflow
- [Eve compatibility](EVE-COMPATIBILITY.md) — user-scoped connection,
  qualified tools, identity, sandbox boundaries, and durable continuity
- [Albatross compatibility](ALBATROSS-COMPATIBILITY.md) — stdio bridge,
  workspace prompt, reset continuity, participant identity, and setup kit

## Build and release

- [Development contract](DEVELOPMENT.md) — toolchain, migrations, testing, and
  release workflow
- [Public quality gates](QUALITY-GATES.md) — automated and manual release
  checks with synthetic-data rules
- [Upstream YAOS policy](UPSTREAM-YAOS.md) — pinned source, adaptation, and
  provenance
- [Release compatibility](RELEASE-COMPATIBILITY.md) — supported schemas,
  versions, and explicit alpha limits
- [Compatibility manifest](../compatibility/upstreams.json) — reviewed source
  identities and critical paths monitored daily by GitHub Actions

The canonical MD9 Obsidian adapter is developed in this repository with the
`mdevolved-sync` identity. Its separate release repository and plugin-store
listing are not claimed until published and independently verified. Existing
`owd-sync` installs remain a supported compatibility path.
