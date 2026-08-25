import {
  collaborationProjectBriefUpdateRequestSchema,
  collaborationProjectBriefUpdateResponseSchema,
} from "@owd/contracts";
import { describe, expect, it } from "vitest";

const projectVersionId = "10000000-0000-4000-8000-000000000001";
const workItemVersionId = "20000000-0000-4000-8000-000000000002";

describe("owner Project brief edit contract", () => {
  it("accepts a bounded successor brief and response", () => {
    const request = collaborationProjectBriefUpdateRequestSchema.parse({
      expectedProjectVersionId: projectVersionId,
      expectedWorkItemVersionId: workItemVersionId,
      idempotencyKey: "brief-edit-1",
      project: { objective: "Ship the verified cross-agent continuation." },
      workItem: {
        constraints: ["Keep provider-neutral evidence."],
        definitionOfDone: ["A fresh agent resumes without prompt copying."],
        objective: "Validate the next resume.",
        requestedOutput: "A concise acceptance report.",
      },
    });
    expect(request.workItem?.definitionOfDone).toHaveLength(1);
    expect(
      collaborationProjectBriefUpdateResponseSchema.parse({
        activeProjectVersionId: projectVersionId,
        activeWorkItemVersionId: workItemVersionId,
        projectId: "30000000-0000-4000-8000-000000000003",
        workItemId: "40000000-0000-4000-8000-000000000004",
      }).activeProjectVersionId,
    ).toBe(projectVersionId);
  });

  it("rejects empty, malformed, and oversized edits", () => {
    expect(
      collaborationProjectBriefUpdateRequestSchema.safeParse({
        expectedProjectVersionId: projectVersionId,
        expectedWorkItemVersionId: workItemVersionId,
      }).success,
    ).toBe(false);
    expect(
      collaborationProjectBriefUpdateRequestSchema.safeParse({
        expectedProjectVersionId: "other-project",
        expectedWorkItemVersionId: workItemVersionId,
        workItem: {
          constraints: [],
          definitionOfDone: ["ok"],
          objective: "ok",
          requestedOutput: "ok",
        },
      }).success,
    ).toBe(false);
    expect(
      collaborationProjectBriefUpdateRequestSchema.safeParse({
        expectedProjectVersionId: projectVersionId,
        expectedWorkItemVersionId: workItemVersionId,
        workItem: {
          constraints: [],
          definitionOfDone: ["ok"],
          objective: "ok",
          requestedOutput: "x".repeat(32_769),
        },
      }).success,
    ).toBe(false);
  });
});
