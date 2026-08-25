import {
  agentMemoryContextSchema,
  owdCheckpointRequestSchema,
  owdFindRequestSchema,
  owdGetSkillRequestSchema,
  owdGetSkillResponseSchema,
  owdResumeRequestSchema,
  owdResumeResponseSchema,
  owdResumeResponseV2Schema,
} from "../src/index";
import { describe, expect, it } from "vitest";

const projectId = "91000000-0000-4000-8000-000000000001";
const checkpointBase = "a".repeat(64);

function independentContext() {
  return {
    brief: {
      constraints: ["Stay inside the explicit Project."],
      definitionOfDone: ["The bounded result is verified."],
      objective: "Continue the exact Project.",
      requestedOutput: "A verified result.",
    },
    citations: [],
    contextMode: "independent" as const,
    currentState: null,
    localVaultAccess: {
      basis: "project-creator" as const,
      enforcement: "advisory" as const,
      handoffRule: "same-client-resume-only" as const,
      humanOwnerRetainsAuthority: true as const,
      localWriteDefault: "owner-requested-bounded-task-only" as const,
      role: "primary-writer" as const,
      scope: "vault" as const,
      warning: "Write only for an owner-requested bounded task.",
    },
    omittedSections: {
      continuityOperationalConclusions: true,
      peerRecordBodies: true,
      provisionalResults: true,
    },
    project: { objective: "Continue the exact Project.", projectId },
    results: [],
    task: "Complete one independent task.",
  };
}

describe("agent-native memory facade contracts", () => {
  it("defaults resume and find to bounded ordinary inputs", () => {
    expect(owdResumeRequestSchema.parse({ projectId })).toEqual({
      acceptedContextVersions: [1],
      contextMode: "focused",
      projectId,
    });
    expect(
      owdFindRequestSchema.parse({ projectId, question: "What changed?" }),
    ).toEqual({ limit: 10, projectId, question: "What changed?" });
    expect(
      owdFindRequestSchema.safeParse({
        limit: 21,
        projectId,
        question: "What changed?",
      }).success,
    ).toBe(false);
    expect(
      owdResumeRequestSchema.safeParse({
        projectId,
        task: "x".repeat(2_001),
      }).success,
    ).toBe(false);
  });

  it("withholds continuity and peer results in independent structured data", () => {
    expect(agentMemoryContextSchema.parse(independentContext())).toEqual(
      independentContext(),
    );
    expect(
      agentMemoryContextSchema.safeParse({
        ...independentContext(),
        currentState: {
          acknowledgedAt: 1,
          blockers: [],
          completedWork: ["Peer conclusion."],
          decisions: [],
          knownRejectedApproaches: [],
          nextAction: "Continue.",
          openWork: [],
          provisionalDecisionNotes: [],
          risks: [],
        },
      }).success,
    ).toBe(false);
    expect(
      agentMemoryContextSchema.safeParse({
        ...independentContext(),
        results: [
          {
            completed: [],
            contentSha256: "a".repeat(64),
            durableRecordId: "91000000-0000-4000-8000-000000000002",
            provenance: {
              producerLabel: "Peer",
              receivedAt: 1,
              verification: "authorization-bound-client",
            },
            provisionalDecisionNotes: [],
            risks: [],
            suggestedNextActions: [],
            summary: "Peer conclusion.",
            unresolvedQuestions: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps the frozen v1 context strict and rejects additive profile fields", () => {
    expect(
      agentMemoryContextSchema.safeParse({
        ...independentContext(),
        workingProfile: { preferences: [], skills: [] },
      }).success,
    ).toBe(false);
  });

  it("negotiates the additive working-profile response without changing v1", () => {
    expect(
      owdResumeRequestSchema.parse({
        acceptedContextVersions: [1, 2],
        projectId,
      }).acceptedContextVersions,
    ).toEqual([1, 2]);
    expect(
      owdResumeRequestSchema.safeParse({
        acceptedContextVersions: [],
        projectId,
      }).success,
    ).toBe(false);

    const common = {
      checkpointBase,
      context: independentContext(),
      contextMode: "independent" as const,
      contextSha256: "b".repeat(64),
      markdown: "# OWD Project Context",
      ok: true as const,
      truncated: false,
    };
    expect(
      owdResumeResponseSchema.parse({ ...common, contextVersion: 1 }),
    ).not.toHaveProperty("workingProfile");
    expect(
      owdResumeResponseSchema.safeParse({
        ...common,
        contextVersion: 1,
        workingProfile: { preferences: [], skills: [] },
      }).success,
    ).toBe(false);
    expect(
      owdResumeResponseV2Schema.parse({
        ...common,
        contextVersion: 2,
        workingProfile: { preferences: [], skills: [] },
      }).contextVersion,
    ).toBe(2);
  });

  it("keeps checkpoint input simple, strict, bounded, and replay-keyed", () => {
    expect(
      owdCheckpointRequestSchema.parse({
        checkpointBase,
        idempotencyKey: "checkpoint.retry.0001",
        nextAction: "Resume the next bounded task.",
        outcome: "Completed and verified the requested work.",
        projectId,
      }),
    ).toEqual({
      blockers: [],
      checkpointBase,
      contextMode: "focused",
      decisions: [],
      idempotencyKey: "checkpoint.retry.0001",
      learningSignals: [],
      nextAction: "Resume the next bounded task.",
      outcome: "Completed and verified the requested work.",
      projectId,
      remainingWork: [],
      risks: [],
      usefulFailures: [],
      verificationEvidence: [],
    });
    expect(
      owdCheckpointRequestSchema.safeParse({
        checkpointBase,
        fencingToken: 1,
        idempotencyKey: "checkpoint.retry.0001",
        leaseId: "91000000-0000-4000-8000-000000000003",
        nextAction: "Continue.",
        outcome: "Completed work.",
        projectId,
      }).success,
    ).toBe(false);
    expect(
      owdCheckpointRequestSchema.parse({
        checkpointBase,
        contextMode: "independent",
        idempotencyKey: "checkpoint.retry.0003",
        nextAction: "Continue independently.",
        outcome: "Completed independent work.",
        projectId,
      }).contextMode,
    ).toBe("independent");
    expect(
      owdCheckpointRequestSchema.safeParse({
        checkpointBase,
        contextMode: "peer-visible",
        idempotencyKey: "checkpoint.retry.0004",
        nextAction: "Continue.",
        outcome: "Completed work.",
        projectId,
      }).success,
    ).toBe(false);
    expect(
      owdCheckpointRequestSchema.safeParse({
        checkpointBase,
        idempotencyKey: "checkpoint.retry.0002",
        nextAction: "Continue.",
        outcome: "x".repeat(1_025),
        projectId,
      }).success,
    ).toBe(false);
  });

  it("keeps provider-neutral skill retrieval exact, inert, and identity-bound", () => {
    const skillId = "91000000-0000-4000-8000-000000000004";
    const versionRecordId = "91000000-0000-4000-8000-000000000005";
    expect(
      owdGetSkillRequestSchema.parse({ projectId, skillId, versionRecordId }),
    ).toEqual({ projectId, skillId, versionRecordId });
    expect(
      owdGetSkillRequestSchema.safeParse({
        projectId,
        skillId,
        versionRecordId,
        provider: "stateful-current",
      }).success,
    ).toBe(false);
    expect(
      owdGetSkillResponseSchema.parse({
        executes: false,
        files: [{ contentBase64: "eA==", path: "SKILL.md" }],
        grantsAuthority: false,
        markdown: "# Inert skill",
        ok: true,
        packageSha256: "b".repeat(64),
        projectId,
        skill: {
          description: "A portable test skill",
          name: "test-skill",
          skillId,
          updatedAt: 1,
          versionRecordId,
        },
      }),
    ).toMatchObject({ executes: false, grantsAuthority: false });
  });
});
