import { collaborationProjectSummarySchema } from "@owd/contracts";
import { describe, expect, it } from "vitest";

const projectId = "10000000-0000-4000-8000-000000000001";

function summary(latestCheckpoint: null | Record<string, unknown>) {
  return {
    activeGrantCount: 1,
    activeKnowledgeSpaceVersionId: "20000000-0000-4000-8000-000000000002",
    activeProjectVersionId: "30000000-0000-4000-8000-000000000003",
    agentVisibility: "discoverable",
    createdAt: 1_800_000_000,
    currentBrief: {
      definitionOfDone: ["A fresh AI can continue correctly."],
      latestCheckpoint,
      nextAction: "Continue the bounded implementation.",
      objective: "Ship the current owner-facing Project workspace.",
    },
    currentPacket: {
      createdAt: 1_800_000_000,
      expiresAt: 1_800_604_800,
      packetId: "40000000-0000-4000-8000-000000000004",
      workItemId: "50000000-0000-4000-8000-000000000005",
    },
    duplicateGroupSize: 1,
    label: "Durable project memory",
    lastActivityAt: 1_800_000_100,
    objective: "Make useful project memory portable between AI tools.",
    pendingAuthorizationCount: 0,
    projectId,
    recordCount: 8,
    sourceVaults: [
      { id: "60000000-0000-4000-8000-000000000006", name: "Product" },
    ],
    state: "ready",
    status: "active",
    workItemCount: 1,
  };
}

describe("owner Project workspace contract", () => {
  it("keeps a useful current brief before the first checkpoint", () => {
    const parsed = collaborationProjectSummarySchema.parse(summary(null));
    expect(parsed.currentBrief?.latestCheckpoint).toBeNull();
    expect(parsed.currentBrief?.definitionOfDone).toEqual([
      "A fresh AI can continue correctly.",
    ]);
  });

  it("carries the latest bounded checkpoint summary without runtime internals", () => {
    const parsed = collaborationProjectSummarySchema.parse(
      summary({
        acceptedDecisions: [
          {
            createdAt: 1_800_000_050,
            rationale: "Use the owner-approved continuation.",
            resolution: "accepted",
          },
        ],
        acknowledgedAt: 1_800_000_100,
        blockers: ["Waiting for focused tests."],
        citedEvidence: [
          {
            contentSha256: "a".repeat(64),
            label: "Brief.md",
            path: "Research/Brief.md",
          },
        ],
        completedWork: ["The Project brief is visible."],
        knownRejectedApproaches: ["Raw-session replay."],
        openWork: ["Run validation."],
      }),
    );
    expect(parsed.currentBrief?.latestCheckpoint).toMatchObject({
      completedWork: ["The Project brief is visible."],
      openWork: ["Run validation."],
    });
    expect(parsed.currentBrief?.latestCheckpoint).not.toHaveProperty(
      "provisionalDecisionNotes",
    );
    expect(parsed.currentBrief).not.toHaveProperty("runId");
    expect(parsed.currentBrief).not.toHaveProperty("leaseId");
  });
});
