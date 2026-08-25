import { createHash } from "node:crypto";
import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  MAX_SUBMISSION_BYTES,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  artifactSchema,
  collaborationCapabilityProfileSchema,
  collaborationLedgerJsonSchema,
  collaborationLedgerSchema,
  collaborationRestoreCreateRequestSchema,
  collaborationSubmissionJsonSchema,
  collaborationSubmissionSchema,
  continuityPointJsonSchema,
  continuityPointSchema,
  leadContinuityCapabilityProfileSchema,
  provenanceEdgeSchema,
  projectCheckpointRequestJsonSchema,
  projectLeadClaimRequestJsonSchema,
  snapshotIntelligenceJsonSchema,
  snapshotIntelligenceManifestSchema,
  workPacketJsonSchema,
  workPacketSchema,
} from "@owd/contracts";
import { describe, expect, it } from "vitest";
import capabilityFixture from "../fixtures/owd-collaboration-capabilities-v1.json";
import continuityFixture from "../fixtures/owd-continuity-point-v1.json";
import leadCapabilityFixture from "../fixtures/owd-lead-continuity-capabilities-v1.json";
import ledgerFixture from "../fixtures/owd-collaboration-ledger-v1.json";
import submissionFixture from "../fixtures/owd-collaboration-submission-v1.json";
import approvedUnvettedFixture from "../fixtures/owd-snapshot-intelligence-approved-unvetted-v1.json";
import approvedFixture from "../fixtures/owd-snapshot-intelligence-approved-v1.json";
import noneFixture from "../fixtures/owd-snapshot-intelligence-none-v1.json";
import packetFixture from "../fixtures/owd-work-packet-v1.json";

type JsonValue =
  boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function integrityDigest(value: unknown): string {
  const copy = structuredClone(value) as {
    integrity: { digest?: string };
  } & JsonValue;
  delete copy.integrity.digest;
  return createHash("sha256").update(canonicalize(copy)).digest("hex");
}

function fixtureUuid(namespace: number, index: number): string {
  return `${namespace.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

describe("Phase 9A collaboration contract fixtures", () => {
  it("requires one-to-one restore vault mappings while accepting legacy snapshots", () => {
    expect(
      collaborationRestoreCreateRequestSchema.parse({
        manifest: approvedFixture,
      }).vaultMappings,
    ).toEqual([]);
    expect(
      collaborationRestoreCreateRequestSchema.safeParse({
        manifest: approvedFixture,
        vaultMappings: [
          {
            sourceVaultId: fixtureUuid(90, 1),
            targetVaultId: fixtureUuid(90, 3),
          },
          {
            sourceVaultId: fixtureUuid(90, 2),
            targetVaultId: fixtureUuid(90, 3),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("publishes JSON Schema 2020-12 shapes for every portable envelope", () => {
    for (const schema of [
      workPacketJsonSchema,
      collaborationSubmissionJsonSchema,
      collaborationLedgerJsonSchema,
      snapshotIntelligenceJsonSchema,
      continuityPointJsonSchema,
      projectLeadClaimRequestJsonSchema,
      projectCheckpointRequestJsonSchema,
    ]) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema.$id).toMatch(/^urn:owd:schema:/u);
      expect(schema.type).toBe("object");
    }
  });

  it("round-trips the bounded Work Packet and verifies its RFC 8785 digest", () => {
    const packet = workPacketSchema.parse(packetFixture);
    expect(integrityDigest(packet)).toBe(packet.integrity.digest);
    expect(workPacketSchema.parse(JSON.parse(JSON.stringify(packet)))).toEqual(
      packet,
    );
  });

  it("detects altered canonical content and rejects non-canonical string padding", () => {
    const altered = structuredClone(packetFixture);
    altered.brief.objective = `${altered.brief.objective} Altered.`;
    expect(integrityDigest(workPacketSchema.parse(altered))).not.toBe(
      packetFixture.integrity.digest,
    );

    const padded = structuredClone(packetFixture);
    padded.brief.objective = ` ${padded.brief.objective}`;
    expect(workPacketSchema.safeParse(padded).success).toBe(false);
  });

  it("round-trips an append-only submission and verifies its RFC 8785 digest", () => {
    const submission = collaborationSubmissionSchema.parse(submissionFixture);
    expect(integrityDigest(submission)).toBe(submission.integrity.digest);
    expect(
      collaborationSubmissionSchema.parse(
        JSON.parse(JSON.stringify(submission)),
      ),
    ).toEqual(submission);
  });

  it("validates a provider-neutral two-agent ledger and all embedded packet digests", () => {
    const ledger = collaborationLedgerSchema.parse(ledgerFixture);
    for (const record of ledger.records) {
      if (record.recordType === "work-packet") {
        expect(integrityDigest(record)).toBe(record.integrity.digest);
      }
    }
    expect(JSON.stringify(ledger)).not.toMatch(
      /workers\.dev|cloudflare|r2_key|d1_row|object_key|access_token|refresh_token/iu,
    );
  });

  it("rejects cross-Project records, missing retained evidence, and false PROV directions", () => {
    const crossProject = structuredClone(ledgerFixture);
    const artifact = crossProject.records.find(
      (record) => record.recordType === "artifact",
    );
    if (artifact !== undefined)
      artifact.projectId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(collaborationLedgerSchema.safeParse(crossProject).success).toBe(
      false,
    );

    const missingEvidence = structuredClone(packetFixture);
    missingEvidence.evidenceObjects = [];
    expect(workPacketSchema.safeParse(missingEvidence).success).toBe(false);

    const backwards = structuredClone(ledgerFixture.provenanceEdges[0]);
    if (backwards === undefined) throw new Error("Fixture edge missing");
    backwards.subject.provClass = "entity";
    expect(provenanceEdgeSchema.safeParse(backwards).success).toBe(false);
  });

  it("rejects cross-Attempt Handoffs and OwnerEvents with unresolved targets", () => {
    const crossAttempt = structuredClone(ledgerFixture);
    const handoff = crossAttempt.records.find(
      (record) => record.recordType === "handoff",
    );
    const reviewingAttempt = crossAttempt.records.find(
      (record) =>
        record.recordType === "attempt" &&
        record.attemptId === "60000000-0000-4000-8000-000000000002",
    );
    if (handoff === undefined || reviewingAttempt === undefined) {
      throw new Error("Fixture handoff or reviewing Attempt missing");
    }
    handoff.attemptId = reviewingAttempt.attemptId;
    expect(collaborationLedgerSchema.safeParse(crossAttempt).success).toBe(
      false,
    );

    const missingOwnerTarget = structuredClone(ledgerFixture) as {
      ownerEvents: unknown[];
    };
    missingOwnerTarget.ownerEvents.push({
      createdAt: 1784820500,
      eventId: "65000000-0000-4000-8000-000000000002",
      eventType: "work-item.closed",
      ownerAuthenticated: true,
      projectId: "20000000-0000-4000-8000-000000000001",
      reason: "This unresolved target must fail closed.",
      recordType: "owner-event",
      schemaVersion: 1,
      workItemId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    expect(
      collaborationLedgerSchema.safeParse(missingOwnerTarget).success,
    ).toBe(false);
  });

  it("rejects broken version chains and mismatched packet/output parents", () => {
    const brokenVersion = structuredClone(ledgerFixture);
    const projectVersion = brokenVersion.records.find(
      (record) => record.recordType === "project-version",
    );
    if (projectVersion === undefined) {
      throw new Error("Fixture Project version missing");
    }
    projectVersion.version = 2;
    expect(collaborationLedgerSchema.safeParse(brokenVersion).success).toBe(
      false,
    );

    const mismatchedOutput = structuredClone(ledgerFixture);
    const artifact = mismatchedOutput.records.find(
      (record) => record.recordType === "artifact",
    );
    if (artifact === undefined) throw new Error("Fixture Artifact missing");
    artifact.workItemId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(collaborationLedgerSchema.safeParse(mismatchedOutput).success).toBe(
      false,
    );

    const wrongPacketParent = structuredClone(ledgerFixture);
    const firstAttempt = wrongPacketParent.records.find(
      (record) =>
        record.recordType === "attempt" &&
        record.attemptId === "60000000-0000-4000-8000-000000000001",
    );
    if (firstAttempt === undefined) throw new Error("Fixture Attempt missing");
    firstAttempt.workPacketId = "50000000-0000-4000-8000-000000000002";
    expect(collaborationLedgerSchema.safeParse(wrongPacketParent).success).toBe(
      false,
    );

    const duplicateOrdinal = structuredClone(ledgerFixture);
    const firstProjectVersion = duplicateOrdinal.records.find(
      (record) => record.recordType === "project-version",
    );
    if (firstProjectVersion === undefined) {
      throw new Error("Fixture Project version missing");
    }
    duplicateOrdinal.records.push({
      ...firstProjectVersion,
      projectVersionId: "21000000-0000-4000-8000-000000000002",
    });
    expect(collaborationLedgerSchema.safeParse(duplicateOrdinal).success).toBe(
      false,
    );
  });

  it("rejects false packet classifications, missing citations, and forged PROV classes", () => {
    const wrongClassification = structuredClone(ledgerFixture);
    const reviewPacket = wrongClassification.records.find(
      (record) =>
        record.recordType === "work-packet" &&
        record.packetId === "50000000-0000-4000-8000-000000000002",
    );
    if (
      reviewPacket === undefined ||
      reviewPacket.includedRecords[0] === undefined
    ) {
      throw new Error("Fixture Review packet inclusion missing");
    }
    reviewPacket.includedRecords[0].includedAs = "accepted-decision";
    expect(
      collaborationLedgerSchema.safeParse(wrongClassification).success,
    ).toBe(false);

    const missingCitation = structuredClone(ledgerFixture);
    const handoff = missingCitation.records.find(
      (record) => record.recordType === "handoff",
    );
    if (handoff === undefined) throw new Error("Fixture Handoff missing");
    handoff.evidenceCitationIds = ["ffffffff-ffff-4fff-8fff-ffffffffffff"];
    expect(collaborationLedgerSchema.safeParse(missingCitation).success).toBe(
      false,
    );

    const forgedClass = structuredClone(ledgerFixture);
    const derivedEdge = forgedClass.provenanceEdges.find(
      (edge) => edge.relation === "was-derived-from",
    );
    if (derivedEdge === undefined) {
      throw new Error("Fixture derivation edge missing");
    }
    derivedEdge.subject = {
      id: "60000000-0000-4000-8000-000000000001",
      provClass: "entity",
      recordType: "attempt",
    };
    expect(collaborationLedgerSchema.safeParse(forgedClass).success).toBe(
      false,
    );

    const duplicateOutputType = structuredClone(packetFixture);
    duplicateOutputType.outputContract.acceptedMediaTypes = [
      "application/json",
      "application/json",
    ];
    expect(workPacketSchema.safeParse(duplicateOutputType).success).toBe(false);
  });

  it("rejects global durable-ID collisions and unsafe external references", () => {
    const duplicateId = structuredClone(ledgerFixture);
    const event = duplicateId.ownerEvents[0];
    const edge = duplicateId.provenanceEdges[0];
    if (event === undefined || edge === undefined) {
      throw new Error("Fixture event or edge missing");
    }
    event.eventId = edge.edgeId;
    expect(collaborationLedgerSchema.safeParse(duplicateId).success).toBe(
      false,
    );

    const artifact = structuredClone(ledgerFixture.records).find(
      (record) => record.recordType === "artifact",
    );
    if (artifact === undefined) throw new Error("Fixture Artifact missing");
    artifact.content = {
      expectedSha256: null,
      kind: "external-reference",
      retrievalPolicy: "never-server-fetch",
      uri: "https://127.0.0.1/private",
      version: null,
    };
    expect(artifactSchema.safeParse(artifact).success).toBe(false);
    artifact.content.uri = "https://example.com/portable-artifact.json";
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("keeps Decisions and owner authority out of agent submissions", () => {
    const decisionAttempt = structuredClone(submissionFixture) as Record<
      string,
      unknown
    >;
    decisionAttempt.record = {
      createdAt: 1784820100,
      decisionId: "66000000-0000-4000-8000-000000000001",
      inputRecords: [],
      ownerAuthored: true,
      projectId: submissionFixture.projectId,
      rationale: "A client must not submit this owner record.",
      recordType: "decision",
      resolution: "accepted",
      schemaVersion: 1,
      supersedesDecisionId: null,
      workItemId: submissionFixture.workItemId,
    };
    expect(
      collaborationSubmissionSchema.safeParse(decisionAttempt).success,
    ).toBe(false);
  });

  it("enforces Approved-only, Approved-plus-Unvetted, and vault-only recovery selection", () => {
    const approved = snapshotIntelligenceManifestSchema.parse(approvedFixture);
    const approvedUnvetted = snapshotIntelligenceManifestSchema.parse(
      approvedUnvettedFixture,
    );
    const none = snapshotIntelligenceManifestSchema.parse(noneFixture);
    expect(approved.requiredCapabilities).toEqual([
      APPROVED_INTELLIGENCE_CAPABILITY,
    ]);
    expect(approvedUnvetted.requiredCapabilities).toEqual([
      APPROVED_INTELLIGENCE_CAPABILITY,
      QUARANTINED_INTELLIGENCE_CAPABILITY,
    ]);
    expect(none.selection).toBe("none");
  });

  it("keeps legacy manifests valid and allows profile recovery with intelligence disabled", () => {
    expect(
      snapshotIntelligenceManifestSchema.safeParse(noneFixture).success,
    ).toBe(true);
    const profileOnly = {
      ...structuredClone(noneFixture),
      requiredCapabilities: [WORKING_PROFILE_SNAPSHOT_CAPABILITY],
      workingProfile: {
        logicalBytes: 0,
        newlyStoredBytes: 0,
        recordCount: 0,
        records: [],
      },
    };
    expect(
      snapshotIntelligenceManifestSchema.safeParse(profileOnly).success,
    ).toBe(true);
    expect(
      snapshotIntelligenceManifestSchema.safeParse({
        ...profileOnly,
        requiredCapabilities: [],
      }).success,
    ).toBe(false);
  });

  it("fails closed for unvetted-only, missing closure, and restored-authority attempts", () => {
    const unvettedOnly = structuredClone(approvedUnvettedFixture);
    unvettedOnly.approved = null;
    expect(
      snapshotIntelligenceManifestSchema.safeParse(unvettedOnly).success,
    ).toBe(false);

    const missingDependency = structuredClone(approvedFixture);
    const decision = missingDependency.approved?.records.find(
      (record) => record.recordType === "decision",
    );
    if (decision !== undefined) {
      decision.dependencies = ["ffffffff-ffff-4fff-8fff-ffffffffffff"];
    }
    expect(
      snapshotIntelligenceManifestSchema.safeParse(missingDependency).success,
    ).toBe(false);

    const authorityField = structuredClone(approvedFixture) as Record<
      string,
      unknown
    >;
    authorityField.liveGrants = [{ grantId: "should-not-parse" }];
    expect(
      snapshotIntelligenceManifestSchema.safeParse(authorityField).success,
    ).toBe(false);
  });

  it("fails closed for unknown recovery capabilities and conflicting portable objects", () => {
    const unknownCapability = structuredClone(noneFixture) as {
      requiredCapabilities: string[];
    };
    unknownCapability.requiredCapabilities.push(
      "owd.snapshot.unknown-intelligence-v1",
    );
    expect(
      snapshotIntelligenceManifestSchema.safeParse(unknownCapability).success,
    ).toBe(false);

    const conflictingObject = structuredClone(approvedFixture);
    const first = conflictingObject.approved?.records[0];
    const second = conflictingObject.approved?.records[1];
    if (first === undefined || second === undefined) {
      throw new Error("Approved fixture records missing");
    }
    second.portableObjectId = first.portableObjectId;
    expect(
      snapshotIntelligenceManifestSchema.safeParse(conflictingObject).success,
    ).toBe(false);

    const unacceptedRoot = structuredClone(approvedFixture);
    const root = unacceptedRoot.approved?.records.find(
      (record) => !record.evidenceOnly,
    );
    if (root === undefined) throw new Error("Approved root missing");
    root.originalState.disposition = "pending";
    expect(
      snapshotIntelligenceManifestSchema.safeParse(unacceptedRoot).success,
    ).toBe(false);
  });

  it("enforces the aggregate intelligence byte budget across both sections", () => {
    const oversized = structuredClone(approvedUnvettedFixture);
    const approvedTemplate = oversized.approved?.records.find(
      (record) => !record.evidenceOnly,
    );
    const unvettedTemplate = oversized.unvetted?.records[0];
    if (
      oversized.approved === null ||
      oversized.unvetted === null ||
      approvedTemplate === undefined ||
      unvettedTemplate === undefined
    ) {
      throw new Error("Recovery fixture sections missing");
    }
    oversized.approved.evidenceObjects = [];
    oversized.approved.evidenceObjectCount = 0;
    oversized.approved.records = Array.from({ length: 64 }, (_, index) => ({
      ...approvedTemplate,
      byteLength: MAX_SUBMISSION_BYTES,
      dependencies: [],
      portableObjectId: fixtureUuid(0x91000000, index + 1),
      recordId: fixtureUuid(0x92000000, index + 1),
    }));
    oversized.approved.recordCount = oversized.approved.records.length;
    oversized.approved.logicalBytes =
      oversized.approved.records.length * MAX_SUBMISSION_BYTES;
    oversized.approved.newlyStoredBytes = oversized.approved.logicalBytes;

    oversized.unvetted.evidenceObjects = [];
    oversized.unvetted.evidenceObjectCount = 0;
    oversized.unvetted.records = Array.from({ length: 65 }, (_, index) => ({
      ...unvettedTemplate,
      byteLength: MAX_SUBMISSION_BYTES,
      dependencies: [],
      portableObjectId: fixtureUuid(0x93000000, index + 1),
      recordId: fixtureUuid(0x94000000, index + 1),
    }));
    oversized.unvetted.recordCount = oversized.unvetted.records.length;
    oversized.unvetted.logicalBytes =
      oversized.unvetted.records.length * MAX_SUBMISSION_BYTES;
    oversized.unvetted.newlyStoredBytes = oversized.unvetted.logicalBytes;

    expect(
      snapshotIntelligenceManifestSchema.safeParse(oversized).success,
    ).toBe(false);
  });

  it("publishes the exact capability profile without treating MCP Tasks or A2A as state", () => {
    const profile =
      collaborationCapabilityProfileSchema.parse(capabilityFixture);
    expect(profile.mcpProtocolRevision).toBe("2025-11-25");
    expect(JSON.stringify(profile)).not.toMatch(/mcp-task|a2a-task/iu);
  });

  it("round-trips a provider-neutral Continuity Point with accepted truth, artifacts, and exact evidence", () => {
    const point = continuityPointSchema.parse(continuityFixture);
    expect(integrityDigest(point)).toBe(point.integrity.digest);
    expect(point.acceptedDecisions).toHaveLength(1);
    expect(point.artifacts).toHaveLength(1);
    expect(point.citedEvidence).toHaveLength(1);
    expect(JSON.stringify(point)).not.toMatch(
      /access_token|refresh_token|leaseId|grantId|workers\.dev|cloudflare|object_key/iu,
    );
    expect(
      continuityPointSchema.parse(JSON.parse(JSON.stringify(point))),
    ).toEqual(point);
  });

  it("rejects cross-Project continuity references and any attempt to restore authority", () => {
    const crossProject = structuredClone(continuityFixture);
    crossProject.acceptedDecisions[0]!.decision.projectId =
      "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(continuityPointSchema.safeParse(crossProject).success).toBe(false);

    const restoredAuthority = structuredClone(continuityFixture) as {
      authority: {
        liveAuthorityIncluded: boolean;
        restoredAuthorityAllowed: boolean;
      };
    };
    restoredAuthority.authority.liveAuthorityIncluded = true;
    restoredAuthority.authority.restoredAuthorityAllowed = true;
    expect(continuityPointSchema.safeParse(restoredAuthority).success).toBe(
      false,
    );
  });

  it("negotiates lead continuity separately from the legacy collaboration profile", () => {
    const leadProfile = leadContinuityCapabilityProfileSchema.parse(
      leadCapabilityFixture,
    );
    expect(leadProfile.mcpTools).toEqual([
      "claim_project_lead",
      "renew_project_lead",
      "checkpoint_project",
      "resume_project",
    ]);
    expect(capabilityFixture).not.toHaveProperty("continuityPointFormats");
  });
});
