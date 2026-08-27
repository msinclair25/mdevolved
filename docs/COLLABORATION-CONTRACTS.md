# Collaboration contracts

## Status

These V1 semantics are implemented by the schemas in
`packages/contracts/src/collaboration.ts`, the transport-neutral services, and
their synthetic fixtures.

This approval freezes the V1 semantic boundary, not physical D1 table
names or R2 keys. Any later implementation discovery that changes authority,
immutability, provenance, portable identity, or recovery classification must
return to this gate before a migration is merged.

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have their
ordinary RFC 2119/8174 meaning.

## Reviewed substrate

The approved gate extends rather than replaces the proven foundation:

| Existing boundary                                 | Collaboration dependency                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| YAOS/Yjs per-vault live source of truth           | Collaboration records do not enter live note state. A later approved notebook projection uses the existing expected-version path.          |
| Published D1/R2 library generations               | Work Packet citations pin vault, path, generation, full-source hash, byte range, and a retained evidence object.                           |
| OAuth protocol state in dedicated KV              | Tokens and authorization codes remain protocol artifacts, not collaboration records.                                                       |
| Authoritative D1 agent grants                     | Every collaboration call must recheck client, audience, Project, Knowledge Space version, scope, expiry, and revocation.                   |
| Immutable R2 materialization and snapshot objects | Artifact bodies, retained packet evidence, and portable record bodies are content-addressed objects; D1 keeps bounded metadata and events. |
| `owd-snapshot-v2` capability negotiation          | Approved and quarantined intelligence are activated only through distinct required capabilities and hostile-import validation.             |
| Staged snapshot restore                           | Approved records and quarantined Unvetted records stage and preview before apply; no grant or credential is restored.                      |

## Contract registry

| Contract                        | Version marker                        | Purpose                                                                          |
| ------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| Work Packet                     | `owd-work-packet-v1`                  | Frozen bounded input for one attempted contribution                              |
| Submission                      | `owd-collaboration-submission-v1`     | One append-only agent record plus idempotency and claimed producer metadata      |
| Ledger                          | `owd-collaboration-ledger-v1`         | Provider-neutral immutable records, owner events, and provenance                 |
| Capability profile              | `owd-collaboration-capabilities-v1`   | Supported record, packet, submission, MCP, and snapshot versions                 |
| Snapshot intelligence extension | `owd-snapshot-intelligence-v1`        | Explicit Approved/Unvetted selection, closure inventory, and restore disposition |
| Continuity Point                | `owd-continuity-point-v1`             | Acknowledged bounded Project state for lead substitution                         |
| Lead continuity capabilities    | `owd-lead-continuity-capabilities-v1` | Additive MCP tools, scope, point, and portable-bundle negotiation                |
| Portable continuity bundle      | `owd-portable-continuity-bundle-v1`   | Provider-neutral README plus canonical latest Continuity Point                   |

All structural schemas target
[JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12). The shared
Zod schemas remain the server-side source of truth because cross-record,
authorization, state-transition, and dependency-closure invariants are not all
expressible in a transport JSON Schema. Adapters publish the generated JSON
Schema and still execute the semantic validator.

Unknown required formats, record schema versions, or snapshot capabilities fail
before storage or staging. Optional adapter features cannot change domain
semantics.

## Primitive conventions

### Portable identity

- Every durable identity is an RFC 9562 UUID string generated with
  cryptographically secure randomness. UUID values are opaque; ordering is
  never inferred from them.
- Portable IDs are not D1 row IDs, R2 keys, Worker hostnames, OAuth tokens,
  Cloudflare account IDs, or managed-cell IDs.
- A restored record keeps its portable ID. Fresh local storage identities are
  implementation details. An import collision with non-identical content fails
  before apply; it is never silently merged.

### Time

- Durable contracts use non-negative integer Unix seconds to match the existing
  snapshot and audit substrate.
- Agent start and completion times are explicitly claimed metadata. Server
  receipt time is separate and authoritative for ordering, expiry, and audit.
- An A2A adapter converts these values to the UTC timestamp strings required by
  A2A 1.0 without changing stored semantics.

### Canonical integrity

- JSON integrity is SHA-256 over the RFC 8785 JSON Canonicalization Scheme
  representation with `integrity.digest` omitted.
- The algorithm marker is `sha-256-jcs-rfc8785`; changing canonicalization or
  hash algorithms requires a new marker and fixture.
- A digest detects altered bytes. Authenticity still comes from the authorized
  live transport, the owner-controlled import action, or authenticated snapshot
  encryption. A self-supplied digest is not producer attestation.

### Paths and bodies

- Vault paths and prefixes are relative, NFC-normalized, case-folded to an
  explicit identity key, and reject absolute paths, traversal, backslashes,
  empty segments, control/format characters, and `.obsidian`.
- The empty Knowledge Space prefix means the vault root. It is represented as
  both `path: ""` and `pathKey: ""`; no other implicit root exists.
- Large or content-bearing values live in immutable R2 objects. Portable
  descriptors contain only media type, byte length, SHA-256, and portable object
  identity. No R2 key is portable.
- V1 stored Artifacts are `text/markdown` or `application/json` and are limited
  to one MiB each. HTTPS external references are inert, optional-digest
  metadata with `never-server-fetch`; they cannot satisfy an offline evidence
  dependency by themselves.

## Core record contracts

| Record                  | Required invariant                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KnowledgeSpace`        | Stable identity only; label/lifecycle changes are owner events.                                                                                        |
| `KnowledgeSpaceVersion` | Immutable ordered version over explicit vault IDs, normalized prefixes, exclusions, predecessor, and selector digest. Each vault appears once.         |
| `Project`               | Stable owner-created identity; it never implies a client grant.                                                                                        |
| `ProjectVersion`        | Immutable objective, exact Knowledge Space version, bounded packet policy, and predecessor. Activating a version is an owner event.                    |
| `WorkItem`              | Stable identity bound to one Project.                                                                                                                  |
| `WorkItemVersion`       | Immutable objective, constraints, requested output, definition of done, and predecessor.                                                               |
| `ParticipantRef`        | Authorization-bound OAuth client identity plus separately client- or owner-claimed harness/model fields. Claimed software is never verified authority. |
| `WorkPacket`            | Immutable, expiring Project/Work Item/space/version snapshot with exact retained evidence, explicit omissions, output limits, and integrity hash.      |
| `Attempt`               | Immutable claimed effort tied to one packet, participant, role label, and—only for live submission—one grant. Role has `authority: none`.              |
| `Artifact`              | Immutable content-addressed Markdown/JSON object or inert HTTPS reference tied to one Attempt.                                                         |
| `Handoff`               | Immutable bounded summary, completed work, risks, open questions, suggested next actions, exact Artifact IDs, and citation IDs.                        |
| `Review`                | Immutable findings and producer-claimed verdict tied to an exact review Attempt and visible Artifact IDs.                                              |
| `Decision`              | Owner-authored immutable resolution identifying accepted/rejected input records and rationale. A later Decision supersedes; it never edits history.    |
| `OwnerEvent`            | Only authoritative share, accept, reject, quarantine, supersede, lifecycle, close/reopen, and version-activation state change.                         |
| `ProvenanceEdge`        | Immutable, typed, Project-local edge whose direction matches W3C PROV classes.                                                                         |

Durable Knowledge, Skills, Evaluation Case Sets, and Evaluation Runs remain
deferred to later roadmap work. The V1 contract reserves recovery and
authorization extension points but does not freeze premature schemas for them.

## Knowledge Space and packet invariants

1. A Knowledge Space version freezes authority selectors, not note contents.
   Work Packet citations freeze the exact source generation and bytes used.
2. Removing a vault or prefix restricts future reads and submissions on the next
   authoritative D1 check. It invalidates affected unexpired packets for new
   submission.
3. Adding or widening a prefix creates a new Knowledge Space version, a new
   Project version, and fresh client consent. Existing refresh tokens and grants
   never inherit it.
4. `project.read` permits bounded Project records and exact Work Packets. It does
   not grant arbitrary search or raw note reads. Those remain separate
   `vault.read` grants.
5. Every packet citation contains the source vault ID, canonical path, immutable
   library generation, whole-source hash, source byte length, half-open byte
   range, and retained evidence-object identity/hash/length.
6. Every retained evidence object is cited and every citation resolves. The
   first packet budget is at most 64 citations and four MiB of retained evidence.
7. Included records name exact IDs, schema versions, hashes, selection reasons,
   and visibility at assembly. Cross-Project records are invalid even when a
   client can access both Projects through separate grants.
8. A packet is stale for submission when expired, invalidated by scope removal,
   replaced by an active Project or Work Item version, tied to a different grant
   Knowledge Space version, or attached to a closed/quarantined Work Item.
9. Staleness blocks new submissions but never mutates the packet or erases a
   historical Attempt that already used it.
10. Revocation cannot retract a packet already downloaded or plaintext already
    returned. It denies the next retrieval or submission and the owner audit
    preserves the prior egress.
11. Packet lifetime is not owner maintenance. After the complete authoritative
    grant, Project, Knowledge Space, restored-source, and integrity checks, a
    current-context operation may append an automatic successor for the same
    Work Item. It cannot widen authority or mutate the expired packet. Exact
    retrieval and submission against that expired packet remain stale.
12. A newer current source-library generation may append the same kind of
    successor after rebuilding and revalidating the exact cited evidence.
    Concurrent refreshes converge on one successor for one prior packet.
13. The canonical Project-context receipt contains the durable `projectId` as
    well as the complete include/exclude policy. Resume never derives Project
    identity from a label, local path, chat, or most recently used grant.
14. Authorized use may slide an active collaboration grant's availability
    window only after the source grant and complete Project authorization
    checks pass. It cannot override explicit revocation or widen authority.

## Submission and idempotency invariants

Each submission contains exactly one declared agent record: `Attempt`,
`Artifact`, `Handoff`, or `Review`. The record carries the same Project, Work
Item, and Work Packet identities as the envelope.

The live sequence is intentionally explicit:

1. `submit_attempt` appends an Attempt.
2. `submit_artifact` appends zero or more Artifacts for that Attempt.
3. `submit_handoff` appends a Handoff for the same Attempt; or a second
   participant appends its own Attempt and then `submit_review`.

This adds the previously omitted `submit_artifact` adapter operation. It keeps
Artifact storage and correction semantics first-class instead of hiding
multiple durable records inside one ambiguous submission.

- The producer can append only records tied to its active grant and packet.
- The server derives and rechecks the live OAuth client and grant; duplicate
  envelope fields are untrusted assertions that must match the authorization
  context.
- Portable owner import sets `mode: owner-import` and `grantId: null`. Imported
  records begin private/pending and gain no client authority.
- A raw idempotency key is accepted only at the request boundary. The durable
  receipt stores its SHA-256, the submission hash, server receipt time, and
  resulting record identity.
- The same grant and idempotency-key hash with the same submission hash returns
  the original receipt. The same key with different bytes is
  `idempotency_conflict`. Reuse from another grant/client is not a match and must
  pass that caller's normal authorization without adopting the first receipt.
- Corrections set `supersedesRecordId` and append a new record. A producer may
  supersede only its own same-type, same-Project record when policy allows; the
  owner event makes the replacement current.
- Agent submissions cannot contain a Decision or OwnerEvent, set visibility or
  disposition, activate a Project version, close a Work Item, widen a grant, or
  write a note.

## Visibility and truth

Visibility and disposition are independent projections over immutable records:

| Dimension   | Values                                                                         | Authority                                                                   |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Visibility  | `private`, `shared`, `owner-only`                                              | Owner event only; new agent submissions start `private`                     |
| Disposition | `pending`, `accepted`, `rejected`, `quarantined`, `superseded`, `checkpointed` | Owner events govern truth; `checkpointed` is acknowledged operational state |

- `private` is readable by the owner and the submitting OAuth client under the
  same Project grant. No other participant can infer its existence.
- `shared` is readable by authorized participants in that exact Project and
  Knowledge Space version. It remains untrusted.
- `owner-only` is used for restored quarantine, Decisions not yet exposed in a
  packet, and evidence-only dependencies.
- Sharing never accepts. Acceptance never silently widens visibility or source
  authority. Rejection and quarantine never delete lineage.
- A shared Review verdict is still a producer claim. A model confidence or
  verdict cannot create a Decision.
- `superseded` requires an identified replacement. Both versions remain
  addressable to the owner and in provenance/recovery history.
- `checkpointed` applies only to a Continuity Point. It does not accept its
  referenced Artifacts or elevate its operational summary to owner truth.

## Authorization matrix

Legend: **A** allowed after all row-level checks; **O** owner only; **N** denied.

| Operation                                          |                   Owner browser | `project.read` | `collaboration.submit` |         `review.submit` | `proposal.status` |        Owner import |
| -------------------------------------------------- | ------------------------------: | -------------: | ---------------------: | ----------------------: | ----------------: | ------------------: |
| Read Project/active version                        |                               A |              A |                      N |                       N |                 N |                   N |
| Retrieve exact Work Packet                         |                               A |              A |                      N |                       N |                 N |                   N |
| Read shared/accepted Project record                |                               A |              A |                      N |                       N |                 N |                   N |
| Read caller's private submission/status            |                               A |              N |                      N |                       N |                 A |                   N |
| Append Attempt                                     |                               O |              N |                      A | A, for a review Attempt |                 N | A, private/no grant |
| Append Artifact for own Attempt                    |                               O |              N |                      A |  A, for review evidence |                 N | A, private/no grant |
| Append Handoff for own Attempt                     |                               O |              N |                      A |                       N |                 N | A, private/no grant |
| Append Review of visible exact Artifact            |                               O |              N |                      N |                       A |                 N | A, private/no grant |
| Share, accept, reject, quarantine, supersede       |                               O |              N |                      N |                       N |                 N |                   N |
| Record Decision or close/reopen Work Item          |                               O |              N |                      N |                       N |                 N |                   N |
| Create/activate Project or Knowledge Space version |                               O |              N |                      N |                       N |                 N |                   N |
| Grant/revoke another client                        |                               O |              N |                      N |                       N |                 N |                   N |
| Search/read arbitrary vault content                |      O or separate `vault.read` |              N |                      N |                       N |                 N |                   N |
| Create/update a note                               | O through expected-version path |              N |                      N |                       N |                 N |                   N |

Scopes are necessary but never sufficient. Every call must check, in order:

1. access token validity and exact MCP audience;
2. active authoritative source D1 grant, client, expiry, and revocation;
3. explicit Project ID plus its separately stored active collaboration grant;
4. exact Project and Knowledge Space version binding;
5. required named scope;
6. current Project/Work Item lifecycle and packet freshness;
7. record ownership, parent Attempt, Artifact visibility, and Project-local
   references;
8. schema, integrity, media type, count, and byte bounds; and
9. idempotency before append.

No external application's organization, role, task, context, or session claim
enters this decision.

Lead-continuity authorization is deliberately narrower:

| Operation                                         | Owner browser | `project.read` |                  `project.lead` |        Restored point |
| ------------------------------------------------- | ------------: | -------------: | ------------------------------: | --------------------: |
| Read latest Continuity Point                      |             A |              A |           A with `project.read` | N without a new grant |
| Claim or renew Project lead                       |             O |              N | A with live exact Project grant |                     N |
| Append one fenced checkpoint                      |             O |              N |         A with live lease/fence |                     N |
| Revoke lead lease                                 |             O |              N |                               N |                     N |
| Accept referenced records or change Project truth |             O |              N |                               N |                     N |

## Normative collaboration invariants

| ID  | Invariant                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Every durable record and event is append-only; correction is supersession.                                                                     |
| C02 | Portable IDs are globally unique inside a ledger and never encode deployment location.                                                         |
| C03 | A record cannot cross Project boundaries through a parent, input, packet, owner event, or provenance edge.                                     |
| C04 | A Project version pins one exact Knowledge Space version.                                                                                      |
| C05 | Widening Knowledge Space authority never mutates or upgrades an existing grant.                                                                |
| C06 | A Work Packet is immutable, bounded, expiring, and hash-checked.                                                                               |
| C07 | Every cited excerpt has retained immutable evidence in addition to its source reference.                                                       |
| C08 | `project.read` cannot be used as arbitrary cross-vault `vault.read`.                                                                           |
| C09 | Every live submission binds the active client, grant, Project, Work Item, packet, participant, and idempotency key.                            |
| C10 | Owner import cannot claim a live grant or producer authority.                                                                                  |
| C11 | Same-key same-payload retry returns the original receipt; same-key different-payload fails.                                                    |
| C12 | Agent roles, model names, verdicts, confidence, and proposed state changes grant no authority.                                                 |
| C13 | OAuth client identity and claimed harness/model identity are distinct fields with distinct verification labels.                                |
| C14 | New submissions are private/pending; only owner events change visibility or disposition.                                                       |
| C15 | Sharing is not acceptance; acceptance is not declassification.                                                                                 |
| C16 | Only the owner can create a Decision, activate versions, close work, or change grants.                                                         |
| C17 | Reviews reference exact visible Artifacts and source versions; a reviewer cannot replace the producer's record.                                |
| C18 | Routine packet rotation is append-only and automatic; it preserves Project, Work Item, Knowledge Space, grant, scope, and consent boundaries.  |
| C18 | External Artifact URIs are HTTPS, inert, and never server-fetched.                                                                             |
| C19 | Provenance relation directions match W3C PROV entity/activity/agent classes.                                                                   |
| C20 | MCP, portable files, dashboard routes, and future adapters validate the same domain contracts.                                                 |
| C21 | Revocation denies the next call but does not claim to retract previously released plaintext.                                                   |
| C22 | Approved recovery is dependency-closed and offline-verifiable.                                                                                 |
| C23 | Unvetted recovery requires Approved recovery and always restores to owner-only quarantine.                                                     |
| C24 | Snapshot restore never recreates credentials, protocol state, live grants, or client authority.                                                |
| C25 | Unknown required capability or schema version fails before staging.                                                                            |
| C26 | Restored quarantine cannot participate in normal recall, sharing, proposals, promotion, or stable pointers without new owner events.           |
| C27 | A provider-neutral export requires no D1 row, R2 key, hostname, source account, or source connectivity.                                        |
| C28 | Project-notebook projection is derived, excluded as source by default, and cannot overwrite an owner edit without the exact prior hash.        |
| C29 | One owner approval atomically creates the exact collaboration grant; the same source MCP connection resolves it without a second OAuth flow.   |
| C30 | `.owdignore` binds resume to one explicit durable Project ID and the complete approved selector.                                               |
| C31 | Routine source, packet, token, and active-grant refresh is automatic; explicit revocation remains final.                                       |
| C32 | Legacy approval self-healing requires the same active source grant and exact approved Project/context; it can never restore revoked authority. |
| C33 | One Project has at most one live lead lease; every takeover increments a monotonically increasing fencing token.                               |
| C34 | A checkpoint names the exact current Project, Work Item, Work Packet, lease fence, predecessor, and idempotency payload.                       |
| C35 | Continuity Points are operational checkpoints, not accepted truth, and cannot include cross-Project references.                                |
| C36 | The legacy capability profile remains strict and unchanged; lead continuity is negotiated through a separate versioned profile.                |
| C37 | Portable and encrypted recovery preserve Continuity Point bodies and dependencies but restore no lease, receipt, grant, or producer authority. |
| C38 | A replacement lead resumes only after independent authorization and a new live claim; historical fence provenance is never reusable authority. |

## Threat and negative-case catalog

These cases are contract fixtures now where structurally possible and required
runtime/integration tests after implementation.

| ID  | Attack or failure                                                                  | Required result                                       | Stable domain error                                                            |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| T01 | Cross-Project parent, input, packet inclusion, or provenance edge                  | Reject before append                                  | `project_reference_invalid`                                                    |
| T02 | Grant and packet pin different Knowledge Space versions                            | Reject before content read or append                  | `knowledge_space_version_mismatch`                                             |
| T03 | Submission uses expired, invalidated, closed, or replaced packet                   | Retain packet historically; deny append               | `work_packet_stale`                                                            |
| T04 | Revoked or expired grant with otherwise valid token                                | Deny next call                                        | `collaboration_grant_revoked`                                                  |
| T05 | Missing named scope                                                                | Deny without revealing record existence               | `collaboration_scope_required`                                                 |
| T06 | Another participant reads a private submission                                     | Not-found-equivalent denial                           | `record_not_visible`                                                           |
| T07 | Review names a private or cross-Project Artifact                                   | Reject Review                                         | `artifact_not_visible`                                                         |
| T08 | Same idempotency key and same payload retry                                        | Return original receipt                               | none                                                                           |
| T09 | Same idempotency key with different payload                                        | Reject; preserve first record                         | `idempotency_conflict`                                                         |
| T10 | Replay envelope under another client/grant                                         | Reauthorize independently; never adopt first identity | `submission_replay_denied`                                                     |
| T11 | Oversize count/body, unsupported media type, malformed JSON, or unknown field      | Reject before R2/D1 mutation                          | `submission_invalid` or `submission_too_large`                                 |
| T12 | Client submits Decision, OwnerEvent, sharing, acceptance, or grant change          | Schema/authorization denial                           | `owner_authority_required`                                                     |
| T13 | Producer labels model/harness as verified                                          | Schema denial or forced `claimed` display             | `producer_identity_invalid`                                                    |
| T14 | Producer replaces another client's record or changes history                       | Reject; require own same-type supersession            | `supersession_not_allowed`                                                     |
| T15 | Altered packet/submission digest                                                   | Reject before use                                     | `integrity_mismatch`                                                           |
| T16 | Citation has missing object, mismatched byte range/hash, or historical object loss | Reject packet/restore; do not weaken citation         | `evidence_unavailable`                                                         |
| T17 | Prompt injection in evidence, filename, frontmatter, Artifact, or Handoff          | Preserve as inert data; no authority/tool expansion   | `content_policy_denied` when bounds are crossed                                |
| T18 | Submitted external URI targets file, localhost, metadata, or unsafe scheme         | Schema denial; never fetch even valid HTTPS           | `external_reference_invalid`                                                   |
| T19 | Projection is re-ingested as independent source or target changed since preview    | Exclude loop; fail stale write                        | `projection_origin_loop` or `projection_target_changed`                        |
| T20 | `approved` section depends on missing or Unvetted object                           | Fail before snapshot publication/import               | `snapshot_dependency_missing`                                                  |
| T21 | Attempted Unvetted-only snapshot                                                   | Reject selection                                      | `snapshot_selection_invalid`                                                   |
| T22 | Older reader lacks approved/quarantine capability                                  | Fail before staging; name capability                  | `snapshot_capability_unsupported`                                              |
| T23 | Restore tries to share, resume proposal, activate Skill, or recreate grant         | Force quarantine/disabled state or fail               | `restore_authority_forbidden`                                                  |
| T24 | Simultaneous Project lead claims                                                   | Exactly one holder; loser receives a stable conflict  | `lead_lease_conflict`                                                          |
| T25 | Expired, revoked, or stale-fence lead checkpoints                                  | Deny before insert                                    | `lead_lease_invalid`                                                           |
| T26 | Checkpoint forks the current predecessor                                           | Preserve the winner and linear chain                  | `continuity_point_conflict`                                                    |
| T27 | Checkpoint names cross-Project Decision/Artifact or missing citation               | Deny without partial point/receipt                    | `project_reference_invalid`, `artifact_not_visible`, or `evidence_unavailable` |
| T24 | Duplicate portable ID with non-identical restored bytes                            | Fail collision review; never merge                    | `portable_identity_collision`                                                  |
| T25 | Token passthrough, wrong audience, or external app role claim                      | Reject before application authorization               | `authorization_context_invalid`                                                |
| T26 | Rate, cursor, or pagination abuse                                                  | Bounded response and redacted denial                  | `rate_limited` or `cursor_invalid`                                             |

## Provenance contract and W3C PROV mapping

MDevolved keeps a compact JSON vocabulary; RDF and a graph database are not required.
Edge direction is part of validation:

| MDevolved edge        | Subject class | Object class | W3C PROV meaning                                          |
| --------------------- | ------------- | ------------ | --------------------------------------------------------- |
| `used`                | activity      | entity       | Attempt/Review used Packet, Artifact, or evidence         |
| `was-generated-by`    | entity        | activity     | Artifact/Handoff was generated by Attempt                 |
| `was-derived-from`    | entity        | entity       | Decision or revision derives from exact immutable records |
| `was-revision-of`     | entity        | entity       | New immutable version supersedes an earlier entity        |
| `was-informed-by`     | activity      | activity     | Later Attempt was informed by an earlier activity         |
| `was-attributed-to`   | entity        | agent        | Entity attribution to an explicit Participant/owner agent |
| `was-associated-with` | activity      | agent        | Attempt/Review association with ParticipantRef            |

The first fixtures use only relations whose endpoints already exist as walking-
skeleton records. A later PROV export MAY introduce an explicit owner agent and
bundle metadata without changing stored edge semantics.

## MCP and A2A interoperability

### MCP 2025-11-25

The versioned v1–v3 MDevolved capability Resources retain `2025-11-25` as their
stable legacy baseline so older clients do not see a silent contract rewrite.
The same Tools, Resources, and Prompts are also served through the current
`2026-07-28` per-request envelope and routing-header contract documented in
[`MCP-COMPATIBILITY.md`](MCP-COMPATIBILITY.md).

- Tool inputs and `structuredContent` outputs use the published JSON Schema
  2020-12 shapes. Each structured result also includes concise serialized JSON
  text for clients that do not surface structured content.
- Opaque cursors bind grant, Project, query/version, and expiry.
- MCP Tasks remain experimental and are not a durable Project, Work Item,
  Attempt, or job record. A future negotiated adapter may wrap a MDevolved-owned job.
- MCP authorization remains audience-bound OAuth with Protected Resource
  Metadata, exact per-client consent, short-lived access, and authoritative D1
  policy checks. Token passthrough is forbidden.
- Lead-continuity clients discover
  `owd://collaboration/lead-continuity-capabilities/v1`; clients that do not
  understand it continue using the unchanged legacy profile and tools.

### A2A 1.0

MDevolved does not expose an A2A service in V1. The documented mapping is lossy and
non-authoritative:

| MDevolved           | A2A 1.0 analogue                         | Compatibility note                                                                     |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Project             | `context_id`                             | An A2A context cannot grant MDevolved Project access.                                  |
| Work Item           | `Task`                                   | MDevolved lifecycle and owner Decisions remain authoritative.                          |
| Work Packet         | input `Message` plus `Part` content      | Packet integrity, exact citations, and retained evidence remain MDevolved extensions.  |
| Attempt             | task execution/activity observation      | A2A Task state never replaces append-only MDevolved Attempts.                          |
| Artifact            | `Artifact`                               | Media/data can map; MDevolved hashes and recovery classification remain required.      |
| Handoff             | output `Artifact`                        | A2A specifies that outputs should be Artifacts rather than relying on Message history. |
| Review              | output `Artifact` plus activity metadata | Verdict remains a producer claim.                                                      |
| Decision/OwnerEvent | no core equivalent                       | Must remain MDevolved owner authority; an extension may reference it.                  |

A2A Message history is not MDevolved harness context and is never silently ingested.

## Recovery capability contract

### Backward-compatible activation

The deployed `owd-snapshot-v2` reader/writer remains unchanged at this gate.
When implementation begins:

- every newly written v2 manifest includes exactly one encrypted
  `owd-snapshot-intelligence-v1` extension, including `selection: none` for a
  vault-only snapshot;
- an existing legacy v2 manifest without the extension is accepted only when it
  declares neither intelligence capability, and deterministically means
  `none`;
- any manifest with intelligence data must declare the matching required
  capability in both the encrypted manifest and public index; and
- an old strict reader rejects the unknown required capability/section before
  staging instead of dropping it.

This preserves already-created v2 recovery points without treating a missing
field in a new manifest as an ambiguous selection.

### Selection and capabilities

| Selection               | Approved section | Unvetted section | Required capabilities                                 | Restore result                                            |
| ----------------------- | ---------------- | ---------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `none`                  | absent           | absent           | neither                                               | Vault content only; not complete intelligence recovery    |
| `approved`              | present          | absent           | `owd.snapshot.approved-intelligence-v1`               | Accepted roots and evidence-only closure; grants disabled |
| `approved-and-unvetted` | present          | present          | approved + `owd.snapshot.quarantined-intelligence-v1` | Approved restore plus owner-only quarantined history      |

There is no Unvetted-only value. Section summaries separately report record
count, evidence-object count, logical bytes, and newly stored bytes.

### Approved closure

1. Start from selected accepted Decisions, accepted Handoffs/Reviews,
   acknowledged Continuity Points, active and
   historical Project/Work Item versions needed to interpret them, and their
   authoritative owner events.
2. Traverse packet, participant, attempt, artifact, citation, evidence,
   provenance, policy, supersession, and future stable-pointer dependencies.
3. Add every missing inert dependency. If it was not independently accepted,
   classify it in the Approved section as `evidenceOnly: true` with
   `restore-evidence-only`.
4. An Approved dependency can resolve only inside the Approved section. It may
   never point into Unvetted.
5. Every portable descriptor names the record type/version, original state,
   Project/Work Item IDs, content hash/length, dependency IDs, classification,
   portable object ID, and restore disposition.
6. A complete-recovery claim requires every dependency locally. An external
   Artifact reference can be preserved as unavailable metadata but cannot be
   dereferenced to complete the closure.

### Unvetted closure and restore

Unvetted may depend on Approved or Unvetted objects. It uses the same owner-key
encryption, authenticated manifest, integrity checks, hostile-import limits,
retention, and provider-neutral export. On restore every Unvetted record is
rewritten to:

- `visibility: owner-only`;
- `disposition: quarantined`; and
- `restoreDisposition: restore-quarantined`.

The original private/shared/rejected/quarantined state remains provenance only.
Restore cannot share it, resume a proposal, apply a note mutation, expose it in
normal Project recall, promote it, activate a Skill, recreate a Participant as
an authorized client, or recreate a grant. The owner must author new bounded
events after review.

### Permanently excluded authority

Every selection excludes access/refresh tokens, authorization codes, OAuth
protocol storage, sessions, passkeys, pairing secrets, vault credentials, live
agent grants, recovery private keys, harness conversations/context, provider
credentials, and runtime caches. ParticipantRefs and historical grant IDs may
remain inert provenance; they are never reconstructed as authorization rows.
Lead leases and checkpoint receipts are likewise permanently excluded.
Continuity Point bodies retain only historical claimed lead identity and fence
provenance with both authority flags fixed to false.

## R2 hands-off lead operation

R2 is an additive operation ledger alongside the existing collaboration
ledger. It does not change an existing record discriminator or grant a harness
new authority.

| Format                     | Durable meaning                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `owd-project-policy-v1`    | Conservative Project-version policy ceiling: eight actors, 64 bundles, 16 events per bundle, 256 KiB per bundle, and 4 MiB per Run            |
| `owd-run-v1`               | One research or coding execution boundary pinned to an exact Work Item, Work Packet, and standing policy                                      |
| `owd-actor-v1`             | A short-lived claimed identity inside one Run; it is not an OAuth client, grant, credential, lease, or verified provider identity             |
| `owd-event-bundle-v1`      | Bounded `run-shared-unvetted` provisional result, review request, or review result                                                            |
| `owd-project-exception-v1` | Explicit blocking evidence for privileged requests, exhausted budgets, evidence conflicts, actor-scope denial, or review-independence failure |
| `owd-run-context-v1`       | Provider-neutral portable view of one exact Run, with both authority flags fixed to false                                                     |

The generic MCP surface is `create_work_item`, `start_run`, `register_actor`,
`get_run_context`, `submit_bundle`, `complete_work_item`, and
`list_project_exceptions`. Every call still requires the exact authorized
Project lead. Mutations additionally require the current lead lease ID and
fencing token. The D1 receipt carries a commit-time proof that the exact grant,
source grant, vault, Project, lease holder, expiry, and fence remain live; a
zero-row guarded projection cannot commit a success receipt.

Actor scopes only narrow work inside that authority: `run.context.read`,
`run.bundle.submit`, and `run.review.submit`. They never widen the Project,
Knowledge Space, vault, folder, protected-path, or owner boundary. Review must
be explicitly routed to a different active actor, and only that routed actor
may submit the result. Completion requires at least three claimed actors, a
routed independent passing review, a fresh live Continuity Point for the Work
Item against the Run's exact pinned Work Packet, and no blocking Exception. A
newer packet does not silently retarget an active Run. `start_run` only selects
an accepted, non-restored packet; quarantined or restored packet bodies can
never seed live Run authority.

Requests for authority expansion, destructive action, or access below the
exact `.git`, `.owdignore`, or `.obsidian` protected roots are recorded and not
executed. Conflicting claim hashes are preserved and block completion; MDevolved does
not choose a winner. No EventBundle contains a raw transcript, hidden
reasoning, terminal history, credential, OAuth state, retry loop, or harness
runtime state.

All five durable R2 record formats are optional Unvetted snapshot records.
They are never Approved roots. Restore verifies their canonical immutable
bodies and inserts only `project_operation_records` rows with
`restore_state = 'quarantined'`; it creates no policy, Run, Actor, bundle,
Exception, receipt, grant, lease, credential, or OAuth projection. A later
live operation therefore requires fresh ordinary authorization and can never
resume restored actor authority.

Capability discovery is additive at
`owd://collaboration/lead-operation-capabilities/v1`. The existing
`owd-collaboration-capabilities-v1` and lead-continuity resource are unchanged,
so current R1 and older clients continue using their existing tools. The
Hermes resource at `owd://adapters/hermes/hands-off/v1` is inert, script-free
sequencing guidance over the same generic services.

## R3 elastic Run and Orca contracts

R3 is negotiated additively through
`owd-lead-operation-capabilities-v2` (schema version 2). Clients that only
advertise `owd-lead-operation-capabilities-v1` retain the R2 seven-tool
surface and R2 limits. A client must opt into the elastic profile; an R2 Run
never silently changes capacity or response shape.

The frozen elastic profile is:

| Bound                             |  R3 ceiling |
| --------------------------------- | ----------: |
| Active actors per Run             |          32 |
| Actor records per Run             |          64 |
| Actor registrations per batch     |          16 |
| EventBundle submissions per batch |           8 |
| Delta records per page            |         100 |
| Actor metadata                    | 8 KiB UTF-8 |
| Aggregate observation             | 4 KiB UTF-8 |

`register_actors_batch` and `submit_bundles_batch` require one exact Project,
Run, Work Item, lead lease, fencing token, and idempotency envelope. Duplicate
IDs inside a batch are invalid. An exact retry returns the original receipt
with `replayed: true`; reusing the same idempotency key with a different
canonical payload fails with `idempotency_conflict`. Capacity exhaustion is a
bounded `backpressure`/`retryable` response with a stable error code and
retry-after metadata. Scheduling, supervision, retry timing, and concurrency
remain execution-harness responsibilities.

`get_run_context` accepts the existing `snapshot` mode (or no mode) for old
clients. R3 `delta` mode requires a cursor-bound request and an optional limit
up to 100. Each `owd-run-delta-v1` record carries one positive, monotonically
increasing Run sequence, exact Project/Run IDs, record type, record ID, and
retention metadata. Pages are stable in sequence order; a non-null cursor is
required while more records remain. Cursors are opaque, bounded, expiring,
and reject cross-Project, cross-Run, altered, or replayed scope.

The R2 `register_actor` and `submit_bundle` mutations remain unchanged for R2
Runs but fail closed on an opt-in elastic Run. This prevents an old mutation
path from bypassing R3 actor slots, delta evidence, or budget accounting; R3
clients use the bounded batch tools. The legacy snapshot read and generic
completion path remain available for the same Run.

`owd-actor-recovery-v1` records abandoned or expired actors and a distinct
replacement. Replacement scopes are a subset of the predecessor scopes and
the old actor remains expired/revoked. No recovery path revives a predecessor,
restores a grant or lease, or changes the Project/vault/folder boundary.

`owd-run-budget-v1` and `owd-budget-entry-v1` store harness-reported logical
units and cost microunits. MDevolved records accepted entries durably and raises a
blocking `budget-exhausted` Project Exception at either limit; it does not
price provider usage, run a meter, or own scheduling. Immutable budget-version
rows prove each conditional accounting advance without making an older entry
reference a mutable parent key. `owd-run-observation-v1`
is aggregate and privacy-safe: actor counts, bundle/delta counts, retries,
rejections, bounded p50/p95 latency, and measurement time only. Raw
transcripts, hidden reasoning, terminal history, credentials, OAuth state,
provider runtime, and production/customer logs are forbidden.

Every new R3 record is append-only, content-addressed where a body exists, and
carries `retentionTier` (`hot`, `warm`, `cold`, or `quarantine`) plus a bounded
`retainUntil`. Cleanup is delayed, limited to 64 records per pass, and
reference-aware. Volume cleanup applies only to expired deltas, budget entries,
observations, Orca projections, and quarantined records after the Run closes;
it refuses records referenced by a pending/ready snapshot, staged restore, or
open/blocking Exception. Snapshot/export and quarantine restore include these
records as inert metadata; no actor, grant, lease, credential, OAuth state,
receipt, or live authority is restored.

The existing provider-neutral Continuity Point export remains two files for
R1/R2 Projects. When R3 records exist it additively includes
`elastic-records.json`, a bounded canonical descriptor/body manifest with
content hashes and portable IDs but no D1 row keys, R2 object keys, grants,
leases, credentials, or runtime state.

The `owd-orca-projection-v1` contract is an inert adapter. It accepts only
bounded optional `worktreeRef`, `branchRef`, `commitSha`, `pullRequestRef`,
`sessionRef`, and the literal provider label `orca`, all with authority flags
false. These values are evidence attached to a generic Run/Actor, never MDevolved
identity or authorization. MDevolved neither invokes Orca nor imports its terminal,
conversation, scheduling, worktree, branch, PR, or session state. If Orca is
unavailable, a provider-neutral lead with fresh authorization resumes from the
Run snapshot/delta and durable exceptions.

### R3 contract gate and acceptance scope

The local gate must exercise solo parity and synthetic 20-plus-actor load,
batch bounds, stable cursor pagination, exact replay versus payload conflict,
backpressure/retry metadata, budget exhaustion, abandoned/expired replacement,
cross-Run/Project leakage, revocation/fence races, malformed/oversize metadata,
restored-authority denial, and old-client compatibility. It must also prove
that losing Orca state does not prevent non-Orca resumption. A live disposable
exercise is human-authorized and remains outside the local automated build
until explicitly run; this document makes no live acceptance claim.

## Cloudflare storage implications

Official platform documentation was reviewed on 2026-08-05. The relevant
current constraints are D1's two-MB row/string/BLOB limit, 100 bound parameters
per query, single-database serialization, Worker CPU/memory limits, and R2's
large immutable-object capacity with 1,024-byte keys and 8,192-byte custom
metadata.

Consequences for the collaboration implementation:

- D1 rows hold identities, hashes, bounded fields, state events, grants, and
  query projections—not Artifact/evidence bodies.
- R2 holds content-addressed immutable bodies and encrypted snapshot objects.
- D1 batches stay intentionally below the platform parameter ceiling and are
  resumable/idempotent at record boundaries.
- Packet and submission limits are product/security limits below platform
  maximums, so deployments behave consistently across plans.
- Snapshot intelligence is bounded to 5,000 records, 5,000 evidence objects,
  and 128 MiB logical bytes for this first contract. Sharded manifests and
  streaming browser staging remain pre-broad-use work.

## Compatibility fixtures and validation

| Fixture                                               | Proves                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `owd-work-packet-v1.json`                             | Exact source/evidence linkage, bounds, JSON round trip, RFC 8785/SHA-256 integrity                  |
| `owd-collaboration-submission-v1.json`                | One-record append envelope, authorization-bound identity, idempotency, integrity                    |
| `owd-collaboration-ledger-v1.json`                    | Two independent participants, shared Handoff, Review, owner Decision, Project-local W3C PROV graph  |
| `owd-collaboration-capabilities-v1.json`              | Exact record/format/MCP/snapshot version discovery                                                  |
| `owd-continuity-point-v1.json`                        | Accepted Decisions, Artifacts, exact evidence, bounded state, integrity, and no live authority      |
| `owd-lead-continuity-capabilities-v1.json`            | Separate additive MCP/scope/portable-format negotiation without breaking legacy clients             |
| `owd-project-policy-v1.json`                          | Exact standing policy ceilings, protected roots, exception-only actions, and no restored authority  |
| `owd-event-bundle-v1.json`                            | Bounded Run-shared provisional claims with exact Run/Actor identity                                 |
| `owd-lead-operation-capabilities-v1.json`             | Additive R2 formats and seven generic MCP tools without changing current-client capability profiles |
| `owd-snapshot-intelligence-none-v1.json`              | Vault-only selection with no intelligence capability                                                |
| `owd-snapshot-intelligence-approved-v1.json`          | Approved root plus unaccepted evidence-only closure                                                 |
| `owd-snapshot-intelligence-approved-unvetted-v1.json` | Approved baseline plus quarantined Unvetted record and evidence                                     |

The current contract tests validate structural and semantic round trips,
canonical hashes and strings, immutable predecessor chains, exact packet and
output parents, cross-Project/Work Item/Attempt rejection, packet record and
citation classification, retained evidence, non-forgeable PROV classes and
directions, global durable-ID uniqueness, safe inert external references,
unresolved OwnerEvents, agent Decision rejection, exact fail-closed capability
selection, aggregate recovery budgets, portable-object collisions,
unvetted-only recovery, missing dependency rejection, and restored-authority
rejection.

The collaboration implementation fixtures additionally round-trip through the
additive D1/R2 representation, portable export/import, and a fresh isolated
installation. Those tests do not authorize changing these semantics in a
migration.

## Official references reviewed

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 9562 — UUIDs](https://www.rfc-editor.org/rfc/rfc9562)
- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)
- [MCP 2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP 2025-11-25 schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema)
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Contract gate decision

Owner approval accepts all of the following as one coherent gate:

1. the first-slice record set and deferral of generalized Knowledge/Skill
   schemas;
2. one durable record per submission and the addition of `submit_artifact` to
   future adapters;
3. `project.read` as packet/ledger access rather than arbitrary vault access;
4. separate authorization-bound client identity and claimed harness/model
   identity;
5. RFC 8785 plus SHA-256 portable integrity;
6. orthogonal visibility/disposition with owner-only authority changes;
7. the authorization matrix, fail-closed ordering, stable error families, and
   threat catalog;
8. explicit legacy-v2 compatibility and new-manifest intelligence selection;
9. Approved evidence closure and mandatory quarantine for Unvetted restore;
   and
10. the initial count/byte bounds and provider-neutral format registry.

Changes to these semantics require matching schema, migration, authorization,
compatibility, portable-format, and recovery updates in one reviewed change.
