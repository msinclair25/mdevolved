# MD2 folder-source migration and recovery

Migration `0036_source_descriptors.sql` is forward-only and additive. It adds
nullable, validated JSON metadata to `vaults` and `snapshot_vaults`. A missing
descriptor continues to mean the legacy Obsidian source, so current clients and
existing rows do not need a rewrite.

Exports and encrypted snapshots carry only provider-neutral source metadata.
On import or restore it is marked `quarantined` with
`authorityRestored: false`. Pairing grants, vault credentials, device state,
OAuth state, sessions, leases, actors, and runtime caches are never restored.
The owner must pair the exact folder again before it can publish.

Local folder state is stored outside the selected source and is scoped to the
canonical folder identity. Raw sync credentials stay in macOS Keychain,
Windows CurrentUser DPAPI, Linux Secret Service, or Electron `safeStorage`.
Linux `basic_text` and unknown protection backends fail closed. Revocation
stops the source and removes the protected desktop credential.

Rollback means deploying the previous application build while leaving the
nullable columns in place; no destructive down-migration is supported. Older
clients ignore the additive capability and continue using their unchanged
pairing response. If descriptor evidence is malformed or conflicts with an
existing source, pairing or snapshot processing fails closed.
