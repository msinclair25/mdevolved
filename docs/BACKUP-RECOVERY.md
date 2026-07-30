# Encrypted backup and staged recovery

> **Production boundary:** `owd-snapshot-v2` is the primary deployed
> multi-vault recovery path. `owd-backup-v1` remains available under Advanced
> as a supported legacy
> single-vault recovery path.

OWD backup artifacts are independent of live YAOS synchronization and the
searchable D1/R2 materialization. Each artifact names one already-published
materialization generation and is encrypted as a standard age/X25519 file.

## Owner workflow

1. In **Backup & restore**, choose **Back up a vault**, then **Create recovery
   key**. Backup setup and emergency restore are separate in-place tasks; only
   the chosen task is shown. OWD explains that an encrypted backup plus its
   matching private `.txt` key are both required for recovery.
2. Choose **Download recovery key** for the timestamped
   `owd-recovery-key-*.txt` file. OWD uses the browser's normal Downloads flow
   and does not invoke a native save-location API. It shows the prepared
   filename and non-zero byte count, but a download request alone is never
   reported as a successful save. Store a second copy in another private,
   recoverable location. OWD cannot view, replace, or recreate the file.
3. Locate and reopen that exact file in OWD. This separate owner action proves
   the downloaded bytes are accessible outside the page that generated them.
   The browser validates the non-empty file, derives its public lock locally,
   and refuses activation unless it matches the key just created. Only the
   public `age1…` recipient is submitted to OWD.
4. Before creating a backup in a new browser session, choose the saved key
   again. OWD verifies locally that it matches the configured public lock; the
   private file contents are never uploaded. Backup creation stays disabled
   until this proof succeeds.
5. Select the exact vault, then choose **Create backup**. OWD safely confirms a
   fresh library in the same operation; a direct API caller also cannot encrypt
   a stale generation. The create request is bound to the fingerprint of the
   public key just verified, and that key cannot rotate while the artifact is
   being encrypted.
6. Download the resulting `.age` artifact. The verified copy also remains in
   the deployment's R2 bucket.

Creating a replacement key does not re-encrypt old artifacts. Retain every
older recovery key while a backup encrypted to it remains in the recovery set.
The dashboard shows a public-key fingerprint on each artifact so a matching
key can be identified without exposing it.

The backup archive remains owner-downloadable after a vault's sync credential
is revoked. Revocation does not reactivate that vault or permit a restore into
it; choose a separately active target for recovery.

## Artifact format

The decrypted `owd-backup-v1` byte stream contains:

1. the ASCII line `OWD-BACKUP-V1`;
2. one bounded JSON manifest line; and
3. each UTF-8 Markdown body in canonical, case-folded path order, with byte
   boundaries and SHA-256 values supplied by the authenticated manifest.

The manifest includes the backup ID, source vault name and ID, source
materialization generation, note metadata, included and excluded sections, and
reserved future sections. V1 includes Markdown notes only. It explicitly
excludes OAuth records, sessions, pairing codes, agent grants, pending agent
proposals, and unknown Obsidian plugin data. Attachments, a reviewed `.obsidian`
allowlist, accepted memory, skills, provenance, and policy remain reserved
until their own schemas and recovery tests exist.

The deployed primary v2 manifest supports Approved and Unvetted Intelligence
capabilities for the current Project, Handoff, Review, Decision, provenance,
and policy records described in
[`PORTABLE-INTELLIGENCE.md`](PORTABLE-INTELLIGENCE.md). Each record type is
activated only with versioned schemas, referential-integrity checks, encrypted
export fixtures, and isolated restore coverage. Future durable Knowledge,
Skills, and Evaluations remain gated. Harness conversations, credentials, and
live grants remain excluded permanently.

Snapshot creation selects **Approved Intelligence** by default and offers
**Unvetted Intelligence** as a nested, off-by-default selection. Unvetted
cannot be selected alone. Approved closure
includes its exact inert dependencies; Unvetted contents restore only into
owner-visible quarantine, with no sharing, recall, proposal resumption, stable
Skill activation, or client authorization. The timeline, manifest, portable
index, and restore preview identify the selected classes and their separate
counts/bytes. Production remains on the legacy capability set until a later
explicit migration and deployment boundary.

The Worker streams verified source objects through age encryption and a
fixed-length backpressured stream into an immutable R2 key. It never holds the
full vault plaintext or ciphertext in memory. A D1 artifact remains hidden in
`creating` state until R2 size, version, and ETag checks pass.

## Primary v2 snapshot workflow

1. Save and reopen the owner recovery key as described above. The private
   identity remains in the browser; D1 stores only the age recipient and its
   SHA-256 fingerprint.
2. Choose **Create snapshot**. The default scope fixes the complete active-vault
   membership at capture start. A deliberately narrower selected-vault scope
   is under **Advanced** controls.
3. OWD asks every fixed member to publish a fresh verified library generation.
   This is a coordinated capture window, not an instantaneous transaction. If
   one member is unavailable, the entire snapshot fails before any partial
   recovery point is published. The server repeats this freshness check at the
   snapshot boundary, so a direct API caller cannot capture a stale library.
4. The browser continues the bounded job while OWD encrypts new content
   objects. Identical content may reference a previously randomized, verified
   ciphertext object only inside the same recipient and section boundary.
   Every manifest remains logically complete and independently restorable. If
   the browser closes or a request stops, **Continue capture** resumes the same
   fixed snapshot from its timeline entry.
5. Publication occurs only after every reachable object and the encrypted
   manifest have matching R2 size, ETag, version, and integrity receipts. The
   timeline then shows the capture window, exact source generations, changed
   items, logical bytes, newly stored bytes, encryption/integrity state, pin
   state, and a short timestamped reference.
6. **Download encrypted copy** streams a provider-neutral `.owdsnapshot`
   container. The timeline immediately identifies the exact requested filename,
   checked timestamp, and short snapshot reference beside the action; this
   confirms a browser download request, not a successful save. The container
   holds an encrypted manifest plus each referenced encrypted object and
   requires no D1 ID, R2 key, Worker hostname, Cloudflare account, or source
   service to recover.

The configured recovery recipient cannot change while a backup is encrypting
or while a snapshot is creating or importing. Re-saving the same recipient is
idempotent. The owner can cancel an incomplete capture from its timeline, after
which a new recipient may be configured. Cancellation never changes a ready
recovery point; failed artifacts enter delayed reference-aware cleanup.

The production sync capability currently supports Markdown only. Accordingly,
created v2 manifests include `notes` and explicitly mark `attachments` and
`obsidian-allowlist` unavailable. OWD does not claim a complete restore while
silently skipping either section. Synthetic fixtures prove encryption,
decryption, hashing, byte boundaries, and path round trips for Markdown, a
binary attachment, and `.obsidian/appearance.json`; enabling real attachment or
allowlisted-configuration capture and write-back requires the corresponding
reviewed live capability.

The current searchable **library** is rebuildable and distinct from recovery
history. A refresh stores unchanged note bodies once by verified digest, keeps
only the current generation's FTS rows, and still rewrites a missing or corrupt
derived object from canonical live state. Historical reads use snapshot
manifests and encrypted objects, not retained search indexes.

### v2 named restore and portable import

1. Choose **Restore** on one timeline entry, or **Open encrypted copy** to use a
   downloaded `.owdsnapshot` from another installation.
2. The portable-file path shows the exact selected filename and byte count.
   Choose the matching recovery key. The browser validates the public index,
   unknown required capabilities, encrypted manifest, every byte boundary, age
   authentication tag, content hash, object membership, and source-vault
   inventory before uploading plaintext. After validation, the filename,
   capture timestamp, source-vault and item counts, and short reference remain
   visible throughout mapping, preview, and apply.
   Production acceptance performs this from a fresh browser session so an
   in-memory value cannot substitute for the owner's durable key file.
3. Map every snapshot-scoped source vault to an explicit, distinct active
   target. Targets begin blank; there is no implicit "current vault" choice.
4. A second authenticated pass stages every Markdown note into the existing
   isolated restore namespace. OWD refreshes each exact target and presents
   added, changed, unchanged, and zero-deleted counts for every mapping. The
   browser polls the durable read-only library job instead of repeatedly
   invoking preview/apply mutations.
5. Type each exact destination name. OWD confirms all previews before applying
   bounded overlays sequentially through the respective Durable Objects. A
   retry reuses staging and apply progress instead of creating duplicate notes.
6. Each target publishes a fresh verified library. Target-only notes survive;
   credentials, pairing authority, sessions, and agent grants remain disabled.
   When every mapping is applied and verified, OWD focuses and centers the
   checked completion card so the shorter final layout cannot leave the result
   outside the current scroll position.

If a portable copy contains an optional section that this installation can
authenticate but cannot safely write, restore fails closed before staging and
names the unsupported section. Successful import/restore requires only the
artifact, matching owner key, compatible format capabilities, active targets,
and explicit mappings—not source connectivity.

### Retention, integrity repair, and scheduling

Automatic retention is off by default. Its control stays disabled until the UI
shows logical size, likely new content, reusable-object count, and currently
retained encrypted bytes. When the owner enables it, OWD keeps the configured
recent history, every pinned point, at least two ready points, and the newest
verified recovery point. Deletion first records every now-unreferenced R2 key,
then removes D1 membership; bounded garbage collection is idempotent and safe
to resume after interruption. A 24-hour queue grace and a final D1 reference
check precede every R2 deletion. Shared ciphertext is deleted only after no
retained manifest references it. Failed/cancelled snapshot records remain
visible, but their stale generation and object references are released by the
scheduled cleanup after grace.

**Archive** removes a completed or failed snapshot from the primary timeline
and places it in collapsed archived history. **Return to current** reverses that
presentation choice. Neither action changes encrypted objects, restore or
download availability, pin state, integrity, or retention eligibility.
Unpinned archived snapshots may still be removed by an enabled automatic
retention policy. The current alpha does not expose permanent per-snapshot
purge.

An integrity check that finds a missing encrypted manifest, vault-content
object, or intelligence object marks the snapshot degraded and disables
restore/download. **Repair** rebuilds the manifest from authenticated D1
membership or creates fresh randomized ciphertext from the retained canonical
library/collaboration object, relinks every affected entry, and reports
verified only after a complete scan. If an object's canonical source is also
missing, repair and download fail closed while older ready recovery points stay
unchanged.

Snapshot capture remains manual. There is no scheduled trigger, overlap queue,
or implied background recovery point in the current alpha.

### Format fixtures and compatibility

The checked-in public fixtures are
`packages/contracts/fixtures/owd-snapshot-v2-manifest.json` and
`packages/contracts/fixtures/owd-snapshot-v2-index.json`. They contain only
synthetic metadata and hashes—no ciphertext, recovery identity, hostname, D1
row identity, R2 key, or personal content.

| Custody or runtime          | v2 contract                                         | Result                                                          |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Fresh OWD Community install | Public index + owner-key-encrypted manifest/objects | Local validation, explicit mappings, staged restore             |
| Future isolated SaaS cell   | Same required capabilities and snapshot-scoped IDs  | No source-cell authority required                               |
| Local downloaded file       | One streamed `.owdsnapshot`                         | Browser-local validation and restore without source service     |
| Legacy `owd-backup-v1`      | Existing `.age` manifest and Markdown stream        | Remains downloadable, importable, and restorable under Advanced |

## Legacy V1 recovery workflow

1. In **Backup & restore**, choose **Restore a vault**. Under **Saved in OWD**,
   choose a backup from the selected source vault. OWD fetches the encrypted
   object directly into browser memory and
   verifies that its byte length matches the immutable artifact record. The
   normal recovery path does not use an operating-system file picker.
2. Choose the matching private recovery `.txt` file. This is the file OWD
   required the owner to save and reopen before the backup could be created.
   A visible **Where do I get this file?** explanation gives its expected name
   and tells the owner to stop if it is missing; a replacement key cannot open
   an older backup. The browser parses the key locally and never includes it in
   a request.
3. Choose **Check backup and key**. The browser decrypts the
   complete artifact, checks the age authentication tags, validates the
   manifest, and verifies every note hash. No plaintext is uploaded during
   this pass.
4. For an off-platform disaster-recovery artifact, switch to **Backup file**
   and choose or drop the independently downloaded `.age` file.
   Pasting the complete recovery-key text remains an explicitly advanced
   alternative to the normal `.txt` picker.
5. Review the displayed **Backup from** and **Restore into** vault names. If
   their IDs differ, acknowledge the cross-vault restore explicitly.
6. Choose **Review what will change**. The browser decrypts the file a second
   time and uploads
   one verified note at a time into an isolated R2 staging namespace. The
   Worker refreshes the target materialization and reports added, changed, and
   unchanged counts. Deletion count is always zero in V1.
7. Type the exact destination vault name and choose **Restore this vault**.
   OWD then applies the overlay in bounded, resumable batches through the
   target's Durable Object.
8. OWD records each note as applied only after the canonical write is durable,
   then deletes its staging object, publishes a fresh target materialization,
   and reports the verified generation ID. If immediate deletion fails, expiry
   cleanup retries the recorded staging key without rolling back durable data.

The preview records the target content hash for every path. If a target note
changes after preview and does not already equal the restored content, apply
fails closed with `restore_target_changed`. Start a new preview; do not force
the stale job. A repeated apply is safe if a request was interrupted after the
Durable Object write because the same restored hash is treated idempotently.

Recovery is an overlay: it creates missing notes and replaces only previewed
paths. It never deletes target-only notes, restores credentials, enables agent
grants, or writes excluded `.obsidian` content.

Plaintext staging is isolated, bounded to the authenticated manifest and the
same 32 MiB limit as a valid materialized generation, and expires after 24
hours. The hourly scheduled single-claimer reaps every recorded object for
expired jobs and marks unfinished jobs failed. Applied notes are deleted from
staging after both their Durable Object
persistence receipt and D1 progress record; an interrupted retry is
idempotent.

## Operational recovery

Migration `0007_encrypted_backups.sql` is append-only and browser-bootstrapped
for terminal-free deployments. Apply the Wrangler migration ledger explicitly
for production visibility. Do not delete the last `ready` backup for a vault.
Failed artifacts and abandoned staging objects require a separately reviewed
retention policy; no automatic retention deletion is enabled in V1.

Before declaring a deployment recoverable, use only a disposable vault and
complete this drill:

1. create and download an encrypted backup;
2. prove a wrong identity and a modified artifact are rejected;
3. restore into a separate disposable target and verify the diff;
4. interrupt apply between batches, retry it, and verify the new generation;
5. confirm target-only notes remain and no authentication or agent access is
   restored; and
6. revoke or remove all temporary disposable-vault access afterward.

Automated Worker-runtime tests cover these invariants for the R2 destination.
A production deployment still requires the manual disposable-vault drill
before release.

### Collaboration migration and rollback

Migration `0010_phase9a_collaboration.sql` is additive and forward-only. Before
applying it outside local or disposable bindings:

1. retain a verified pre-migration encrypted snapshot and its separately held
   recovery key;
2. export ordinary D1 recovery data and record the exact application rollback
   version;
3. apply the reviewed migration ledger before the matching Worker;
4. create a synthetic Project, submit and revoke one scoped client, then prove
   its next call is denied;
5. create Approved-only and Approved-plus-Unvetted snapshots, open their
   provider-neutral copies in a fresh isolated installation, and confirm that
   accepted roots are owner-only, Unvetted records are quarantined, provenance
   is intact, and the grant count is zero; and
6. exercise immutable Decision projection only into a disposable vault folder
   that is excluded from the Knowledge Space.

Migrations `0010`, `0011`, and `0012` are never discovered or applied from an
HTTP, OAuth, or MCP request. A missing release schema is a failed prerequisite,
not an invitation for the Worker to issue DDL. CI applies the full ledger to an
empty D1 database and separately exercises populated upgrade fixtures before
the candidate can merge.

Application rollback redeploys the recorded prior Worker and leaves the new D1
tables and immutable R2 objects untouched. Never down-migrate, drop
collaboration tables, rewrite owner events, or delete collaboration/snapshot R2
keys as rollback. The older application ignores the additive ledger. Resume
with a forward fix if a candidate cannot read a new record or required
capability.

Restore is deliberately staged: the browser authenticates/decrypts the
portable archive locally, the Worker verifies every bounded object against the
manifest, the owner reviews exact Approved/Unvetted counts, and the exact
confirmation phrase applies only owner-visible records. A collision, missing
dependency, bad hash, unknown capability, or attempted authority restoration
fails closed. Successful apply reconstructs query projections but never OAuth
protocol state, credentials, live grants, sharing, or producer authority.

First-slice contract ceilings are 5,000 records, 5,000 evidence objects, 128
MiB logical intelligence, 1 MiB per record/evidence object, and 1 MiB per
stored submission body. The initial unsharded restore-job manifest is also
limited to 1.75 MB so it stays below D1's row/string ceiling; a valid portable
snapshot above that implementation limit fails before staging until sharded
restore manifests are implemented. Capture and repair are bounded and
resumable at object boundaries. Broad-scale restore and a production disaster
drill remain release work; do not treat passing synthetic fixtures as
authorization to migrate production or personal data. Follow the
[public quality gates](QUALITY-GATES.md) and retain private deployment receipts
outside the public repository.
