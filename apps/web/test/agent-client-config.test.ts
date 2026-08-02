import { describe, expect, it } from "vitest";
import {
  AGENT_SERVER_NAME,
  createAlbatrossAuthorizationCommand,
  createAlbatrossMcpMergeConfig,
  createAlbatrossSetupKit,
  createAntigravityConfig,
  createCodexSetupCommands,
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

  it("creates a complete least-privilege Codex setup", () => {
    expect(createCodexSetupCommands(MCP_URL)).toBe(
      "codex mcp add md-evolved --url 'https://private-deployment.example/mcp'\n" +
        "codex mcp login md-evolved --scopes vault.read,project.initialize.request,project.connect.request",
    );
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

  it("creates Albatross's pre-authorized pinned bridge setup", () => {
    expect(createAlbatrossAuthorizationCommand(MCP_URL)).toContain(
      "mcp-remote@0.1.38 mcp-remote-client",
    );
    expect(JSON.parse(createAlbatrossMcpMergeConfig(MCP_URL))).toEqual({
      mcpServers: {
        owd: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote@0.1.38",
            MCP_URL,
            "--header",
            "X-OWD-Albatross-Participant:primary",
            "--transport",
            "http-only",
            "--auth-timeout",
            "120",
            "--static-oauth-client-metadata",
            '{"client_name":"Albatross via mcp-remote","client_uri":"https://github.com/morganlinton/Albatross"}',
            "--silent",
          ],
        },
      },
    });
    const setup = createAlbatrossSetupKit(MCP_URL);
    expect(setup).toContain(".albatross/prompt.md");
    expect(setup).toContain("/mcp trust owd");
    expect(setup).toContain("mcp__owd__resume_project");
    expect(setup).not.toContain("@latest");
    expect(setup).not.toContain("Bearer ");
  });
});
