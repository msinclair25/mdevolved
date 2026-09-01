import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArguments, runCli } from "../src/cli.js";
import {
  harnessSetupCommands,
  validateMcpUrl,
} from "../src/harness-connect.js";
import {
  MemoryProtectedCredentialBackend,
  ProtectedCredentialCustody,
} from "../src/custody.js";
import { pairFolder, parsePairingLink } from "../src/pairing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function* stdin(value: string): AsyncGenerator<string> {
  yield value;
}

class FakeText {
  constructor(private value: string) {}
  toString(): string {
    return this.value;
  }
  delete(index: number, length: number): void {
    this.value = this.value.slice(0, index) + this.value.slice(index + length);
  }
  insert(index: number, value: string): void {
    this.value = this.value.slice(0, index) + value + this.value.slice(index);
  }
}

describe("mdevolved CLI safety", () => {
  it("requires a folder and rejects credential arguments", () => {
    expect(() => parseCliArguments(["sync", ".", "--token=secret"])).toThrow(
      "credentials_must_not_be_passed_as_arguments",
    );
    expect(
      parseCliArguments(["sync", ".", "--pairing-stdin", "--json"]),
    ).toEqual({
      command: "sync",
      sourceRoot: ".",
      pairingFromStdin: true,
      json: true,
    });
  });

  it("parses one-command harness setup without accepting credentials", () => {
    expect(
      parseCliArguments([
        "connect",
        "https://private-deployment.example/mcp",
        "--client",
        "claude",
        "--json",
      ]),
    ).toEqual({
      command: "connect",
      client: "claude",
      json: true,
      mcpUrl: "https://private-deployment.example/mcp",
    });
    expect(() =>
      parseCliArguments([
        "connect",
        "https://private-deployment.example/mcp",
        "--token=secret",
      ]),
    ).toThrow("credentials_must_not_be_passed_as_arguments");
    const credentialBearingUrl = [
      "https://",
      "user:",
      "secret@example.com/mcp",
    ].join("");
    expect(() => validateMcpUrl(credentialBearingUrl)).toThrow(
      "mcp_url_must_not_contain_credentials_or_state",
    );
    expect(() => validateMcpUrl("http://example.com/mcp")).toThrow(
      "mcp_url_insecure",
    );
  });

  it("uses each harness native installer without a shell or static token", () => {
    const url = "https://private-deployment.example/mcp";
    expect(harnessSetupCommands("codex", url)).toEqual([
      {
        command: "codex",
        args: ["mcp", "add", "mdevolved", "--url", url],
      },
      {
        command: "codex",
        args: [
          "mcp",
          "login",
          "mdevolved",
          "--scopes",
          "vault.read,project.initialize.request,project.connect.request",
        ],
      },
    ]);
    expect(JSON.stringify(harnessSetupCommands("claude", url))).not.toContain(
      "Bearer",
    );
    expect(harnessSetupCommands("claude", url)).toEqual([
      {
        command: "claude",
        args: ["mcp", "add", "--transport", "http", "mdevolved", url],
      },
    ]);
    expect(JSON.stringify(harnessSetupCommands("grok", url))).not.toContain(
      "Bearer",
    );
    expect(harnessSetupCommands("grok", url)).toEqual([
      {
        command: "grok",
        args: ["mcp", "add", "--transport", "http", "mdevolved", url],
      },
    ]);
    expect(JSON.stringify(harnessSetupCommands("hermes", url))).not.toContain(
      "Bearer",
    );
    expect(harnessSetupCommands("hermes", url)).toEqual([
      {
        command: "hermes",
        args: ["mcp", "add", "mdevolved", "--url", url, "--auth", "oauth"],
      },
    ]);
  });

  it("configures an explicit harness and fails closed on ambiguous auto-detection", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const connected = await runCli(
      {
        command: "connect",
        client: "codex",
        json: true,
        mcpUrl: "https://private-deployment.example/mcp",
      },
      {
        commandExists: async (command) => command === "codex",
        commandRunner: async (command, args) => {
          calls.push({ command, args });
          return 0;
        },
      },
    );
    expect(connected).toMatchObject({
      action: "client_configured",
      client: "codex",
      ok: true,
    });
    expect(calls).toHaveLength(2);

    let ran = false;
    const ambiguous = await runCli(
      {
        command: "connect",
        client: "auto",
        json: true,
        mcpUrl: "https://private-deployment.example/mcp",
      },
      {
        env: { PATH: "/synthetic" },
        commandExists: async (command) =>
          command === "codex" || command === "claude",
        commandRunner: async () => {
          ran = true;
          return 0;
        },
      },
    );
    expect(ambiguous).toMatchObject({
      action: "client_setup_failed",
      message: "multiple_clients_detected:codex,claude",
      ok: false,
    });
    expect(ran).toBe(false);
  });

  it("parses only bounded, HTTPS pairing links", () => {
    const grant = "a".repeat(32);
    expect(
      parsePairingLink(
        `owd-pair://connect?deployment=https%3A%2F%2Fexample.com&grant=${grant}`,
      ),
    ).toEqual({
      deploymentUrl: "https://example.com",
      grant,
    });
    expect(
      parsePairingLink(
        `mdevolved://connect?deployment=https%3A%2F%2Fexample.com&grant=${grant}`,
      ),
    ).toEqual({ deploymentUrl: "https://example.com", grant });
    expect(() =>
      parsePairingLink(
        `owd-pair://connect?deployment=http%3A%2F%2Fevil.example&grant=${grant}`,
      ),
    ).toThrow("pairing_deployment_insecure");
  });

  it("keeps credential metadata idempotent while secret remains backend-owned", async () => {
    const backend = new MemoryProtectedCredentialBackend();
    const custody = new ProtectedCredentialCustody("folder-test", backend);
    const record = {
      sourceId: "folder-test",
      fingerprint: "fingerprint",
      status: "active" as const,
      issuedAt: 1,
    };
    await custody.install(record, "opaque-token");
    expect(await custody.get()).toEqual(record);
    expect(await custody.getSecret()).toBe("opaque-token");
    await custody.confirmReplacement(record);
    expect(await custody.get()).toEqual(record);
    await custody.revoke();
    expect((await custody.get())?.status).toBe("revoked");
    expect(await custody.getSecret()).toBeNull();
  });

  it("sends only a credential hash for an enrolled source device", async () => {
    const deviceId = "8b37b0c3-9d90-4c42-9373-b659472583a1";
    const captured: unknown[] = [];
    const connection = await pairFolder(
      { deploymentUrl: "https://example.com", grant: "g".repeat(24) },
      {
        sourceKind: "folder",
        label: "Disposable folder",
        capabilities: ["markdown", "watch"],
        clientVersion: "mdevolved-cli-alpha.1",
        syncSchemaVersion: 1,
        descriptorVersion: 1,
        provenance: { pairedAt: 1 },
      },
      "Disposable folder",
      "mdevolved-cli-alpha.1",
      {
        exchange: async (request) => {
          captured.push(structuredClone(request));
          if (captured.length === 1) throw new Error("response_lost");
          return {
            credentialAccepted: true,
            deploymentUrl: request.deploymentUrl,
            serverVersion: "0.3.0",
            sourceDevice: { deviceId },
            supportedSchemaVersions: { min: 1, max: 3 },
            vaultId: "00000000-0000-4000-8000-000000000001",
          };
        },
      },
      {
        deviceId,
        displayName: "Disposable device",
        rootFingerprintSha256: "b".repeat(64),
      },
    );
    const wire = captured[1] as {
      sourceDevice?: { credentialSha256: string };
    };
    expect(wire.sourceDevice?.credentialSha256).toBe(
      createHash("sha256").update(connection.token, "utf8").digest("hex"),
    );
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]);
    expect(JSON.stringify(captured)).not.toContain(connection.token);
    expect(connection.deviceId).toBe(deviceId);
    expect(connection.rootFingerprintSha256).toBe("b".repeat(64));
  });

  it("pairs once, publishes a folder, and reconnects idempotently on the second run", async () => {
    const root = await temporaryDirectory("mdevolved-cli-");
    const stateDirectory = await temporaryDirectory("mdevolved-cli-state-");
    await fs.writeFile(join(root, "local.md"), "local", "utf8");
    const backend = new MemoryProtectedCredentialBackend();
    const remote = new Map<string, FakeText>([
      ["remote.md", new FakeText("remote")],
    ]);
    const vaultFactory = async () => ({
      connected: true,
      providerSynced: true,
      serverAppliedLocalState: true,
      getActiveMarkdownPaths: () => [...remote.keys()],
      getTextForPath: (path: string) => remote.get(path) ?? null,
      ensureFile: (path: string, content: string) => {
        const text = new FakeText(content);
        remote.set(path, text);
        return text;
      },
    });
    let exchanges = 0;
    const output: string[] = [];
    const pairingLink = `mdevolved://connect?deployment=${encodeURIComponent("https://example.com")}&grant=${"g".repeat(24)}`;
    const first = await runCli(
      {
        command: "sync",
        sourceRoot: root,
        pairingFromStdin: true,
        json: true,
      },
      {
        backend,
        stateDirectory,
        stdin: stdin(pairingLink),
        stdout: (line) => output.push(line),
        pairingTransport: {
          exchange: async (request) => {
            exchanges += 1;
            return {
              deploymentUrl: request.deploymentUrl,
              vaultId: "00000000-0000-4000-8000-000000000001",
              credential: "c".repeat(24),
              issuedAt: 1,
              supportedSchemaVersions: { min: 1, max: 3 },
            };
          },
        },
        vaultFactory,
      },
    );
    expect(first.action).toBe("sync_complete");
    expect(exchanges).toBe(1);
    expect(remote.get("local.md")?.toString()).toBe("local");
    expect(await fs.readFile(join(root, "remote.md"), "utf8")).toBe("remote");

    const second = await runCli(
      {
        command: "sync",
        sourceRoot: root,
        pairingFromStdin: false,
        json: true,
      },
      {
        backend,
        stateDirectory,
        stdout: (line) => output.push(line),
        pairingTransport: {
          exchange: async () => {
            throw new Error("pairing_must_not_repeat");
          },
        },
        vaultFactory,
      },
    );
    expect(second.action).toBe("sync_complete");
    expect(exchanges).toBe(1);
    expect(output.join("\n")).not.toContain("c".repeat(24));
    expect(output.join("\n")).not.toContain("g".repeat(24));
  });
});
