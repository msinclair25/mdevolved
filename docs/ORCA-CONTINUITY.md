# Orca continuity adapter

## Status and boundary

The R3 Orca adapter is an inert, script-free compatibility projection. Orca
ADE is an optional execution workbench, not an OWD runtime, scheduler, owner,
identity provider, or recovery source. The generic OWD Project, Run, Actor,
EventBundle, Exception, budget, delta, and Continuity Point records remain
authoritative. This document describes the frozen local R3 contract; it does
not claim a live Orca exercise has passed. A live disposable exercise requires
separate human authorization and is outside the local automated build until it
is explicitly run.

## Mapping contract

An authorized lead may submit one bounded `owd-orca-projection-v1` descriptor
through the generic `project_orca_metadata` service/tool. It carries the exact
Project and Run, an optional Actor, the literal provider label `orca`, and
optional evidence references:

| Orca value             | OWD destination  | Meaning                                                          |
| ---------------------- | ---------------- | ---------------------------------------------------------------- |
| Worktree reference     | `worktreeRef`    | Claimed location/evidence pointer, not a filesystem grant        |
| Branch reference       | `branchRef`      | Claimed branch label, not branch control                         |
| Commit SHA             | `commitSha`      | Immutable-looking source evidence; OWD does not verify Git state |
| Pull-request reference | `pullRequestRef` | Claimed review pointer; no PR mutation or approval               |
| Session reference      | `sessionRef`     | Claimed session correlation; no transcript or session authority  |

All fields are bounded metadata. The projection's authority flags are always
`restoredAuthorityAllowed: false` and `liveAuthorityIncluded: false`. Orca
names, task IDs, dispatch IDs, agent labels, model labels, terminal output,
conversation text, tool traces, environment variables, credentials, and OAuth
state are not accepted as OWD authority or required evidence.

OWD never launches or stops Orca agents, sends terminal input, creates or
deletes worktrees, creates branches, opens or merges pull requests, schedules
work, or changes Orca/Codex/Claude permissions. The caller remains responsible
for verifying its own worktree, branch, commit, pull request, and session
state. A projection is an append-only evidence record attached to a generic
Run/Actor and may be contradicted by later evidence or an Exception.

## Elastic Run relationship

Orca actors use the same opt-in R3 elastic profile as any other harness: at
most 32 active and 64 total actor records, registration batches of 16, bundle
submissions of 8, and cursor delta pages of 100. Batch retries are idempotent;
same-key payload changes are explicit replay conflicts. Backpressure returns
bounded retry metadata but does not move scheduling or retry ownership into
OWD. `get_run_context` without a mode remains the R2-compatible snapshot path;
delta mode is bound to one exact Project/Run and stable sequence cursor.

Budgets are reported by the harness as logical units and cost microunits.
Exhaustion creates a blocking budget Exception; OWD does not calculate vendor
pricing. Observations are aggregate counts and latency/retry summaries only.

## State loss and provider-neutral resumption

Orca state is deliberately disposable. If a worktree, branch, pull request, or
session disappears, OWD retains only the accepted projection metadata and
generic Run evidence that was durably submitted. A separately authorized
provider-neutral lead resumes by:

1. reading the exact Run snapshot or the next stable delta cursor;
2. checking open Exceptions, budget state, actor expiry/recovery, and the latest
   Continuity Point;
3. claiming a fresh lead lease/fencing token where required; and
4. registering a new actor with only the scopes needed for the next bounded
   operation.

No Orca session, lease, actor, grant, credential, OAuth state, worktree,
branch, pull request, scheduler state, or runtime context is revived. An
expired or abandoned predecessor remains expired/revoked; a replacement's
scopes are a strict subset. If the projection later becomes stale, OWD
preserves it only as non-authoritative evidence rather than selecting a
provider-side winner.

## Portability, retention, and privacy

Orca projections participate in the same encrypted snapshot, portable export,
quarantine restore, and hot/warm/cold/quarantine retention as other R3 records.
Cleanup is limited to 64 records per pass and waits for a closed Run; a
pending/ready snapshot, staged restore, or open/blocking Exception keeps the
projection. Plane, account, budget, recovery, and Continuity Point records are
outside R3 volume cleanup.
Portable descriptors use no D1 row ID, R2 key, Worker hostname, managed-cell
identifier, or provider API as required restore semantics.

Restore validates schema, capability, integrity, and dependency bounds before
staging. Orca projections restore only as owner-visible quarantined evidence
with both authority flags false. They never create live Run/Actor rows, grants,
leases, receipts, budgets, credentials, OAuth state, or execution schedules.
Raw transcripts, hidden reasoning, terminal history, provider runtime,
credentials, OAuth state, and production/customer logs are excluded.

## Compatibility and acceptance

The R3 capability resource is additive. R1/R2 clients continue to discover
their existing resources and tools, and old `get_run_context` callers receive
the unchanged snapshot contract. Unknown required formats or capabilities fail
closed before storage or restore; an Orca adapter cannot widen a legacy grant.

Local tests should cover valid and invalid metadata, byte bounds, exact
Project/Run/Actor binding, replay versus payload conflict, cursor stability,
cross-Run denial, revocation/fence races, actor replacement, budget
exhaustion, quarantine-only restore, and Orca-state loss followed by
non-Orca resumption. Synthetic fixtures contain only disposable IDs, hashes,
and metadata. Live vendor acceptance remains human-authorized and unverified
until run.

## M4 user recipe

Connect the same generic OWD MCP endpoint from the owner's chosen client, then
let Orca execute work in its own worktree. At a checkpoint, the client submits
the bounded outcome and evidence; a fresh Codex, Claude, or Hermes client later
calls `owd_resume` for the same Project or Run. That handoff does not restore an
Orca session, terminal, worktree, branch, credentials, or scheduler state.

OWD does not launch Orca, dispatch its agents, manage retries, or certify a
commit or pull request. A worktree reference is evidence supplied by the
harness and remains subject to the owner's normal review.
