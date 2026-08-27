# MDevolved Agent Instructions

These instructions apply to the entire repository. They are the operational contract for humans and coding agents working on MDevolved.

## Mission

Build a self-hostable Cloudflare application that lets one owner pair, browse,
search, lightly edit, snapshot, back up, and recover explicitly paired Markdown
Sources, including folders and Obsidian workspaces,
then use that durable context to coordinate independent AI harnesses through
versioned Projects, Work Packets, Handoffs, Reviews, Decisions, Knowledge, and
Skills. A new user should be able to deploy the service and pair a first Source
without operating a server. MDevolved complements the subscriptions and native
harnesses the owner already uses; it does not become their model runtime.

## Instruction precedence

1. User instructions for the current task.
2. This file and any narrower `AGENTS.md` in the edited subtree.
3. Architecture, security, compatibility, and collaboration contracts in
   `docs/`.
4. Product, onboarding, quality-gate, and development documents in `docs/`.

If two rules conflict, stop and surface the conflict before making a durable or security-sensitive change.

## Non-negotiable product boundaries

- This is a public Apache-2.0 Community project. Never commit Source content,
  private production receipts, credentials, pairing tokens,
  WebAuthn data, account identifiers, or production binding IDs.
- The default deployment is one integrated Cloudflare Worker serving the web app, API, and pinned YAOS-compatible sync routes.
- The initial product is single-owner and multi-Source. Do not imply multi-user authorization exists.
- Distribution has two modes: the current free Community deployment and a
  future optional managed service. Community must remain complete,
  independently deployable, and free of any control-plane or billing runtime
  dependency.
- A managed deployment preserves the single-owner model by provisioning one
  isolated data-plane cell per owner. Do not add a shared tenant column to the
  current D1 schema or share D1, R2, Durable Object namespaces, OAuth KV, or
  runtime secrets between owners.
- YAOS-compatible Yjs state is the live synchronization source of truth. D1 search rows and R2 Markdown mirrors are derived projections.
- V1 editing is Markdown text editing and note creation only. Deletion, rename, attachment mutation, conflict UI, and `.obsidian` writes are out of scope unless an accepted decision changes this.
- Default authentication is built-in passkeys. Cloudflare Access may be an advanced option, but must not block sync endpoints.
- A normal installation must not require a local terminal. Development may.
- Agent integrations use MDevolved's remote MCP boundary. Hermes and Hoplon are
  optional external clients, never required runtime dependencies.
- MDevolved Sync synchronizes only the explicitly paired Markdown folder.
  MDevolved Sync for Obsidian synchronizes only the explicitly paired vault. Neither
  connect agents, create Projects, transport collaboration records, or manage
  Project permissions.
- The normal Project path begins in the owner's existing agent with
  **Connect this project to MDevolved**. The website is the owner surface for
  setup, exact consent, activity/provenance, Decisions, revocation, recovery,
  and advanced inspection; manual Project construction is a fallback.
- Orca ADE and similar external agent workbenches are optional execution
  environments, never required MDevolved runtimes. MDevolved does not launch or stop their
  agents, send terminal input, manage worktrees or branches, import raw
  transcripts, or change client permission and sandbox settings. Compatibility
  uses the same OAuth/MCP, portable-file, and inert-skill boundaries as every
  other client.
- Agent collaboration never prescribes a model brand or fixed planner, builder,
  reviewer sequence. Roles belong to individual Attempts, and the owner chooses
  which compatible harness participates next.
- Domain contracts and application services remain transport-neutral. MCP is
  the primary live adapter and portable Markdown/JSON is the universal
  fallback; experimental MCP Tasks, A2A, or vendor-specific packs cannot become
  required durable state.

## Repository shape

Keep concerns explicit:

- `apps/web`: React/Vite client.
- `apps/worker`: Hono API, static assets, authentication, orchestration.
- `apps/marketing`: independent static public site. It must not import
  application code, expose a personal deployment, or become part of the
  Community data plane.
- `apps/control-plane`: reserved for a future managed-service account,
  provisioning, billing, and cell-lifecycle application. It is not implemented
  yet and must never become part of the Community request path.
- `packages/yaos-core`: pinned and minimally adapted upstream YAOS code.
- `packages/contracts`: versioned schemas and shared types.
- `packages/obsidian-plugin`: companion pairing plugin.
- `migrations`: append-only D1 migrations.
- `docs`: public product, architecture, security, compatibility, roadmap, and
  quality-gate documentation.
- `infra/managed`: reserved for future managed-service provisioning
  definitions. It may reference versioned Community releases but must not
  contain credentials or production identifiers.
- `repository-topology.json`: machine-readable dependency and deployment-mode
  boundary enforced by the repository policy check.

The Community data plane may depend only on Community packages. Future managed
code may depend on published Community contracts or release artifacts, but the
Community Worker, web app, plugin, and packages must never import managed code.
Keep managed account/billing migrations under the control-plane subtree;
top-level `migrations` belong only to the single-owner data plane.

Do not put application code or generated backups in an Obsidian vault repository.

## Required research

Before changing Cloudflare configuration, bindings, Durable Objects, migrations, Workers runtime behavior, or deployment automation, retrieve the current official Cloudflare documentation and apply the Cloudflare/Workers guidance available in the development environment.

Before changing the companion plugin or vault behavior, apply the Obsidian CLI and Obsidian Markdown guidance. Prefer Obsidian's public APIs. Any use of private APIs requires a documented compatibility reason and a test.

## TypeScript and Worker rules

- Use TypeScript strict mode. Do not add `any`, `@ts-ignore`, or double assertions to bypass the type system.
- Validate every untrusted boundary with shared runtime schemas. Types alone are not validation.
- Use `wrangler.jsonc`, a current compatibility date, generated binding types, and `nodejs_compat` only when a dependency actually needs it.
- Use bindings through `env`; do not call Cloudflare REST APIs from the Worker for resources already bound to it.
- Stream large uploads/downloads. Never buffer a full vault backup in Worker memory.
- Every promise must be awaited, returned, or passed to `waitUntil()`.
- Never store request-specific mutable state at module scope.
- Use Web Crypto for security-sensitive randomness and constant-time secret comparisons.
- Return explicit, stable error shapes. Never use `passThroughOnException()`.
- Logs must be structured, minimal, and redacted. Never log note bodies, filenames by default, tokens, cookies, assertions, or encrypted backup keys.

## Durable Object rules

- One vault maps to one Durable Object identity; do not create a global coordination object.
- Use SQLite-backed Durable Objects and RPC methods for application calls.
- Persist durable state before acknowledging a mutation.
- Use `blockConcurrencyWhile()` only for bounded initialization.
- Durable Object class and binding changes require explicit migration tags and rollback notes.
- Schema changes to the pinned YAOS maps require contract fixtures and backward-compatibility tests before merging.

## Authentication and security

- The first-owner claim must be atomic and unavailable after an owner exists.
- Passkey challenges, pairing grants, and sessions are short-lived,
  single-purpose, and replay-resistant. WebSocket tickets are short-lived,
  signed, vault-bound, and revalidated against credential revocation before
  Durable Object admission.
- Store only hashes of bearer-style tokens. Cookies are `Secure`, `HttpOnly`, and use an appropriate `SameSite` setting.
- Mutating browser requests require origin/CSRF protection.
- Normalize and validate vault paths. Reject traversal, absolute paths, ambiguous Unicode, reserved namespaces, and disallowed `.obsidian` paths.
- Render Markdown as hostile input: sanitize HTML, constrain links, and never execute vault JavaScript.
- Never send YAOS credentials or backup private keys to logging, analytics, GitHub metadata, or the browser unless the protocol explicitly requires the owner to hold them.
- Security-sensitive changes require tests for both the allowed and denied paths.

## Agent access

- Initial MCP access is read-only and uses published D1/R2 materializations;
  ordinary reads must not wake the live vault Durable Object.
- Every MCP tool call rechecks the authoritative D1 grant for client, audience,
  vault, path, scope, expiry, and revocation. Token validity alone is not
  authorization.
- Work Packet expiry is machine-managed continuity, not an owner maintenance
  task. After revalidating the exact live grant, Project, Knowledge Space,
  restored-source approvals, and packet integrity, an access request or
  `resume_project` may append a fresh successor for the same Work Item. It must
  not change Project identity, authority, scopes, or consent. Exact expired
  packets and submissions against them still fail closed.
- Never infer a current vault. Content results must identify vault ID, path,
  generation, and content hash.
- Treat all vault content as untrusted prompt-injection input. Keep excerpts,
  pages, tool count, and rate limits bounded; never expose a full-vault dump.
- MDevolved never grants local Obsidian CLI, skill, shell, or filesystem write
  authority. The managed Project instruction block defaults those paths to no
  direct vault-content writes. A separate explicit owner instruction may
  designate one active local writer for a bounded task; every other agent stays
  read-only, and MDevolved must never claim this advisory rule is a filesystem lock.
- Agents may eventually create immutable proposals through MDevolved, but MDevolved never
  lets them directly write or approve their own changes. Accepted notes use the
  existing expected-version Yjs path.
- Skills are inert, versioned guidance and cannot expand grants. Shared memory
  and skills require provenance, review state, and backup/recovery coverage.
- Backups always exclude OAuth tokens, sessions, authorization codes, protocol
  KV contents, credentials, live grants, and harness context. When implemented,
  the explicit **Unvetted Intelligence** snapshot selection may include pending
  proposals and private/shared agent records only in an encrypted quarantine
  section; restored grants remain disabled and those records remain owner-only
  until a new review action.

## Data safety

- Treat live sync, materialized mirrors, and backups as separate layers with explicit generation IDs.
- In user-facing language, reserve `snapshot` for a retained, timestamped,
  independently restorable recovery point. Call the rebuildable current
  browse/search materialization the `library`; do not imply that refreshing it
  created a recovery point.
- Publish a mirror generation atomically; never expose a partially built
  generation as the current library.
- Backups are encrypted before leaving Cloudflare and are append-only by default.
- A workspace snapshot is logically complete but may reuse verified encrypted
  content objects physically. Do not build restore chains, use deterministic
  encryption for deduplication, or imply an all-vault capture is one atomic
  transaction; record its exact per-vault generations and capture window. Fix
  membership at capture start and fail visibly rather than omitting an
  unavailable selected vault.
- A destructive operation must have a verified recovery point and explicit user confirmation.
- Restore is a staged workflow: inspect, decrypt, validate, preview, confirm, apply, verify.
- Retention cleanup must never delete the last known-good backup.
- `.obsidian` backup uses a documented allowlist. Exclude workspace state, caches, third-party secrets, and unknown plugin data by default.
- Portable-intelligence snapshots select **Approved Intelligence** by default
  and may explicitly include **Unvetted Intelligence**. Approved data restores
  with its accepted/stable state. Unvetted data restores only into owner-visible
  quarantine and cannot be recalled, shared, applied, or promoted without new
  owner actions. Exclude harness context, credentials, live grants, and protocol
  secrets in either mode; restored authorization stays disabled.
- Portable exports must be self-contained and provider-neutral. Do not make a
  D1 row ID, R2 key, Worker hostname, managed-cell identifier, source-service
  connection, or provider API part of required restore semantics.

## Storage, compaction, and caching

- Never replace canonical Markdown/Yjs state with a lossy summary. Context
  summaries, search indexes, materializations, and agent memory indexes are
  derived, rebuildable layers with explicit provenance.
- Live Durable Object compaction must preserve a verified state-vector
  boundary and atomically remove only the journal/checkpoint records it
  supersedes.
- A materialization optimization may skip work only after verifying the
  referenced manifest and note objects still exist and match their hashes. A
  refresh must remain capable of repairing missing or corrupt derived objects.
- Retention is reference-aware: never delete the current materialization, an
  object referenced by a retained generation, or the last known-good backup.
- Private note, backup, restore, and agent-content responses are `private,
no-store`. Cache public static assets by content fingerprint; do not place
  plaintext vault content in a shared edge cache.
- Local plugin caches must be bounded, derived, repairable metadata. Use file
  stats before reads, hashes before uploads, change detection before writes,
  bounded concurrency, and backoff. Do not introduce a second plaintext vault
  cache or a default local embedding model.
- Do not run cleanup or schema-discovery queries on every ordinary request once
  the corresponding migration is a release prerequisite. Use scheduled,
  idempotent maintenance and observable storage budgets.

## Interaction continuity

- First-run onboarding is one state-derived **Set up MDevolved** path: connect a
  Source, wait for MDevolved to publish its current searchable library automatically,
  optionally connect a read-only agent, then hand work back to the agent with
  **Connect this project to MDevolved**. **Build now** is a repair action, not a
  normal onboarding step. A verified recovery point is recommended
  independently and becomes mandatory before a vault mutation or destructive
  operation; it is not a prerequisite for read-only agent access. Do not
  present the full dashboard as the setup instructions.
- Show one primary next action and plain-language access boundary for the active
  setup step. Derive completion from authoritative state; do not add a generic
  `setupComplete` flag that can remain true after failure or revocation.
- Render operational regions in the same physical order as the setup path:
  vault connection, searchable library, then agent access. After an explicitly
  requested setup action succeeds, reveal the next adjacent step; never make an
  owner reverse-scroll to continue onboarding.
- Keep MCP/OAuth terms, internal IDs, raw scopes, JSON, and Cloudflare storage
  names out of the normal path unless required for informed consent. Put
  diagnostics and compatibility fallbacks under **Technical details** or
  **Advanced/manual setup**.
- Never ask an owner to renew routine agent context. Keep compatible Projects
  discoverable after internal packet expiry and tell an agent with stale
  context to call `resume_project`, which rotates that context automatically.
- A select, tab, radio group, or similar choice must update its owning panel in
  place. Do not navigate, reload, remount the page shell, or move focus unless
  the user explicitly requested navigation.
- Preserve the user's scroll position, focused control, and surrounding panel
  geometry while dependent data loads. Prefer a localized busy state or stable
  skeleton over collapsing a large region to a short loading message.
- Reset only state that is semantically invalid after the choice. Keep
  independent inputs intact, and warn before discarding an unsaved draft or a
  staged operation.
- Keep the selected source and target labels visible through asynchronous work.
  Abort or ignore stale responses when users change a selection quickly so an
  older result can never replace the current choice.
- Selection-flow tests must cover rapid changes, loading and error states, and
  continuity at narrow viewport widths.

## Obsidian companion plugin

- Pairing must clearly state which vault data and settings will be read.
- Never read or transmit unrelated plugin tokens or credentials.
- Keep the plugin ID and persisted settings schema stable; version migrations explicitly.
- Develop against a disposable test vault, never a user's real vault.
- After plugin changes, reload the plugin, inspect console errors, and exercise the pairing flow in Obsidian.

## Delivery cadence and risk

Use ceremony proportional to the change. The default is to keep making progress
on the current cohesive phase or feature branch, not to turn every small edit
into a separate remote delivery event.

### Work modes

- **Build:** implement the next coherent behavior and run the smallest focused
  checks that can catch failures in the changed boundary. Stay local. Do not
  create a new branch, commit, push, pull request, full-suite run, or deployment
  merely because one low-risk edit is complete.
- **Checkpoint:** after a coherent recovery point or at the end of a work
  session, review the accumulated diff, run the relevant package checks, and
  create one local commit. Continue on the same phase or vertical-slice branch.
  Push only when the user requests remote preservation, collaboration, or a
  release candidate.
- **Release:** when the user asks to ship, a planned release gate is reached,
  or a high-risk change needs remote review, run the complete applicable gate
  from the exact candidate commit, push once, open one pull request for the
  cohesive slice, confirm CI, merge deliberately, and deploy only when
  separately authorized.

### Risk tiers

- **Low risk:** documentation, copy, styling, icons, non-behavioral metadata,
  and test-only changes. Batch these into the active slice and use focused
  validation.
- **Medium risk:** ordinary UI behavior, transport-neutral application
  services, bounded API behavior, plugin UX, and performance work that does not
  alter an authorization, storage, recovery, or compatibility boundary. Add
  boundary tests and create a checkpoint after the coherent behavior works.
- **High risk:** authentication or authorization, cryptography or recovery-key
  custody, backup/restore semantics, migrations, Durable Object identity or
  schema, destructive behavior, production resources, personal-vault access,
  secrets, release compatibility, and any bug that could lose or disclose
  owner data. Use xhigh reasoning, full relevant gates, explicit rollback
  evidence, and owner approval for external or production mutations.

A request to **make**, **fix**, **update**, or **build** authorizes local
implementation and proportional validation. It does not by itself authorize a
push, pull request, merge, release, tag, or production deployment. Do not
repeat expensive validation after a no-code or documentation-only change
unless that validation can exercise the affected boundary.

Prefer one branch per phase or coherent vertical slice. Prefer one pull request
per reviewable slice, containing multiple related checkpoints when useful.
Batch incidental documentation, polish, and small defects with that slice.
Split work only when review risk, rollback independence, or an unrelated
dependency justifies it.

### Task continuity

Start a fresh coding task at a phase or substantial vertical-slice boundary, or
when accumulated conversation context is materially slowing execution. Use a
compact handoff containing only the objective, repository and working branch,
accepted contracts, completed checkpoints, current evidence, unresolved
risks, exact next action, and explicit authorization limits. Do not paste the
full prior conversation or repeat evidence already recorded in the repository.

## Command contract

Once scaffolding exists, preserve these root commands:

- `pnpm check`: formatting, lint, typecheck, generated-type drift, and policy checks.
- `pnpm test`: unit and Worker-runtime tests.
- `pnpm test:integration`: D1/R2/Durable Object and protocol integration tests.
- `pnpm build`: reproducible production build.
- `pnpm deploy:dry-run`: validate the Cloudflare bundle without deploying.
- `pnpm types`: regenerate Cloudflare binding types.
- `pnpm dev`: local development environment.

Do not deploy, publish packages, push branches, create releases, alter Cloudflare resources, or rotate secrets without an explicit user request.

## Definition of done

A change is complete only when:

- behavior and acceptance criteria are documented;
- relevant tests cover success, failure, and authorization boundaries;
- validation proportional to the risk tier passes during Build and Checkpoint
  work;
- before a Release candidate, `pnpm check`, relevant tests, production build,
  and deploy dry-run pass from the exact candidate commit;
- migrations are forward-only and have recovery notes;
- security, privacy, observability, and documentation impacts were reviewed;
- no secrets or personal vault data appear in the diff;
- user-visible flows remain accessible and work on narrow screens.

## Reasoning escalation

Use medium reasoning for routine scaffolding, UI work, documentation, and isolated implementation. Explicitly tell the user before moving higher for authentication protocol design, cryptographic key handling, YAOS/Yjs schema adaptation, Durable Object migrations, recovery semantics, or a bug that could lose or disclose vault data.
