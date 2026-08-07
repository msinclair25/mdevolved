# Public quality gates

OWD handles private notes, authorization, and encrypted recovery. A change is
not ready merely because it builds. The public repository keeps the automated
controls that protect the onboarding, Project, vault, and recovery failures
found during alpha use; private production receipts and deployment identifiers
are deliberately not published.

## Required automated gate

Run from the exact candidate commit:

```sh
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm check
pnpm test:migrations
pnpm test
pnpm test:e2e
pnpm build
pnpm deploy:dry-run
pnpm deploy:marketing:dry-run
```

CI runs the same sequence for pull requests and `main`.

## Manual Community release checks

Use synthetic or disposable data. Never attach a real vault, access token,
pairing URL, passkey detail, recovery key, deployment identifier, or private
hostname to an issue or test receipt.

- Start from a fresh Cloudflare account or isolated test resources.
- Apply the complete migration chain before activating the matching Worker.
- Claim the owner once and verify a second claim fails.
- Install the exact OWD Sync version advertised by the platform.
- On a clean macOS profile in current Chrome, fully quit Obsidian with ⌘Q,
  cancel the vault picker once, retry, and confirm the page reports both states
  without implying an install. Complete the direct install from the vault root.
- Separately enable BRAT, wait until its command is registered, and verify the
  pinned deep link opens a form that still requires **Add Plugin** and enabling
  OWD Sync. Do not run both installation paths in the same check.
- Pair only the open test vault and wait for its library to publish
  automatically.
- Confirm read-only agent access does not require a recovery point.
- Complete the guided order: vault, library, agent, prepared Project.
- Say **Connect this project to OWD** once and confirm create, join, rejoin, and
  resume converge without duplicate Projects or repeated routine consent.
- Connect a second independently authorized agent and verify cross-vault,
  private-Artifact, and hidden-conversation isolation.
- Transfer one cited Handoff, create an independent Review, and record an owner
  Decision.
- Revoke each source and Project grant and verify denial on the next call.
- Create, download, reopen, inspect, and restore an encrypted snapshot into an
  isolated target. Confirm credentials and grants are not restored.
- Exercise the folder-style workspace at desktop and narrow widths with
  keyboard, pointer, and touch input.

## Managed release checks

Managed-service operations are maintained privately because they contain
deployment topology and production receipts. Any managed release must still
use an immutable Community commit and must additionally prove:

- one isolated Worker, database, object store, OAuth namespace, Durable Object
  namespace, secrets set, and hostname per owner;
- one validated private cell-build manifest that records every provisioned
  resource, release/migration provenance, expiry, and post-delete check;
- one atomically maintained account registry proving that no active cell
  shares any rate-limit namespace ID;
- no cross-cell data, logs, grants, diagnostics, or recovery objects;
- versioned rollout, rollback, export, suspension, retention, and deletion;
- redacted diagnostics with no names, paths, note content, credentials, or
  private hostnames; and
- no managed control-plane dependency on the Community request path.

## Compatibility review

[`compatibility/upstreams.json`](../compatibility/upstreams.json) records each
reviewed upstream release, source commit, critical paths, and package integrity.
The daily monitor opens one rolling issue when a newer contract needs review.
It never changes a compatibility claim automatically.
