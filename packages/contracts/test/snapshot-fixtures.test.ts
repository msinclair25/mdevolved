import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  snapshotExportIndexSchema,
  snapshotIntelligenceManifestSchema,
  snapshotManifestSchema,
} from "@mdevolved/contracts";
import { describe, expect, it } from "vitest";
import indexFixture from "../fixtures/owd-snapshot-v2-index.json";
import manifestFixture from "../fixtures/owd-snapshot-v2-manifest.json";

describe("published snapshot format fixtures", () => {
  it("keeps the provider-neutral public index and complete manifest compatible", () => {
    const index = snapshotExportIndexSchema.parse(indexFixture);
    const manifest = snapshotManifestSchema.parse(manifestFixture);
    expect(index.snapshotId).toBe(manifest.snapshotId);
    expect(index.requiredCapabilities).toEqual(manifest.requiredCapabilities);
    expect(
      index.parts
        .filter((part) => part.role === "content")
        .map((part) => part.portableObjectId)
        .sort(),
    ).toEqual(manifest.objects.map((object) => object.portableObjectId).sort());
    expect(JSON.stringify(index)).not.toMatch(
      /workers\.dev|cloudflare|r2|d1|object_key|source_vault_id/iu,
    );
  });

  it("rejects declared content objects that no vault entry references", () => {
    const unreferenced = structuredClone(manifestFixture);
    unreferenced.objects.push({
      byteLength: 1,
      contentSha256: "c".repeat(64),
      portableObjectId: "77777777-7777-4777-8777-777777777777",
      section: "notes",
    });
    expect(snapshotManifestSchema.safeParse(unreferenced).success).toBe(false);
  });

  it("allows R4 operational bodies only as quarantined restore evidence", () => {
    const descriptor = {
      byteLength: 1,
      classification: "approved" as const,
      contentSha256: "a".repeat(64),
      dependencies: [],
      evidenceOnly: false,
      originalState: {
        disposition: "accepted" as const,
        visibility: "owner-only" as const,
      },
      portableObjectId: "77777777-7777-4777-8777-777777777777",
      projectId: "88888888-8888-4888-8888-888888888888",
      recordId: "99999999-9999-4999-8999-999999999999",
      recordType: "policy-binding" as const,
      restoreDisposition: "restore-quarantined" as const,
      schemaVersion: 1 as const,
      workItemId: null,
    };
    const manifest = {
      approved: {
        classification: "approved" as const,
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes: 1,
        newlyStoredBytes: 1,
        recordCount: 1,
        records: [descriptor],
      },
      excludedAuthority: [
        "oauth-access-tokens",
        "oauth-refresh-tokens",
        "oauth-authorization-codes",
        "oauth-protocol-storage",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "vault-credentials",
        "live-agent-grants",
        "recovery-private-keys",
        "harness-context",
        "provider-credentials",
        "runtime-caches",
      ] as const,
      format: "owd-snapshot-intelligence-v1" as const,
      requiredCapabilities: [APPROVED_INTELLIGENCE_CAPABILITY] as const,
      schemaVersion: 1 as const,
      selection: "approved" as const,
      unvetted: null,
    };
    const parsed = snapshotIntelligenceManifestSchema.safeParse(manifest);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
      true,
    );
    expect(
      snapshotIntelligenceManifestSchema.safeParse({
        ...manifest,
        approved: {
          ...manifest.approved,
          records: [{ ...descriptor, restoreDisposition: "restore-approved" }],
        },
      }).success,
    ).toBe(false);
  });
});
