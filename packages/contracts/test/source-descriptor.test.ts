import {
  pairingExchangeRequestSchema,
  portableSourceDescriptorSchema,
  serverCapabilitiesSchema,
  sourceDescriptorInputSchema,
  sourceDescriptorSchema,
  snapshotManifestSchema,
} from "../src";
import { describe, expect, it } from "vitest";

const descriptorInput = {
  sourceKind: "folder" as const,
  label: "Research workspace",
  capabilities: ["markdown", "watch"] as const,
  clientVersion: "0.1.0",
  syncSchemaVersion: 1,
};

const descriptor = sourceDescriptorSchema.parse({
  ...descriptorInput,
  descriptorVersion: 1,
  provenance: {
    pairedAt: 1_750_000_000,
    descriptorSha256: "a".repeat(64),
  },
});

describe("source descriptor contracts", () => {
  it("accepts an optional descriptor without changing the legacy pairing response", () => {
    expect(
      pairingExchangeRequestSchema.parse({
        grant: "a".repeat(43),
        vaultName: "Legacy-compatible vault",
        pluginVersion: "0.1.7",
        schemaVersion: 3,
      }).sourceDescriptor,
    ).toBeUndefined();
    expect(
      pairingExchangeRequestSchema.parse({
        grant: "a".repeat(43),
        vaultName: "Folder workspace",
        pluginVersion: "0.1.7",
        schemaVersion: 3,
        sourceDescriptor: descriptorInput,
      }).sourceDescriptor,
    ).toEqual(descriptorInput);
  });

  it("rejects duplicate, oversized, and provider-specific descriptor data", () => {
    expect(
      sourceDescriptorInputSchema.safeParse({
        ...descriptorInput,
        capabilities: ["markdown", "markdown"],
      }).success,
    ).toBe(false);
    expect(
      sourceDescriptorInputSchema.safeParse({
        ...descriptorInput,
        label: "x".repeat(121),
      }).success,
    ).toBe(false);
    expect(
      sourceDescriptorSchema.safeParse({
        ...descriptor,
        hostname: "https://provider.example",
      }).success,
    ).toBe(false);
  });

  it("marks portable descriptors as quarantined and authority-free", () => {
    const portable = portableSourceDescriptorSchema.parse({
      ...descriptor,
      restoreDisposition: "quarantined",
      authorityRestored: false,
    });
    expect(portable.restoreDisposition).toBe("quarantined");
    expect(portable.authorityRestored).toBe(false);
    expect(
      portableSourceDescriptorSchema.safeParse({
        ...portable,
        authorityRestored: true,
      }).success,
    ).toBe(false);
  });

  it("negotiates source descriptors additively", () => {
    const capabilities = serverCapabilitiesSchema.parse({
      claimed: false,
      authMode: "unclaimed",
      attachments: false,
      snapshots: false,
      socketTicketAuth: true,
      serverVersion: "0.3.0",
      minPluginVersion: "0.1.7",
      recommendedPluginVersion: "0.1.7",
      minSchemaVersion: 1,
      maxSchemaVersion: 3,
      migrationRequired: false,
      updateProvider: null,
      updateRepoUrl: null,
      updateRepoBranch: null,
      sourceDescriptors: { version: 1, kinds: ["folder", "obsidian"] },
    });
    expect(capabilities.sourceDescriptors?.kinds).toEqual([
      "folder",
      "obsidian",
    ]);
  });

  it("round-trips descriptor metadata in a disconnected snapshot manifest", () => {
    const manifest = snapshotManifestSchema.parse({
      captureCompletedAt: 2,
      captureStartedAt: 1,
      excludedSecuritySections: [
        "oauth",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "agent-grants",
        "pending-agent-proposals",
        "harness-context",
        "unknown-obsidian-plugin-data",
      ],
      format: "owd-snapshot-v2",
      includedSections: ["notes"],
      logicalBytes: 0,
      objects: [],
      optionalCapabilities: [],
      recipientFingerprint: "b".repeat(64),
      requiredCapabilities: ["owd.snapshot.notes-v1"],
      reservedSections: [
        "accepted-handoffs",
        "durable-knowledge",
        "skills",
        "evaluations",
        "provenance",
        "policy",
      ],
      scope: "imported",
      snapshotId: crypto.randomUUID(),
      unavailableSections: ["attachments", "obsidian-allowlist"],
      vaults: [
        {
          entries: [],
          snapshotVaultId: crypto.randomUUID(),
          sourceGeneration: null,
          sourceDescriptor: {
            ...descriptor,
            restoreDisposition: "quarantined",
            authorityRestored: false,
          },
          vaultName: "Research workspace",
        },
      ],
    });
    expect(manifest.vaults[0]?.sourceDescriptor?.authorityRestored).toBe(false);
    expect(manifest.vaults[0]?.sourceDescriptor?.restoreDisposition).toBe(
      "quarantined",
    );
  });
});
