# October 7 compatibility and security update

## Outcome and acceptance

Local milestone: make useful cloud/editor connection paths easier, review
upstream drift, and patch newly reported dependency advisories. Acceptance
requires tested generated setup, desktop/narrow selection behavior, a clean
dependency audit, and passing relevant Worker/package checks. This is not a
live certification of third-party clients or a production release.

Added dashboard paths for Claude / Cowork, Zed, and Cline. Existing Claude CLI
setup is explicitly labeled Claude Code. All use the existing remote MCP
service, owner approval, and authoritative grant checks. No new adapter, token
store, scheduler, transcript import, schema, or migration is needed.

## Cowork: what changed and why it matters

Anthropic's [October 6 cloud rollout](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
moves new Pro/Max Cowork tasks to cloud execution across web, desktop, and mobile;
existing local tasks and organization settings have exceptions. Local folder
and local connector access still depends on the desktop being available.
Claude's own cloud continuity already solves part of the cross-device problem.

MDevolved's complementary value is portable, reviewed Project state across
providers, with bounded access to already-published Source material even when
the originating computer is offline. Offline reads are only as fresh as the
last successful sync/materialization. Local edits and local tools still need
their own running client. A remote connector does not upload chat history or
grant access to an entire computer. Selected context returned to Claude is
processed by Anthropic under the user's provider settings; self-hosting does
not mean that context never reaches the chosen model provider.

## Useful additions, not more infrastructure

| Client          | Reviewed setup surface                                                                                                                                         | Evidence limit                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude / Cowork | [Custom remote connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), URL plus browser authorization | Organization availability varies; no live account session exercised                                           |
| Zed             | [Native remote server UI and OAuth](https://zed.dev/docs/ai/mcp)                                                                                               | Native Agent supports tools/prompts; external agents and terminal CLIs have separate configuration boundaries |
| Cline           | [MCP configuration](https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx), explicit `streamableHttp`, no auto-approvals                          | Generated config and local UI tested, not a live extension OAuth session                                      |

[Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md)
is a useful next candidate with remote HTTP/OAuth extensions.
[OpenHands](https://github.com/OpenHands/docs/blob/main/openhands/usage/cli/mcp-servers.mdx)
and [Amp](https://ampcode.com/docs/customize/mcp) also offer remote MCP paths,
but hosted-runtime routing and authorization custody need dedicated checks.
They can use generic MCP where supported today; no named live certification is
claimed. New integration choices do not change client tool/sandbox permissions.

## Existing upstream drift

Read-only release/source review observed Eve `0.73.0`, Connect `2.4.1`, Obsidian
Mind `9.1.0`, OpenCode `1.18.35`, OpenClaw `2026.9.8`, Gemini CLI `0.63.0`,
Copilot CLI `1.0.93`, and LangChain `1.4.3`. Hermes, Albatross, and mcp-remote
still match their reviewed releases. Public release/package metadata is not
equivalent to a full source or live compatibility test: existing reviewed pins
remain unchanged.

Obsidian Mind's new ShardMind prerequisite and Windows startup guidance merit a
separate compatibility review. Eve/Connect need connection/OAuth source review
before advancing their installed fixtures. Targeted OpenCode/Gemini/OpenClaw
setup review found no command break, but incomplete full-tree comparisons do
not support silently certifying their newer releases.

## Security dependency changes

The initial package audit reported 37 findings (1 critical, 12 high, 18 moderate,
6 low), including transitive development dependencies. This does not establish
37 exploitable production flaws. For example, the MCP advisory concerns its
OAuth client and the Hono advisory concerns JSX boundary rendering; package
presence alone is not proof that those paths are used by this Worker.

Scoped fixes: MCP SDK `1.31.0`, MCP client `2.2.0`, Hono `4.13.7`, fast-uri
`3.1.8`, ip-address `10.7.1`, moment `2.31.0`, brace-expansion `5.0.12`,
proxy-addr `2.0.8`, sharp `0.35.5`, source-map-js `1.2.2`, and Undici
`7.29.1` / `8.10.2`. Undici overrides preserve each installed major line.
Existing framework/runtime pins, bindings, compatibility date, synchronization
stack, and stored authorization contracts are unchanged.

Primary advisories include [MCP OAuth client credentials](https://github.com/advisories/GHSA-6qxp-vccf-f47h),
[Hono JSX](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv), and
[proxy-addr trust matching](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).
The updated lockfile audit reports zero known vulnerabilities on October 7.

## Validation and delivery

- `pnpm test`: passed, including 568 core tests at that point and all marketing,
  continuity, operations, sync, folder, CLI, desktop, and plugin suites.
- `pnpm check`: passed (format, lint, types, generated binding drift, policy,
  identity, upstream fixture, release, and cell-manifest checks).
- Production build and `pnpm deploy:dry-run`: passed without deployment.
- After review simplification, focused setup/MCP/client-pack tests: **68/68**;
  typecheck and changed-file lint passed. Two tests of removed, unnecessary
  helper functions were deliberately removed, not skipped.
- Final desktop/narrow setup browser checks: **2/2**, including URL-first Cline
  setup with JSON hidden under Advanced/manual setup.
- Lockfile audit: **zero known vulnerabilities**. Full browser/release gates and
  real client OAuth sessions are not claimed by this local update.

Independent review found no security blocker but identified two unnecessary
helpers and ambiguous Cline configuration instructions. Both helpers were
removed. Root source verification also corrected Claude's current Customize
connector URL; Cline now leads with native URL entry, with explicit JSON merge
instructions only in Advanced. No grants, credentials, or approval policy were
added to generated configuration. The remaining uncertainty is live third-party
client behavior, not a known local test failure.

The original October 7 validation was local only. On October 10, the owner
authorized publishing and merging this update alongside the disposable Codex
and Claude continuity proof runners. A fresh dependency audit reports zero
known vulnerabilities; the combined candidate must pass the release gate and
GitHub CI before merge. Live Claude testing remains a separate owner-run check.
No deployment, client login, paid model execution, or npm publication is part of
this delivery. No schema changes or remote resources require cleanup. Rollback
is a code/manifest/lockfile revert; production remains on its existing version
until a separately authorized deployment.
