# Development Contract

## Toolchain

- Current active Node.js LTS supported by Cloudflare tooling.
- `pnpm` with a committed lockfile and pinned package manager version.
- TypeScript strict mode.
- Wrangler configuration in `wrangler.jsonc`.
- Cloudflare binding types generated from configuration.
- Vitest with `@cloudflare/vitest-pool-workers` for runtime-sensitive tests.
- Playwright for browser onboarding and critical recovery flows.

Exact versions will be pinned during scaffolding and updated intentionally.

## Environments

- Local development uses synthetic vaults and local bindings.
- Preview deployments use isolated non-production D1/R2/DO resources.
- Production resources are never used by automated pull-request tests.
- Secret examples contain names and instructions only, never usable values.

## Root command behavior

The root commands defined in `AGENTS.md` must remain stable. A command should fail loudly on configuration drift and should not mutate production. Deployment commands are separate and require explicit intent.

## Risk-proportional validation

Validation should catch the likely failure at the earliest useful boundary
without running the entire release pipeline after every edit.

| Work state           | Typical scope                                                                                                                                                                          | Required validation                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build, low risk      | Documentation, copy, styling, icons, metadata, test-only work                                                                                                                          | Inspect the diff and run formatting, link/schema, asset, or focused tests that cover the changed files.                                                                                                                  |
| Build, medium risk   | Ordinary UI, service, API, plugin, or performance behavior outside protected boundaries                                                                                                | Run the affected package's typecheck and focused unit/runtime tests; build that package when bundling or runtime compatibility can change.                                                                               |
| Checkpoint           | A coherent, locally usable behavior or end-of-session recovery point                                                                                                                   | Review the accumulated diff, run relevant package checks and tests, confirm no secrets or personal data, then create one local commit.                                                                                   |
| Release or high risk | Release candidate; auth, authorization, cryptography, backup/restore, migrations, Durable Object identity/schema, destructive behavior, production resources, or personal-vault access | Run `pnpm check`, all relevant unit/runtime/integration and browser tests, `pnpm build`, and `pnpm deploy:dry-run` from the exact candidate commit, plus the documented threat, migration, recovery, and rollback gates. |

Automated pull-request CI remains a release evidence layer. Reduce its
frequency by opening pull requests for cohesive vertical slices rather than
using remote CI as the inner development loop. A low-risk change may still
receive broader validation when it interacts with a risky boundary; the risk
of the resulting behavior, not the file extension, determines the tier.

## Coding-task handoff

Use a fresh coding task when starting a substantial vertical slice, crossing a
phase boundary, changing reasoning effort, or when accumulated conversation
context is materially slowing execution. Keep the handoff short and point to
repository evidence instead of reproducing it.

```text
Objective:
Repository and active branch:
Base or checkpoint commit:
Accepted contracts and relevant docs:
Completed work:
Checks already passed:
Current risks or blockers:
Exact next action:
Authorization limits (push/PR/deploy/production/personal vault):
Required reasoning effort:
```

Omit old transcript history, obsolete attempts, and full test logs. Record
durable evidence in the repository once and reference the file or commit.

## Testing layers

- Unit: schemas, path policy, Markdown policy, manifests, deterministic transforms.
- Worker runtime: routes, bindings, authentication boundaries, Durable Object behavior.
- Protocol contract: pinned YAOS/Yjs fixtures across supported versions.
- Integration: D1 migrations, R2 generation publication, jobs, backup verification.
- End-to-end: claim, passkey login, pairing, browse/search, edit, backup, staged recovery.

Use only synthetic vault fixtures. Fixtures must contain no copied personal content.

The permanent YAOS contract fixtures live in
`packages/yaos-core/fixtures/schema-compatibility.json`. Runtime tests apply
each fixture, wait for its durable state-vector receipt, evict the target
Durable Object, and verify the reconstructed Yjs document. The WebSocket test
uses the exact y-partyserver update frame and closes all sockets before
eviction.

The companion client lives in `packages/obsidian-plugin`. MDevolved-specific adapters
are under `src`, while the reviewed upstream client is pinned under
`vendor/yaos-src` and excluded from mechanical root lint/format rewrites. Use
`pnpm build:plugin` for a production bundle and its security guard,
`pnpm --filter @owd/obsidian-plugin test` for the pairing contract, and
`pnpm package:plugin` for the version-checked release directory and ZIP. Test
installation only in a synthetic disposable vault; never install development
builds into a real vault as part of automated verification.

Obsidian's developer hot reload reevaluates the bundled Yjs module in the same
renderer. Yjs therefore emits its duplicate-import sentinel on reload even when
the production bundle contains exactly one Yjs input. Confirm that with an
esbuild metafile, require `dev:errors` to remain empty, and complete a live
persistence-receipt check; restart the disposable vault when a clean renderer
is specifically required. Any additional Yjs copy or thrown runtime error is a
failed gate.

## Migration policy

D1 and Durable Object migrations are append-only after release. Each migration
states prerequisites, forward action, compatibility window, failure behavior,
and recovery procedure. CI runs `pnpm test:migrations` to apply the full D1
chain to an empty database and to upgrade an isolated fixture from the prior
release. A migration that is a release prerequisite must not be discovered or
applied by ordinary request traffic.

## Observability

Prefer stable error codes and redacted structured events. Dashboards should answer whether sync, materialization, backup, and recovery jobs are healthy without exposing content.

## Dependency policy

Dependencies need a clear purpose, compatible license, Worker-runtime compatibility, and acceptable bundle/security cost. Pin high-risk protocol and cryptography dependencies. Avoid libraries that require Node APIs unless `nodejs_compat` is deliberately enabled and tested.
