# Run the continuity proof with Claude Code

This is the Claude Code companion to the [Codex proof](CODEX-CONTINUITY-PROOF.md).
It starts a disposable local MDevolved instance, connects Claude automatically,
and tests whether a fresh session can continue from saved Project memory.
No MDevolved passkey, public tunnel, deployed Project, or manual MCP setup is needed.

## Run it

From this repository, with dependencies installed and a recent Claude Code CLI
already signed in:

```sh
claude auth status
pnpm proof:claude:local --allow-model-usage --model sonnet
```

If you are not signed in, use `claude auth login` once. The runner uses Claude's
normal credential custody; it does not read or copy your login tokens. `sonnet`
is an example alias; use `opus` or an exact model ID available to your account.
The live command consumes Claude usage. There are at most three CLI sessions,
each bounded to 120 seconds, 12 MCP calls and 2 MB of CLI output. These are not
a hard dollar/token cap. The runner does not automatically retry a failed proof.

To ask your existing Claude Code session to launch it:

> In this MDevolved repository, read docs/CLAUDE-CONTINUITY-PROOF.md and run
> `pnpm proof:claude:local --allow-model-usage --model sonnet`. Model usage is
> authorized. Report the final receipt; do not change production or weaken
> permissions to make the test pass.

Your outer Claude Code session may ask permission to launch the command, according
to its own settings. The three test sessions do not require interactive approval.
Do not disable the outer harness's safety policy or bypass managed restrictions.

This command is for the **local Claude Code CLI**, including a local terminal
launched by Claude Code. Claude's cloud chat/Cowork connectors cannot reach your
computer's loopback server. A remote Claude environment must check out the repo
and run its own local test instance; this is not a public chat connector URL.

## What is tested

1. A no-memory control must report that the routing policy is missing.
2. A separate Claude session saves a randomized policy and useful failure through
   the real MDevolved MCP tools.
3. A fresh session receives only the Project identity and task, retrieves the
   saved facts, performs the classification, and saves a linked successor.

The grader uses the same nine checks as Codex. Claude's streamed tool requests
must match the real local server's observed requests and structured receipts.
An unauthorized tool, missing server receipt, wrong scope, failed checkpoint,
permission denial, mismatched session, timeout, or invented answer cannot pass.
Look for exit status zero and `"passed": true`; a confident final answer alone
is not proof. Claude receipts say `live-claude-mcp`, never `live-codex-mcp`.

## Isolation and cleanup

The test runs unchanged product Worker code with fresh local storage and synthetic
owner/Source/Project data. Setup automates real OAuth PKCE and Project consent
using a synthetic owner session. No test bypass is added to production.

Each Claude process gets a fresh temporary directory, session persistence disabled,
restricted mode, no built-in tools, no skills or Chrome integration, only the
explicit MCP configuration, and `dontAsk` with just the three memory tools
pre-approved. CLAUDE.md discovery, auto memory, background tasks and cloud
connectors are disabled. Normal Claude authentication remains available; `--bare`
is deliberately not used because it disables subscription OAuth login.
Managed organization policy still applies. This is not a container/OS isolation
certification and does not override policy restrictions.

The synthetic bearer is supplied through the child's environment. The temporary
MCP config contains an environment-variable reference, not the secret. Model
reasoning, transcripts, raw tool payloads and credentials are not written to the
receipt. Server evidence stays in memory; temporary configs and local storage are
removed on normal completion/failure. A force-killed parent can leave temporary
files. Provider processing/retention and the CLI's own non-session metadata are
outside this test's custody.

## Free checks and current status

```sh
pnpm test:proof:claude
pnpm proof:claude:local --smoke
pnpm test:proof:codex:local
```

These do not call a model. `--smoke` proves automatic local setup/resume, not Claude
continuity. The local runtime needs permission to bind loopback sockets.

**CP2 acceptance:** a documented, isolated Claude runner with offline adapter,
failure, cleanup, and real local-server evidence checks. A Claude live pass is
separate and requires running the opt-in command above. This implementation does
not claim a live Claude result, Codex-to-Claude transfer, a second-computer test,
subscription cancellation, spontaneous checkpointing, or a measured success rate.

Validated October 8, 2026: all 26 offline continuity checks passed, including six
Claude adapter/failure tests; the real local MCP integration test and Claude
setup-only smoke check passed. Repository policy and diff checks passed. Review
kept the shared grader and verifies Claude requests against server-observed
receipts rather than trusting the model's reported tool results. Changes remain
local; no publication, deployment, or live Claude run was performed for CP2.

CLI flags were checked against installed Claude Code 2.1.283 and the official
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[programmatic usage](https://code.claude.com/docs/en/headless),
[MCP configuration](https://code.claude.com/docs/en/mcp), and
[environment variables](https://code.claude.com/docs/en/env-vars).
