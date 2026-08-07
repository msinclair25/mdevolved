# Security Model

## Protected assets

- Note text, filenames, attachments, and selected Obsidian configuration.
- Owner identity, sessions, passkeys, pairing grants, and vault credentials.
- Backup encryption keys, manifests, and recovery material.
- Integrity and availability of live Yjs state and stored generations.
- Deployment identifiers and operational metadata that could expose vault habits.
- Project briefs, Work Packets, agent submissions, Reviews, Decisions, durable
  Knowledge, Skills, evaluation cases/results, and their provenance.
- Project lead leases, fencing tokens, Continuity Points, checkpoint receipts,
  and their provider-neutral recovery closure.

## Assumed adversaries

- An unauthenticated internet client.
- A malicious web page attempting CSRF or cross-origin access.
- Malicious Markdown or attachments inside a vault.
- A leaked pairing link, session cookie, vault token, or encrypted backup.
- A compromised external backup destination.
- Accidental owner action, faulty migration, or partial job execution.
- A malicious or compromised MCP client, including OAuth client impersonation.
- Prompt injection embedded in note text, filenames, frontmatter, or links.
- Runaway agent loops attempting excessive reads or cost amplification.
- Poisoned memory or skill proposals and stale agent write proposals.
- A malicious client replaying, replacing, backdating, or cross-linking another
  client's Project submission.
- Two clients racing to act as Project lead, or a stale/expired/revoked holder
  attempting a checkpoint after takeover.
- Visibility confusion that presents a shared but unaccepted Handoff as owner
  truth, or leaks a private submission to another Project participant.
- False harness/model identity claims used to overstate who produced or
  independently reviewed an Artifact.
- A knowledge-space edit that silently broadens an existing client grant.
- A compromised external application attempting to translate its own Project,
  team, or organization role into OWD vault authority.
- A malicious managed customer attempting hostname, identifier, OAuth, storage,
  log, quota, or provisioning confusion across owner cells.
- A compromised managed control plane, deployment credential, support account,
  or infrastructure operator.

Compromise of the owner's Cloudflare account or local device is outside the primary boundary, but the design should limit secondary damage where practical.

## Security invariants

1. An unclaimed deployment cannot expose vault or owner data.
2. Only the owner can create pairing grants, browse content, edit notes, trigger exports, or initiate recovery.
3. A vault credential authorizes only its assigned vault and sync protocol.
4. Pairing grants are short-lived, single-use, deployment-bound, and stored
   only as hashes. Socket tickets are short-lived, signed, vault-bound, and
   revalidated against credential revocation before Durable Object admission.
5. No browser route can access a Durable Object without authorization at the Worker boundary.
6. No path can escape its vault namespace or write to a disallowed `.obsidian` location.
7. Markdown cannot execute script, load unsafe URL schemes, or inject unsanitized HTML.
8. Plaintext recovery contents and decryption private keys never leave the trusted encryption boundary.
9. A snapshot is not reported healthy until its ciphertext objects, manifest,
   membership, and integrity checks are durable.
10. Restore requires validation, preview, confirmation, and post-apply verification.
11. A web note update must present the expected live file identity, path, and
    content version; creation must prove the path is absent and not tombstoned.
12. Every MCP tool call must pass an active D1 grant check for the exact client,
    audience, vault, path, and scope; token validity alone is insufficient.
13. Every agent content result names its vault ID, path, generation, and content
    hash. No implicit current vault exists.
14. An agent cannot directly mutate owner data or approve its own proposal.
15. Restored OAuth grants remain disabled until the owner reauthorizes them.
16. Community operation never requires a managed account, billing decision, or
    control-plane request.
17. Every managed owner cell has dedicated D1, R2, Durable Object, OAuth KV,
    hostname, and runtime-secret boundaries; a user-controlled identifier can
    never select another cell's binding.
18. The managed control plane has no vault-content API, backup decryption
    identity, implicit owner session, or presence on the live data path.
19. Hosted-service disclosures state that the infrastructure operator may have
    account-level access to live plaintext state and do not claim zero
    knowledge.
20. Removing a vault/path from a knowledge space denies it on the next tool
    call; adding or widening content never expands an existing grant without
    fresh owner consent.
21. An external application's user, organization, Project, or role claims do
    not authorize OWD. Only an active OWD grant does.
22. A producing agent or model cannot approve or promote its own note, memory,
    or skill proposal, and evaluation cannot expand the proposal's source grant.
23. A snapshot is logically complete and independently restorable. Physical
    deduplication never creates a required delta chain.
24. A multi-vault snapshot records its bounded capture window and exact
    per-vault generations; it is never represented as an instantaneous global
    transaction. Its membership is fixed at capture start, and an unavailable
    selected vault fails the snapshot instead of being silently omitted.
25. Deterministic encryption is not used to deduplicate owner content. Only a
    previously randomized, verified ciphertext object may be reused within its
    owner and recipient boundary.
26. Snapshot scope may include portable owner data but never sessions,
    passkeys, OAuth material, pairing secrets, live grants, or harness context.
    **Approved Intelligence** is selected by default. **Unvetted Intelligence**
    is an explicit nested selection that requires Approved Intelligence and is
    off by default. Unvetted records restore only into owner-visible quarantine;
    they cannot regain sharing, recall, proposal execution, promotion, stable
    status, or client authority. Runtime caches, device-local state, and
    superseded Yjs journals remain implementation state. Restored authorization
    remains disabled.
27. `.obsidian` snapshot capture and restore use a compiled allowlist, explicit
    owner action, bounded schemas, and staged preview. They never expose an
    arbitrary plugin-data or filesystem read/write capability.
28. A portable snapshot requires no source-service access and contains no
    provider-specific authority. Unknown required capabilities fail closed;
    skipped optional sections prevent a complete-restore claim.
29. An agent submission is append-only, bound to one active grant, Project,
    Work Item, Work Packet, and idempotency key. A correction supersedes rather
    than replaces the original record.
30. Private, shared, accepted, rejected, quarantined, and superseded states are
    distinct. Sharing permits review but never promotes a Handoff, Knowledge
    Candidate, Decision, or Skill.
31. Only owner-authenticated events change Project authority, record
    visibility, acceptance, promotion, stable-skill pointers, or Knowledge
    Space versions. No submission scope grants any of those actions.
32. OAuth client identity and claimed harness/model identity are displayed
    separately. Self-reported model metadata is never treated as verified
    authority or independent-review proof.
33. A Work Packet is immutable and cites exact source, Project, Work Item,
    Knowledge Space, shared-record, Decision, Knowledge, and Skill versions.
    Later source changes cannot alter what an Attempt received.
34. MCP, portable-file, Obsidian-projection, and future protocol adapters
    enforce the same domain schemas and authorization services. A transport
    cannot create a stronger authority path.
35. Revocation prevents future retrieval and submission but cannot retract
    plaintext already returned to a client or downloaded in a Work Packet.
    Consent and audit UI disclose that egress boundary.
36. Accepting Knowledge or a Skill cannot silently widen its source authority.
    Derived records inherit the most restrictive source visibility unless the
    owner performs a separate, previewed declassification event.
37. Project-notebook projections are excluded from their Project source scope by
    default and retain ledger-origin hashes. A projection cannot become
    independent evidence for itself or create a promotion feedback loop.
38. Accepted records retain immutable packet evidence objects sufficient to
    verify their cited source excerpts after the live library changes. Complete
    restore cannot require an external URL or source deployment.
39. The private-trial web installer can write only the pinned OWD Sync release
    and enabled-plugin list after an explicit local directory-picker gesture.
    It cannot enumerate notes, persist a directory handle, upload vault data,
    change general Obsidian settings, or grant filesystem access to the Worker,
    sync protocol, MCP clients, or agents.
40. Every Project operation names an explicit durable Project ID. OWD resolves
    its separately stored collaboration grant from the active source
    connection; it never infers authority from a label, local path, chat, or
    most recently used grant.
41. Exact owner Project approval atomically creates or activates that
    collaboration grant. It does not widen the source token and does not require
    a second OAuth flow. Legacy approval self-healing requires the same active
    source grant and exact approved context.
42. Routine OAuth refresh, collaboration-grant renewal, source refresh, and
    Work Packet rotation are machine-managed. None can survive explicit
    revocation, add scope, change a Project, or expand source authority.
43. A managed alpha cell and its delivery artifact contain no development
    vault, internal acceptance Project, operator evidence/runbook, source
    branch, or other tester's state.
44. An owner may additionally classify an exact Project as `owner-only`.
    OWD revokes that Project's agent grants, expires pending joins, and excludes
    its identity and source membership from every agent discovery,
    authorization-repair, and collaboration path while preserving it in the
    authenticated owner dashboard.
45. Owner, agent, sequential, and concurrent Project creation all commit
    through one database-enforced `(vault, normalized Project label)` fence.
    A loser may recover the winner only when the immutable creation payload,
    Project, Work Item, and packet identities match exactly.
46. A local Project receipt that names a different vault boundary never causes
    silent Knowledge Space mutation or cross-vault metadata disclosure. It
    returns one owner-only repair page that shows the mismatch and requires an
    explicit boundary decision.
47. At most one live Project lead lease exists per Project. Takeover is one
    atomic D1 write and strictly increments its fencing token.
48. A live checkpoint is accepted only when the database can re-prove the exact
    lease, fence, authorization-bound client, active source/project grants,
    active Project, open Work Item, and current chain parent in its insert
    transaction. Same-key different-payload replay fails.
49. Continuity Points are acknowledged operational state, never owner-accepted
    truth. Cross-Project Decisions/Artifacts, missing evidence, stale packets,
    malformed bodies, and forked predecessors fail before durable insertion.
50. Snapshot/import may preserve a Continuity Point and historical lead/fence
    provenance, but can never recreate a lead lease, checkpoint receipt, grant,
    credential, producer authority, or permission to resume without fresh
    authorization.

## Browser hardening

The Cloudflare Static Assets layer applies the browser boundary without
invoking the Worker for HTML, JavaScript, or CSS:

- the SPA shell receives a restrictive Content Security Policy, clickjacking
  protection, MIME sniffing protection, a no-referrer policy, and a deny-by-
  default browser-feature policy;
- fingerprinted `/assets/*` files are cached immutably for one year, while the
  HTML shell keeps Cloudflare's revalidation behavior so releases are visible
  immediately;
- versioned `/owd-sync/<version>/*` files contain only the checked companion
  release and generated installer manifest and are cached immutably;
- these rules live in `apps/web/public/_headers`, are copied into the Vite
  output, and are enforced by Cloudflare Static Assets at the edge.

The private-trial installer is entirely local to the browser after the owner
chooses a vault. It validates `.obsidian` without listing the vault, fetches
only same-origin versioned assets, verifies each byte count and SHA-256 hash,
backs up only its four allowed targets in memory, writes the enabled-plugin
list last, and rolls back on failure. Directory handles are not placed in
browser storage or transmitted. Browser permission remains visible and
revocable through the browser; closing the tab releases OWD's in-memory
reference. Obsidian must be closed during the write so its shutdown cannot
overwrite the enabled-plugin list. A clean vault remains in Restricted Mode
until the owner explicitly chooses **Turn on community plugins** inside
Obsidian; the installer neither changes nor bypasses that setting.

The beta candidate also emits a stricter report-only policy whose
`connect-src` is limited to the deployment itself. The existing enforced
policy remains unchanged until the trusted-browser pass confirms that sync,
OAuth, downloads, and recovery produce no unexpected violations. Worker API
responses use the same report-only directive with an exact HTTP-to-WebSocket
origin mapping.

## Authentication

Use WebAuthn passkeys with an atomic first-owner claim. Challenges are bound to origin and ceremony, expire quickly, and are consumed once. Sessions rotate after authentication and sensitive account changes.

The V1 implementation requires WebAuthn user verification and discoverable
credentials, uses no attestation identity, and accepts ES256 or RS256
credentials through the pinned SimpleWebAuthn verifier. Ceremony challenges
expire after five minutes. Session cookies expire after seven days and are
revoked as a generation when the owner authenticates again. D1 stores hashes,
never raw session, flow, or CSRF bearer values.

Every authentication mutation requires the exact request origin and a
double-submit CSRF value. Cookies are host-only, Secure, and
`SameSite=Strict`; session and ceremony-flow cookies are also HttpOnly.
Fixed-window D1 counters rate-limit registration and login using a hash of the
connecting address rather than the raw address.

OAuth dynamic registration is protected before provider KV writes by
Cloudflare native route and client limits plus an exact D1-backed ceiling of
500 accepted attempts per UTC-aligned 24-hour bucket. Token requests have an
independent client-address limit. Limiter failure fails closed, and saturated
D1 rows are not incremented further.

Cloudflare Access is optional defense in depth for browser routes. If enabled, its JWT must be validated by the Worker, and the configuration must explicitly exempt or separately protect required sync routes.

## Agent authentication and authorization

The MCP endpoint follows the current HTTP MCP authorization profile. OWD is the
protected resource and issues audience-bound tokens after authenticating the
owner with the existing passkey flow. Authorization uses PKCE, state and exact
redirect validation, resource indicators, per-client consent, short-lived
access tokens, and independently revocable refresh grants. OWD never forwards
or accepts another service's token as authority to vault data.

OAuth protocol artifacts live in a dedicated KV namespace, while D1 is the
authoritative application grant store. Each tool call rechecks D1 for client,
audience, vault, path, scope, active-vault state, and revocation. Consent
identifies the client and redirect domain, marks dynamic clients unverified,
and permits exactly one vault with an optional allowed-folder boundary.

Recovery copies do not inherit the target vault's agent authority. Applied
restore paths are denied unless the current D1 grant has an explicit row for
that exact restore. Existing grants have no such rows. SQL filters enforce the
boundary before search or recent-change results are formed; direct reads and
Project source selection recheck it before R2 content is fetched. Approved
results identify the restore source as well as the active target vault.
Restore lineage remains attached to the path across later edits, preventing a
content-hash change from becoming an authorization bypass. It is stored
separately from expiring plaintext restore staging, so normal cleanup cannot
erase the security decision.

A vault-runtime compatibility profile is defense in depth below owner consent.
It can only intersect with and narrow the D1 OAuth folder grant. For Obsidian
Mind, the effective policy excludes the declared memory root, private
frontmatter, configured never-expose filenames, and paths outside the reported
content roots. SQL filters apply it before search or recent-change results are
formed; direct reads and all Project source/citation paths recheck it before R2
content is fetched or a Project becomes joinable. A profile update makes the
library stale until private-note metadata has been reprojected. The descriptor
does not select a Project, mint a scope, approve a request, or widen a grant.

For legacy restores whose plaintext entries expired before the lineage
migration, backfill uses an exact complete source generation when available.
Otherwise it quarantines the verified post-restore target generation, falling
back to the current target generation. This may conservatively classify a
pre-existing target note as restored, but cannot expose a copied note by
guessing.

Existing Project packets are not grandfathered. Before an authorized agent can
read or submit against a packet, every immutable source citation is rechecked
against the source agent grant's restored-content approvals.

The beta lifetime contract uses one-hour access tokens, a 30-day refresh-token
window, a separate 30-day Project grant, and a 90-day dynamic-client
registration. None replaces the D1 authorization check. Refresh restores a
short-lived access token only while the independently checked application grant
remains active; Project expiry or revocation still denies the next tool call.

The owner can inspect last use, revoke one client, or revoke all agent
connections. Logs and audit events record stable outcomes without tokens,
query text, note bodies, excerpts, or raw filenames.

Knowledge-space grants pin the exact evaluated space version and member
vault/path set. A removal is an immediate restriction. An addition or wider
prefix requires a new consent ceremony and cannot be inherited by existing
refresh tokens. Consent and connection management show both the human-readable
space and its exact vault/path boundaries.

Hoplon and other external applications use the same OAuth/MCP path. OWD ignores
their organization membership and never accepts their session, provider token,
service binding, or project identifier as vault authority. The application may
retain its own isolated OAuth client state, but OWD authorizes every content
call from the active D1 grant and revokes at that boundary.

Project grants add explicit `project.read`, append-only collaboration or review
submission, and knowledge/skill proposal scopes. They remain bound to one exact
Project and Knowledge Space version. The source access token is not widened;
the server resolves the Project grant through the active source connection and
the explicit Project ID on every call. Each submission additionally checks
packet identity, record visibility, parent Artifact access, payload bounds,
idempotency, and whether the client is attempting to reference a private or
cross-Project record.

The additive `project.lead` scope permits only lead claim/renew and checkpoint
operations for that exact Project. It does not grant vault reads, record
acceptance, owner Decisions, grant management, or note writes. Each tool call
first rechecks ordinary Project authorization; D1 lease and checkpoint writes
then enforce the current fencing token independently of the adapter.

Every Project collaboration call also reloads the pinned Knowledge Space,
verifies its selector, and requires all member vaults to remain active.
Agent-first grants additionally require the source agent grant and its vault
to remain active. These checks deny legacy grants even if an older revocation
path failed to cascade a stored status update.

Agent-first initialization also pins an owner-approved include/exclude policy
as the Knowledge Space selector. The canonical `.owdignore` receipt contains
the exact `projectId` and is Project-context policy, not a sync exclusion. A
fresh task presents that full manifest to `resume_project`; OWD verifies the
explicit Project identity, live source and Project grants, pinned version, and
selector hash before returning the current Work Packet. Local policy drift
cannot widen server authority and is surfaced as a stable failure rather than
being silently accepted.

An agent may separately have Obsidian CLI, shell, or filesystem access on the
owner's machine. That capability is outside OWD's grant and can bypass the
read-only MCP boundary, so it must never be inferred from Project access. The
managed `AGENTS.md` block requires each agent to inspect the caller-specific
`localVaultAccess` role returned by `resume_project`. The first agent that
establishes a Project for the vault becomes its advisory primary writer; later
agents remain read-only. A same-client restart retains the role; replacing it
with a different authorization is not allowed from the global Agents screen
and remains read-only. The human remains owner, every bounded write still
requires owner instruction, all CLI operations put
`vault=<exact vault name>` first and name the exact path, and ambiguous or
overlapping responsibility stops for owner clarification. This warning is
defense in depth, not an operating-system lock; enforceable OWD-originated note
changes still require the proposal and expected-version path.

Cross-computer Project discovery uses a distinct
`project.connect.request` bootstrap scope. It reveals only bounded summaries of
active Projects whose single-vault Knowledge Space is wholly contained by the
caller's exact vault/folder grant and whose current Project, Work Item, and
Knowledge Space versions remain valid. Routine packet expiry or source-library
change cannot reveal or hide Project metadata; OWD refreshes current context
only after the full authorization and integrity checks. Discovery never returns
private submissions or treats a label, local path, or agent claim as Project
identity.

An existing-Project request pins the selected Project ID, Knowledge Space
version, Work Packet, Work Item, context selector, OAuth client, audience, and
requested scopes. The authenticated owner sees those values before approval,
and the server revalidates them plus the source grant immediately before
atomically issuing a separate Project grant. The agent waits on the same MCP
connection; no second OAuth ceremony or copied completion prompt exists.
Changed or incompatible state fails closed; approval neither creates another
Project nor widens the vault grant.

Agent submissions first enter a private inbox visible to the owner and
producer. **Share with project** is an owner action that makes the immutable
record available to other authorized Project participants while preserving its
untrusted status. Acceptance, Decision, Knowledge promotion, Skill promotion,
and rollback are separate owner actions and cannot be inferred from visibility,
model confidence, review verdict, or evaluation score.

## Pairing and vault authorization

Pairing links contain ten-minute opaque grants, never long-lived sync secrets.
Grant creation requires an authenticated owner session, exact-origin checks,
CSRF protection, and rate limiting. D1 stores the grant hash and the exact
deployment origin. Exchange is rate-limited, accepts only that origin, validates
the plugin/schema contract, and atomically consumes the grant before returning a
new credential once. A wrong-origin attempt cannot consume a valid grant.

The plugin validates HTTPS (with a localhost-only development exception),
origin-only deployment URLs, grant shape, response origin, vault ID,
credential shape, and schema compatibility. It names the vault and deployment
host in an explicit consent prompt and discloses storage and network behavior.
Pairing is initiated only from inside the currently selected vault; the copied
link is never registered as a global operating-system or Obsidian URI handler.
The release excludes `.obsidian`, unrelated settings and credentials,
telemetry, QA controls, and legacy raw-token sharing paths.

Long-lived vault credentials are stored only as hashes in D1 and are
independently revocable. A credential is accepted over HTTPS only to mint a
five-minute HMAC-signed WebSocket ticket bound to its credential and vault.
Admission checks the ticket and current D1 revocation state before reaching the
Durable Object, and strips the ticket from the internal request URL. Revocation
also closes active sockets with policy code `1008`.

## Content safety

- Require NFC paths before authorization and storage; do not silently repair
  hostile or ambiguous input.
- Reject traversal, absolute and drive-root paths, backslashes, repeated or
  empty segments, control/format characters, Windows-reserved names and
  characters, trailing dot/space segments, oversized paths, and canonical
  case collisions.
- The current editor accepts only Markdown and denies the entire `.obsidian`
  namespace.
  Later backup support may introduce a separately reviewed configuration
  allowlist; browse/materialization must not inherit it automatically.
- Display Markdown as inert text. Any future rendered view must use a
  deny-by-default HTML and URL policy with a hostile-content regression corpus.
- Proxy or block remote embeds by policy; do not leak the user's IP or referrer unexpectedly.
- Serve attachments with safe content types and download disposition where inline rendering is risky.
- Label all MCP note content as untrusted data, never as instructions. Keep the
  tool catalog narrow, excerpts and pages bounded, and `.obsidian` plus owner
  exclusions unavailable to the agent.
- Disclose that once an authorized client sends content to its model provider,
  OWD cannot enforce that provider's retention or training policy.

Materialized note objects use fresh generation/content-hash keys with no raw
filename. R2 objects are written before D1 publication and are never
overwritten. D1's current-generation pointer is the only read barrier. Failed
or interrupted generations may leave unreachable immutable objects or staged
rows, but cannot replace a prior current generation. Owner authentication is
required for status, browse, search, and streamed note reads; publication also
requires exact-origin CSRF verification and an active vault.

Live note reads require the owner session and return inert Markdown plus an
opaque version token. Live writes additionally require exact-origin CSRF,
per-vault rate limits, schema v3, decoded UTF-8 size bounds, and the same path
policy as materialization. A null expected version is create-only; a non-null
version is update-only. Web writes never rename, delete, revive tombstones,
touch attachments, or write `.obsidian`. The per-vault Durable Object applies
the Yjs transaction and confirms persistence before acknowledging it.

Agent-originated writes are not direct live writes. A future proposal is bound
to the client, grant, vault, canonical path, base identity/version, content
hash, and expiry. Approval requires an owner browser session, origin/CSRF
checks, and policy-selected passkey step-up. The proposing credential is never
an approval credential, and stale proposals fail before the Yjs mutation path.

Accepted memory and skill records carry source provenance, confidence, review
state, expiry or supersession, and immutable version history. Unaccepted
proposals are never returned as trusted shared defaults. A skill is inert
Markdown guidance and cannot add scopes, grant folders, invoke arbitrary URLs,
or bypass an agent client's own permission system.

Skill evaluation cases are versioned separately from the candidate under test.
The candidate cannot edit its own approval criteria, auto-promote on a score, or
replace the prior stable version. Promotion, quarantine, deprecation, and
rollback are owner-authorized events. A Hoplon Project or model comparison may
produce evaluation evidence but is not an OWD approval authority.

## Encryption and backup keys

Use a well-reviewed age/X25519 implementation and version the envelope format.
The browser generates the private identity and exposes it only through a
timestamped local download; it does not invoke a native save-location API.
Setup stays locked until the owner reselects a non-empty downloaded file whose
derived public recipient matches. Only that recipient and its SHA-256
fingerprint reach D1. The identity remains in ephemeral browser state only
while the owner validates or stages a restore.
Recipients are configured by the owner; the service does not invent
recoverability it cannot provide. Never log key material. Test decryption and
manifest verification using synthetic fixtures before enabling retention
cleanup. Backup creation is bound to the fingerprint the browser just verified,
and recipient rotation is transactionally blocked while a backup or snapshot
is actively publishing.

The `owd-snapshot-v2` design may split one logical snapshot across encrypted
content objects. A new object receives randomized authenticated encryption and
is verified before publication. An identical object may reference that exact
verified ciphertext within the same owner/recipient boundary; OWD does not use
convergent or deterministic encryption. The encrypted manifest binds every
object's plaintext hash, ciphertext integrity metadata, logical section, and
snapshot membership. Recipient rotation creates a new encryption boundary and
cannot silently reuse ciphertext addressed only to the prior identity.

Restore input is hostile even after successful age decryption. Revalidate the
manifest, canonical Markdown path policy, counts, byte lengths, UTF-8, and
SHA-256 values at both browser and Worker boundaries. A preview captures target
content hashes; apply fails closed if a target path changed afterward. Exact
vault-name confirmation and a separate cross-vault-ID acknowledgment prevent
an implicit current-vault choice. V1 is an overlay and has no delete operation.
Plaintext restore staging expires after 24 hours; an hourly single-claimer
reaper deletes abandoned R2 objects, while successful apply deletes each object
immediately after its Durable Object persistence receipt.

## Managed-service boundary

The future managed control plane stores customer account, entitlement,
deployment version, resource identifier, quota, billing, and redacted health
metadata. It must not receive vault names, note paths or bodies, search terms,
passkey assertions, session values, OAuth tokens, vault credentials, socket
tickets, or backup private identities.

Provisioning credentials are narrowly scoped, stored outside customer cells,
rotated, and unavailable to data-plane code. Data-plane bindings are fixed at
deployment; requests do not dynamically select a database or bucket from a
hostname header, URL parameter, token claim, or owner-supplied tenant ID.
Administrative access uses an explicit, time-bounded, audited break-glass path
and never manufactures an owner session.

Noisy-neighbor and cost isolation are security properties. Each cell has
bounded storage, request, sync, MCP, materialization, backup, and recovery
usage. Logs and metrics identify a pseudonymous cell and stable outcome without
content. Export and deletion enumerate every cell resource, verify completion,
and retain only the minimum billing or security record required by a published
policy.

## Logging and audit

Structured logs may include request ID, route template, status, latency, vault pseudonym, generation ID, and stable error code. They must exclude note bodies, raw filenames by default, query text, cookies, authorization headers, WebAuthn payloads, grants, tokens, and keys.

Automatic invocation logs are disabled for this Worker so raw request URLs do
not bypass the route-template logger. Private note paths, search strings, and
pagination cursors are carried in authenticated request bodies. Custom error
events record only bounded error classes and stable codes.

D1 audit events record security-relevant actions without sensitive payloads:
claim, credential creation/revocation, pairing, live note creation/update,
agent authorization/revocation, snapshot intelligence selection, approved or
quarantined restore, post-restore unvetted review, backup, restore, and
configuration changes.

## Availability and abuse controls

Rate-limit claim, authentication, OAuth registration/token exchange, pairing
exchange, search, export, and recovery endpoints. Bound request sizes and Yjs
update sizes. Stream large objects. Use idempotency keys and resumable job
state for long operations.

Rate-limit MCP initialization and every tool per client and grant. Bound
results, pages, bytes, execution time, and concurrent requests; reject
unbounded vault dumps and record repeated denials as redacted audit events.

## R3 elastic Run security and privacy

The elastic profile is opt-in and remains below the exact Project, Work Item,
Work Packet, Knowledge Space, source-grant, lead-lease, and fencing-token
boundaries already enforced for R2. It permits 32 active and 64 total actor
records per Run, 16 actor registrations per batch, 8 bundle submissions per
batch, and 100 records per delta page. These are hard contract ceilings, not
deployment-wide authority. Solo clients use the unchanged R2 snapshot path;
there is no swarm-only ceremony or implicit capability upgrade.

Batch mutations are atomic at the durable record boundary and carry an
idempotency key plus canonical request hash. An exact replay returns its prior
receipt. A key reused with a different payload is `idempotency_conflict`, never
a second append. Capacity exhaustion is explicit bounded backpressure with
retry metadata; OWD does not accept a client-supplied schedule, execute retries,
or supervise provider processes. Cursor deltas are opaque, expiring, and bound
to the exact grant, Project, Run, query, and sequence; cross-Run or altered
cursors fail closed.

Actor recovery records an expired or abandoned predecessor and a newly issued
replacement with a strict subset of scopes. The predecessor remains expired or
revoked. Recovery does not restore a grant, lease, actor bearer token,
credential, vault/folder scope, or protected-path authority. Revocation and
fence checks occur again at commit time, including when a batch races a lead
takeover.

Logical-unit and cost-microunit budgets are harness-reported durable evidence.
An exhausted limit creates a blocking `budget-exhausted` Exception; OWD never
estimates provider charges or treats a claimed cost as billing truth. Aggregate
observations contain counts, retry/rejection totals, bounded p50/p95 latency,
and timestamps only. They must not contain raw transcripts, hidden reasoning,
terminal history, credentials, OAuth state, provider runtime, or
production/customer logs. Structured logs remain pseudonymous and redact
worktree paths, branch names, commit metadata, session identifiers, and all
content by default.

The Orca adapter accepts only bounded, inert worktree/branch/commit/PR/session
references attached to a generic Run or Actor. Orca state is not an identity,
authorization, scheduler, runtime, or recovery source. OWD does not invoke
Orca, import its conversations or terminal history, or inherit its permission
settings. If Orca disappears, a non-Orca lead must use the generic Run
snapshot/delta with fresh authorization; no Orca authority is reconstructed.

R3 records have hot/warm/cold/quarantine retention metadata. Cleanup is
delayed, bounded, idempotent, and reference-aware; it protects retained
snapshots/exports, open Run/Exception dependencies, and the last known-good
recovery point. Portable restore keeps R3 rows owner-only/quarantined with
both authority flags false and inserts no live policy, actor, bundle, budget,
lease, receipt, credential, OAuth, or grant rows.

## R4 policy-autopilot and continuity security

Only an owner session with CSRF protection can activate the immutable binding
or resolve an explicitly permitted Exception. The binding names the exact
active Project version and exact owner-authored policy/evidence hashes; the lead
cannot author, approve, or edit the policy that judges its work. Every
evaluation revalidates those canonical bodies and consumes only bounded
accepted evidence, Decisions, and Continuity Points. Model confidence, hidden
reasoning, transcripts, terminal history, credentials, provider runtime, and
customer or production logs are not gate inputs.

Authority expansion, policy editing, self-approval, destructive action,
protected paths, conflicting or missing evidence, budget exhaustion, integrity
failure, and unsupported upgrade or rollback fail closed as Exceptions or
owner-only actions. An allow is committed only after rechecking the exact
Project, Run, bundle count, Continuity Point, grant, source grant, vault, lease,
expiry, and fence. Scheduled events emit bounded idempotent requests only; they
do not supervise agents or invoke providers. Drill completion requires the
exact scheduled request and source Continuity Point under a distinct current
replacement lead fence.

Partial integrity coverage is degraded. Retention protects the latest and last
complete known-good integrity reports plus referenced operational bodies.
Portable export is bounded and dependency-complete. Restore inserts only
quarantined operational base records and no grant, lease, actor, credential,
OAuth, policy, scheduler, receipt projection, or other live authority. Receipt
redaction structurally excludes filenames, hostnames, raw bodies, credentials,
OAuth state, transcripts, hidden reasoning, terminal history, provider runtime,
customer data, and production logs.

## Required security tests

Lead-continuity coverage includes simultaneous claims, expiry and revocation
takeover, stale fencing tokens, checkpoint idempotency conflicts, cross-Project
Decision/Artifact references, stale packets, missing evidence, malformed and
oversize bodies, legacy-client compatibility, encrypted restore with zero
authority rows, and a fresh replacement claim after restore.

Hands-off lead coverage additionally requires exact Project/Run/Work Item
matching; commit-time grant, source-grant, vault, lease-holder, expiry, and
fence checks; actor scope and expiry denial; replay versus payload-conflict
separation; Run-shared visibility isolation; malformed and byte-oversize bundle
denial; same-Run independent review routing; actor and byte budget Exceptions;
protected-root normalization; explicit non-execution of authority expansion
and destructive requests; conflicting-claim preservation; checkpoint-before-
completion; and snapshot restore with quarantined bodies but zero live policy,
Run, Actor, bundle, Exception, receipt, grant, or lease projections.

R3 coverage additionally requires allowed and denied cases for 20-plus actors
and solo parity, actor/bundle batch ceilings, stable cursor ordering and
cross-Run denial, exact replay versus payload conflict, bounded backpressure
and retry metadata, logical/cost budget exhaustion, expired/abandoned actor
replacement, revocation/fence races, retention reference safety, malformed or
oversize metadata, aggregate-observation redaction, Orca metadata boundaries,
Orca-state loss with non-Orca resume, old-client R2 compatibility, and
restored-authority denial. A local synthetic pass does not close the human
authorized live disposable exercise.

R4 coverage additionally requires research and coding allow/deny truth tables;
self-approval and policy-edit denial; cross-Project and cross-Run isolation;
revocation/fence races; malformed, oversized, missing, conflicting, or tampered
evidence; exception-only resolution; scheduled replay, overlap, and
backpressure; exact RPO/RTO/age/quality calculations; receipt redaction; lead
replacement; fresh Community restore with zero authority; partial-integrity
failure; last-known-good retention; dependency-complete export; forward-only
upgrade/application-only rollback evidence; old-client compatibility; and an
exact-request drill completion under the replacement fence.

- Claim race and post-claim rejection.
- WebAuthn challenge replay and origin/RP mismatch.
- CSRF and cross-origin mutation rejection.
- Cross-vault credential denial.
- Pairing expiry, replay, concurrent exchange, exact-origin binding, and
  revocation of current and pre-issued access.
- Plugin rejection of malformed links/responses and cancellation before any
  network request or settings change.
- Path traversal and `.obsidian` policy corpus.
- Malicious Markdown/XSS corpus.
- Partial R2/D1 materialization failure with prior-generation preservation.
- Alarm interruption/retry, bounded progress, and atomic publication for a
  multi-batch materialization.
- Browse, search, and note-stream generation consistency.
- Live-edit authentication/CSRF, stale identity rejection, restart durability,
  tombstone non-revival, and YAOS round-trip preservation.
- Backup tamper and wrong-key failure.
- Restore interruption and idempotent retry.
- Redaction checks for logs and error responses.
- OAuth native-limit denial, exact daily-budget saturation, and fail-closed
  limiter errors.
- OAuth discovery, PKCE, state, redirect, audience/resource-indicator, refresh,
  expiry, client impersonation, and immediate D1 revocation tests.
- Cross-client, cross-vault, excluded-folder, insufficient-scope, and restored-
  grant denial for every MCP content tool.
- Prompt-injection fixtures proving vault text remains inert tool data, plus
  tool-loop, output-bound, and rate-limit tests.
- Proposal self-approval, stale-base, replay, expiry, and memory/skill poisoning
  tests before any agent mutation capability is released.
- Knowledge-space removal, addition-without-reconsent, version confusion,
  cross-space cursor, and renamed-label identity tests.
- Cross-Project and private-submission denial, packet/source version confusion,
  idempotent retry, duplicate-key payload mismatch, record replacement,
  backdating, parent-Artifact visibility, and oversize submission tests.
- Sharing-versus-acceptance confusion, producer self-sharing, agent Decision,
  false verified-model labeling, cross-client correction, quarantine recall,
  and restored-authorization denial tests.
- MCP-versus-portable-file contract parity, hostile bundle/path handling,
  Obsidian projection stale-target protection, partial projection publication,
  and owner-edit preservation tests.
- Post-revocation packet denial plus explicit already-exported-data disclosure;
  inherited-visibility, attempted implicit declassification, projection-loop,
  missing historical library object, and external-reference non-fetch tests.
- Snapshot default-selection, approved-only, approved-plus-unvetted,
  unvetted-without-approved denial, exact section/count/byte receipts,
  dependency closure, older-reader fail-closed, quarantine-only restore, no
  proposal resumption, no stable-skill activation, no client reauthorization,
  and post-restore owner re-review tests.
- External-client Project/organization claim rejection, connection-owner
  removal, callback/token redaction, prompt-injection, fixed-evidence, and
  immediate two-sided revocation tests before the Hoplon connector leaves a
  private disposable-vault pilot.
- Skill evaluation-case tampering, self-promotion, malicious score, quarantine,
  downgrade, rollback, incompatible-client, and restored-state tests.
