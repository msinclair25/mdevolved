# Policy autopilot and operational continuity

MDevolved R4 adds a deliberately small policy and continuity layer over the R1–R3
Project, lead-lease, Run, evidence, checkpoint, and recovery services. MDevolved
still does not plan work, supervise agents, execute tools, own worktrees,
schedule inference, retry providers, or store provider runtime.

## Standing policy and deterministic Decisions

An owner may activate one immutable `mdevolved-policy-binding-v1` for the exact
active Project version and its existing `mdevolved-project-policy-v1`. The binding
records both input hashes, the two versioned gate profiles, fixed checkpoint
and drill intervals, and `ownerAuthored: true`. A lead cannot create, replace,
or edit that binding through MCP.

Every evaluation re-reads those exact canonical bodies and verifies both
owner-authored input hashes. A newer active Project version supersedes the old
binding and pauses its schedule in the same transaction; changing the
intervals for the same Project version remains forbidden policy editing.

The generic `evaluate_run_policy` tool evaluates only bounded durable inputs:

- the exact active owner-authored binding and Project version;
- the exact Project, Run, Work Item, and Work Packet;
- purpose-specific claims whose accepted evidence bodies are enumerated by
  that Work Packet and pass R2 object-integrity checks;
- the immutable EventBundles that carried those claims;
- an independent requested and passing review;
- the latest usable fenced Continuity Point for the same Work Item and packet;
- the current immutable R3 budget version when an elastic budget exists;
- open blocking Exceptions, conflicting claims, and the latest integrity scan;
  and
- the exact accepted bundle count at evaluation and again at completion.

The gate never consumes model confidence, raw transcripts, hidden reasoning,
terminal history, provider credentials, provider runtime, or production logs.
It emits an immutable `mdevolved-policy-decision-v1`: either every fixed check passes
and the outcome is `allow`, or the outcome is `exception` with an explicit
reason. Completion re-reads the canonical binding and Decision bodies and
rechecks the active Project version, binding, Run, bundle count, Continuity
Point, grant, lease, and fencing token in the commit transaction. Projects that
do not opt into R4 keep the unchanged R1–R3 path.

## Exception-only owner workflow

Authority expansion, policy editing, self-approval, destructive action,
protected-path access, conflicting evidence, budget exhaustion, integrity
failure, unsupported upgrade, and unsupported rollback are fixed
exception-only actions. The lead may surface these actions and may continue
only after an owner resolves an action that standing policy explicitly permits.
MDevolved never performs the requested privileged or destructive work itself.

The owner UI displays active/inactive bindings, the latest allow or Exception,
pending operational requests, integrity state, continuity age, and the latest
RPO, RTO, recovery-quality, and runtime-independence receipt. Policy activation
is owner-session and CSRF protected. A second activation with changed intervals
fails closed as policy editing. The owner-only, CSRF-protected
`POST /api/collaboration/projects/:projectId/exceptions/:exceptionId/resolve`
route records an explicit resolution; the lead cannot resolve an Exception or
expand the standing policy that judged its work.

## Bounded scheduling, not agent supervision

Migration `0033_policy_autopilot_r4.sql` adds one provider-neutral schedule per
active binding. The existing Worker scheduled handler passes the Cloudflare
scheduled-event timestamp into a bounded service. At most eight due schedules
are inspected per invocation. The service emits deterministic, idempotent
`mdevolved-operational-evidence-v1` requests for a Continuity Point or disposable
drill; it does not call an inference provider or launch an agent. Missed windows
are coalesced, and an uncompleted request backpressures another request of the
same kind.

An external execution harness remains responsible for consuming a request,
checkpointing under the current fenced lead lease, replacing a lost lead,
running a disposable drill, and reporting completion. The inert MCP resource
`mdevolved://adapters/policy-continuity/v1` documents this sequencing without code,
authority, credentials, or provider behavior. The append-only v3
`complete_continuity_drill` tool accepts only the exact pending scheduled
request, exact source Continuity Point, distinct replacement lead lease, and
current fencing token. Its commit atomically records the receipt and completes
that request. A replay returns the immutable receipt; an unrelated point,
source lead, stale lease, or mismatched request fails closed.

## Metrics and receipt redaction

`mdevolved-continuity-receipt-v1` derives metrics from explicit integer event times:

- `RPO = max(0, simulatedLeadLossAt - latestAcknowledgedPointAt)`;
- `RTO = replacementProductiveAt - simulatedLeadLossAt`;
- `continuity age = receiptEmittedAt - restoredPointAcknowledgedAt`; and
- `recovery quality bps = floor(10000 × passed checks / total checks)`.

The selected and restored acknowledgement are the same exact scheduled source
Continuity Point, and the required order is checkpoint ≤ simulated loss ≤
replacement productive ≤ receipt emitted. Loss before the scheduled due window
or any reversed timestamp fails closed.

Runtime independence is true only for a complete passing recovery in a fresh
Community installation. The contract requires a distinct replacement lead,
disposable cleanup, zero remaining authority, and false flags for raw bodies,
filenames, hostnames, customer data, credentials, OAuth state, transcripts,
hidden reasoning, terminal history, provider runtime, and production logs.

Run the synthetic local drill without Cloudflare or inference:

```sh
pnpm acceptance:continuity:local
```

The command builds a content-addressed portable operational export in a
temporary directory, restores all five R4 record kinds into a fresh logical
Community installation as quarantined evidence, verifies a distinct external
replacement lead and zero restored authority, emits only the redacted receipt,
and removes the disposable files and directories in a `finally` cleanup. The
acceptance command first runs the local Worker evidence gates, scheduled trigger,
replacement-lead completion fence, and fresh-install restore tests, then emits
the deterministic script receipt.

## Integrity, retention, export, and recovery

The scheduled integrity scan hashes a bounded page of R1–R4 D1/R2 bodies and
records missing or mismatched content without copying raw bodies into the
report. Partial coverage is explicitly `degraded`, never `ok`. R4 evidence
expiration is reference-aware: pending requests, the latest integrity report,
the last complete known-good integrity report, snapshot items, staged restores,
and operational dependencies prevent deletion. The R2 garbage collector also
treats R4 R2 keys as live references.

Owner export is available from the policy-operations portable endpoint as
`mdevolved-operational-record-export-v1`. The bounded export is dependency-complete:
it includes the exact R4 dependency graph and content-addressed referenced R1,
R2, and R3 record bodies, including every accepted R2 evidence body used by a
Decision. Encrypted snapshots inventory the five R4 record kinds and their
dependencies. Restore validates the exact canonical body, hash, byte length,
record identity, Project identity, portable identity, and dependency Project.
It inserts only `project_operational_records` with
`restore_state = 'quarantined'`; it creates no policy-binding, Decision,
schedule, request, integrity, receipt, grant, lease, actor, credential, OAuth,
or scheduler projection.

## Upgrade and rollback

Migration 0033 is additive, forward-only, STRICT, and trigger-free. It retains
transport-safe foreign keys and checks and has no destructive down-migration.
Activation records immutable upgrade evidence from 0032 to 0033 and rollback
evidence stating that rollback is application-only, never automatic. The v1,
v2, and v3 MCP capability resources and legacy portable-continuity format
remain unchanged. MD8 clients opt into the additive v4 capability resource.
Existing records map to reviewed completion; owner-consented solo completion
is frozen in the Run and its exact Decision. Migration 0038 is forward-only,
and application rollback resumes the stricter reviewed path without deleting
the additive columns.

The owner may supersede an active immutable binding with the other completion
mode while retaining the fixed checkpoint and drill intervals. Selecting
reviewed completion immediately revokes standing solo consent. Agent requests
still cannot edit policy or replace the owner-authored binding.

Managed-cell health is aggregate operational evidence only. It declares the
execution engine external and the Community data path independent; no managed
control plane is required to run or recover Community.
