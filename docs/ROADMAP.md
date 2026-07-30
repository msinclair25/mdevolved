# OWD public roadmap

OWD is being developed in public as an owner-controlled continuity layer for
Obsidian and independent AI agents. This roadmap describes product outcomes,
not private deployment schedules or service commitments.

## Available now

- A complete Apache-2.0 Community data plane for one owner and multiple vaults
- Passkey authentication, explicit OWD Sync pairing, and automatic searchable
  libraries
- Remote MCP over Streamable HTTP with OAuth 2.1/PKCE and revocable
  vault/folder grants
- Agent-first Project creation, connection, rejoin, and resume
- Durable Work Packets, Artifacts, Handoffs, Reviews, owner Decisions, and
  provenance
- Encrypted owner-key-controlled snapshots with staged restore
- Source-pinned Obsidian Mind and Eve.dev compatibility profiles
- A direct desktop installer for OWD Sync while Community Plugin review is
  pending

## Harden next

- Complete repeated, unassisted two-agent durability exercises with disposable
  data across more compliant MCP clients
- Simplify Community deployment, upgrade, rollback, and health verification
- Submit OWD Sync to Obsidian Community Plugins and validate its updater path
- Expand portable Project export/import and recovery fixtures
- Add source-pinned profiles only where they improve a client without changing
  OWD's universal MCP contract
- Publish clearer performance envelopes for larger vaults and longer-lived
  Projects

## Explore later

- Owner-reviewed durable knowledge and inert, versioned skill promotion
- Additional provider-neutral export and interop formats
- Optional managed OWD Cloud accounts while preserving one isolated data-plane
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
