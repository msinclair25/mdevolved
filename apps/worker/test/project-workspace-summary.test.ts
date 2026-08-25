import { describe, expect, it } from "vitest";
import {
  packetMatchesActiveProject,
  projectWorkspaceSummary,
} from "../src/collaboration-service";

const ids = {
  knowledgeSpaceVersionId: "10000000-0000-4000-8000-000000000001",
  packetId: "20000000-0000-4000-8000-000000000002",
  projectId: "30000000-0000-4000-8000-000000000003",
  projectVersionId: "40000000-0000-4000-8000-000000000004",
  workItemId: "50000000-0000-4000-8000-000000000005",
  workItemVersionId: "60000000-0000-4000-8000-000000000006",
};

const packet = {
  ...ids,
  brief: {
    constraints: [],
    definitionOfDone: ["The next AI continues from durable memory."],
    objective: "Finish the current Project workspace.",
    requestedOutput: "A verified owner-facing workspace.",
  },
};

const authority = {
  activeKnowledgeSpaceVersionId: ids.knowledgeSpaceVersionId,
  activeProjectVersionId: ids.projectVersionId,
  activeWorkItemVersionId: ids.workItemVersionId,
  currentPacketId: ids.packetId,
  currentWorkItemId: ids.workItemId,
  knowledgeSpaceValid: true,
  packetIntegrityValid: true,
  projectId: ids.projectId,
  projectStatus: "active" as const,
  workItemStatus: "open" as const,
};

describe("Project workspace dashboard projection", () => {
  it("allows only the exact integrity-valid active packet", () => {
    // Expiry is intentionally absent: routine resume rotates an otherwise authoritative packet.
    expect(packetMatchesActiveProject(packet, authority)).toBe(true);
    expect(
      packetMatchesActiveProject(packet, {
        ...authority,
        workItemStatus: "closed",
      }),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(
        { ...packet, projectVersionId: crypto.randomUUID() },
        authority,
      ),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(
        { ...packet, knowledgeSpaceVersionId: crypto.randomUUID() },
        authority,
      ),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(
        { ...packet, packetId: crypto.randomUUID() },
        authority,
      ),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(
        { ...packet, workItemId: crypto.randomUUID() },
        authority,
      ),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(
        { ...packet, workItemVersionId: crypto.randomUUID() },
        authority,
      ),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(packet, {
        ...authority,
        knowledgeSpaceValid: false,
      }),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(packet, {
        ...authority,
        projectStatus: "archived",
      }),
    ).toBe(false);
    expect(
      packetMatchesActiveProject(packet, {
        ...authority,
        packetIntegrityValid: false,
      }),
    ).toBe(false);
  });

  it("uses the current Work Packet before a checkpoint exists", () => {
    expect(projectWorkspaceSummary(packet, null)).toEqual({
      constraints: [],
      definitionOfDone: ["The next AI continues from durable memory."],
      latestCheckpoint: null,
      nextAction: "Finish the current Project workspace.",
      objective: "Finish the current Project workspace.",
      requestedOutput: "A verified owner-facing workspace.",
    });
  });

  it("projects accepted Decisions, evidence metadata, and rejected approaches without content", () => {
    expect(
      projectWorkspaceSummary(packet, {
        acceptedDecisions: [
          {
            decision: {
              createdAt: 1_800_000_090,
              rationale: "Keep the owner-approved approach.",
              resolution: "accepted",
            },
          },
        ],
        blockers: ["Focused validation remains."],
        citedEvidence: [
          {
            citation: {
              path: "Research/Current evidence.md",
              sourceContentSha256: "a".repeat(64),
            },
          },
        ],
        completedWork: ["The current brief is visible."],
        knownRejectedApproaches: ["Do not replay raw sessions."],
        nextAction: "Run the focused tests.",
        openWork: ["Verify narrow-width styles."],
        provenance: { acknowledgedAt: 1_800_000_100 },
      }),
    ).toMatchObject({
      latestCheckpoint: {
        acceptedDecisions: [
          {
            rationale: "Keep the owner-approved approach.",
            resolution: "accepted",
          },
        ],
        citedEvidence: [
          {
            contentSha256: "a".repeat(64),
            label: "Current evidence.md",
            path: "Research/Current evidence.md",
          },
        ],
        knownRejectedApproaches: ["Do not replay raw sessions."],
      },
      nextAction: "Run the focused tests.",
    });
  });
});
