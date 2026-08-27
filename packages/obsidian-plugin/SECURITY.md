# Security

MDevolved Sync for Obsidian handles a vault-scoped credential and live Markdown synchronization.
Please do not publish suspected vulnerabilities, credentials, pairing links,
recovery keys, private deployment hostnames, vault names, or note content in a
public issue.

Report a vulnerability privately through GitHub's private vulnerability
reporting for `msinclair25/mdevolved-sync` when available. If that channel is not
available, open a content-free issue asking the maintainer to enable a private
contact path.

## Pairing boundary

- Pairing starts from the MDevolved Sync for Obsidian command inside the vault the owner already
  opened. A browser URI never selects a vault.
- The plugin repeats the current vault name and deployment host before any
  exchange.
- Pairing grants expire after ten minutes, are single use, and are stored by
  the server only as hashes.
- The resulting credential is vault scoped. Revocation is rechecked before
  socket admission and closes active access.
- MDevolved Sync for Obsidian does not use an automatic updater of its own. Private-beta updates
  come from the public GitHub Release through BRAT; the long-term path is
  Obsidian's reviewed Community Plugin updater.

The current compatibility and security contracts are maintained in the
[MDevolved repository](https://github.com/msinclair25/mdevolved).
