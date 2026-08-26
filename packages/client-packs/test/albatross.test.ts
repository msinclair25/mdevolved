import { describe, expect, it } from "vitest";
import {
  ALBATROSS_COMPATIBILITY_PROFILE,
  ALBATROSS_PROFILE_RESOURCE_URI,
  ALBATROSS_WORKSPACE_PROMPT,
  createAlbatrossAuthorizationCommand,
  createAlbatrossMcpMergeConfig,
  createAlbatrossSetupKit,
  serializeAlbatrossCompatibilityProfile,
} from "../src/albatross";

const MCP_URL = "https://private-deployment.example/mcp";

describe("Albatross compatibility profile", () => {
  it("pins the reviewed client and temporary bridge contracts", () => {
    expect(ALBATROSS_PROFILE_RESOURCE_URI).toBe(
      "owd://compatibility-profiles/albatross/v1",
    );
    expect(ALBATROSS_COMPATIBILITY_PROFILE).toMatchObject({
      bridge: {
        authBootstrapBinary: "mcp-remote-client",
        authTimeoutSeconds: 120,
        clientName: "Albatross via mcp-remote",
        license: "MIT",
        package: "mcp-remote",
        temporary: true,
        transportStrategy: "http-only",
        version: "0.1.38",
      },
      client: {
        configFile: "agent.config.json",
        consumesInitializeInstructions: false,
        consumesPrompts: false,
        consumesResources: false,
        consumesStructuredContent: false,
        mcpProtocolVersion: "2025-06-18",
        nativeRemoteTransport: false,
        promptFile: ".albatross/prompt.md",
        requestTimeoutSeconds: 30,
        serverName: "owd",
        toolPrefix: "mcp__owd__",
        trustCommand: "/mcp trust owd",
      },
      connection: {
        auth: "oauth-2.1-pkce",
        participantHeader: "X-OWD-Albatross-Participant",
        transport: "stdio-to-streamable-http",
      },
      format: "owd-client-profile-v1",
      id: "albatross",
      projectLifecycle: {
        entryTool: "mcp__owd__open_project",
        receipt: ".owdignore",
        waitTimeoutSeconds: 20,
      },
      runtime: {
        automation: expect.stringContaining("current OWD Work Packet"),
        evaluation: expect.stringContaining("/iterate"),
      },
      source: {
        commit: "0543226b800ee57659f200c1ef928925868c90c9",
        license: "MIT",
        repository: "https://github.com/morganlinton/Albatross",
        version: "2.0.3",
      },
    });
    expect(JSON.parse(serializeAlbatrossCompatibilityProfile())).toStrictEqual(
      ALBATROSS_COMPATIBILITY_PROFILE,
    );
  });

  it("generates a pinned additive stdio bridge configuration", () => {
    const config = JSON.parse(createAlbatrossMcpMergeConfig(MCP_URL));
    expect(config).toEqual({
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
    expect(createAlbatrossMcpMergeConfig(MCP_URL)).not.toContain("@latest");
    expect(createAlbatrossMcpMergeConfig(MCP_URL)).not.toContain("Bearer ");
  });

  it("pre-authorizes OAuth outside Albatross's startup timeout", () => {
    expect(createAlbatrossAuthorizationCommand(MCP_URL)).toBe(
      'npx -y -p mcp-remote@0.1.38 mcp-remote-client \'https://private-deployment.example/mcp\' --header \'X-OWD-Albatross-Participant:primary\' --transport http-only --auth-timeout 120 --static-oauth-client-metadata \'{"client_name":"Albatross via mcp-remote","client_uri":"https://github.com/morganlinton/Albatross"}\'',
    );
  });

  it("partitions independent participants without treating the label as a secret", () => {
    const primary = createAlbatrossMcpMergeConfig(MCP_URL, "primary");
    const reviewer = createAlbatrossMcpMergeConfig(MCP_URL, "reviewer-1");
    expect(primary).toContain("X-OWD-Albatross-Participant:primary");
    expect(reviewer).toContain("X-OWD-Albatross-Participant:reviewer-1");
    expect(reviewer).not.toBe(primary);
    expect(createAlbatrossSetupKit(MCP_URL, "reviewer-1")).toContain(
      "The participant header is not a credential",
    );
  });

  it("ships the missing client guidance in the bounded workspace prompt", () => {
    expect(ALBATROSS_WORKSPACE_PROMPT.length).toBeLessThan(8_192);
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain("mcp__owd__resume_project");
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain("timeoutSeconds: 20");
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain("/path fork");
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain("/auto");
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain("/iterate");
    expect(ALBATROSS_WORKSPACE_PROMPT).toContain(
      "ignores server initialize instructions",
    );
    const setupKit = createAlbatrossSetupKit(MCP_URL);
    expect(setupKit).toContain("/mcp trust owd");
    expect(setupKit).toContain("Connect this project to MDevolved");
    expect(setupKit).toContain("Connect this project to OWD");
    expect(setupKit).toContain("MDevolved resume project");
    expect(setupKit).toContain("OWD resume project");
  });

  it.each([
    "http://remote.example/mcp",
    "https://user:password@private-deployment.example/mcp",
    "https://private-deployment.example/mcp?token=secret",
    "https://private-deployment.example/mcp#secret",
  ])("rejects unsafe MCP URL %s", (url) => {
    expect(() => createAlbatrossMcpMergeConfig(url)).toThrow();
    expect(() => createAlbatrossAuthorizationCommand(url)).toThrow();
  });

  it.each([
    "",
    " reviewer",
    "reviewer ",
    "reviewer two",
    "reviewer:two",
    "x".repeat(65),
  ])("rejects unsafe participant ID %s", (participantId) => {
    expect(() => createAlbatrossMcpMergeConfig(MCP_URL, participantId)).toThrow(
      "participant ID",
    );
  });
});
