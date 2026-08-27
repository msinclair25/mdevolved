import { describe, expect, it } from "vitest";
import {
  MDEVOLVED_ALBATROSS_COMPATIBILITY_PROFILE,
  MDEVOLVED_ALBATROSS_PROFILE_RESOURCE_URI,
  MDEVOLVED_EVE_COMPATIBILITY_PROFILE,
  MDEVOLVED_EVE_PROFILE_RESOURCE_URI,
  MDEVOLVED_OBSIDIAN_MIND_COMPATIBILITY_PROFILE,
  MDEVOLVED_OBSIDIAN_MIND_PROFILE_RESOURCE_URI,
  createMDevolvedAlbatrossMcpMergeConfig,
  createMDevolvedEveConnectionSource,
  createMDevolvedObsidianMindMcpMergeConfig,
} from "../src/index";

const MCP_URL = "https://private-deployment.example/mcp";

describe("canonical MDevolved client packs", () => {
  it("uses canonical resource, server, receipt, and tool identities", () => {
    expect(MDEVOLVED_ALBATROSS_PROFILE_RESOURCE_URI).toBe(
      "mdevolved://compatibility-profiles/albatross/v1",
    );
    expect(MDEVOLVED_EVE_PROFILE_RESOURCE_URI).toBe(
      "mdevolved://compatibility-profiles/eve/v1",
    );
    expect(MDEVOLVED_OBSIDIAN_MIND_PROFILE_RESOURCE_URI).toBe(
      "mdevolved://compatibility-profiles/obsidian-mind/v1",
    );
    expect(MDEVOLVED_ALBATROSS_COMPATIBILITY_PROFILE).toMatchObject({
      client: {
        serverName: "mdevolved",
        toolPrefix: "mcp__mdevolved__",
        trustCommand: "/mcp trust mdevolved",
      },
      legacyCompatibility: {
        serverName: "owd",
        receipt: ".owdignore",
      },
      format: "mdevolved-client-profile-v1",
      projectLifecycle: {
        receipt: ".mdevolvedignore",
        entryTool: "mcp__mdevolved__open_project",
      },
    });
    expect(MDEVOLVED_EVE_COMPATIBILITY_PROFILE).toMatchObject({
      connection: {
        connectionFile: "agent/connections/mdevolved.ts",
        connectionName: "mdevolved",
        toolPrefix: "mdevolved__",
      },
      format: "mdevolved-client-profile-v1",
      projectLifecycle: { receipt: ".mdevolvedignore" },
      legacyCompatibility: { connectionName: "owd" },
    });
    expect(MDEVOLVED_OBSIDIAN_MIND_COMPATIBILITY_PROFILE).toMatchObject({
      format: "mdevolved-vault-runtime-profile-v1",
      identity: { serverProjectReceipt: ".mdevolvedignore" },
      mcpTopology: {
        remoteCollaborationServer: { preferredName: "mdevolved" },
      },
      legacyCompatibility: { serverName: "owd" },
    });
  });

  it("generates canonical client configurations without changing authority", () => {
    const albatross = createMDevolvedAlbatrossMcpMergeConfig(MCP_URL);
    expect(JSON.parse(albatross)).toHaveProperty("mcpServers.mdevolved");
    expect(albatross).toContain("mcp-remote@0.1.38");
    expect(albatross).not.toContain("Bearer ");

    const eve = createMDevolvedEveConnectionSource(MCP_URL);
    expect(eve).toContain(`const mdevolvedMcpUrl = "${MCP_URL}";`);
    expect(eve).toContain('connector: "oauth/mdevolved"');
    expect(eve).toContain('principalType: "user"');
    expect(eve).not.toContain('principalType: "app"');

    const mind = JSON.parse(createMDevolvedObsidianMindMcpMergeConfig(MCP_URL));
    expect(mind).toEqual({
      mcpServers: { mdevolved: { type: "http", url: MCP_URL } },
    });
  });
});
