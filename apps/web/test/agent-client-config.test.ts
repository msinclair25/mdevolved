import { describe, expect, it } from "vitest";
import {
  AGENT_SERVER_NAME,
  createAntigravityConfig,
  createCursorInstallUrl,
  createEveConnectionSource,
  createObsidianMindMcpMergeConfig,
  createObsidianMindProjectMcpCommand,
} from "../src/agent-client-config";

const MCP_URL = "https://private-deployment.example/mcp";

describe("agent client setup helpers", () => {
  it("creates a Cursor one-click installer for the deployment MCP URL", () => {
    const installUrl = new URL(createCursorInstallUrl(MCP_URL));
    expect(installUrl.origin).toBe("https://cursor.com");
    expect(installUrl.pathname).toBe("/en/install-mcp");
    expect(installUrl.searchParams.get("name")).toBe(AGENT_SERVER_NAME);

    const encodedConfig = installUrl.searchParams.get("config");
    expect(encodedConfig).not.toBeNull();
    expect(JSON.parse(atob(encodedConfig ?? ""))).toEqual({ url: MCP_URL });
  });

  it("creates Antigravity's current remote MCP configuration shape", () => {
    expect(JSON.parse(createAntigravityConfig(MCP_URL))).toEqual({
      mcpServers: {
        [AGENT_SERVER_NAME]: {
          serverUrl: MCP_URL,
        },
      },
    });
  });

  it("creates an additive Obsidian Mind project setup", () => {
    expect(createObsidianMindProjectMcpCommand(MCP_URL)).toBe(
      "claude mcp add --transport http --scope project md-evolved 'https://private-deployment.example/mcp'",
    );
    expect(JSON.parse(createObsidianMindMcpMergeConfig(MCP_URL))).toEqual({
      mcpServers: {
        "md-evolved": {
          type: "http",
          url: MCP_URL,
        },
      },
    });
  });

  it("creates Eve's user-scoped connection module", () => {
    const source = createEveConnectionSource(MCP_URL);
    expect(source).toContain(`const owdMcpUrl = "${MCP_URL}";`);
    expect(source).toContain('connector: "oauth/owd"');
    expect(source).toContain('principalType: "user"');
    expect(source).toContain('"vault.read"');
    expect(source).toContain("resources: [owdMcpUrl]");
    expect(source).toContain("autoProvision: true");
    expect(source).not.toContain('principalType: "app"');
    expect(source).not.toContain("Bearer ");
  });
});
