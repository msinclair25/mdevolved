# D1 migrations

Migrations are append-only after release and are applied in filename order.

Local:

```sh
pnpm wrangler d1 migrations apply owd-platform-db --local
```

Remote migration is an explicit production action and is never part of `pnpm build`:

```sh
pnpm db:migrations:apply
```

`pnpm db:migrations:apply` targets the stable `DB` binding rather than a
database name. Deploy to Cloudflare may provision a differently named database
for a new owner and write its identifier into the cloned Wrangler
configuration. The binding keeps the migration target exact after that
provisioning step.

The public installer runs the complete ledger before it deploys the matching
Worker:

```sh
pnpm deploy
```

`pnpm deploy` stops if migration application fails. Cloudflare must not
activate the new Worker after a partial or failed ledger. A maintainer deploying
from an unbuilt local checkout uses `pnpm deploy:manual`; normal owners never
run either command.

## Browser bootstrap

`0002_owner_authentication.sql`, `0003_vault_pairing.sql`,
`0004_pairing_origin.sql`, `0005_materialized_generations.sql`,
`0006_agent_access.sql`, `0007_encrypted_backups.sql`, and
`0008_snapshot_recovery.sql` and `0009_snapshot_archiving.sql` are additive and
idempotent. The Worker imports and applies those same files when their tables
are absent, allowing a new template deployment to complete first-owner claim,
vault pairing, first materialization, first agent consent, encrypted backup
setup, and snapshot-first recovery setup without a terminal. Applying the full
Wrangler migration ledger afterward is safe and remains recommended for
operational visibility.

The collaboration and managed-release ledger from
`0010_phase9a_collaboration.sql` through
`0029_vault_primary_writer_transfer.sql` is different: these migrations are release
prerequisites and are never imported or applied by production request handlers.
Apply the reviewed ledger before deploying the matching Worker. CI runs
`pnpm test:migrations` against the full empty ledger and populated
prior-release fixtures.

Local SQLite execution is not sufficient evidence that Wrangler will transport
a migration to remote D1 correctly. The first managed-cell rehearsal found
that Wrangler's SQL splitter removed the terminating delimiter from a
`CREATE TRIGGER` statement and remote D1 rejected it with `incomplete input`.
`pnpm check` now runs every migration through Wrangler's actual splitter and
rejects that shape. A release that adds or changes migration grammar must still
pass a fresh remote empty-D1 rehearsal before a tester invitation is installed.
See the [public quality gates](../docs/QUALITY-GATES.md).

`0009_snapshot_archiving.sql` adds one idempotent presentation-only archive
table. Browser bootstrap applies it with the other snapshot schema whenever the
table is absent.

The browser bootstrap does not mark a Wrangler migration as applied and does
not replace the ledger. It creates only the earlier Phase 2 through Phase 8
tables when absent. OAuth protocol records are independently created by the
provider in the dedicated `OAUTH_KV` binding.

## Recovery

Before a production schema change, create a D1 backup or export appropriate to
the deployment. If Phase 2 bootstrap is interrupted, retrying is safe because
every schema statement uses `IF NOT EXISTS`; an owner is not created by schema
bootstrap. If a first-owner transaction fails, D1 rolls back the owner, session,
and audit insert together. If schema integrity is damaged, restore the database
backup rather than editing a released migration.

The Phase 4 bootstrap is also retry-safe. Pairing exchange consumes its grant,
creates the hashed credential, activates the vault, and writes the audit event
inside one D1 batch transaction. Rolling application code back leaves these
tables untouched; do not drop them as a rollback mechanism.

Phase 5 bootstrap is additive and retry-safe. A generation is staged before R2
or projection writes and is visible only through `current_materializations`
after one final atomic D1 batch. If deployment or storage fails, retry with a
new generation; do not repoint the table manually. Roll application code back
without dropping Phase 5 tables or deleting R2 objects. The prior current
generation remains the recovery path. Orphan reclamation requires a separate
retention review and must never delete the only published generation.

Phase 6.5 bootstrap is additive and retry-safe. Consent rows are single-use and
session-bound. An interrupted OAuth issuance leaves the matching D1 grant
pending or revoked, so every MCP tool fails closed. Roll application code back
without deleting D1 grant history or OAuth KV records; the absent MCP route
makes those artifacts inert. Dashboard revocation changes D1 first, making the
next tool call fail even if best-effort KV cleanup must be retried.

Phase 9B restored-content authorization is additive and fail-closed. Existing
agent grants receive no restore-source approvals. Notes whose paths descend
from an applied recovery restore remain outside MCP search, recent changes,
reads, and Project initialization until the owner reconnects the agent and
selects the exact named restore source. Roll application code back only to a
version that enforces the same boundary; older code treats restored paths as
ordinary target-vault content. Durable `restored_note_lineage` rows survive
normal plaintext restore-entry cleanup; cleanup must never erase authorization
provenance. Upgrade backfill prefers exact applied entries, then a complete
retained source generation. If both are gone, it conservatively quarantines the
verified or current target generation so a cleaned legacy restore fails closed
instead of guessing which paths were copied.

The onboarding-lifecycle migration is additive and backfills the last
published generation as the freshness baseline for an already active vault.
New pairings remain unready until the matching plugin proves that its local
state reached the vault Durable Object. Every later live-state change marks
the searchable library stale until a generation for that exact state vector
publishes. Project initialization token aliases preserve transport retries
without creating a second Project; they do not authorize a different semantic
request. Rolling back to code that ignores these rows removes those guarantees
and is not an acceptable response to a cross-vault or duplicate-Project
incident.

The Project-connection hardening migration adds the immutable packet-rotation
ledger used to converge concurrent automatic refreshes, a bounded cleanup queue
for losing R2 writes, and short approval leases that recover after a Worker
crash. Packet rows are foreign-key bound to their prior and successor records
and exact active Project versions. Retry the migration safely if deployment is
interrupted. Application rollback may leave all three additive tables and their
indexes in place; never delete packet records, rewrite rotation rows, or revive
an expired approval lease to force an older Worker to run. Restore the
pre-change D1 backup if the ledger itself is damaged.

The Project-creation identity migration adds a vault-wide reservation for each
case-insensitive Project name. Separate agents retain separate consent requests,
but only one request can become the creator and only its durable creation
receipt can bind the shared identity. Concurrent or later approvals may issue
their own exact grants only against that bound Project; they cannot create
another Project with the same identity. The additive upgrade backfills
agent-created Projects and pending requests without deleting or merging
historical duplicates. Rollback may leave the reservations inert, but returning
to code that ignores them reopens the duplicate-creation race and is not an
acceptable production rollback.

The shared Project-creation commit migration extends that identity fence to
every creator, including the owner dashboard. The normalized vault/name key,
immutable creation payload, Project, Work Item, and packet commit in the same
D1 transaction as the Project. A losing concurrent creator recovers the exact
winner only when every pinned identity and payload matches; otherwise it fails
closed. Legacy bound agent Projects are backfilled without guessing their R2
payload hash. Do not roll application code back to a creator that omits this
fence.

The agent-grant continuity migration records an explicit predecessor/successor
edge only for equivalent OAuth grant rotation. Pending Project consent and
durable Project authorization may follow that exact lineage without a new
owner link. A normal explicit revoke has no successor edge and remains final.
The table is additive; do not manufacture replacement rows to revive revoked
access.

The Project agent-visibility migration defaults existing Projects to
`discoverable` and lets the authenticated owner set an exact Project to
`owner-only`. Owner-only Projects stay in the owner dashboard but are excluded
from agent discovery, exact lookup, authorization repair, and collaboration
use; hiding one also revokes its active Project grants and expires pending join
requests. Rollback to code that ignores this column would reopen an information
boundary and is not an acceptable production rollback.

The vault-primary-writer migration adds one advisory local-writer identity per
vault. Existing approved Project history backfills deterministically; after the
upgrade, owner approval atomically assigns the first Project client with
`INSERT OR IGNORE`, so concurrent or same-second approvals cannot produce two
writers. The row grants no OWD mutation scope or owner authority. Application
rollback may ignore the additive table, but doing so removes the
machine-readable local-write warning and is not an acceptable production
rollback while multiple locally privileged agents are connected.

The vault-runtime-profile migration adds a nullable, validated-at-the-
application-boundary compatibility descriptor to each synchronized vault and a
projected private-note flag to each materialized Markdown note. Existing vaults
and notes remain unprofiled/public until a compatible plugin reports a profile
and completes a fresh library build. Profile facts may only narrow an existing
OAuth grant; they never grant access or supply Project identity. Do not roll
application code back while profiled vaults depend on the server-side
`memories/`, private-frontmatter, or never-expose filtering.

The prepared-Project-handoff migration adds single-use owner authorization for
the normal first Project connection. Each prepared row is bound to one active
agent grant, vault, normalized folder boundary, and normalized Project label.
Only one prepared or in-flight handoff may exist per vault. A matching
`open_project` request may consume it once; mismatches and later Projects retain
the exact owner-approval path. Revocation closes the handoff, and OWD content
snapshots never restore it. Application rollback may leave the additive table
intact, but the prepared row will be ignored and the existing approval flow
will fail closed.

The vault-primary-writer-transfer migration preserves the append-only history
for deployments that used the former vault-wide writer-transfer action. The
current Worker reads those rows for provenance but exposes no new global
transfer action. A same-client session restart keeps continuity through
`resume_project`; a different authorization remains read-only. Never
manufacture a transfer row or update the assignment manually. Any future
responsibility handoff must be explicitly Project-scoped.

Phase 7 bootstrap is additive and retry-safe. Only the public age recipient is
stored in D1; the recovery identity is never server-held. Backup rows remain in
`creating` until the encrypted R2 object has been written and verified. Retry a
failed backup with a fresh artifact ID. Roll application code back without
dropping backup history or deleting ready objects. Retention must never remove
the last known-good artifact for a vault. Restore jobs stage path-validated
notes under random R2 keys, apply bounded overlay batches through the Durable
Object, and become `applied` only after a new materialization is verified.
Interrupted `staging` or `applying` jobs are retryable; do not rewrite their D1
state manually.

Phase 7C bootstrap is additive and retry-safe. Snapshot membership and exact
source generations are fixed before encryption. Rows remain `creating` until
every randomized or reused ciphertext object and the encrypted manifest have
verified R2 receipts. Roll application code back without dropping the Phase 7C
tables or deleting R2 objects. Retention first queues unreferenced object keys
in `snapshot_gc_objects`, then removes D1 membership; bounded deletion may be
retried until the queue is empty. Never manually unpin, delete the newest
verified point, or remove an object still referenced by `snapshot_entries`.
Migration `0009_snapshot_archiving.sql` does not change that recovery graph.
Application rollback may ignore its table; do not drop it or rewrite the
migration ledger. Archive/unarchive through the supported owner API.

The Phase 9A migration is additive and retry-safe. Collaboration records and
owner events are append-only; exact bodies and evidence are immutable R2 objects.
Snapshot intelligence is published only after every selected object is
owner-key encrypted and verified. Restore stages authenticated portable objects
before one explicit owner confirmation, forces Approved roots to owner-only
visibility, forces Unvetted records to quarantine, and never recreates grants
or OAuth state. Roll application code back without dropping the Phase 9A
tables, rewriting events, or deleting collaboration/snapshot R2 objects. Use
the forward-recovery procedure in `docs/BACKUP-RECOVERY.md` for incompatible
record or capability failures.

The beta-hardening migration adds a partial index over immutable
`historical_grant_id` provenance, durable materialization/GC job tables, and a
nullable restore-to-materialization job reference. Rollback may leave all
additive objects and the nullable column in place. Never rewrite older grant
identities, drop job history, or delete staged/immutable R2 objects to force a
rollback.

The invited-owner migration is additive and leaves Community installations in
their existing open first-owner mode because no configuration row is installed
there. A managed cell remains fail-closed until its operator installs the exact
hostname and an unexpired invitation digest. Managed owner creation rechecks
and consumes that invitation inside the same transactional D1 batch as owner
and session creation. Application rollback leaves these tables intact; reissue
a fresh digest rather than reviving an expired or consumed invitation.
