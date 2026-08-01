import { describe, expect, it } from "vitest";
import {
  EVE_COMPATIBILITY_PROFILE,
  EVE_PROFILE_RESOURCE_URI,
  createEveConnectionSource,
  serializeEveCompatibilityProfile,
} from "../src/eve";

const MCP_URL = "https://private-deployment.example/mcp";

describe("Eve compatibility profile", () => {
  it("pins the reviewed upstream contract and standard OWD topology", () => {
    expect(EVE_PROFILE_RESOURCE_URI).toBe(
      "owd://compatibility-profiles/eve/v1",
    );
    expect(EVE_COMPATIBILITY_PROFILE).toMatchObject({
      connection: {
        auth: "oauth-2.1-pkce",
        connectionFile: "agent/connections/owd.ts",
        connectionName: "owd",
        connectorUid: "oauth/owd",
        sourceScopes: [
          "vault.read",
          "project.initialize.request",
          "project.connect.request",
        ],
        toolPrefix: "owd__",
        transport: "streamable-http",
        userScoped: true,
      },
      format: "owd-client-profile-v1",
      id: "eve",
      source: {
        commit: "85c1dd7a647a04cc1bd74879ba8d27a3ba0bdd9d",
        connectVersion: "0.6.0",
        eveVersion: "0.29.4",
        license: "Apache-2.0",
        repository: "https://github.com/vercel/eve",
        reviewedAt: "2026-07-31",
      },
    });
    expect(JSON.parse(serializeEveCompatibilityProfile())).toStrictEqual(
      EVE_COMPATIBILITY_PROFILE,
    );
  });

  it("generates a user-scoped standard Eve MCP connection", () => {
    const source = createEveConnectionSource(MCP_URL);

    expect(source).toContain(
      'import { defineMcpClientConnection } from "eve/connections";',
    );
    expect(source).toContain(`const owdMcpUrl = "${MCP_URL}";`);
    expect(source).toContain('connector: "oauth/owd"');
    expect(source).toContain('principalType: "user"');
    expect(source).toContain('"vault.read"');
    expect(source).toContain('"project.initialize.request"');
    expect(source).toContain('"project.connect.request"');
    expect(source).toContain("resources: [owdMcpUrl]");
    expect(source).toContain("autoProvision: true");
    expect(source).not.toContain('principalType: "app"');
    expect(source).not.toContain("Bearer ");
    expect(source).not.toContain("validate: true");
    expect(source).not.toContain("tools:");
  });

  it("supports a separate connector identity for an independent reviewer", () => {
    expect(createEveConnectionSource(MCP_URL, "oauth/owd-reviewer")).toContain(
      'connector: "oauth/owd-reviewer"',
    );
  });

  it.each([
    "http://remote.example/mcp",
    "https://user:password@private-deployment.example/mcp",
    "https://private-deployment.example/mcp?token=secret",
    "https://private-deployment.example/mcp#secret",
  ])("rejects unsafe MCP URL %s", (url) => {
    expect(() => createEveConnectionSource(url)).toThrow();
  });

  it.each([" oauth/owd", "oauth/owd ", "oauth//owd", "oauth/owd reviewer"])(
    "rejects unsafe connector UID %s",
    (connectorUid) => {
      expect(() => createEveConnectionSource(MCP_URL, connectorUid)).toThrow(
        "connector UID",
      );
    },
  );
});
