# MDevolved Sync for Obsidian

MDevolved Sync for Obsidian is the optional Obsidian source adapter for
[MDevolved](https://github.com/msinclair25/mdevolved). It connects the
vault you explicitly opened to an owner-controlled MDevolved deployment for sync,
search, encrypted snapshots, and recovery.

Existing installations keep the `owd-sync` plugin ID, settings, `owd-pair`
deep link, BRAT repository, release tags, archive names, and updater path. The
display-name transition requires no reinstall or re-pairing.

> **Invited family test:** the compatibility package `0.1.7` is available through MDevolved's
> temporary direct desktop installer because it is not yet listed in Obsidian
> Community Plugins. The invited tester opens their private cell invitation;
> the pre-provisioned OWD dashboard provides the version-matched installer.
> Testers do not clone, fork, build, or deploy the platform.

## Install the invited test candidate

1. Open the private invitation and claim the pre-provisioned OWD cell.
2. If needed, explicitly choose **Settings → Community plugins → Turn on
   community plugins** in Obsidian.
3. Fully quit Obsidian with **Obsidian → Quit Obsidian** or **⌘Q**.
   Closing the macOS window is not enough.
4. Open **Sources**, choose **Choose vault and install MDevolved Sync for Obsidian
   0.1.7**, and select the intended vault root containing `.obsidian` in Chrome
   or Edge's native folder picker. Do not select `.obsidian` itself; choose
   **Allow** if the browser asks for write access.
5. Reopen Obsidian and confirm the selected vault shows MDevolved Sync for Obsidian `0.1.7`
   enabled. Stop if the version differs.

The dashboard verifies the published release, writes only the OWD Sync files
and enabled-plugin list, and does not enumerate or upload notes. BRAT remains
the disclosed two-stage fallback when the browser picker is unsupported or
blocked. A BRAT deep link only opens its prefilled form; choose **Add Plugin**,
wait for BRAT to finish, and enable OWD Sync afterward. No terminal or hidden
vault-folder work is required.

The direct installer and BRAT are testing bridges, not the permanent
distribution plan. OWD Sync will move to Obsidian's official Community Plugin
directory after the private-beta compatibility, security, mobile, update, and
clean-install gates pass.

## Pair one vault safely

1. In the authenticated MDevolved dashboard, create a private pairing request.
2. Open the exact vault you intend to connect.
3. Return to MDevolved and choose **Open Obsidian and pair**.
4. Confirm the displayed current vault name, deployment host, and access
   disclosure.

The protocol handoff never chooses a vault silently: the plugin displays the
currently open vault and waits for approval. Pairing uses a ten-minute
single-use grant and does not expose the stored vault credential in the
dashboard. If the handoff is blocked, use MDevolved's **Manual fallback**, copy
the request, run **MDevolved Sync: Pair this vault with MDevolved**, and paste
it. Existing `owd-pair` links remain accepted.

## Diagnostic package

Download `owd-sync-<version>.zip` and `checksums.txt` from the matching
[OWD Sync 0.1.7 GitHub Release](https://github.com/msinclair25/owd-sync/releases/tag/0.1.7).
Verify the checksum, then install the complete `owd-sync` directory as one
version-matched unit. Do not mix `main.js`, `manifest.json`, or `styles.css`
from different releases. If both direct install and BRAT are blocked, stop the
acceptance run. The ZIP is for separate maintainer diagnosis, not a substitute
installation path.

## Development

OWD Sync is developed in the OWD Platform monorepo and promoted to this
sanitized public distribution repository. The repository contains the
reviewable adapter, pinned upstream client source and notices, tests, build
configuration, and release assets.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

See [UPSTREAM.md](UPSTREAM.md) for pinned YAOS provenance and
[SECURITY.md](SECURITY.md) for vulnerability reporting and the pairing trust
boundary.

## License

The OWD adapter is Apache-2.0. Vendored YAOS components retain their 0BSD
notice and provenance.
