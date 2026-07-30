import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  BASE_SNAPSHOT_REQUIRED_CAPABILITIES,
  OWD_SNAPSHOT_EXPORT_MAGIC,
  OWD_SNAPSHOT_FORMAT,
  canonicalizeCollaborationJson,
  decisionSchema,
  snapshotManifestSchema,
  type SnapshotExportIndex,
  type SnapshotManifest,
} from "@owd/contracts";
import {
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { describe, expect, it } from "vitest";
import { inspectSnapshotArchive } from "../src/snapshot-archive";
import { snapshotVaultRestoreManifest } from "../src/SnapshotRestorePanel";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
    ),
  );
}

async function encrypt(value: Uint8Array, recipient: string): Promise<Blob> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(
    new Blob([Uint8Array.from(value).buffer]).stream(),
  );
  return new Blob([await new Response(encrypted).arrayBuffer()]);
}

async function createSyntheticPortableSnapshot(input?: {
  includeIntelligence?: boolean;
  oversizedFirstContent?: boolean;
  unknownRequiredCapability?: boolean;
}): Promise<{
  file: Blob;
  identity: string;
  manifest: SnapshotManifest;
}> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const values = [
    {
      bytes: encoder.encode("# Hello\n"),
      id: "20000000-0000-4000-8000-000000000001",
      path: "Notes/Hello.md",
      section: "notes" as const,
    },
    {
      bytes: new Uint8Array([0, 1, 2, 3]),
      id: "20000000-0000-4000-8000-000000000002",
      path: "Assets/pixel.bin",
      section: "attachments" as const,
    },
    {
      bytes: encoder.encode('{"theme":"moonstone"}'),
      id: "20000000-0000-4000-8000-000000000003",
      path: ".obsidian/appearance.json",
      section: "obsidian-allowlist" as const,
    },
  ];
  const objects = await Promise.all(
    values.map(async (value) => ({
      byteLength: value.bytes.byteLength,
      contentSha256: await sha256Hex(value.bytes),
      portableObjectId: value.id,
      section: value.section,
    })),
  );
  const decision = decisionSchema.parse({
    createdAt: 20,
    decisionId: "90000000-0000-4000-8000-000000000001",
    inputRecords: [],
    ownerAuthored: true,
    projectId: "90000000-0000-4000-8000-000000000002",
    rationale: "Synthetic approved intelligence recovery fixture.",
    recordType: "decision",
    resolution: "accepted",
    schemaVersion: 1,
    supersedesDecisionId: null,
    workItemId: "90000000-0000-4000-8000-000000000003",
  });
  const decisionBytes = encoder.encode(canonicalizeCollaborationJson(decision));
  const decisionDigest = await sha256Hex(decisionBytes);
  const intelligence =
    input?.includeIntelligence === true
      ? {
          approved: {
            classification: "approved" as const,
            evidenceObjectCount: 0,
            evidenceObjects: [],
            logicalBytes: decisionBytes.byteLength,
            newlyStoredBytes: decisionBytes.byteLength,
            recordCount: 1,
            records: [
              {
                byteLength: decisionBytes.byteLength,
                classification: "approved" as const,
                contentSha256: decisionDigest,
                dependencies: [],
                evidenceOnly: false,
                originalState: {
                  disposition: "accepted" as const,
                  visibility: "owner-only" as const,
                },
                portableObjectId: decision.decisionId,
                projectId: decision.projectId,
                recordId: decision.decisionId,
                recordType: decision.recordType,
                restoreDisposition: "restore-approved" as const,
                schemaVersion: 1 as const,
                workItemId: decision.workItemId,
              },
            ],
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
          requiredCapabilities: [APPROVED_INTELLIGENCE_CAPABILITY],
          schemaVersion: 1 as const,
          selection: "approved" as const,
          unvetted: null,
        }
      : undefined;
  const requiredCapabilities = [
    ...BASE_SNAPSHOT_REQUIRED_CAPABILITIES,
    ...(input?.includeIntelligence === true
      ? [APPROVED_INTELLIGENCE_CAPABILITY]
      : []),
    ...(input?.unknownRequiredCapability === true
      ? ["owd.snapshot.future-required-v99"]
      : []),
  ];
  const manifest = snapshotManifestSchema.parse({
    captureCompletedAt: 20,
    captureStartedAt: 10,
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
    format: OWD_SNAPSHOT_FORMAT,
    includedSections: ["notes", "attachments", "obsidian-allowlist"],
    intelligence,
    logicalBytes: values.reduce(
      (total, value) => total + value.bytes.byteLength,
      0,
    ),
    objects,
    optionalCapabilities: [
      "owd.snapshot.attachments-v1",
      "owd.snapshot.obsidian-allowlist-v1",
    ],
    recipientFingerprint: await sha256Hex(encoder.encode(recipient)),
    requiredCapabilities,
    reservedSections: [
      "accepted-handoffs",
      "durable-knowledge",
      "skills",
      "evaluations",
      "provenance",
      "policy",
    ],
    scope: "selected",
    snapshotId: "10000000-0000-4000-8000-000000000001",
    unavailableSections: [],
    vaults: [
      {
        entries: values.map((value, index) => ({
          ...objects[index],
          modifiedAt: index + 1,
          path: value.path,
        })),
        snapshotVaultId: "30000000-0000-4000-8000-000000000001",
        sourceGeneration: {
          completedAt: 9,
          createdAt: 8,
          generationId: "40000000-0000-4000-8000-000000000001",
          noteCount: 1,
          sourceStateVectorSha256: "b".repeat(64),
          totalBytes: values[0]?.bytes.byteLength,
        },
        vaultName: "Synthetic vault",
      },
    ],
  });
  const manifestPart = await encrypt(
    encoder.encode(JSON.stringify(manifest)),
    recipient,
  );
  const contentParts = await Promise.all(
    values.map((value, index) =>
      encrypt(
        input?.oversizedFirstContent === true && index === 0
          ? new Uint8Array([...value.bytes, 0])
          : value.bytes,
        recipient,
      ),
    ),
  );
  const intelligencePart =
    input?.includeIntelligence === true
      ? await encrypt(decisionBytes, recipient)
      : null;
  const index: SnapshotExportIndex = {
    format: OWD_SNAPSHOT_FORMAT,
    ...(input?.includeIntelligence === true
      ? { intelligenceSelection: "approved" as const }
      : {}),
    optionalCapabilities: manifest.optionalCapabilities,
    parts: [
      {
        ciphertextBytes: manifestPart.size,
        portableObjectId: "50000000-0000-4000-8000-000000000001",
        role: "manifest",
      },
      ...contentParts.map((part, index) => ({
        ciphertextBytes: part.size,
        portableObjectId: values[index]?.id ?? crypto.randomUUID(),
        role: "content" as const,
      })),
      ...(intelligencePart === null
        ? []
        : [
            {
              ciphertextBytes: intelligencePart.size,
              portableObjectId: decision.decisionId,
              role: "content" as const,
            },
          ]),
    ],
    requiredCapabilities,
    snapshotId: manifest.snapshotId,
  };
  return {
    file: new Blob([
      OWD_SNAPSHOT_EXPORT_MAGIC,
      `${JSON.stringify(index)}\n`,
      manifestPart,
      ...contentParts,
      ...(intelligencePart === null ? [] : [intelligencePart]),
    ]),
    identity,
    manifest,
  };
}

describe("portable snapshot archive", () => {
  it("round-trips Markdown, a supported attachment, and allowlisted Obsidian configuration", async () => {
    const fixture = await createSyntheticPortableSnapshot();
    const restored = new Map<string, Uint8Array>();
    const inspected = await inspectSnapshotArchive(
      fixture.file,
      fixture.identity,
      async ({ bytes, entry }) => {
        restored.set(`${entry.section}:${entry.path}`, bytes);
      },
    );
    expect(inspected.manifest).toEqual(fixture.manifest);
    expect(new TextDecoder().decode(restored.get("notes:Notes/Hello.md"))).toBe(
      "# Hello\n",
    );
    expect([...(restored.get("attachments:Assets/pixel.bin") ?? [])]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(
      new TextDecoder().decode(
        restored.get("obsidian-allowlist:.obsidian/appearance.json"),
      ),
    ).toBe('{"theme":"moonstone"}');
  });

  it("authenticates and exposes Approved intelligence separately from vault content", async () => {
    const fixture = await createSyntheticPortableSnapshot({
      includeIntelligence: true,
    });
    const inspected = await inspectSnapshotArchive(
      fixture.file,
      fixture.identity,
    );
    const decisionBytes = inspected.intelligenceObjects.get(
      "90000000-0000-4000-8000-000000000001",
    );
    expect(decisionBytes).toBeDefined();
    expect(
      decisionSchema.parse(
        JSON.parse(new TextDecoder().decode(decisionBytes)) as unknown,
      ),
    ).toMatchObject({
      ownerAuthored: true,
      recordType: "decision",
      resolution: "accepted",
    });
  });

  it("fails closed on an unknown required capability", async () => {
    const fixture = await createSyntheticPortableSnapshot({
      unknownRequiredCapability: true,
    });
    await expect(
      inspectSnapshotArchive(fixture.file, fixture.identity),
    ).rejects.toThrow("newer compatible OWD version");
  });

  it("rejects modified ciphertext before exposing an entry", async () => {
    const fixture = await createSyntheticPortableSnapshot();
    const bytes = new Uint8Array(await fixture.file.arrayBuffer());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(
      inspectSnapshotArchive(new Blob([bytes]), fixture.identity),
    ).rejects.toThrow();
  });

  it("stops decrypting when authenticated plaintext exceeds its declared bound", async () => {
    const fixture = await createSyntheticPortableSnapshot({
      oversizedFirstContent: true,
    });
    await expect(
      inspectSnapshotArchive(fixture.file, fixture.identity),
    ).rejects.toThrow("safety limit");
  });

  it("adapts each named source vault to the existing staged Markdown overlay contract", async () => {
    const fixture = await createSyntheticPortableSnapshot();
    const sourceVault = fixture.manifest.vaults[0];
    if (sourceVault === undefined) throw new Error("Synthetic vault missing.");
    const restoreManifest = snapshotVaultRestoreManifest(
      fixture.manifest,
      sourceVault,
    );
    expect(restoreManifest).toMatchObject({
      backupId: fixture.manifest.snapshotId,
      includedSections: ["notes"],
      vaultName: "Synthetic vault",
    });
    expect(restoreManifest.notes).toEqual([
      expect.objectContaining({ path: "Notes/Hello.md" }),
    ]);
  });
});
