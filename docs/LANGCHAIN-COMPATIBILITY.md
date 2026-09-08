# LangChain compatibility

This is a source-verified compatibility recipe for LangChain `1.4.0` at commit
`79cab2dc7f58be720cac43db3677b4c1fd971f91`, reviewed `2026-09-07`.
LangChain's built-in `langchain.mcp` package is currently beta, so this pin is
monitored and must be reviewed before it advances.

## Connect

Install the native MCP integration:

```bash
pip install "langchain[mcp]>=1.4.0,<1.5"
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
- MDevolved does not require MCP sampling, elicitation, or roots.
- Connecting does not grant access to local files, shells, worktrees, or another
  agent's authority.
- This profile does not claim vendor certification or a completed live
  LangChain acceptance run.
