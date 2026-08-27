import { describe, expect, it } from "vitest";
import {
  MAX_POLICY_EVIDENCE_REFS,
  completeContinuityDrillRequestSchema,
  completionPolicySchema,
  continuityReceiptSchema,
  evaluateRunPolicyRequestSchema,
  md8CapabilitiesSchema,
  policyBindingSchema,
  policyDecisionSchema,
  r4CapabilitiesSchema,
} from "@owd/contracts";
import bindingFixture from "../fixtures/owd-policy-binding-v1.json";
import receiptFixture from "../fixtures/owd-continuity-receipt-v1.json";
import decisionFixture from "../fixtures/owd-policy-decision-v1.json";

describe("R4 policy autopilot and continuity fixtures", () => {
  it("requires explicit owner consent before advertising solo completion", () => {
    expect(
      completionPolicySchema.parse({
        allowedModes: ["orchestrated-reviewed", "solo-verified"],
        defaultMode: "orchestrated-reviewed",
        format: "owd-completion-policy-v1",
        schemaVersion: 1,
        soloVerifiedOwnerConsent: true,
      }).soloVerifiedOwnerConsent,
    ).toBe(true);
    expect(
      completionPolicySchema.safeParse({
        allowedModes: ["orchestrated-reviewed", "solo-verified"],
        defaultMode: "orchestrated-reviewed",
        format: "owd-completion-policy-v1",
        schemaVersion: 1,
        soloVerifiedOwnerConsent: false,
      }).success,
    ).toBe(false);
  });

  it("does not let solo completion claim an independent review", () => {
    const solo = structuredClone(decisionFixture);
    solo.completionMode = "solo-verified";
    const review = solo.checks.find(
      (check) => check.key === "independent-review",
    );
    if (review === undefined) throw new Error("Review check missing.");
    review.evidenceRefs = [];
    expect(policyDecisionSchema.safeParse(solo).success).toBe(true);
    review.evidenceRefs = [solo.decisionId];
    expect(policyDecisionSchema.safeParse(solo).success).toBe(false);
  });

  it("parses the frozen owner policy, deterministic allow, and redacted drill receipt", () => {
    expect(policyBindingSchema.parse(bindingFixture).ownerAuthored).toBe(true);
    expect(policyDecisionSchema.parse(decisionFixture).checks).toHaveLength(10);
    expect(continuityReceiptSchema.parse(receiptFixture).metrics).toEqual({
      continuityAgeSeconds: 60,
      recoveryChecksPassed: 8,
      recoveryChecksTotal: 8,
      recoveryQualityBps: 10_000,
      rpoSeconds: 10,
      rtoSeconds: 40,
      runtimeIndependent: true,
    });
  });

  it("fails closed for self-approval, policy editing, and an incomplete truth table", () => {
    const selfApproval = {
      projectId: decisionFixture.projectId,
      runId: decisionFixture.runId,
      workItemId: decisionFixture.workItemId,
      leaseId: "78000000-0000-4000-8000-000000000001",
      fencingToken: 1,
      idempotencyKey: "r4-self-approval-0001",
      normalizedRelativePath: null,
      requestedOwnerActions: ["self-approval"],
    };
    expect(evaluateRunPolicyRequestSchema.parse(selfApproval)).toMatchObject({
      requestedOwnerActions: ["self-approval"],
    });

    const editedBinding = structuredClone(bindingFixture);
    editedBinding.ownerAuthored = false;
    expect(policyBindingSchema.safeParse(editedBinding).success).toBe(false);

    const incomplete = structuredClone(decisionFixture);
    incomplete.checks.pop();
    expect(policyDecisionSchema.safeParse(incomplete).success).toBe(false);

    const falseAllow = structuredClone(decisionFixture);
    falseAllow.checks[2]!.passed = false;
    expect(policyDecisionSchema.safeParse(falseAllow).success).toBe(false);
  });

  it("rejects malformed or oversized evidence and conflicting outcome fields", () => {
    const oversized = structuredClone(decisionFixture);
    oversized.evidenceRefs = Array.from(
      { length: MAX_POLICY_EVIDENCE_REFS + 1 },
      (_, index) => ({
        contentSha256: String(index).padStart(64, "a").slice(-64),
        id: `79000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        kind: "accepted-content" as const,
      }),
    );
    expect(policyDecisionSchema.safeParse(oversized).success).toBe(false);

    const exceptionWithoutReason = structuredClone(decisionFixture);
    exceptionWithoutReason.outcome = "exception";
    exceptionWithoutReason.checks[2]!.passed = false;
    expect(policyDecisionSchema.safeParse(exceptionWithoutReason).success).toBe(
      false,
    );
  });

  it("derives exact RPO, RTO, age, quality, and runtime independence", () => {
    const wrongMetric = structuredClone(receiptFixture);
    wrongMetric.metrics.rpoSeconds += 1;
    expect(continuityReceiptSchema.safeParse(wrongMetric).success).toBe(false);

    const secretLeak = structuredClone(receiptFixture);
    secretLeak.redaction.credentialsIncluded = true;
    expect(continuityReceiptSchema.safeParse(secretLeak).success).toBe(false);

    const incompleteRecovery = structuredClone(receiptFixture);
    incompleteRecovery.metrics.recoveryChecksPassed = 7;
    incompleteRecovery.metrics.recoveryQualityBps = 8_750;
    incompleteRecovery.metrics.runtimeIndependent = true;
    incompleteRecovery.outcome = "fail";
    expect(continuityReceiptSchema.safeParse(incompleteRecovery).success).toBe(
      false,
    );

    const postLossCheckpoint = structuredClone(receiptFixture);
    postLossCheckpoint.sourceTimes.latestAcknowledgedPointAt =
      postLossCheckpoint.sourceTimes.simulatedLeadLossAt + 1;
    postLossCheckpoint.sourceTimes.restoredPointAcknowledgedAt =
      postLossCheckpoint.sourceTimes.latestAcknowledgedPointAt;
    postLossCheckpoint.metrics.rpoSeconds = 0;
    postLossCheckpoint.metrics.continuityAgeSeconds =
      postLossCheckpoint.sourceTimes.receiptEmittedAt -
      postLossCheckpoint.sourceTimes.restoredPointAcknowledgedAt;
    expect(continuityReceiptSchema.safeParse(postLossCheckpoint).success).toBe(
      false,
    );

    const productiveAfterReceipt = structuredClone(receiptFixture);
    productiveAfterReceipt.sourceTimes.replacementProductiveAt =
      productiveAfterReceipt.sourceTimes.receiptEmittedAt + 1;
    productiveAfterReceipt.metrics.rtoSeconds =
      productiveAfterReceipt.sourceTimes.replacementProductiveAt -
      productiveAfterReceipt.sourceTimes.simulatedLeadLossAt;
    expect(
      continuityReceiptSchema.safeParse(productiveAfterReceipt).success,
    ).toBe(false);
  });

  it("binds drill completion to the exact scheduled request and Project", () => {
    const request = {
      fencingToken: 9,
      idempotencyKey: "r4-drill-completion-0001",
      leaseId: "78000000-0000-4000-8000-000000000001",
      projectId: receiptFixture.projectId,
      receipt: receiptFixture,
      requestId: receiptFixture.drillId,
    };
    expect(completeContinuityDrillRequestSchema.parse(request)).toMatchObject({
      projectId: receiptFixture.projectId,
      requestId: receiptFixture.drillId,
    });

    expect(
      completeContinuityDrillRequestSchema.safeParse({
        ...request,
        requestId: "78000000-0000-4000-8000-000000000002",
      }).success,
    ).toBe(false);
    expect(
      completeContinuityDrillRequestSchema.safeParse({
        ...request,
        projectId: "78000000-0000-4000-8000-000000000003",
      }).success,
    ).toBe(false);
  });

  it("negotiates R4 additively without changing v1 or v2 clients", () => {
    expect(
      r4CapabilitiesSchema.parse({
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: "owd-lead-operation-capabilities-v3",
        formats: [
          "owd-policy-binding-v1",
          "owd-policy-decision-v1",
          "owd-operational-schedule-v1",
          "owd-operational-evidence-v1",
          "owd-continuity-receipt-v1",
        ],
        mcpProtocolRevision: "2025-11-25",
        mcpTools: [
          "evaluate_run_policy",
          "get_policy_operations",
          "complete_continuity_drill",
        ],
        requiredScope: "project.lead",
        schemaVersion: 3,
      }).schemaVersion,
    ).toBe(3);
  });

  it("negotiates autonomous completion without changing the reviewed legacy default", () => {
    expect(
      md8CapabilitiesSchema.parse({
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        completionModes: ["orchestrated-reviewed", "solo-verified"],
        completionPolicyFormat: "owd-completion-policy-v1",
        connectionModes: [
          "direct-mcp",
          "lead-mediated-mcp",
          "portable-handoff",
        ],
        format: "owd-lead-operation-capabilities-v4",
        legacyDefaultMode: "orchestrated-reviewed",
        mcpProtocolRevision: "2025-11-25",
        requiredScope: "project.lead",
        schemaVersion: 4,
      }),
    ).toMatchObject({
      legacyDefaultMode: "orchestrated-reviewed",
      schemaVersion: 4,
    });
  });
});
