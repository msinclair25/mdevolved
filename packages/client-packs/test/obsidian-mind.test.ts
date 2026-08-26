import { describe, expect, it } from "vitest";
import {
  OBSIDIAN_MIND_COMPATIBILITY_PROFILE,
  OBSIDIAN_MIND_CONTINUITY_GUIDANCE,
  OBSIDIAN_MIND_PROFILE_PROMPT,
  OBSIDIAN_MIND_PROFILE_RESOURCE_URI,
  createObsidianMindMcpMergeConfig,
  createObsidianMindProjectMcpCommand,
  serializeObsidianMindCompatibilityProfile,
} from "../src/obsidian-mind";

const MCP_URL = "https://private-deployment.example/mcp";

describe("Obsidian Mind compatibility profile", () => {
  it("pins the reviewed upstream contract and dual-server topology", () => {
    expect(OBSIDIAN_MIND_PROFILE_RESOURCE_URI).toBe(
      "owd://compatibility-profiles/obsidian-mind/v1",
    );
    expect(OBSIDIAN_MIND_COMPATIBILITY_PROFILE).toMatchObject({
      detection: {
        file: "vault-manifest.json",
        property: "template",
        value: "obsidian-mind",
      },
      format: "owd-vault-runtime-profile-v1",
      id: "obsidian-mind",
      identity: {
        localRoutingMarker: ".om-project",
        serverProjectReceipt: ".owdignore",
      },
      mcpTopology: {
        localKnowledgeServer: {
          preferredName: "om",
          transport: "stdio",
        },
        remoteCollaborationServer: {
          preferredName: "md-evolved",
          transport: "streamable-http",
        },
      },
      projectDefaults: {
        documentationDecision: "keep-current-locations",
        dynamicContentRoots: ["perf/h*-*/"],
        memoryRoot: "memories",
      },
      source: {
        commit: "538522e4ea660cdc1265f8ef71ef43966e1d9a96",
        license: "MIT",
        repository: "https://github.com/breferrari/obsidian-mind",
        reviewedAt: "2026-07-31",
        version: "8.3.1",
      },
      toolPolicy: {
        localReadTools: ["search", "expand", "recall", "reason", "health"],
        localWriteTools: ["record_work", "remember"],
      },
    });
    expect(
      JSON.parse(serializeObsidianMindCompatibilityProfile()),
    ).toStrictEqual(OBSIDIAN_MIND_COMPATIBILITY_PROFILE);
  });

  it("generates an additive remote MCP entry without replacing Mind", () => {
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
    expect(OBSIDIAN_MIND_CONTINUITY_GUIDANCE).toContain(
      "Never replace the existing `qmd` or `om` server entry",
    );
    expect(OBSIDIAN_MIND_PROFILE_PROMPT).toContain(
      "Preserve every existing MCP entry",
    );
  });

  it("carries the 8.3 promotion and single-writer rules into agent guidance", () => {
    expect(OBSIDIAN_MIND_CONTINUITY_GUIDANCE).toContain(
      "block or heading anchor",
    );
    expect(OBSIDIAN_MIND_CONTINUITY_GUIDANCE).toContain(
      "The promoted note still wins any conflict",
    );
    expect(OBSIDIAN_MIND_PROFILE_PROMPT).toContain("localVaultAccess");
    expect(OBSIDIAN_MIND_CONTINUITY_GUIDANCE).toContain(
      "MDevolved resume project",
    );
    expect(OBSIDIAN_MIND_CONTINUITY_GUIDANCE).toContain("OWD resume project");
    expect(OBSIDIAN_MIND_PROFILE_PROMPT).toContain(
      "do not let the raw capture overrule the promoted note",
    );
  });

  it.each([
    "http://remote.example/mcp",
    "https://user:password@private-deployment.example/mcp",
    "https://private-deployment.example/mcp#secret",
  ])("rejects unsafe MCP URL %s", (url) => {
    expect(() => createObsidianMindMcpMergeConfig(url)).toThrow();
    expect(() => createObsidianMindProjectMcpCommand(url)).toThrow();
  });
});
