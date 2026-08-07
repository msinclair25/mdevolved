# Architecture

## Deployment unit

OWD Platform ships as one Cloudflare Worker project with static assets. The Worker owns browser routes, authenticated APIs, pairing endpoints, YAOS-compatible sync routes, scheduled work, and access to D1, R2, and Durable Objects.

The companion Obsidian plugin is built and released separately but pairs only with a user-owned OWD deployment.

## Distribution architecture

The integrated Worker is the Community data plane and remains a complete,
independently deployable product. The invitation-only managed alpha
provisions that pinned release into isolated single-owner cells with dedicated
storage bindings, Durable Object namespaces, secrets, hostnames, and quota
policy. It does not convert OWD into one shared multi-tenant Worker.

A future control plane will handle account, entitlement, automated
provisioning, release, and cell-health metadata only. It will not sit on the
request path for sync, browse, search, backup, recovery, or MCP. The Community
data plane has no runtime dependency on it. Full repository and trust
boundaries are defined in [`DEPLOYMENT-MODES.md`](DEPLOYMENT-MODES.md).

## Components

### Web client

React/Vite application for first-owner claim, vault onboarding, search, Markdown
browsing/editing, sync health, a timestamped snapshot timeline, and staged
recovery workflows.

### Worker API

Hono routes enforce authentication, authorization, input validation, origin policy, rate limits, and stable error contracts. Static assets and APIs share one origin.

The same Worker exposes a stateless Streamable HTTP MCP endpoint at `/mcp`.
MCP conversation state remains in the client. Tool calls read published D1/R2
materializations and do not create per-session Durable Objects.

### Vault Durable Object

Each vault has its own SQLite-backed Durable Object. It owns serialized YAOS-compatible Yjs mutations, sync connections, vault-local sequence numbers, and snapshot boundaries.

### D1

D1 stores owner credentials, sessions, vault registry, hashed pairing grants,
authoritative MCP client grants and folder/scope policy, materialization
generations, current-library note metadata and FTS5 rows, snapshot membership
and retention metadata, legacy backup manifests, collaboration identities and
query projections, Project-specific grants, append-only owner/provenance state,
restore jobs, and audit events. It does not store canonical live document
state or collaboration content bodies.

Project lead leases are a dedicated D1 projection keyed by Project. Atomic
claim/takeover increments a monotonically increasing fencing token. Continuity
Point identities, chain parents, dependency edges, and checkpoint receipts are
stored separately from the legacy collaboration ledger so strict existing
clients remain compatible.

### R2

R2 stores immutable library objects, attachment objects, content-addressed
collaboration records/evidence, owner-key-encrypted snapshot objects, legacy
backup bundles, and authenticated integrity manifests. Snapshot payload
objects are content addressed within one owner cell and recipient boundary but
use no vault name or note path in their object keys.

Canonical Continuity Point bodies use the same immutable content-addressed R2
boundary. Their portable body contains historical lead identity and fence
provenance, but no grant ID, lease ID, credential, conversation, or runtime
state.

### Companion plugin

The plugin validates the deployment origin and untrusted exchange response,
then obtains explicit consent naming the local vault and remote host before it
exchanges a short-lived pairing grant. It synchronizes eligible Markdown and,
only when the server advertises support, eligible attachments. `.obsidian`,
unrelated plugin settings, third-party credentials, telemetry, QA controls, and
legacy raw-token sharing flows are excluded from the release build.

A future snapshot capability may add an owner-triggered export for a compiled,
documented `.obsidian` allowlist. That is a bounded recovery channel, not live
sync or an arbitrary filesystem API. Unknown plugin data remains excluded.
Restore stages and previews each allowlisted setting separately and cannot turn
this channel into general `.obsidian` writes.

## Core flows

### First-owner claim

An unclaimed deployment exposes only health and claim routes. The Worker imports
the append-only authentication migration and idempotently bootstraps it if a new
deployment has not run the D1 migration ledger yet. Registration options are
bound to the request origin and RP ID. The short-lived challenge is keyed by the
hash of an HttpOnly flow cookie and consumed before verification.

SimpleWebAuthn performs WebAuthn verification. One D1 batch atomically inserts
the singleton owner, the initial hashed session, and the redacted audit event.
The singleton primary-key constraint makes exactly one concurrent claim win.
Once claimed, setup routes reject additional claims.

### Owner session

Registration and login require user verification. Session and CSRF tokens are
generated with Web Crypto; D1 stores only SHA-256 hashes. The browser receives
Secure, `SameSite=Strict`, host-only cookies. Anonymous and authenticated
mutations require the exact deployment origin and a double-submit CSRF token.
Authentication rotates all prior sessions for the single-owner V1 model.
Authentication attempts use D1-backed, pseudonymous fixed-window limits.

### Vault pairing

The authenticated dashboard creates a ten-minute, single-use pairing grant and
stores only its SHA-256 hash plus the exact deployment origin in D1. The
dashboard exposes a non-launching `owd-pair://` value for explicit copying. The
user first opens the intended vault, invokes OWD Sync from inside that vault,
and pastes the grant there. No operating-system URI handler selects a vault.
After a second confirmation naming the current vault, the plugin sends that
vault name, plugin version, and schema version to the same origin. One atomic D1
batch consumes the grant, activates the vault, and stores only the hash of a
newly issued vault credential. The raw credential is returned once to that
vault's plugin settings and is never exposed to the dashboard.

### Live synchronization

The plugin presents its vault credential in an HTTPS authorization header to
obtain a five-minute HMAC-signed socket ticket. It then connects to the
vault-specific sync route with that ticket. Before a Durable Object is reached,
the Worker validates the signature, lifetime, credential status, and vault
binding, then strips the ticket from the internal URL. The object applies and
persists Yjs updates in order before acknowledging them.

The wire protocol is pinned to YAOS server `0.3.0`, y-partyserver `2.1.2`, and
Yjs `13.6.20`, with schema versions 1 through 3 accepted. y-partyserver may
broadcast an applied update to connected clients immediately; that broadcast
is not a durability receipt. OWD emits YAOS's state-vector echo only after the
serialized checkpoint/journal persistence chain succeeds. A failed write
closes the originating socket without a receipt. Sync admission reads the
client schema version and explicitly rejects unsupported clients, unsupported
vaults, and clients older than an existing vault with `update_required`.

Revocation marks both the vault and all of its credentials inactive in D1,
invalidates even previously issued tickets at their next admission check, and
closes active Durable Object sockets with policy code `1008`. Invalid,
expired, revoked, or cross-vault tickets fail before a Durable Object is
instantiated.

### Materialization

An owner-triggered Durable Object RPC first persists live Yjs state, then clones
one complete update and state vector synchronously. The clone is the immutable
input boundary: live synchronization may continue while the derived generation
is built without mixing states.

Schema-aware extraction treats `pathToId` as authoritative for schema v1 and
`meta.path` as authoritative for schemas v2-v3. It rejects missing text,
unsupported schema records, non-NFC or cross-platform-ambiguous paths,
case-insensitive path collisions, `.obsidian`, non-Markdown files, and bounded
size/count violations. A bad record fails the whole new generation; it is never
silently omitted.

The immutable clone is framed into one private R2 staging object and recorded
as a durable D1 job. A vault alarm processes at most 16 notes per invocation,
persists its byte cursor and note count, and retries idempotently. Note bodies
use verified per-vault digest keys, so filenames never enter object keys and
unchanged content is reused across generations. Manifest, D1 metadata, and FTS5
rows remain generation-scoped.

Only after the staged byte boundary, note count, total bytes, object hashes, and
manifest all agree does one atomic D1 batch mark the generation published,
replace the vault's `current_materializations` pointer, complete the job, and
add a redacted audit event. Interrupted or failed jobs remain unreachable by
readers and leave the prior pointer unchanged. The current generation and two
most recent non-current published generations are retained; older unreferenced
generations and objects pass through bounded, delayed, reference-rechecking
garbage collection.

Owner-only browse, search, and note APIs first resolve one published generation
and use it for the complete response. Private paths, search text, and cursors
travel in authenticated JSON bodies rather than URLs. Note bodies stream from
R2. The dashboard renders Markdown as inert source text; a future rich
renderer must add an independently tested sanitizer before it replaces this
view.

### Web editing

The browser first reads the canonical note from the vault Durable Object. Its
opaque expected-version token binds the stable YAOS file ID, canonical path,
and Markdown content. An update is never an upsert: a non-null version may only
update that live identity, while a null version may only create an absent path.
This rejects stale editors even if a note was deleted and recreated with the
same path and text.

The Durable Object accepts web writes only for schema v3, rechecks that the
vault is active, validates the complete live Markdown projection and safety
bounds, and refuses tombstone revival, canonical path collisions, rename,
delete, attachments, and `.obsidian` writes. It applies one Yjs transaction
using the shared metadata helpers and returns success only after the resulting
state is durable. `y-partyserver` broadcasts that transaction to connected
Obsidian clients. A serialized background materialization then publishes a new
immutable browse/search generation; projection failure cannot revoke the live
write or replace the prior generation.

### Agent connection and read access

The owner adds the dashboard's MCP URL to a compatible client. OAuth then opens
OWD, where the owner reviews the unverified client identity, chooses an exact
vault and optional folder boundaries, and authenticates consent with the
existing passkey session. Protocol artifacts use a dedicated OAuth KV
namespace. An
authoritative D1 grant binds the client, redirect identity, MCP audience, vault,
paths, and scopes; every tool call checks that active policy so revocation is
effective immediately at the application boundary.

The initial MCP catalog is read-only. Search resolves one published D1 FTS
generation, returns bounded excerpts, and fetches no R2 body. A selected note
then streams in bounded pages from its immutable R2 key. Responses always echo
vault name and ID, canonical path, generation, content hash, and state layer.
There is no implicit current vault and no full-vault content tool.

A recognized vault-runtime profile is an additional server-side ceiling, not
authority. OWD Sync reports a validated descriptor; D1 stores it with sync
state, and materialization projects a private-frontmatter flag without putting
note bodies in D1. The Worker intersects profile roots with the OAuth folder
grant and applies the result to search, recent changes, direct reads, Project
source selection, Project discovery, packet validation, repair, and resume.
For the Obsidian Mind profile this also withholds its memory root and configured
never-expose filenames. A changed profile marks the library stale until the
new projection completes, preventing an older generation from bypassing the
new ceiling.

Future agent mutations use a proposal ledger. The agent records an immutable,
expiring diff tied to its grant and a live expected version. The owner—not the
client—reviews and approves it in the browser before the existing Durable
Object write path may apply it. Accepted memories and skills use the same
reviewed-owner-data principle.

### Knowledge spaces and portable intelligence

The collaboration layer stores a versioned policy over explicit vault IDs and
path prefixes; it does not duplicate canonical notes. Grants pin the evaluated
space version and exact membership. Removing content takes effect through the
authoritative D1 check on the next tool call. Adding content produces a new
version and requires fresh consent, so a convenient multi-vault view cannot
silently expand an existing client's authority.

Attempts, Artifacts, Handoffs, Reviews, Decisions, and their exact provenance
use immutable D1 identities with content-addressed R2 bodies. Future durable
knowledge, skill versions, evaluation results, and proposal metadata use the
same boundary. They identify producing client/model, source
vault/path/generation/hash, knowledge-space version, review state, expiry,
supersession, and integrity hash. The first collaboration records enter
backup/recovery through explicit Approved and Unvetted capabilities; later
record types must pass the same gate before activation.

Harness working context remains outside OWD. Codex, Claude Code, Grok Build,
Antigravity/Gemini, Cursor, Hermes, and other clients execute their native tools
and skills. OWD supplies bounded knowledge, lineage, policy, proposals, and
owner-reviewed stable versions rather than becoming a universal agent runtime.

The complete collaboration domain, portable packet/submission envelopes,
visibility states, authorization scopes, Obsidian projection, and staged
delivery order are defined in
[`PORTABLE-INTELLIGENCE.md`](PORTABLE-INTELLIGENCE.md). The first vertical slice
centers Projects and Work Items rather than a fixed agent sequence. An owner
freezes one bounded Work Packet, an authorized client appends an immutable
Attempt/Artifact/Handoff or Review, and the owner separately decides whether to
share it with the Project or accept it as durable truth.

The collaboration ledger is transport-neutral. Dashboard routes, MCP tools,
portable Markdown/JSON files, and future protocol adapters call the same
validated application services. MCP Tasks and A2A task state do not become
canonical Project state. This keeps clients without those capabilities fully
functional and prevents an experimental or service-agent protocol from
dictating the owner's durable record.

The MCP adapter exposes one convergent Project state machine through
`open_project`. It creates, connects, rejoins, or resumes from the exact active
source connection and explicit durable Project identity. When owner consent is
needed, `wait_for_project_connection` remains on that same MCP connection while
the browser action atomically creates the separately stored collaboration
grant. The source access token is never widened and no second OAuth redirect is
required. `.owdignore` carries the exact `projectId` with its approved selector
so later `resume_project` calls cannot infer Project identity from labels,
folders, or client history.

Routine source-generation refresh, immutable Work Packet rotation, and active
collaboration-grant renewal are transport-neutral application maintenance.
They run only after the full current authorization and integrity checks,
preserve authority exactly, and converge idempotently. Explicit revocation
remains final. Approved legacy requests from the former two-step flow may
self-heal only when their same active source grant still covers the exact
approved Project and context.

Accepted Project records may be projected into an explicitly selected safe
folder in one active vault as immutable Markdown version notes. The structured
D1/R2 ledger remains authoritative; the projection is content-hashed,
rebuildable, and may not silently overwrite owner edits. Projection failure
cannot revoke an owner Decision or publish a partial Project view.

### Lead substitution continuity

`project.lead` is additive to existing Project scopes. `claim_project_lead`
atomically acquires an absent, expired, revoked, or invalid-holder lease;
`renew_project_lead` preserves its fence; takeover always increments the fence.
Every checkpoint reauthorizes the exact client and Project, then one
constraint-guarded database insert rechecks the live lease ID, fencing token,
grant, client, Project, open Work Item, and chain parent in the same D1 batch
that inserts the point and its idempotency receipt.

`checkpoint_project` freezes the active Project/Work Item versions and Work
Packet plus explicitly selected accepted Decisions, visible Artifacts, exact
packet evidence, completed/open work, blockers, rejected approaches, risks,
and next action. It creates operational `checkpointed` state; it does not
accept any record. `resume_project` adds the latest verified point when one
exists. A separate capability resource advertises this extension without
changing `owd-collaboration-capabilities-v1`.

The owner may download a two-file provider-neutral bundle containing a README
and canonical Continuity Point JSON. Encrypted Approved Intelligence includes
the same point and dependency closure. Restore writes null source lease/client
columns and creates no grant, lease, or checkpoint receipt; replacement work
starts only after fresh authorization and a new live claim.

### External client federation

An external application such as Hoplon is an ordinary OAuth/MCP client. It gets
no YAOS credential, Durable Object binding, vault credential, storage binding,
or control-plane role. Its access is constrained and revoked by the same OWD
grant checks as a coding-agent client.

For Hoplon, the default path is live federation: Hoplon authorizes its user and
private Project, performs bounded OWD search/read calls, and freezes one cited
evidence packet before provider fan-out. OWD never receives Hoplon provider
credentials or organization policy, and Hoplon does not mirror the whole vault
by default. An explicit later Project import is a separate Hoplon artifact; it
does not make Project membership equivalent to the owner's live OWD grant.

### Recovery snapshots and legacy backups

The owner browser generates the age identity and offers a timestamped standard
download without invoking a native save-location API. It submits only the
public recipient, and only after the owner reselects a non-empty matching file.
Existing `owd-backup-v1` jobs select one verified materialization generation,
construct a deterministic Markdown manifest, stream the bundle through
age/X25519, and publish it only after the R2 size, version, and ETag match.
These artifacts remain importable and restorable.

`owd-snapshot-v2` makes a retained snapshot a workspace-level recovery point.
Its D1 record identifies a bounded capture window and exact per-vault
generations. Its encrypted authenticated manifest contains a complete logical
inventory of the selected vaults and portable owner-data sections. All active
vaults are the default scope; a selected vault is an advanced scope. A capture
is coordinated across independent vault Durable Objects and is not represented
as one instantaneous global transaction. Membership is fixed when capture
starts. If any selected vault lacks a verified durable generation, publication
fails without silently producing a partial "everything" snapshot.

Snapshot creation rechecks each selected vault through the durable
materialization job boundary even when a caller bypasses the browser workflow.
The recovery recipient is fixed by the same conditional D1 write that starts
the snapshot. Changing it is blocked while a capture/import is incomplete; the
owner may explicitly cancel that incomplete work, after which delayed cleanup
reclaims only artifacts that are still unreferenced.

Note, attachment, and future portable-intelligence bodies use immutable
content-addressed recovery objects. The first occurrence is encrypted with
randomized authenticated encryption to the owner recipient, verified, and then
may be reused for identical content inside the same owner/recipient boundary.
The design never derives deterministic ciphertext from note content. Each
snapshot manifest is logically full, so restoring one point does not replay a
delta chain; only its new physical objects consume additional R2 storage.
Missing or corrupt objects can be rebuilt from canonical live state before
publication. Current-library FTS rows remain bounded and rebuildable rather
than being retained for every recovery point.

The format reserves authenticated sections for approved and unvetted portable
intelligence. **Approved Intelligence** is selected by default and includes
accepted handoffs, Decisions, durable Knowledge, stable/superseded Skills,
supporting evaluations, provenance, policy, and their inert evidence closure.
**Unvetted Intelligence** is an explicit nested selection and includes
private/shared submissions, pending proposals, candidates, experimental or
quarantined Skills, unused evaluations, rejected records, and their provenance.
Unvetted selection requires approved selection. OAuth tokens, sessions,
authorization codes, protocol KV state, credentials, live grants, and harness
context are excluded in either mode. Optional external export receives only the
encrypted snapshot representation.

Stored snapshots use cell-local D1 membership and an R2 object graph. Portable
export streams the encrypted manifest and all reachable ciphertext objects into
one provider-neutral container. The container uses no required D1 row ID, R2
key, hostname, cell identifier, or provider API. A target installation can
verify and import it with no source connectivity, then reconstruct fresh local
membership records after the owner explicitly maps source vaults to targets.
Required and optional format capabilities are declared so an older reader fails
closed instead of silently performing an incomplete restore.

### Recovery

Recovery never writes directly from an unverified archive or snapshot. The
browser first decrypts and verifies age authentication, schema, byte boundaries,
and content hashes. For a workspace snapshot, the owner maps every selected
source vault to an explicit target before any plaintext is staged. A second
pass uploads bounded objects to an isolated staging namespace. The Worker
refreshes each exact target generation, presents an added/changed/unchanged
preview, requires exact target confirmation, and applies an overlay through the
live state owner in resumable batches. Each write compares the target hash
captured by preview, preserves target-only notes, and is followed by a verified
library generation. Restored credentials and grants remain disabled.

Approved portable intelligence restores through isolated staging with its
accepted/stable pointers and complete provenance. Unvetted portable
intelligence stages separately and restores only as owner-visible quarantine:
prior private/shared/proposed/experimental/rejected states remain historical
metadata and confer no current visibility, recall, write, promotion, or
stable-skill authority. An older importer that cannot preserve the selected
classification and quarantine semantics fails before staging.

## Consistency model

- Live state: strongly serialized per vault by its Durable Object.
- Materialized state: immutable, eventually consistent, generation-addressed.
- Search: corresponds to a named materialization generation.
- Recovery snapshot: corresponds to an immutable workspace manifest, a bounded
  capture window, an exact verified generation for every included vault, and
  the exact Approved/Unvetted Intelligence selection with separate counts and
  dependency closure.
- Agent read: corresponds to a named materialization generation and active D1
  grant checked for that tool call.
- Knowledge-space read: additionally corresponds to the exact consented space
  version and evaluated vault/path membership.
- Work Packet: corresponds to one immutable Project/Work Item version, one
  exact Knowledge Space version, a bounded set of cited source generations, and
  the accepted/shared records selected when the packet was frozen.
- Agent submission: is an immutable append-only claim associated with one
  active client grant and Work Packet; sharing and acceptance are separate
  owner events.
- Accepted intelligence: immutable, versioned owner data with source and review
  provenance; session context and unaccepted proposals are not shared truth.
- Project lead lease: one D1-serialized holder per Project with a monotonically
  increasing takeover fence; expiration or revocation invalidates later writes.
- Continuity Point: immutable acknowledged operational state in one linear
  predecessor chain; recovery preserves the body and provenance but no live
  authority.
- Standing lead-operation policy: one conservative immutable policy per active
  Project version; it only narrows existing owner-approved authority.
- Run: exact Project, Work Item, Work Packet, and policy identity with bounded
  actor/bundle/byte projections. The execution harness still owns scheduling,
  supervision, tools, worktrees, and retries.
- Actor: a short-lived claimed Run identity whose scopes are checked on each
  contextual read or bundle submission; it is never a restored or independently
  bearer-authorized principal.
- EventBundle: immutable `run-shared-unvetted` evidence visible only through
  the exact authorized Run context. Independent review routing and claim
  conflicts are durable projections, not provider runtime state.
- R2 mutation receipt: atomic with both the requested state transition and a
  commit-time check of the exact current Project grant, source grant, vault,
  lead holder, lease expiry, and fencing token.
- R4 PolicyDecision and drill receipt: immutable bodies bound to the exact
  owner-authored policy/evidence inputs, active Project version, scheduled
  request, source Continuity Point, replacement lease, and commit-time fence.

The UI always shows which layer and generation it is displaying.

## Trust boundaries

- Browser to Worker: hostile network and hostile input.
- Obsidian plugin to Worker: vault-scoped client, not an administrator.
- Worker to bindings: trusted platform channel, least-privilege bindings.
- GitHub export: external untrusted storage; only encrypted artifacts leave Cloudflare.
- Markdown renderer: note content is untrusted even when authored by the owner.
- MCP client to Worker: potentially malicious or compromised client with only
  its explicit vault, path, and scope grant.
- External application to Worker: an ordinary MCP client whose own user,
  organization, Project, provider, and conversation authority is not accepted
  as OWD authority.
- Worker to model provider: no direct relationship. After an authorized client
  sends returned content to a model provider, that downstream use is outside
  OWD's enforcement boundary and must be disclosed.
- Managed control plane to data-plane cell: provisioning and health metadata
  only; the control plane has no vault-content API or implicit owner session.
- Managed operator to Cloudflare account: trusted infrastructure operator with
  potential account-level access to live plaintext state. This is an explicit
  hosted-service trust boundary, not zero-knowledge storage.
- Cell to cell: mutually untrusted deployments with distinct D1, R2, Durable
  Object, KV, hostname, and secret boundaries.

### R3 elastic Run plane

R3 is an additive vertical slice over the R2 operation ledger. An opt-in Run
advertises `owd-elastic-run-plane-v1` and keeps the same Project, Work Item,
Work Packet, lead lease, exact grant, and fence checks. It permits at most 32
active actors and 64 actor records in one Run. Registration is bounded to 16
actors per call and bundle submission to 8 bundles per call. The harness still
owns scheduling, supervision, retries, worktrees, branches, and process
concurrency; OWD stores only bounded identity, evidence, continuity, budget,
exception, recovery, and observation metadata.

`get_run_context` remains compatible with R2 clients and returns the existing
snapshot envelope when `mode` is omitted. R3 clients may request `mode: delta`
with an opaque grant/Project/Run-bound cursor and a limit of at most 100. Delta
records are ordered by one monotonically increasing Run sequence, then stable
record identity; a cursor is returned whenever more records remain. A cursor
cannot be reused for another Project or Run and expires rather than widening
authority. A snapshot followed by deltas is therefore deterministic and does
not leak adjacent Runs.

Mutation idempotency is keyed by the caller-supplied operation key and a hash of
the complete canonical request. An exact retry returns the original receipt;
the same key with different payload is an explicit `idempotency_conflict` and
never appends a second record. Capacity limits return bounded backpressure with
stable retry metadata; OWD does not enqueue work or choose a retry schedule for
the execution harness. Batch operations are all-or-nothing at the durable
record boundary, and a replayed batch reports its prior receipt.

Legacy R2 mutation tools continue to operate on R2 Runs but are rejected on an
opt-in elastic Run so they cannot bypass R3 slots, deltas, or accounting. The
unchanged snapshot read and generic completion path remain compatible.

Expired or abandoned actors are represented by an immutable
`owd-actor-recovery-v1` record. A replacement actor is newly issued inside the
same Run with a subset of the predecessor scopes. The predecessor is never
revived, and recovery cannot create a Project grant, vault access, lease, or
protected-path authority. Recovery and replacement are visible through Run
deltas and are safe to retry by idempotency key.

The harness reports logical units and cost microunits through
`owd-run-budget-v1` and `owd-budget-entry-v1`. OWD validates monotonic bounded
accounting through immutable version rows and records a blocking
`budget-exhausted` Exception when a limit is met; it does not estimate provider
spend or schedule execution. Observations
(`owd-run-observation-v1`) contain only aggregate counts, retry/rejection
counts, bounded latency percentiles, and timestamps. They exclude transcripts,
hidden reasoning, terminal history, credentials, OAuth state, provider runtime,
and production/customer logs.

Run, actor, bundle, delta, recovery, budget, observation, and Orca projection
metadata use hot/warm/cold/quarantine retention tiers. Each volume-cleanup pass
selects at most 64 expired delta, budget-entry, observation, Orca, or
quarantined records. It waits for a closed Run and refuses records referenced
by a pending/ready snapshot, staged restore, or open/blocking Exception. Plane,
account, budget, recovery, actor, bundle, and Continuity Point records are not
volume-cleanup candidates.

The inert `owd-orca-projection-v1` adapter accepts optional worktree, branch,
commit, pull-request, and session references and maps them to generic Run or
Actor evidence. Values are bounded, provider-labelled metadata only. Orca is
not called, launched, scheduled, or trusted as an identity source; loss or
unavailability of Orca state leaves the generic Run ledger usable and permits
a separately authorized non-Orca lead to resume. The adapter cannot grant,
restore, or widen authority and is omitted from recovery authority rows. A
supplied Actor reference must identify an active, unexpired Actor in the exact
Run.

### R4 policy and continuity plane

R4 adds five immutable operational record kinds: policy binding, deterministic
Decision, operational schedule, operational evidence, and continuity receipt.
Migration 0033 keeps canonical bodies in content-addressed R2 and minimal
query/fence projections in D1. A binding names the exact active Project version
and owner-authored policy/evidence hashes. Evaluation revalidates those bodies,
then records a fixed research or coding truth table. Completion rechecks the
Decision, evidence count, Continuity Point, grant, source grant, vault, lease,
and fence in the commit transaction.

The Worker scheduled handler is a bounded trigger, not a supervisor. It
examines at most eight due schedules, coalesces missed windows, and creates an
idempotent Continuity Point or disposable-drill request. The external execution
harness owns planning, agents, tools, retries, worktrees, inference, and
provider state. Drill completion is accepted only for the exact pending request
and source Continuity Point under a distinct replacement lead fence.

Integrity pages are bounded and partial coverage is degraded. Retention
protects active dependencies, the latest report, and the last complete
known-good report. Portable export carries the closed dependency graph and
content-addressed referenced bodies. Snapshot restore verifies canonical bytes
and creates quarantined base records only; it never restores policy, scheduler,
grant, lease, actor, credential, OAuth, or provider authority. Managed-cell
health is aggregate evidence, while the Community data and recovery path stays
independent of any control plane.
