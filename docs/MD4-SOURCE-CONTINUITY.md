# MD4 cross-computer source continuity

## Execution capsule

MD4 adds an owner-approved device identity below one existing durable source
(`vaultId`). The source remains the Yjs coordination atom. A device is only a
sync principal for that source; it is never a Project, agent, owner, grant,
lease, actor, or authority source. Project discovery and resume continue to
revalidate the existing source and collaboration grants and the exact durable
Project ID.

The portable source boundary is version 1: logical root `.`, source kind,
source capabilities, and the frozen `mdevolved-markdown-v1` path policy. Its
canonical SHA-256 must match on every enrolled device. Each device separately
stores a SHA-256 fingerprint of its exact canonical local root so a restart or
folder substitution fails closed without uploading an absolute path. The
fingerprint is not used to compare paths across computers.

New devices generate their sync credential locally and send only its SHA-256
hash during the single-use owner-approved exchange. The raw credential stays
in protected local custody. Exact enrollment replay is idempotent; reuse of an
idempotency key with a different canonical request is
`idempotency_conflict`. The durable receipt binds hashes of the grant and
deployment origin plus every versioned outer request field, so used-grant
cleanup cannot turn an exact retry into a conflict and no raw grant is retained.
Device IDs are globally unique and cannot move between sources. Expired,
revoked, boundary-mismatched, cross-source, and stale
credentials fail before Durable Object admission. Source revocation remains
authoritative and immediately revokes every device and credential.

At most 16 non-expired devices may be active and at most 64 device-history
records are retained for a source. Enrollment fails before consuming the owner
grant at either bound; listing, export, and snapshot contracts use the same
64-record bound.

CLI and desktop connections persist that approved root fingerprint alongside
the canonical source ID and revalidate both before starting sync. Obsidian
persists the corresponding vault-root fingerprint in its additive settings.
If an exchange response is lost, clients retry once with the same in-memory
credential, device ID, idempotency key, and byte-identical request.

A publication receipt is appended only after the Worker proves that the
source Durable Object includes the device's state vector. The receipt records
the device, source, credential, state-vector hash, time, and a per-source
monotonic sequence so same-second publishes remain ordered. Last-publisher UI
is derived from that durable receipt and grants no authority. Reconciliation,
tombstones, expected versions, state-vector receipts, and conflict artifacts
remain the stale-write boundary.

Existing clients negotiate no source-device capability and retain the current
single-device replacement behavior. Existing records with no device link stay
readable and revocable. They must upgrade before enrolling an additional
simultaneously active device; no old-client request is silently widened.

Encrypted backups, portable snapshots, and provider-neutral exports may
include bounded device history only with `restoreDisposition: quarantined` and every authority,
credential, and connection restoration flag false. Restore never creates a
device, credential, pairing grant, session, OAuth state, source/Project grant,
lease, actor, or live authority. Restore stores device history under the exact
restore job as inert quarantine; plaintext staging cleanup does not remove that
audit/recovery record. Portable snapshot restore carries the inert device array
into the same quarantine store used by encrypted backup restore. Snapshot
retention protects referenced encrypted history through the existing delayed
reference-aware cleanup boundary.

## Frozen hostile and compatibility invariants

- Enrollment requires an authenticated owner-created existing-source grant;
  denial, expiry, replay conflict, malformed/oversized input, and missing
  approval fail closed.
- Source kind, logical root, capabilities, path-policy version, and canonical
  boundary hash must match. Absolute paths, traversal, symlinks, protected
  paths, and a changed local-root fingerprint never pass as the same device.
- Device state, presence, publisher provenance, labels, and runtime metadata
  never create or expand Project authority and never select a Project.
- Two devices converge through the same source Durable Object and existing Yjs
  receipts. They cannot create another Project or cross a source/Project
  boundary.
- Revocation is authoritative on the next ticket, confirmation, API, or MCP
  call. No reconnect, replay, restart, restore, or offline queue revives it.
- Clients lacking `owd.source-devices-v1` keep the legacy schemas and behavior.
- New Obsidian pairings persist the local vault-root fingerprint and fail closed
  before sync if the approved root changes. Legacy settings without that
  additive field retain their existing behavior until the next pairing.
- Runtime transcripts, hidden reasoning, terminal/browser state, provider
  credentials, personal data, and execution-harness state are never accepted.

## Acceptance

Close MD4 only after two synthetic devices reconcile one source without a
duplicate Project, stale overwrite, cross-source access, or restored device
credential, and a fresh compatible agent resumes the same durable Project
while both sync clients are offline. Run the focused MD4 gate first, then the
complete public quality gate from the exact candidate and the affected
desktop/CLI and Obsidian package/installer/updater gates.
