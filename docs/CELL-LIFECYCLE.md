# Managed cell lifecycle manifest

Every future managed tester cell must have one complete
`owd-managed-cell-build-manifest-v1` before its invitation is delivered. The
manifest is the exact, non-secret build list for that one isolated cell and the
source of its later deprovision plan.

The public schema lives at
[`infra/managed/cell-build-manifest.schema.json`](../infra/managed/cell-build-manifest.schema.json),
and the account-scoped rate-limit reservation schema lives at
[`cell-rate-limit-registry.schema.json`](../infra/managed/cell-rate-limit-registry.schema.json),
with synthetic data only in
[`disposable-cell-build.example.json`](../infra/managed/examples/disposable-cell-build.example.json).
Real manifests are private operational records. They do not belong in the
public repository, issue trackers, CI output, or customer-visible logs.

## Provisioning rule

Create the manifest with the cell and update it from each successful provider
response. Do not send the owner invitation until it records:

- the exact Community version, 40-character release commit, compatibility
  date, complete ordered migration ledger, and ledger digest;
- the Cloudflare account, Worker deployment/version, cron triggers,
  workers.dev state, Custom Domain objects, ordinary Worker routes, and their
  zone identifiers;
- the exact D1 database, R2 bucket, OAuth KV namespace, Durable Object
  namespace, and rate-limit namespace identifiers;
- runtime secret names only, never secret values, invitation tokens,
  credentials, recovery keys, passkey material, or vault content; and
- provision/expiry timestamps plus mandatory explicit data disposition,
  zero-authority precheck, and post-delete inventory requirements.

Rate-limit namespace IDs are account-scoped: reusing an ID across Workers
shares counters and violates cell isolation. Allocate three positive IDs under
an atomic lock in the private active-cell registry before Worker deployment.
The registry check rejects any ID already reserved by another provisioning,
active, or deprovisioning cell. The Community defaults `1001`–`1003` are not a
managed-cell allocator and must not be copied into private manifests.

Validate a private manifest from the repository root:

```sh
node scripts/cell-lifecycle-manifest.mjs check /private/path/cell.json \
  --registry /private/path/active-cells.json
```

The check fails closed on unknown fields, partial migration provenance,
missing resource identifiers, duplicate entries, malformed timestamps,
unsupported deletion modes, expired pre-invitation records, rate-limit
collisions, registry/manifest provenance mismatch, or a release/config
mismatch. The public JSON schema is compiled first; the CLI then checks
cross-field and account-registry invariants that JSON Schema cannot express.
The repository gate validates the synthetic example with
`pnpm cell:manifest:check`.

## Deprovisioning rule

Generate a redacted ordered plan by default:

```sh
pnpm cell:deprovision:plan -- /private/path/cell.json
```

An operator may add `--show-targets` only in a private terminal immediately
before an authorized deletion. The command generates a plan; it does not call
Cloudflare or delete anything.

Before deletion, add `authorizedDisposition` to the private manifest. Record
its bounded mode, authorization timestamp, owner-authorization receipt digest,
and either the zero-authority precheck or retained-export receipt digest. The
plan command fails closed until those non-secret references exist. Query
bounded counts and require zero owners, live sessions, vaults, Projects, and
active grants before using `discard-after-zero-authority-precheck` for a
never-claimed disposable cell. If any authority or content exists, stop and
use `retain-portable-export-before-delete` with its separately authorized
export evidence. Delete only the identifiers in the manifest, then list
Workers, routes, DNS records, D1, R2, KV, and Durable Object namespaces again.
The lifecycle is incomplete until every recorded target is absent and the
redacted receipt records that verification.

Delete every recorded secret by name before the Worker, verify its secret list
is unavailable afterward, and force the exact account/Worker deletion when a
Durable Object namespace is attached. Worker deletion owns scheduled triggers,
rate-limit bindings, versions, and Worker association; the generated plan
still lists each recorded binding for post-delete verification. Ordinary Worker routes remain explicit deletion items. A Worker Custom Domain is a
distinct account resource whose Cloudflare-managed DNS record is verified
absent after domain deletion; the manifest does not invent a separate DNS ID.
Durable Object state is destructive and must be verified against the recorded
namespace after Worker deletion; never reuse a tester namespace for another
owner. Remove the registry reservation only after the complete absence receipt
passes, so a failed cleanup cannot recycle a live namespace ID. An empty
`reservations` array is the valid terminal registry state after the final cell
has been removed. Validate that state only with the explicit
`post-delete-absence-verified` context, exact account, timestamp, and redacted
absence-receipt digest; the ordinary pre-invitation validator always requires
the exact cell reservation. Retain the account-scoped registry itself as the
allocation record.

Community installations do not depend on this manifest or any managed control
plane. Their complete deploy, upgrade, export, recovery, and deletion paths
remain inside the owner's Cloudflare account.
