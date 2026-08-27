# Hermes lead-continuity instructions

These thin instructions use the generic MDevolved MCP contract. Hermes-specific
scripts, conversation export, provider credentials, hidden reasoning, terminal
history, and runtime state are neither required nor accepted.

1. Read `mdevolved://collaboration/lead-continuity-capabilities/v1`. If the resource
   or required format is unsupported, continue with the legacy Project tools
   and do not pretend continuity support exists.
2. Call `resume_project` with the explicit Project context. Treat the latest
   Continuity Point as acknowledged operational context; owner Decisions and
   accepted records remain the only accepted truth.
3. With a separately authorized `project.lead` grant, call
   `claim_project_lead`. Keep the returned lease ID and fencing token only as
   ephemeral live authority. Renew before expiry when work continues.
4. At a meaningful boundary, call `checkpoint_project` with the exact current
   packet, predecessor, accepted Decision IDs, visible Artifact IDs, packet
   citation IDs, completed/open work, blockers, rejected approaches, risks,
   and one concrete next action. Retry only with the identical idempotency
   payload.
5. On `lead_lease_invalid`, `continuity_point_conflict`, packet staleness, or
   authorization failure, stop and resume/reclaim from authoritative MDevolved state.
   Never reuse a stale fence or infer authority from the historical point.

A replacement Hermes instance follows the same steps as any other client:
fresh authorization, `resume_project`, a new lead claim, then work from the
latest verified point. No transcript reconstruction is part of the contract.

## R1 live substitution drill

The repository includes a protocol-level reference harness for the disposable
R1 drill. It deliberately registers three independent OAuth clients: a source
lead, a replacement lead, and a fresh-restored-cell lead. It does not claim to
be the Hermes runtime. A release decision that names Hermes must still repeat
the source and replacement steps from Hermes itself using the generic contract
above.

Before running the harness, prepare two owner-isolated disposable cells. Do not
point it at a personal vault, the production deployment, or an existing test
cell whose cleanup ownership is uncertain. In the source cell, prepare a
synthetic vault and one initialized Project whose current Work Packet will stay
valid for the duration of the exercise. Keep its factual root Markdown
inventory available as `none` or a comma-separated list of root-level `.md`
filenames.

Run from an interactive owner terminal:

```sh
pnpm acceptance:continuity:live
```

Enter the disposable origins, vault names, Project identity, and factual root
Markdown inventory only at the harness prompts so they do not enter shell
history.

The harness then enforces these boundaries:

1. Authorize the source client and its exact Project, claim and renew the lead,
   then append a synthetic Continuity Point.
2. Remove the source client/session when prompted. The five-minute substitution
   clock starts when that removal is confirmed in the terminal.
3. Authorize the independently registered replacement client and its exact
   Project. The harness requires an exact Continuity Point match, a higher
   fencing token, and a successor checkpoint before the clock expires.
4. Make the explicit operator comparison requested by the harness. The
   comparison is against Git plus a runtime backup alone and concerns the
   visible objective and bounded completed/open work, blockers, rejected
   approaches, risks, and next action—not hidden reasoning or a transcript.
5. Remove the replacement. Using the owner UI, create an encrypted snapshot
   with Approved Intelligence, open it in a fresh owner session, and restore it
   into the blank target of the second disposable cell. Enter that cell's
   origin and target vault name only when the harness prompts; they are kept in
   process memory instead of the final receipt. The harness rejects the source
   origin and requires the owner to attest that the distinct target cell is
   fresh and has no pre-existing clients, grants, sessions, snapshots, or
   restored content.
6. Authorize the restored-cell client. The harness requires the exact restored
   Continuity Point, both authority flags set to false, a fresh fencing token
   of `1`, and an append-only successor before it verifies final revocation.

The emitted JSON receipt is redacted: it distinguishes the owner's fresh-cell
attestation from the machine-checked distinct-origin, restored-point, and
fencing facts, but contains no hostname, URL, vault name, Project ID, client
ID, grant, token, lease ID, or Continuity Point ID. Authorization
and Project approval URLs are necessarily shown while the operator completes
each browser ceremony; do not retain the terminal transcript.

The protocol receipt intentionally ends with
`disposableCellCleanupRequired: true`. R1 remains no-go until an owner verifies
that both cells' Worker, D1, R2, KV, routes, custom domains, OAuth clients,
grants, sessions, snapshots, and restored content are gone and records the
separate redacted cleanup receipt. Resource creation, deployment, and deletion
remain owner-authorized operations outside this harness.
