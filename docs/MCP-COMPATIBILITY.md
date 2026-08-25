# MCP compatibility

This page freezes the protocol boundary that OWD must satisfy before the
project describes its public agent endpoint as MCP compatible. The claim is
about interoperable protocol behavior, not certification by every MCP client
vendor.

## Supported protocol eras

OWD exposes one remote, authenticated Streamable HTTP endpoint at `/mcp`.

| Era              | Transport behavior                                                                                    | Required entry point                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| MCP `2026-07-28` | Stateless Streamable HTTP. Each request carries the current protocol metadata and routing headers.    | `server/discover`                                     |
| MCP `2025-11-25` | Stateless legacy compatibility. There is no durable MCP session and no resumable server event stream. | `initialize`, followed by `notifications/initialized` |

The endpoint supports ordinary MCP Tools, Resources, and Prompts. It does not
claim stdio, the deprecated HTTP+SSE transport, MCP session persistence,
resumability, subscriptions, tasks, sampling, elicitation, roots, logging, or
completion support. Execution engines remain outside OWD.

## Product operations over MCP

The ordinary Project path uses three OWD tools over this unchanged protocol:

- `owd_resume` returns bounded structured context, a `checkpointBase`, and the
  applied `contextMode`;
- `owd_find` performs targeted cited recall; and
- `owd_checkpoint` passes that opaque base and context mode back unchanged with
  verified progress.

`focused` is the default resume mode. `independent` withholds peer conclusions
and provisional results; `synthesis` compares only separately attributable
durable results. Resume is not transcript or session replay. OWD keeps durable
records when a provider session expires, but cross-computer preservation
requires a deployed endpoint/account and backup.

Existing packet, lease, fencing, collaboration, and Run tools remain compatible
advanced operations. None of these operations makes OWD an agent runtime or
grants a client local shell, skill, or filesystem authority. The owner retains
root authority and immediate revocation.

## Authentication boundary

The endpoint is protected by OAuth 2.1-style authorization with RFC 9728
protected-resource metadata, authorization-code exchange, S256 PKCE, exact
resource indicators, Dynamic Client Registration, and Client ID Metadata
Documents. Plain PKCE, implicit grants, token exchange, bearer tokens in URLs,
and resource-prefix matching are not supported.

MCP transport compatibility never widens OWD authority. Every tool call still
revalidates the exact client, grant, audience, Project or vault/folder scope,
expiry, and authoritative revocation state. A conforming request that lacks
OWD authority is denied.

## Frozen conformance matrix

| Case                                                           | Expected result                                           |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| Current `server/discover` POST with matching routing headers   | JSON-RPC success                                          |
| Current `tools/list`, `resources/list`, or `prompts/list` POST | JSON-RPC success                                          |
| Current named call/read/get with matching `Mcp-Name`           | JSON-RPC success or the ordinary OWD authorization result |
| Legacy initialize and initialized notification                 | JSON-RPC success, then HTTP `202` for the notification    |
| Legacy tools/resources/prompts request                         | JSON-RPC success                                          |
| GET or DELETE on the stateless endpoint                        | HTTP `405`                                                |
| Present but untrusted `Origin`                                 | HTTP `403`                                                |
| Unsupported content type                                       | HTTP `415`                                                |
| Current routing header/body mismatch                           | HTTP `400`, JSON-RPC `HeaderMismatch` (`-32020`)          |
| Unsupported protocol version                                   | HTTP `400`, JSON-RPC `UnsupportedProtocolVersion`         |
| Unknown method                                                 | HTTP `404`, JSON-RPC method-not-found (`-32601`)          |
| JSON-RPC batch                                                 | Rejected; OWD does not execute any member                 |
| Request body over 64 KiB                                       | HTTP `413`; OWD does not execute it                       |
| Missing or invalid bearer token                                | HTTP `401` with the protected-resource challenge          |
| Valid token missing a tool's scope                             | HTTP `403` with `insufficient_scope`                      |
| Revoked grant or client                                        | The next request is denied                                |

The body limit applies before JSON parsing and before MCP or OWD dispatch. The
transport must not inspect an unbounded clone of the request stream. Modern
header validation takes precedence over OWD's tool-specific challenge and
retirement responses, so custom behavior cannot hide a protocol mismatch.

## Compatibility and recovery invariants

- Requests without an `Origin` remain valid for non-browser MCP clients. A
  present Origin must be localhost-class or match the request endpoint host.
- Current and legacy clients share the same tools, resources, prompts, OAuth
  policy, revocation behavior, and OWD authorization checks.
- Unknown protocol versions and unknown OWD contract versions fail closed.
- Capabilities remain additive. Older clients can ignore OWD Resources and
  Prompts without losing the portable read-only vault baseline.
- MCP inputs never include hidden reasoning, provider credentials, raw
  terminal history, customer logs, or restored live authority.

## Public claim

After the frozen matrix passes locally, the precise public claim is:

> OWD implements authenticated remote MCP Streamable HTTP for the current
> `2026-07-28` protocol and stateless legacy `2025-11-25` clients, exposing
> ordinary MCP Tools, Resources, and Prompts with OAuth 2.1 and S256 PKCE.

The M1 facade is implemented in the local candidate; this document does not
claim that candidate has been deployed to production.

This is a protocol-compatibility statement. Named clients are described as
independently validated only when a dated receipt for that exact client and
version exists.

## Acceptance evidence

The Worker conformance test named `serves current and stateless legacy MCP`
uses a real OAuth authorization-code grant and the deployed Worker entrypoint
in the local Workers runtime. It exercises current discovery, Tools,
Resources, and Prompts; the legacy handshake; routing-header and version
errors; methods, media type, Origin, batch, malformed JSON, and body-limit
rejections. The complete agent-access suite preserves the existing grant,
folder, Project, and immediate-revocation behavior.

Before a deployment claim, run the complete repository quality gate and then
run `pnpm acceptance:agent:production` against an owner-approved disposable
deployment. That live acceptance client proves both protocol eras through one
OAuth grant and emits only redacted counts, timings, and version names. It is
not a substitute for a separate named-client receipt.

Normative references:

- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Cloudflare MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [Cloudflare MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Cloudflare MCP server security](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/)
