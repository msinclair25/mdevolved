# Portable agent compatibility

This receipt records the exact upstream surfaces reviewed for PAC1, refreshed on
2026-09-24. These are compatibility claims, not vendor endorsements or claims
that MDevolved controls a client's runtime.

| Client or standard | Reviewed release                                          | Source contract used by MDevolved                                                                                                                                   |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Plugins      | `1.0.0`                                                   | Root `plugin.json`, optional root `mcp.json`, immediate-child `skills/*/SKILL.md`, and `streamable-http`; OAuth remains client-managed.                             |
| OpenCode           | `v1.18.32` at `545f51d26cc39a907d2867492d498d9607ea5fa4`  | `opencode mcp add mdevolved --url <url>` creates a remote server; OpenCode owns its OAuth flow and credentials.                                                     |
| OpenClaw           | `v2026.9.6` at `eb377ac59e6c9fd6c7705028034812becf00271b` | Local archives with root Agent Plugins metadata are installed through `openclaw plugins install`; supported skill and HTTP MCP components are mapped into OpenClaw. |
| Gemini CLI         | `v0.61.0` at `bb523741c7429a44d03e964bc124c7c92df59d5f`   | `gemini mcp add mdevolved <url> --transport http` adds the remote MCP server.                                                                                       |
| GitHub Copilot CLI | `v1.0.88` at `c13b3dcae4f1e176c5a074c0d063a6e9f258081f`   | `copilot mcp add --transport http mdevolved <url>` adds the remote MCP server; Copilot owns its interactive authorization state.                                    |

Primary sources:

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
- [OpenCode MCP command source](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/cli/cmd/mcp.ts)
- [OpenClaw bundle contract](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/plugins/bundles.md)
- [Gemini CLI command reference](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/cli/cli-reference.md)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

The refreshed Gemini MCP-add implementation and OpenClaw bundle documentation
are unchanged from the previous pins. OpenCode's reviewed release is still
current. [Copilot 1.0.88 release notes](https://github.com/github/copilot-cli/releases/tag/v1.0.88)
describe MCP reconnect, OAuth, and tool-cache fixes; its proprietary
implementation was not inspected. No generated setup command or archive layout
needed changing. These checks do not certify a live install or OAuth session.

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
