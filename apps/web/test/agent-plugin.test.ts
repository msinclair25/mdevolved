import Ajv2020 from "ajv/dist/2020.js";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import mcpSchema from "../../../compatibility/agent-plugins/mcp.schema.json";
import pluginSchema from "../../../compatibility/agent-plugins/plugin.schema.json";
import {
  AGENT_PLUGIN_FILENAME,
  createAgentPluginArchive,
  createAgentPluginFiles,
} from "../src/agent-plugin";

const MCP_URL = "https://private-deployment.example/mcp";

describe("per-deployment Agent Plugins package", () => {
  it("validates both manifests against the frozen Agent Plugins 1.0 schemas", () => {
    const files = createAgentPluginFiles(MCP_URL);
    const ajv = new Ajv2020({ strict: true });
    expect(ajv.validate(pluginSchema, JSON.parse(files["plugin.json"]))).toBe(
      true,
    );
    expect(ajv.validate(mcpSchema, JSON.parse(files["mcp.json"]))).toBe(true);
  });

  it("contains one exact deployment URL and no credential material", () => {
    const files = createAgentPluginFiles(MCP_URL);
    expect(JSON.parse(files["mcp.json"])).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        mdevolved: { type: "streamable-http", url: MCP_URL },
      },
    });
    const serialized = Object.values(files).join("\n");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("access_token");
  });

  it("emits a deterministic, installable zip with the expected root layout", () => {
    const first = createAgentPluginArchive(MCP_URL);
    const second = createAgentPluginArchive(MCP_URL);
    expect(first).toEqual(second);
    const archive = unzipSync(first);
    expect(Object.keys(archive).sort()).toEqual([
      "mcp.json",
      "plugin.json",
      "skills/mdevolved-project/SKILL.md",
    ]);
    expect(
      strFromU8(
        archive["skills/mdevolved-project/SKILL.md"] ?? new Uint8Array(),
      ),
    ).toContain("mdevolved_checkpoint");
    expect(AGENT_PLUGIN_FILENAME).toBe("mdevolved-agent-plugin.zip");
  });

  it("rejects insecure, credential-bearing, stateful, and wrong-path endpoints", () => {
    const credentialBearingUrl = [
      "https",
      "://",
      "user",
      ":",
      "password",
      "@example.com/mcp",
    ].join("");
    for (const url of [
      "http://example.com/mcp",
      credentialBearingUrl,
      "https://example.com/mcp?token=secret",
      "https://example.com/mcp#state",
      "https://example.com/api",
    ]) {
      expect(() => createAgentPluginFiles(url)).toThrow();
    }
    expect(() =>
      createAgentPluginFiles("http://localhost:8787/mcp"),
    ).not.toThrow();
  });
});
