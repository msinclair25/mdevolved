# OWD alpha status

**Updated:** August 26, 2026<br />
**OWD Platform:** `1.0.0-alpha.7`<br />
**OWD Sync:** `0.1.7`

OWD Platform is now available as an Apache-2.0 Community alpha. The optional
managed service remains invitation-only. Alpha means the contracts and safety
boundaries are explicit, but broader real-world compatibility, upgrade, and
durability evidence is still being accumulated.

## Availability

| Surface                   | Current status                                                           |
| ------------------------- | ------------------------------------------------------------------------ |
| Community source          | Public Apache-2.0 alpha                                                  |
| Community self-hosting    | Available for technical alpha use in the owner's Cloudflare account      |
| Managed service           | Invitation-only alpha; one isolated data-plane cell per owner            |
| MDevolved Sync            | Public `0.1.0-alpha.1` npm and unsigned macOS/Windows/Linux prerelease   |
| OWD Sync                  | Public `0.1.7` alpha release and version-matched desktop installer       |
| Obsidian Community Plugin | Submission/listing pending                                               |
| Public OWD Cloud accounts | Not generally available; billing and service commitments are future work |

Community is the complete product core, not a reduced tier. Managed hosting
uses the same pinned Community release and adds operational convenience; it
does not place multiple owners in one vault database.

## Working now

- One-owner passkey claim and sign-in
- Multiple explicitly paired Obsidian vaults
- Source-neutral Markdown-folder sync without requiring Obsidian
- Automatic searchable libraries from current durable sync state
- Bounded browsing, search, Markdown creation, and version-checked editing
- Remote MCP with Streamable HTTP, OAuth 2.1/PKCE, and revocable vault/folder
  grants
- Agent-first Project create, connect, rejoin, and resume through
  `open_project`
- The bounded `owd_resume` → `owd_find` → `owd_checkpoint` loop across fresh
  compatible clients
- Editable immutable Project briefs, portable preferences, inert Agent Skills,
  and owner-reviewed memory suggestions
- Owner-only local continuation evidence with no analytics provider or raw
  Project content in the response
- Prepared first-Project consent during guided onboarding
- Work Packets, Attempts, Artifacts, Handoffs, Reviews, owner Decisions, and
  provenance
- Provider-neutral lead continuity, bounded elastic Runs, deterministic
  research/coding evidence gates, and exception-only policy autopilot
- Scheduled continuity points and disposable recovery drills with measured
  RPO, RTO, continuity age, recovery quality, and runtime independence
- Encrypted owner-key-controlled snapshots and staged restore
- Source-pinned Obsidian Mind and Eve.dev compatibility profiles
- Daily upstream compatibility monitoring that requires human review before a
  version claim advances

## Alpha limits

- Use synthetic or disposable data while evaluating a new deployment.
- One owner per deployment; no team accounts or shared administration.
- Web mutation is limited to Markdown text creation/editing. Rename, deletion,
  attachment writes, and arbitrary `.obsidian` writes are not supported.
- Snapshot attachment and `.obsidian` sections are disabled.
- OWD Sync is not yet discoverable through Obsidian Community Plugins.
- Local multi-agent writer coordination is advisory guidance, not a filesystem
  lock.
- A protocol-compatible client is not automatically a client-specific
  acceptance claim.
- Operators remain responsible for Cloudflare account security, usage, updates,
  and recovery-key custody.

## What the alpha is proving

The most important external exercise is intentionally simple:

1. pair a disposable vault;
2. connect two agents independently;
3. say **Connect this project to OWD**;
4. carry a cited Handoff from one agent to the other;
5. create an independent Review;
6. record the owner's Decision;
7. resume the Project in a later task;
8. revoke access; and
9. recover the approved record into an isolated deployment.

Issues that create Project duplication, repeated authorization, cross-vault
visibility, stale context, hidden internal data, or recovery ambiguity are
release blockers.

[Deploy Community](https://deploy.workers.cloudflare.com/?url=https://github.com/msinclair25/mdevolved) ·
[Request managed alpha access](https://mdevolved.com/#alpha-access) ·
[Review the security model](SECURITY-MODEL.md)
