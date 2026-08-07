# R4 policy-autopilot and operational-continuity freeze

**Milestone:** R4 — Policy autopilot and operational continuity

**Frozen:** 2026-08-06 before R4 implementation

**Acceptance decision:** accept the local R4 candidate only when one synthetic
research Run and one synthetic coding Run close without routine owner action,
unsupported self-approval and policy editing fail closed, and one scheduled
disposable drill replaces a lead, restores into a fresh Community
installation, and emits a redacted receipt with measured RPO, RTO, recovery
quality, continuity age, and runtime independence.

## Preserved dirty baseline

R4 starts directly on `codex/continuity-r1` at
`cc1ab645180e86e67c0bab8c3d5f4080be7446f7`. The pre-R4 status contains 33
modified tracked files and the complete untracked R1/R2/R3 candidates listed
by `git status --short`; nothing is staged. The baseline status digest is
`4c39f2b77688f452323068bbaf0bd28d5539ad91a830dea16cd79683cbf7259a`
and the tracked binary-diff digest is
`94418484fa286bf9b73db2f9aed2272bd846db1316cac6baeadc5e89e5dfa061`.
The untracked-file hashes were captured before the first R4 edit. In
particular, `docs/CONTINUITY-PLAN.md` was preserved at
`8b5aa94e936082bb817ce25d8ab85d3d7da9188ad683fbfeff734ea710fc42cf`.

The exact reported R3 gate receipt entering R4 is:

- `pnpm check` passed;
- `pnpm test` passed with marketing 8, continuity harness 5, repository 392,
  and plugin 12 tests;
- `pnpm test:integration` passed with 392 tests;
- `pnpm build`, `pnpm deploy:dry-run`, and `git diff --check` passed.

R4 does not rerun or reinterpret that historical receipt. The final R4 gate
will run once from the exact R4 candidate.

## Versioned records

R4 adds an additive operational-record family. Every body is canonical JSON in
content-addressed R2 storage with an immutable D1 descriptor, bounded size,
retention metadata, and `liveAuthorityIncluded=false` plus
`restoredAuthorityAllowed=false`.

| Format                        | Purpose                                                                                                               | Live-authority rule                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `owd-policy-binding-v1`       | Owner-authored activation of one fixed gate profile for an exact Project version and existing standing Project policy | Created only through an owner session; no MCP create/edit operation           |
| `owd-policy-decision-v1`      | Deterministic allow/exception result for one exact Run and evidence cutoff                                            | Lead may evaluate but cannot author or activate its policy                    |
| `owd-operational-evidence-v1` | Bounded checkpoint/drill request, integrity result, upgrade/rollback provenance, or managed-cell health evidence      | A request is inert; execution remains in an external harness                  |
| `owd-continuity-receipt-v1`   | Redacted result of a disposable continuity drill                                                                      | Contains measurements and negative authority assertions, never live authority |

Restore stages every R4 record as owner-only quarantine. It never recreates a
policy activation, schedule, job claim, grant, lease, actor, credential, OAuth
state, scheduler authority, or other live authority.

## Deterministic completion truth tables

An R4 gate consumes only bounded immutable database projections and verified
content-addressed bodies. It rejects raw transcripts, terminal history,
provider runtime, credentials, customer or production logs, model confidence,
and hidden reasoning as inputs.

All checks below must pass. A missing, malformed, oversize, cross-Project,
restored, stale, conflicting, or integrity-failed input is a deterministic
exception, never an inferred pass.

| Check                       | Research                                 | Coding                                  | Exact evidence                                                                                                                   |
| --------------------------- | ---------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Owner policy                | required                                 | required                                | live `owd-policy-binding-v1`, exact Project version, existing `owd-project-policy-v1`, canonical hashes                          |
| Run identity                | `purpose=research`                       | `purpose=coding`                        | exact active Run, Work Item, Work Packet, policy, Project                                                                        |
| Result evidence             | `research.finding` and `research.source` | `coding.change` and `coding.validation` | non-null SHA-256 claims whose bodies exist in accepted packet/content evidence                                                   |
| Independent review          | required                                 | required                                | request and passing completion by an actor distinct from the producer                                                            |
| Continuity                  | required                                 | required                                | latest non-restored Continuity Point for the exact Work Item and packet, acknowledged after Run start                            |
| Exceptions                  | none open/blocking                       | none open/blocking                      | exact Project/Run exception projection                                                                                           |
| Conflicts                   | none                                     | none                                    | no claim key has more than one accepted value digest                                                                             |
| Budget                      | within bound or not applicable           | within bound or not applicable          | immutable R3 budget/version rows when the Run is elastic                                                                         |
| Integrity                   | complete                                 | complete                                | D1 metadata plus verified referenced R2 size, metadata hash, and content hash                                                    |
| Requested owner-only action | none                                     | none                                    | no authority expansion, policy edit, self-approval, destructive action, protected path, unsupported upgrade, or rollback request |

An allow Decision records every check, exact evidence hashes and record IDs,
the policy-binding hash, the Continuity Point, actor-independent review, input
bundle count, and evaluation time. Completion rechecks live grant, source
grant, vault, lease, fencing token, blocking exceptions, decision identity,
bundle cutoff, and checkpoint identity at commit time. Legacy Projects without
an R4 binding retain the accepted R2/R3 completion behavior.

## Exception-only owner workflow

The generic lead API may evaluate the fixed policy, read operational requests,
checkpoint through the existing fenced service, and list Exceptions. It has no
policy create, edit, activate, self-approve, exception-resolve, destructive,
upgrade, rollback, or scheduler-authority tool. A valid attempt to request one
of those actions appends a blocking Exception and a denied PolicyDecision. The
owner UI may activate the fixed policy and resolve an Exception, but resolution
does not grant authority or execute the requested action.

## Scheduling and replay

Cloudflare Cron remains one bounded UTC trigger over provider-neutral
services. Its `scheduledTime` determines the due window. For each live schedule
the service inserts at most one immutable request per schedule/window. Duplicate
delivery replays the same durable request; overlap cannot create a second due
request. Work is page-bounded and failures remain visible for the next trigger.
The trigger never launches agents, chooses models, manages retries or
worktrees, invokes provider inference, or restores authority.

Checkpoint requests are consumed by a compatible external lead, which uses the
existing fenced `checkpoint_project` operation. Drill requests are consumed by
the disposable local drill harness. Community operation requires neither a
managed control plane nor a provider-specific adapter.

## Receipt redaction and metrics

The receipt includes opaque local record IDs, integer timestamps and durations,
counts, gate versions, schema/migration identifiers, booleans, and SHA-256
digests. It excludes note bodies, filenames, prompts, transcripts, hidden
reasoning, terminal history, credentials, tokens, cookies, OAuth state,
provider runtime/session IDs, customer data, production logs, hostnames,
binding IDs, and managed-cell identifiers.

- **RPO seconds:** `max(0, simulatedLeadLossAt - latestAcknowledgedPointAt)`.
- **RTO seconds:** `replacementProductiveAt - simulatedLeadLossAt`.
- **Continuity age seconds:** `receiptEmittedAt - restoredPointAcknowledgedAt`.
- **Recovery quality basis points:**
  `floor(10000 * passedRecoveryChecks / totalRecoveryChecks)`, where the fixed
  checks are record-count parity, dependency closure, body integrity, latest
  Continuity Point readability, expected objective/open-work/next-action
  recovery, and absence of all live authority.
- **Runtime independence:** true only when a generic replacement reads the
  restored state in a fresh Community installation and the export/receipt
  asserts no provider runtime, credentials, OAuth state, grants, leases,
  actors, policy authority, or scheduler authority.

Negative or reversed times are invalid. Metric inputs are integer seconds from
the synthetic drill clock so expected values are exact.

## Recovery, retention, compatibility, and rollback invariants

- Snapshot/export dependency closure includes every R4 body and the exact R2
  evidence bodies cited by a PolicyDecision.
- Retention is reference-aware and never deletes an active policy binding, the
  latest allow/exception Decision for an active Run, the latest Continuity
  receipt, the last known-good integrity result, any retained snapshot/restore
  reference, or any referenced R2 body.
- Integrity scans are bounded and report complete versus partial coverage. A
  mismatch creates blocking evidence and cannot be promoted into a gate pass.
- Migration `0033` is additive, forward-only, and trigger-free. Application
  rollback leaves its tables and immutable R2 bodies in place. There is no
  destructive down-migration and no automatic rollback.
- R1/R2 capability resources and R3 capability v2 remain byte-for-byte
  compatible. R4 is a new additive capability profile; old clients may ignore
  it and old Projects continue their existing behavior.
- Managed-cell health evidence is an optional projection over the same
  Community contracts. The Community Worker, D1, R2, KV, and Durable Object
  path imports no managed code and has no control-plane dependency.

## Frozen hostile fixtures

Required fixtures cover research/coding allow and deny, self-approval, policy
editing, cross-Project/Run references, revocation and fence races, malformed
and oversize evidence, missing/conflicting evidence, exception resolution,
scheduled replay, overlap/backpressure, exact metric calculations, redaction,
lead replacement, fresh Community restore with zero authority, integrity
tampering, upgrade/rollback evidence, old-client negotiation, and all R1–R3
regressions.
