# Storage, Compaction, and Cache Policy

This document distinguishes the data OWD must preserve from the derived data it
may compact, cache, rebuild, or retire. The goal is fast sync and agent access
without turning a user's CPU, SSD, or Cloudflare account into an unbounded
indexing system.

## Storage tiers

| Layer                 | Role                                                    | Current policy                                                                                                                                    |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obsidian vault        | Owner's readable Markdown and attachments               | Canonical local files; never rewritten merely to optimize OWD                                                                                     |
| Vault Durable Object  | Canonical live Yjs sync state                           | Per-vault, hibernating object; incremental journal plus verified checkpoints                                                                      |
| D1/R2 library         | Current browse, search, MCP, and snapshot source        | Immutable derived generation; rebuildable from live state                                                                                         |
| Encrypted R2 snapshot | Timestamped workspace recovery point                    | Logically complete, physically incremental, and encrypted with the owner-held identity                                                            |
| Plugin indexes        | Avoid repeated disk reads and hashes                    | Derived `mtime`/size/hash metadata; resettable and repairable                                                                                     |
| Project ledger        | Work Packets, submissions, Decisions, Knowledge, Skills | D1 relationships/events plus content-addressed R2 bodies; Approved records and optionally quarantined Unvetted records are recoverable owner data |
| Agent working context | Harness-local conversation and bounded OWD packet views | Ephemeral or derived; never a replacement for cited source or accepted owner data                                                                 |

## What is already efficient

- One Durable Object represents one vault and uses WebSocket hibernation.
- Yjs persistence skips equal state vectors, appends small deltas, checkpoints a
  delta larger than 2 MiB or after two append failures, and compacts after more
  than 50 journal entries or 1 MiB of journal data.
- Checkpoint publication and superseded journal deletion occur in one Durable
  Object storage transaction. A client receives a durability echo only after
  persistence succeeds.
- R2 note bodies and backup downloads stream. Backup encryption streams from R2
  through age into R2 instead of buffering a vault in Worker memory.
- Library publication stages one bounded binary snapshot, then processes at
  most 16 notes per Durable Object alarm. Progress is durable in D1, publication
  is atomic, and browser polling uses read-only status endpoints.
- Collaboration dashboard reads are D1-only and initially page 25 inbox plus
  25 timeline items. Client-claimed labels load from R2 only when the owner
  asks to see them.
- The plugin stats Markdown files first and reads only changed files. Attachment
  hashes are reused when `mtime` and size match. Disk writes are debounced and
  use bounded concurrency.
- The active attachment queue is persisted only when its durable snapshot
  changes, avoiding a complete plugin `data.json` rewrite every three-second
  status tick.
- Private content responses use `private, no-store`. This avoids cross-owner or
  cross-session plaintext caching and keeps the trust boundary easy to audit.

## Deliberate non-features

- OWD does not maintain a second local plaintext copy of the vault.
- OWD does not install a local embedding or reranking model by default.
- OWD does not lossy-compress canonical notes or Yjs state into an agent summary.
- OWD does not put authenticated note bodies into Cloudflare's shared Cache API.

A QMD/vector adapter can be optional later for users who want local semantic
search, but its model downloads, disk index, CPU use, refresh schedule, and
deletion controls must be explicit. D1 FTS remains the lightweight default.

## Open scale work

Items 1 through 4 are implemented for the accepted manual snapshot path.
Unattended snapshots remain disabled. Items 5 through 9 block broad unattended
or long-horizon use unless a narrower release gate explicitly proves them
unnecessary.

1. **Cross-generation object deduplication.** Immutable bodies use scoped
   digest identities, while library generations and snapshot manifests keep
   explicit references. Existing object size/hash is verified before reuse; a
   manual library refresh still repairs a missing or corrupt derived object.
   Snapshot ciphertext is randomized once per new content object and the
   verified object is reused; encryption is not made deterministic for
   deduplication.
   **Implemented:** library note bodies use verified digest keys;
   recovery objects reuse only an existing randomized ciphertext inside the
   same recipient and section boundary. Manual refresh repairs missing or
   corrupt digest objects.
2. **Reference-aware library and snapshot retention.** Retain the current
   library generation, pinned and recent recovery windows, and every object
   referenced by a retained snapshot. Remove obsolete D1 FTS rows before their
   derived library objects, and delete an encrypted object only when no retained
   manifest references it. Garbage collection is bounded, resumable, and
   conservative after interrupted runs.
   **Implemented:** only current-generation FTS rows remain. Library cleanup
   keeps current plus two recent non-current generations and excludes backup,
   snapshot, restore, and active-job references. Snapshot deletion protects
   pinned/newest-known-good points. Both object queues wait through a grace
   period and recheck live references before R2 deletion.
3. **Owner-controlled snapshot quotas and retention.** Show both logical bytes
   and newly stored bytes plus projected retention before enabling automation.
   Never delete the only known-good snapshot, a pinned snapshot, or an artifact
   whose matching recovery identity may still be needed.
   **Implemented:** the owner sees logical, projected-new, reusable, and
   retained bytes before retention can be enabled; automatic capture remains
   disabled.
4. **Scheduled cleanup.** Restore staging, obsolete library generations, failed
   snapshot artifacts, and both object queues run in bounded, idempotent
   scheduled handlers. Failed snapshot records remain visible while their
   stale source/object references are released after grace.
5. **Migration-only schema checks.** The current compatibility bootstrap probes
   several D1 schemas on each API request. Once deployment always applies
   migrations, remove those hot-path discovery reads and fail health checks
   clearly on version drift.
6. **Projection coalescing.** Coalesce rapid web edits so only the newest durable
   state boundary is materialized while preserving explicit owner-requested
   refreshes as repair operations.
7. **Budgets and observability.** Track materialization amplification, retained
   bytes, R2 Class A/B operations, D1 rows read/written, Durable Object storage
   and active duration, plugin scan/read/hash time, and queue persistence writes.
   Alert per deployment/cell before throttling or surprise cost.
8. **Streaming browser recovery inspection.** Portable import currently
   decrypts and retains bounded unique objects in browser memory while checking
   the archive. Before attachments or long-lived Project ledgers raise the
   practical ceiling, validate and stage objects incrementally while preserving
   the complete manifest and explicit target preview.
9. **Collaboration-ledger growth.** Keep Project timelines, provenance edges,
   Work Packets, evaluations, and superseded versions append-only without
   turning ordinary reads into unbounded joins. Store large immutable bodies in
   R2, page every list with stable opaque cursors, maintain bounded rebuildable
   D1 projections, shard portable manifests when required, and expose owner
   storage budgets by record type.

## Cache policy

Cache public, fingerprinted JavaScript, CSS, icons, and immutable release
metadata. Keep authentication, vault lists, note bodies, search excerpts,
snapshots, restore staging, and MCP content private and non-cacheable. If a future
managed UI caches owner-specific metadata, its key must be explicitly partitioned
by authenticated owner/cell and it must never contain note plaintext.

R2 already supplies the durable object store and Cloudflare does not charge R2
egress; adding a plaintext edge cache would save comparatively little while
creating another security, invalidation, and residency boundary. Prefer fewer
materializations, immutable digest reuse, pagination/range reads, and streaming.
