# Portable agent compatibility

This receipt records the exact upstream surfaces reviewed for PAC1 on
2026-09-21. These are compatibility claims, not vendor endorsements or claims
that MDevolved controls a client's runtime.

| Client or standard | Reviewed release                                          | Source contract used by MDevolved                                                                                                                                   |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Plugins      | `1.0.0`                                                   | Root `plugin.json`, optional root `mcp.json`, immediate-child `skills/*/SKILL.md`, and `streamable-http`; OAuth remains client-managed.                             |
| OpenCode           | `v1.18.32` at `545f51d26cc39a907d2867492d498d9607ea5fa4`  | `opencode mcp add mdevolved --url <url>` creates a remote server; OpenCode owns its OAuth flow and credentials.                                                     |
| OpenClaw           | `v2026.9.5` at `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9` | Local archives with root Agent Plugins metadata are installed through `openclaw plugins install`; supported skill and HTTP MCP components are mapped into OpenClaw. |
| Gemini CLI         | `v0.60.0` at `733edcb597ce690ac2e2fe3b3b3690b60a4c8f27`   | `gemini mcp add mdevolved <url> --transport http` adds the remote MCP server.                                                                                       |
| GitHub Copilot CLI | `v1.0.87` at `d418dbf1061152afa17500cbc69478f8dce153d8`   | `copilot mcp add --transport http mdevolved <url>` adds the remote MCP server; Copilot owns its interactive authorization state.                                    |

Primary sources:

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
- [OpenCode MCP command source](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/mcp.ts)
- [OpenClaw bundle contract](https://github.com/openclaw/openclaw/blob/v2026.9.5/docs/plugins/bundles.md)
- [Gemini CLI command reference](https://github.com/google-gemini/gemini-cli/blob/v0.60.0/docs/cli/cli-reference.md)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

## Boundary

The dashboard emits only a public deployment URL. The generated Agent Plugins
archive contains no bearer token, client secret, OAuth state, runtime hook, or
script. The `mdevolved` CLI starts native client installers with an argument
array and `shell: false`; it does not write third-party configuration itself.

MDevolved continues to own only durable Project identity, bounded context,
evidence, recovery, revocation, and exceptions. Each client keeps its model,
filesystem and shell permissions, scheduler, worktrees, retries, transcript,
credentials, and runtime state. Any client not listed above can continue using
the universal remote-MCP URL or the authority-free portable handoff.

These receipts prove the reviewed setup contract and local generated-artifact
validation. They do not replace a live certification run in every proprietary
or fast-moving client version.
