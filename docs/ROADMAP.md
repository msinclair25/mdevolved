# OWD public roadmap

OWD is being developed in public as durable, owner-controlled Project memory
and evidence for Obsidian and compatible AI tools. It complements execution
harnesses; it does not run, schedule, route, or supervise agents. This roadmap
describes product outcomes, not deployment schedules or service commitments.

## Available now

- A complete Apache-2.0 Community data plane for one owner and multiple vaults
- Passkey authentication, explicit OWD Sync pairing, and automatic searchable
  libraries
- Remote MCP over Streamable HTTP with OAuth 2.1/PKCE and revocable
  vault/folder grants
- Agent-first Project creation, connection, rejoin, and resume
- The ordinary `owd_resume` → `owd_find` → `owd_checkpoint` loop, including an
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
- A direct desktop installer for OWD Sync while Community Plugin review is
  pending

## Continue hardening the agent-native resume loop

- Make one MCP connection and one Project consent sufficient for the ordinary
  loop, with no routine packet, lease, or fencing ceremony
- Verify `focused` default context, `independent` withholding of peer
  conclusions, and `synthesis` comparison of separately attributable durable
  results
- Complete separately authorized live disposable exercises across more
  compliant MCP clients and Cloudflare cells; the deployed provider-neutral
  contract does not imply a named-client acceptance claim
- Observe the alpha.7 Community deployment and exercise separately authorized
  application rollback evidence without destructive down-migrations
- Submit OWD Sync to Obsidian Community Plugins and validate its updater path
- Expand recovery scale and performance envelopes beyond the bounded R4
  dependency-complete portable fixture
- Add source-pinned profiles only where they improve a client without changing
  OWD's universal MCP contract
- Publish clearer performance envelopes for larger vaults and longer-lived
  Projects

## Explore later

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
