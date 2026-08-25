import {
  compoundingCandidateSchema,
  compoundingDraftActionRequestSchema,
  compoundingDraftSchema,
  learningSignalsSchema,
} from "../src/index";
import { describe, expect, it } from "vitest";

const projectId = "92000000-0000-4000-8000-000000000001";
const pointId = "92000000-0000-4000-8000-000000000002";

describe("M3 compounding contracts", () => {
  it("accepts only bounded provider-neutral learning signals", () => {
    expect(
      learningSignalsSchema.parse([
        {
          key: "package-manager",
          kind: "preference",
          projectId,
          scope: "project",
          value: "Use pnpm.",
        },
        {
          description: "Run the focused checks.",
          instruction: "Run the focused checks and record the result.",
          kind: "skill",
          name: "focused-checks",
          projectId: null,
          scope: "personal",
        },
      ]),
    ).toHaveLength(2);
    expect(
      learningSignalsSchema.safeParse(
        Array.from({ length: 5 }, () => ({
          key: "one",
          kind: "preference",
          projectId: null,
          scope: "personal",
          value: "bounded",
        })),
      ).success,
    ).toBe(false);
    expect(
      learningSignalsSchema.safeParse([
        {
          key: "unsafe",
          kind: "preference",
          projectId,
          scope: "personal",
          value: "wrong scope",
        },
      ]).success,
    ).toBe(false);
  });

  it("keeps drafts explicit, attributable, and correlation-labeled", () => {
    const candidate = compoundingCandidateSchema.parse({
      key: "package-manager",
      kind: "preference",
      projectId,
      scope: "project",
      value: "Use pnpm.",
    });
    const draft = compoundingDraftSchema.parse({
      candidate,
      conflict: true,
      correlationNote: "Suggestion only; correlation is not proof.",
      draftId: "92000000-0000-4000-8000-000000000003",
      evidence: [
        {
          acknowledgedAt: 10,
          continuityPointId: pointId,
          contentSha256: "a".repeat(64),
          producerClientId: "client-a",
        },
        {
          acknowledgedAt: 20,
          continuityPointId: "92000000-0000-4000-8000-000000000004",
          contentSha256: "b".repeat(64),
          producerClientId: "client-b",
        },
      ],
      fingerprint: "c".repeat(64),
      firstObservedAt: 10,
      lastObservedAt: 20,
      observationCount: 2,
      projectId,
      scope: "project",
      status: "pending",
    });
    expect(draft.conflict).toBe(true);
    expect(
      compoundingDraftActionRequestSchema.parse({
        draftId: draft.draftId,
        idempotencyKey: "owner-action-0001",
      }),
    ).toMatchObject({ attachProjectSkill: false, sourceLabel: "Owner" });
    expect(
      compoundingCandidateSchema.safeParse({
        ...candidate,
        terminalHistory: "forbidden",
      }).success,
    ).toBe(false);
  });
});
