# LangChain compatibility

This is a source-verified compatibility recipe for LangChain `1.4.2` at commit
`a18de590e7ccf5c647fbf3d689e5f1a15f78e9f5`, reviewed `2026-09-21`.
LangChain's built-in `langchain.mcp` package is currently beta, so this pin is
monitored and must be reviewed before it advances.

## Connect

Install the native MCP integration:

```bash
pip install "langchain[mcp]>=1.4.2,<1.5"
```

Use `MCPAdapter` over FastMCP's OAuth client. Keep tokens in the client's normal
OAuth custody rather than source code or MDevolved records.

```python
from fastmcp import Client
from langchain.mcp import MCPAdapter

client = Client("https://YOUR-MDEVOLVED-HOST/mcp", auth="oauth")

async with MCPAdapter(client) as adapter:
    tools = await adapter.list_tools()
```

Give each independently authorized agent its own OAuth client and use the
returned tools for the normal MDevolved Project lifecycle. MDevolved stores
bounded Project context and evidence; LangChain or LangGraph still owns models,
graphs, scheduling, retries, tools, and local execution.

## Boundaries

- The beta adapter's normal LangChain surface focuses on tools. Use the
  underlying FastMCP client when an application needs MCP Prompts or Resources.
- `MCPAdapter` now preserves structured MCP results as tool artifacts and
  requires bare string targets to be explicit HTTP(S) URLs, avoiding accidental
  local subprocess execution.
- MDevolved does not require MCP sampling, elicitation, or roots.
- Connecting does not grant access to local files, shells, worktrees, or another
  agent's authority.
- This profile does not claim vendor certification or a completed live
  LangChain acceptance run.
