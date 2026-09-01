# MDevolved public roadmap

MDevolved is being developed in public as durable, owner-controlled Project memory
and evidence for Markdown folders, Obsidian, and compatible AI tools. It complements execution
harnesses; it does not run, schedule, route, or supervise agents. This roadmap
describes product outcomes, not deployment schedules or service commitments.

## Current direction — prove the product experience

MDevolved's durable protocol and Community data plane are the compatibility
foundation for source-independent Project memory, with a plain Markdown folder
as the universal sync floor and Obsidian as an optional first-class adapter.
The next work makes MDevolved canonical for all new clients, data, packages,
and installations while isolating former identities behind a deprecated
compatibility layer.

The source-core, desktop folder, Obsidian adapter, cross-computer, product
release, and naming-completion milestones are complete. The locally accepted
MD8 candidate adds the Autonomous Project Loop: one owner-consented agent or an authorized
lead managing several actors can verify, checkpoint, and continue bounded work
without routine MDevolved-specific owner coordination. MDevolved still does not
schedule, execute, or supervise agents.
The next three acceptance decisions are canonical identity and release hygiene,
one simple public path with real product proof, and unassisted alpha evidence.
New feature development is frozen until those pass. The exact scope, migration
boundary, external gates, and tests live in the
[MDevolved product experience plan](MDEVOLVED-PRODUCT-EXPERIENCE-PLAN.md). The completed
architecture and MD1–MD8 delivery record remain in the
[source-independent product plan](MDEVOLVED-PLAN.md).

## Available now

- A complete Apache-2.0 Community data plane for one owner and multiple Sources
- Passkey authentication, explicit MDevolved Sync pairing, and automatic searchable
  libraries
- Remote MCP over Streamable HTTP with OAuth 2.1/PKCE and revocable
  vault/folder grants
- Agent-first Project creation, connection, rejoin, and resume
- The ordinary `mdevolved_resume` → `mdevolved_find` → `mdevolved_checkpoint` loop, including an
  agent-handled `checkpointBase` that fails stale memory closed
- Editable Project briefs, portable owner and Project preferences, inert Agent
  Skills, and evidence-backed owner-reviewed suggestions
- A provider-neutral synthetic continuation demo, cross-harness recipes, and
  owner-only local outcome evidence
- Durable Work Packets, Artifacts, Handoffs, Reviews, owner Decisions, and
  provenance
- Fenced Project-lead substitution, bounded hands-off Runs, and an opt-in
  elastic actor plane with privacy-safe budgets and observations
- Owner-authored deterministic completion policy, exception-only escalation,
  bounded operational triggers, integrity monitoring, and measured disposable
  Community recovery drills
- Forward-only R1–R4 Community upgrade and bounded scheduled continuity on the
  persistent alpha test deployment
- Encrypted owner-key-controlled snapshots with staged restore
- Source-pinned Obsidian Mind and Eve.dev compatibility profiles
- A direct desktop installer for MDevolved Sync while Community Plugin review is
  pending

## Next

- **MD9:** make MDevolved the canonical identity for new protocols, packages,
  artifacts, installations, and releases while retaining bounded old-client and
  old-data compatibility.
- **MD10:** show the complete continuity loop with real synthetic-data captures
  and one six-step-or-shorter human quickstart.
- **MD11:** observe 5–10 external alpha users and accept only after at least five
  independently complete a correct fresh-session resume without owner help.

## Explore later

- Additional Source adapters and broader performance envelopes
- More named-client compatibility exercises where they add evidence beyond the
  provider-neutral contract
- Additional provider-neutral export and interop formats
- Optional managed MDevolved Cloud accounts while preserving one isolated data-plane
  cell per owner
- Managed upgrades, monitoring, retention, export, and deletion without making
  Community depend on a control plane

## Invariants

Roadmap work must preserve:

- one owner as the authority for grants and Decisions;
- exact vault and folder consent;
- no hidden-conversation or chain-of-thought ingestion;
- no provider-specific runtime dependency;
- no restored credentials or live grants;
- no shared multi-tenant vault database; and
- a complete Community edition that remains independently deployable.

Feature proposals are welcome through GitHub Discussions or Issues. Security
reports belong in the private channel described in
[`SECURITY.md`](../SECURITY.md).
