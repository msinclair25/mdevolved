# Codex fresh-session continuity proof

For Claude Code, use the [Claude continuity proof](CLAUDE-CONTINUITY-PROOF.md),
which reuses this experiment and grader with a separate provider adapter.

## Milestone and acceptance

**CP1: a repeatable Codex proof harness.** Close the implementation milestone when
the runner, objective grader, hostile-fixture tests, and operating instructions
work locally. Separately, a **live proof** passes only when actual Codex sessions
produce the required successful MCP evidence. Offline unit tests are not a live
proof and do not close MD11's unassisted-user evidence requirement.

The question is deliberately narrow: can a fresh Codex process retrieve a saved
synthetic Project decision, remember a rejected approach, perform the next task,
and save a linked successor without another owner intervention?

## The experiment

1. **No-memory control:** a fresh process receives a batch-classification task
   without its routing policy. It must report insufficient context, not invent
   the missing policy. No MCP server is enabled.
2. **Save:** another fresh process receives a randomized threshold policy, a
   unique reference, a synthetic rejected approach, and a next action. It calls
   `mdevolved_resume`, then `mdevolved_checkpoint` on the exact approved Project.
3. **Continue:** the first process has exited and its temporary workspace is
   gone. A third process gets only the Project identity and task—not the saved
   policy, failure, unique reference, prior output, or conversation. It resumes
   through MCP, classifies the batch, and checkpoints its continuation.
4. **Grade outside the model:** require successful Project-scoped MCP responses,
   a new thread identity, exact facts in server-returned current state, correct
   classification, the remembered rejected approach, and a successor checkpoint
   linked to the saved checkpoint. Model prose alone cannot pass.

Randomized facts are generated at run time. The output schema contains field
definitions, never expected answers. This is a small decision-continuation
experiment, not a coding benchmark or a claim that the agent executed tests.
The control is an ablation of memory access, not a comparison against native
provider memory, Git documentation, or competing products.

## Run the free local checks

```sh
pnpm test:proof:codex
pnpm proof:codex --help
```

These do not run models, contact MDevolved, read credentials, or mutate cloud
state. The tests are also included in `pnpm test:continuity:harness` and therefore
the ordinary repository test command. No paid-model job is added to GitHub CI.

## Fully automated local proof (recommended for development)

With Codex already signed in, run:

```sh
pnpm proof:codex:local --allow-model-usage --model YOUR-AVAILABLE-CODEX-MODEL
```

No passkey, browser consent, production Project, Cloudflare account, or persistent
MCP configuration is needed. The runner starts the actual production Worker code
in Cloudflare's local test harness with fresh D1/R2/KV/DO simulations, applies the
repository migrations, seeds an entirely synthetic owner session and empty Source,
and exercises the real OAuth PKCE and Project consent APIs automatically. It does
not add a login bypass or test endpoint to the product.

A loopback-only MCP relay accepts a short-lived synthetic bearer and only the
three memory tools for the exact test Project. The token is supplied to Codex via
a child-process environment variable, never command arguments or model prompts.
Fresh sessions retain normal model authentication and read-only sandboxing. The
ordinary Codex tool host remains available; shell, browser, apps and unrelated
tools remain disabled. All local storage and listeners are discarded on normal
success/failure. No production data is read or changed. Interrupted/killed runs
may require cleanup of their own temporary test directories.

For setup and security checks without model usage:

```sh
pnpm proof:codex:local --smoke
pnpm test:proof:codex:local
```

These verify real MCP checkpoint/readback, rejection of unauthenticated/browser/
wrong-Project/unsupported-tool relay requests, authoritative grant revocation,
and listener shutdown. They are not a substitute for the live-model result.
This path intentionally does **not** test real passkey enrollment, remote TLS,
or an existing user's consent journey. Model login/subscription availability is
still a prerequisite; no testing tool can remove provider account requirements.

## Optional remote proof: prepare once

Use a dedicated, disposable deployment/Project containing synthetic material
only. Do not select a real working Project: this experiment advances its
continuity head with synthetic checkpoints. A Project-specific grant is strongly
preferred; a prompt or tool allowlist is not a replacement for server-side scope.

Use your installed, authenticated Codex CLI and normal MDevolved owner consent.
On the machine chosen for the experiment, register the dedicated connection:

```sh
codex mcp add mdevolved-proof --url https://YOUR-DISPOSABLE-HOST/mcp
codex mcp login mdevolved-proof --scopes vault.read,project.initialize.request,project.connect.request
```

Then use the ordinary agent-first setup to create/approve the disposable Project
on that connection with read and lead/checkpoint capabilities. Confirm that
`mdevolved_resume` works for its exact Project ID. A bootstrap connection alone
is not a Project grant. The test does not create or expand grants, bypass
consent, renew OAuth manually, or read/copy credential files.

The runner requires CLI support for `--ephemeral`, `--ignore-user-config`,
`--output-schema`, JSONL MCP events, the listed feature switches, and per-server
`enabled_tools`. Unsupported versions fail rather than using a less-isolated
fallback. Verify with `codex exec --help` and `codex features list`.

## Explicit live invocation

```sh
pnpm proof:codex --live --allow-model-usage \
  --disposable-project YOUR-SYNTHETIC-PROJECT-UUID \
  --url https://YOUR-DISPOSABLE-HOST/mcp \
  --model YOUR-AVAILABLE-CODEX-MODEL
```

Choose a model available under your account; none is hardcoded. Live mode consumes
Codex usage and may incur provider charges depending on authentication and plan.
There are at most three Codex processes, each limited to 120 seconds, 12 observed
MCP calls, and 2 MB of output. Each session can make multiple model requests.
These bounds are **not a hard token or dollar limit**. No automatic rerun occurs.

The runner ignores the user's normal configuration, disables shell, browser,
apps, plugins, hooks, memory, host skill discovery, and subagent features for its
invocations, and enables only the three Project-memory tools. Existing execution
policy rules are not bypassed. It keeps normal
Codex authentication custody, uses the read-only sandbox, and never enables
permission bypass. This reduces contamination; it is not an OS/container
isolation guarantee. Run on a dedicated test account/machine if you need that
stronger boundary. Do not provide secrets or real data in the synthetic Project.

## Receipt, failure, and cleanup

Exit zero plus `passed: true` means every listed check passed. Any failed check,
authorization failure, missing result, timeout, unexpected tool, or incompatible
event shape is a failed/unestablished proof. Authentication/Project setup failures
are not evidence that continuity itself is broken.

Only a bounded JSON receipt with booleans and explicit evidence limits goes to
stdout. Prompts, model reasoning, raw event streams, server payloads, Project IDs,
endpoint URLs, credentials, and conversation IDs are not saved in the receipt.
Temporary directories contain only the generic answer schema and are removed
after each process, including failures. `--ephemeral` avoids Codex rollout-file
persistence; normal provider-side processing/retention still applies.

The two remote checkpoints remain in the disposable Project as evidence. A failed
run may leave its first checkpoint. The runner never deletes remote records or
revokes grants; retire the dedicated test deployment through its normal recovery
and cleanup procedure when finished. Never rerun against a Project in active use.

## What this does not prove

- Cancelling an actual subscription, migrating hidden state, or preserving an
  unsaved chat. This tests independence from the old conversation, not the old
  provider: all sessions use the same account, client authority, and provider.
- Autonomous checkpoint adoption: saving is explicitly prompted in this first
  experiment. The next experiment should assess ordinary task instructions.
- Cross-provider transfer, a second computer, real coding success, broad user
  satisfaction, or live revocation/restore. Existing Worker tests independently
  cover scope, revocation, idempotency, and recovery contracts.
- Ground-truth correctness of arbitrary remembered claims. The fixture is known
  synthetic data and the grader has its expected answer.

Next evidence stages are ordinary-task checkpointing, a bounded code change with
independent tests, another provider on a separate grant, and unassisted users.
Do not label any of these stages passed merely because CP1's local tests pass.

## Sources and implementation receipt

The runner follows [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [OpenAI's skill-evaluation guidance](https://developers.openai.com/blog/eval-skills):
fresh `codex exec`, structured final responses, and checking observed tool events.
Local CLI help and features were inspected on October 7, 2026.

Implementation validation: **11/11 new offline tests**, **18/18 combined
continuity-harness tests**, targeted lint, formatting, repository policy, and
diff checks passed. Child-process tests cover timeout, output overflow, malformed
events, nonzero exit, and removal of schema-only temporary directories. Grader
tests reject wrong Projects, absent server evidence, repeated thread identities,
false completed claims, incorrect resume-token binding, and self-linked successors.

Independent review found and prompted repairs to checkpoint-base binding, seed
completion validation, and successor distinctness. Additional local execution
features were explicitly disabled. The runner kills its direct Codex child on
timeout; it is not a descendant-process containment system. No product runtime
was modified, so a full production release/browser gate was not repeated.

### Automated local live receipt

**Passed:** three real, ephemeral Codex CLI 0.160.1 sessions using the configured
`gpt-6-astra` model against the actual Worker in disposable local storage. All nine
checks passed: fresh processes, honest no-memory control, exact scope, resume
first, durable seed checkpoint, correct checkpoint-base binding, server readback,
correct continuation, and a distinct linked successor checkpoint. The two
connected sessions each made exactly one successful resume and checkpoint call.
No passkey or owner action occurred during setup or execution.

Validation: **20/20 continuity-harness tests**, the local Worker security/lifecycle
integration test, formatting, targeted lint, repository policy and diff checks
passed. The full production release/browser gate was not repeated for test-only
scripts; production Worker code, migrations and deployment configuration are
unchanged. No dependencies were added.

Rework and earlier failures are not counted as passes: initial runs disabled the
Codex tool host and could not call MCP; a later run recovered the correct memory
but made a rejected checkpoint attempt before retrying. The strict grader rejected
it. Keeping the normal tool host and clarifying the minimal checkpoint arguments
produced the passing run without relaxing the grader. Startup diagnostics also
exposed a local harness binding-handle race; normal file-based runner checks pass.
Independent review found no auth bypass and identified persistent Wrangler logs;
the runner now disables Wrangler file logging and telemetry before importing it.

Delivery is local and uncommitted, not pushed or deployed. Authorized model usage
was consumed; no Cloudflare resources or production Projects were created. This
is one successful synthetic same-provider trial after repairs, not a measured
success rate, cross-provider proof, or unassisted-user acceptance.
