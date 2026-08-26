import { describe, expect, it, vi } from "vitest";
import {
  OwdPairingError,
  pairOwdVault,
  parseObsidianPairingProtocol,
  parseOwdPairingLink,
  parseOwdPairingParameters,
  type OwdPairingDependencies,
} from "../src/pairing-contract";

const DEPLOYMENT = "https://owd.example";
const GRANT = "grant_token_12345678901234567890";
const CREDENTIAL = "credential_12345678901234567890";
const VAULT_ID = "946009ef-ad0e-43e4-bd7e-3552d559a9ab";
const DEVICE_ID = "a4cfebbb-1c37-4fea-a30b-894e0d909911";
const IDEMPOTENCY_KEY = "bad2c67d-d80f-40b2-a4c0-49070ed1a25c";
const PAIRING_LINK = `owd-pair://connect?deployment=${encodeURIComponent(DEPLOYMENT)}&grant=${GRANT}`;

function dependencies(
  overrides: Partial<OwdPairingDependencies> = {},
): OwdPairingDependencies {
  return {
    applyConnection: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
    createDeviceMaterial: vi.fn(async () => ({
      credential: CREDENTIAL,
      deviceId: DEVICE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    })),
    request: vi.fn(async () => ({
      json: {
        credentialAccepted: true,
        deploymentUrl: DEPLOYMENT,
        serverVersion: "0.3.0",
        sourceDevice: { deviceId: DEVICE_ID },
        supportedSchemaVersions: { max: 3, min: 1 },
        vaultId: VAULT_ID,
      },
      status: 200,
    })),
    ...overrides,
  };
}

describe("OWD Obsidian pairing contract", () => {
  it("accepts HTTPS deployment origins and local HTTP only", () => {
    expect(
      parseOwdPairingParameters({ deployment: DEPLOYMENT, grant: GRANT }),
    ).toEqual({ deploymentUrl: DEPLOYMENT, grant: GRANT });
    expect(
      parseOwdPairingParameters({
        deployment: "http://localhost:8787",
        grant: GRANT,
      }).deploymentUrl,
    ).toBe("http://localhost:8787");

    for (const deployment of [
      "http://owd.example",
      "https://owd.example/other",
      "https://user:password@owd.example",
    ]) {
      expect(() =>
        parseOwdPairingParameters({ deployment, grant: GRANT }),
      ).toThrow(OwdPairingError);
    }
  });

  it("accepts only a copied OWD pairing link with one deployment and grant", () => {
    expect(parseOwdPairingLink(PAIRING_LINK)).toEqual({
      deploymentUrl: DEPLOYMENT,
      grant: GRANT,
    });

    for (const link of [
      `obsidian://owd-pair?deployment=${encodeURIComponent(DEPLOYMENT)}&grant=${GRANT}`,
      `owd-pair://other?deployment=${encodeURIComponent(DEPLOYMENT)}&grant=${GRANT}`,
      `${PAIRING_LINK}&grant=${GRANT}`,
      `${PAIRING_LINK}&extra=value`,
      `${PAIRING_LINK}#fragment`,
    ]) {
      expect(() => parseOwdPairingLink(link)).toThrow(OwdPairingError);
    }
  });

  it("accepts only the registered Obsidian protocol action and exact fields", () => {
    expect(
      parseObsidianPairingProtocol({
        action: "owd-pair",
        deployment: DEPLOYMENT,
        grant: GRANT,
      }),
    ).toEqual({
      deploymentUrl: DEPLOYMENT,
      grant: GRANT,
    });

    const invalidProtocolParams: Readonly<Record<string, string>>[] = [
      { action: "other", deployment: DEPLOYMENT, grant: GRANT },
      {
        action: "owd-pair",
        deployment: DEPLOYMENT,
        extra: "value",
        grant: GRANT,
      },
      { action: "owd-pair", deployment: DEPLOYMENT },
    ];
    for (const params of invalidProtocolParams) {
      expect(() => parseObsidianPairingProtocol(params)).toThrow(
        OwdPairingError,
      );
    }
  });

  it("does nothing when the user declines the disclosure", async () => {
    const deps = dependencies({ confirm: vi.fn(async () => false) });

    await expect(
      pairOwdVault(
        { deploymentUrl: DEPLOYMENT, grant: GRANT },
        "Private notes",
        "app://local/private-notes",
        "0.1.1",
        deps,
      ),
    ).resolves.toBe("cancelled");
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.applyConnection).not.toHaveBeenCalled();
  });

  it("exchanges the grant once and applies only the validated connection", async () => {
    const deps = dependencies();

    await expect(
      pairOwdVault(
        { deploymentUrl: DEPLOYMENT, grant: GRANT },
        "Private notes",
        "app://local/private-notes",
        "0.1.1",
        deps,
      ),
    ).resolves.toBe("paired");
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: `${DEPLOYMENT}/api/pairing/exchange`,
      }),
    );
    const request = vi.mocked(deps.request).mock.calls[0]?.[0];
    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      grant: GRANT,
      pluginVersion: "0.1.1",
      schemaVersion: 3,
      vaultName: "Private notes",
      sourceDescriptor: {
        capabilities: ["markdown", "editor-integration", "watch"],
        clientVersion: "0.1.1",
        label: "Private notes",
        sourceKind: "obsidian",
        syncSchemaVersion: 3,
      },
      sourceDevice: {
        contractVersion: 1,
        credentialSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        deviceId: DEVICE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        rootFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(JSON.stringify(body)).not.toContain(CREDENTIAL);
    expect(deps.applyConnection).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      host: DEPLOYMENT,
      rootFingerprintSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      token: CREDENTIAL,
      vaultId: VAULT_ID,
    });
  });

  it("retries a lost exchange response with byte-identical device material", async () => {
    const successful = {
      json: {
        credentialAccepted: true,
        deploymentUrl: DEPLOYMENT,
        serverVersion: "0.3.0",
        sourceDevice: { deviceId: DEVICE_ID },
        supportedSchemaVersions: { max: 3, min: 1 },
        vaultId: VAULT_ID,
      },
      status: 200,
    };
    const request = vi
      .fn<OwdPairingDependencies["request"]>()
      .mockRejectedValueOnce(new Error("response_lost"))
      .mockResolvedValueOnce(successful);
    const deps = dependencies({ request });
    await expect(
      pairOwdVault(
        { deploymentUrl: DEPLOYMENT, grant: GRANT },
        "Private notes",
        "app://local/private-notes",
        "0.1.1",
        deps,
      ),
    ).resolves.toBe("paired");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toEqual(request.mock.calls[0]?.[0]);
  });

  it("rejects mismatched or malformed server responses without saving", async () => {
    const applyConnection = vi.fn(async () => undefined);
    const deps = dependencies({
      applyConnection,
      request: vi.fn(async () => ({
        json: {
          credential: CREDENTIAL,
          deploymentUrl: "https://evil.example",
          serverVersion: "0.3.0",
          supportedSchemaVersions: { max: 3, min: 1 },
          vaultId: VAULT_ID,
        },
        status: 200,
      })),
    });

    await expect(
      pairOwdVault(
        { deploymentUrl: DEPLOYMENT, grant: GRANT },
        "Private notes",
        "app://local/private-notes",
        "0.1.1",
        deps,
      ),
    ).rejects.toThrow("invalid pairing response");
    expect(applyConnection).not.toHaveBeenCalled();
  });

  it("does not expose the grant in an expired-link error", async () => {
    const deps = dependencies({
      request: vi.fn(async () => ({ json: { grant: GRANT }, status: 400 })),
    });

    await expect(
      pairOwdVault(
        { deploymentUrl: DEPLOYMENT, grant: GRANT },
        "Private notes",
        "app://local/private-notes",
        "0.1.1",
        deps,
      ),
    ).rejects.not.toThrow(GRANT);
  });
});
