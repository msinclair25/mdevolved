# Pinned YAOS Obsidian client

OWD Sync vendors the YAOS Obsidian sync-client subset needed to preserve its
tested reconciliation and Yjs behavior.

- Repository: <https://github.com/kavinsood/yaos>
- Commit: `e3d73d6850349f772812fbe7758cf5f3f6b11390`
- Commit date: 2026-07-08
- Upstream plugin version: `1.6.1`
- Upstream license: 0BSD; see `LICENSE`
- Imported path: the product paths under `src/**` to `vendor/yaos-src/**`
- Excluded paths: `src/telemetry/**`, the raw-token device-pairing and recovery
  modals, QA, tests, examples, and upstream deployment/update tooling

OWD-specific code lives in `src/**`. The semantic modifications inside the
vendored tree are deliberately narrow: the public `applyOwdConnection()` bridge
sends an already-validated OWD exchange result through YAOS's existing setup
controller after OWD's consent prompt (without a second post-exchange vault-ID
prompt); the legacy credential-bearing YAOS link/device-sharing paths and
upstream updater calls are disabled; the settings deploy link points to OWD;
and primary visible labels say OWD Sync. The production build keeps YAOS's QA
mutation harness disabled. Upstream telemetry is excluded from the vendored
source and release artifact; OWD retains only minimal no-op diagnostic ports
needed by the sync engine's command interfaces.

The OWD adapter validates an untrusted copied `owd-pair://` value and exchange
response, starts pairing only from the command or settings UI inside the
currently selected vault, displays an explicit vault-data disclosure, and
stores the resulting credential through the upstream settings path. It does not
register a global URI handler, add analytics, or read another plugin's data.

Update this directory only through the review process in
`docs/UPSTREAM-YAOS.md`. Never copy a floating branch.
