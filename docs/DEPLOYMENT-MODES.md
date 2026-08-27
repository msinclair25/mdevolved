# Deployment Modes and Repository Boundaries

## Current status

Community remains the complete single-owner, multi-vault reference data plane
and independent self-hosted release path. Its source is public under
Apache-2.0. The optional managed service is still an invitation-only alpha;
public MDevolved Cloud accounts, billing, and service-level commitments remain later
gates. A managed trial cell is not a public managed launch.

## Distribution principle

MDevolved has one open-source product core and optional operational convenience:

| Mode            | Infrastructure owner                      | Data location                          | Availability        |
| --------------- | ----------------------------------------- | -------------------------------------- | ------------------- |
| Community       | The user                                  | The user's Cloudflare account          | Public alpha source |
| Managed alpha   | The service operator                      | One isolated Cloudflare cell per owner | Invitation-only     |
| MDevolved Cloud | The service operator                      | One isolated Cloudflare cell per owner | Planned public mode |
| Managed BYOC    | The user, with narrowly scoped automation | The user's Cloudflare account          | Possible later mode |

Community is not a reduced feature tier. It must deploy, upgrade, back up,
recover, and connect agents without a managed-service account or control-plane
request. Hosted value comes from onboarding, upgrades, monitoring, retention,
support, and recovery operations rather than withholding core capabilities.

## Repository topology

The machine-readable boundary lives in `repository-topology.json` and is checked
by `pnpm policy:check`.

| Path                       | Responsibility                                             | Dependency boundary                                         |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web`                 | Owner dashboard shipped with each cell                     | Community only                                              |
| `apps/worker`              | Integrated Community/data-plane Worker                     | Community only                                              |
| `packages/contracts`       | Versioned public runtime schemas and client contracts      | Environment-neutral                                         |
| `packages/yaos-core`       | Pinned live-sync compatibility                             | Data plane only                                             |
| `packages/obsidian-plugin` | Companion vault client                                     | Public data-plane contracts only                            |
| `migrations`               | Append-only schema for one owner cell                      | Never control-plane state                                   |
| `apps/control-plane`       | Future accounts, billing, provisioning, and cell lifecycle | May depend on public Community contracts; never the reverse |
| `infra/managed`            | Future managed provisioning definitions                    | Versioned releases and synthetic identifiers only           |

The future control plane is a separate deployable application. It is not on the
sync, browse, search, backup, restore, or MCP request path. Its loss may block
new account provisioning or account-management actions, but existing cells
must continue their core vault operations.

The data plane uses Cloudflare bindings for its own resources. A future
provisioner may use the Cloudflare account API because its job is to create and
bind resources that do not exist yet; those credentials belong only to the
managed provisioning boundary and must never be exposed to a customer cell.

## Managed cell contract

Each managed owner receives a cell built from a pinned Community release. A
cell has its own:

- stable hostname and WebAuthn relying-party boundary;
- D1 database and migration ledger;
- R2 bucket;
- OAuth protocol KV namespace;
- Durable Object namespace and vault identities;
- socket-signing, session, and other runtime secrets;
- quotas, retention policy, audit stream, and health status.

The preferred production boundary is a dedicated resource, not merely a
`tenant_id` column. No request may select a customer's storage binding from an
untrusted hostname or user-supplied identifier. Provisioning records the
expected hostname-to-cell mapping, and the deployed Worker receives only that
cell's bindings.

The first-owner claim remains atomic inside every cell. A managed account is
not a second vault administrator and does not weaken data-plane authorization.
Support tooling must not create an undocumented owner session or content-read
endpoint.

### Managed tester delivery boundary

When a managed tester is invited, the operator pre-provisions the complete
isolated cell and sends one owner-claim link for its permanent hostname. The
tester does not receive or fork the development repository, import a
Cloudflare build, choose a branch, configure bindings, or use an operator
account. Those are Community self-hosting or internal release activities, not
managed onboarding.

The tester package contains only the version-matched start guide and public
product disclosures. It must not contain an internal acceptance Project,
development-vault notes, private evidence, operator runbooks, worktrees, source
branches, resource ledgers, or other testers' metadata.
Pre-invitation verification proves the cell is unclaimed and empty and that
Project discovery cannot return operator-only metadata. This delivery contract
does not by itself claim that the public MDevolved Cloud service or a particular
trial cell has passed its release gate.

Provisioning is incomplete until the private per-cell build record satisfies
the versioned [managed cell lifecycle manifest](CELL-LIFECYCLE.md). That record
captures every created resource and the exact later deletion inventory without
storing secret values or vault metadata.

## Trust disclosure

Community users trust their own Cloudflare account and the reviewed MDevolved release.
Managed users additionally trust the service operator's Cloudflare account and
operational staff. Live sync state and searchable materializations are not
end-to-end encrypted from that operator. MDevolved Cloud must state this plainly and
must not claim zero-knowledge storage.

Backup private identities remain owner-held. The managed service may store the
public age recipient and encrypted artifacts but cannot decrypt a conforming
backup without the owner's private identity.

The control plane should retain account, entitlement, deployment version,
quota, and health metadata only. Vault names, paths, note bodies, search terms,
OAuth tokens, vault credentials, passkey assertions, and backup private keys do
not belong in control-plane databases, billing metadata, analytics, or support
systems.

## Community publication and release gate

Before publishing any Community release:

1. Scan the complete Git history for credentials, account identifiers,
   production binding IDs, and vault content.
2. Verify the pinned one-click deployment from clean GitHub and Cloudflare
   accounts. The user chooses **Deploy MDevolved**, approves the two providers, and
   opens the permanent MDevolved URL; they do not select a branch, type a command,
   name a binding, create a resource, or apply a migration.
3. Complete the disposable-vault backup and recovery drill.
4. Complete the disposable Project Handoff/Review/Decision drill with two
   independent agent harnesses, including Approved-only recovery and optional
   Unvetted Intelligence quarantine recovery.
5. Publish the security model, supported-version policy, data-flow disclosure,
   export/deletion guidance, and reproducible plugin artifacts.
6. Keep telemetry absent by default; any future Community diagnostics upload
   requires explicit consent and a preview of the redacted payload.

The public repository is a sanitized Community snapshot with no private
production receipts or managed-operations history. A release is pinned to a
reviewed commit and the same **Deploy to Cloudflare** path. Publication does not
move missing automation or operational work onto managed users.

The Community installation simplicity contract is:

- one public start link and one primary **Deploy MDevolved** action;
- provider sign-in/authorization and an explicit final deploy confirmation are
  the only infrastructure choices;
- release configuration owns the Worker name, build, complete fresh migration
  chain, D1/R2/KV/Durable Object provisioning, health check, and permanent URL;
- the permanent companion-plugin action opens MDevolved Sync in Obsidian Community
  Plugins; until listing, the version-matched desktop installer is the primary
  alpha path, while BRAT and ZIP remain technical fallbacks;
- upgrades use a versioned, rollback-protected path and cannot run migration
  discovery or DDL during ordinary Worker requests; and
- setup continues inside MDevolved with one next action at a time. GitHub and
  Cloudflare vocabulary does not leak into vault, recovery, or agent setup.

The current managed alpha removes the GitHub and Cloudflare approvals by
pre-provisioning one isolated cell. Community adoption does not wait for a
public hosted service to become script-free and terminal-free.

## Automated managed `v2.0` build-ready gate

The manual private-alpha cell path does not imply that an account, billing, or
automated provisioning control plane exists. Before the first control-plane
feature ticket, accept a versioned package that defines:

- the Community-versus-hosted product promise, trial/plan hypotheses, quotas,
  retention choices, and per-cell cost envelope;
- account, entitlement, cell, release, hostname, quota, health, suspension, and
  deletion records containing no vault-content metadata;
- provisioning, secret rotation, upgrade, migration, rollback, export,
  deletion, incident, support, and audited break-glass state machines;
- infrastructure-as-code and release-artifact interfaces with least-privilege
  credentials and synthetic examples only;
- control-plane outage behavior, operator trust disclosure, downstream-model
  egress wording, privacy/data-flow inventory, and owner-held recovery identity
  responsibility;
- cross-cell denial, hostname routing, log isolation, quota, billing, backup,
  restore, export, deletion, rollout, rollback, and incident acceptance tests;
  and
- an ordered implementation backlog in which every ticket identifies its
  threat boundary, migration, test, rollback, operational metric, and cost
  effect.

The gate passes only if the first synthetic managed cell can be designed from a
pinned Community release without adding shared tenancy to the Community schema
or placing the control plane on a vault, recovery, or MCP request path. Passing
this gate means MDevolved Cloud is ready to build, not available.

## Managed beta gate

A hosted beta does not open to untrusted users until synthetic cross-cell tests
prove hostname, D1, R2, Durable Object, KV, secret, log, quota, export, and
deletion isolation. The beta also requires:

- documented operator access and an audited break-glass procedure;
- per-cell cost ceilings, rate limits, storage quotas, and retention;
- backup and restore drills from more than one isolated cell;
- customer export and complete deletion workflows;
- incident response, privacy, and support boundaries;
- versioned rollout, rollback, and migration behavior;
- an explicit statement that downstream AI providers receive only the content
  an owner-authorized MCP client chooses to send.

The current external validation uses a separately provisioned managed cell for
one trusted tester. Its onboarding and collaboration friction becomes release
input; it must not share the developer's production bindings, vaults, Project
catalog, or operator metadata.
