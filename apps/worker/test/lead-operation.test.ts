import { describe, expect, it } from "vitest";
import {
  actorSchema,
  eventBundleSchema,
  projectExceptionSchema,
  projectPolicySchema,
  runSchema,
} from "@mdevolved/contracts";
import { LeadOperationProblem } from "../src/lead-operation-service";

describe("R2 lead-operation contract spine", () => {
  const ids = () => crypto.randomUUID();
  it("accepts policy, run, actor, bundle and exception envelopes", () => {
    const projectId = ids();
    const workItemId = ids();
    const runId = ids();
    const policyId = ids();
    const actorId = ids();
    const now = 1_000;
    expect(
      projectPolicySchema.parse({
        format: "owd-project-policy-v1",
        schemaVersion: 1,
        policyId,
        projectId,
        projectVersionId: ids(),
        createdAt: now,
        maxActorsPerRun: 8,
        maxBundlesPerRun: 64,
        maxEventsPerBundle: 16,
        maxBundleBytes: 262144,
        maxRunLogicalBytes: 4194304,
        independentReviewRequired: true,
        protectedPaths: [".git", ".owdignore", ".obsidian"],
        exceptionOnlyActions: [
          "authority-expansion",
          "destructive-action",
          "protected-path-access",
        ],
        source: "project-version-bound-default",
        liveAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
      }),
    ).toBeTruthy();
    expect(
      runSchema.parse({
        format: "owd-run-v1",
        schemaVersion: 1,
        runId,
        projectId,
        workItemId,
        policyId,
        purpose: "research",
        status: "active",
        createdAt: now,
        completedAt: null,
        logicalBytes: 0,
      }),
    ).toBeTruthy();
    expect(
      actorSchema.parse({
        format: "owd-actor-v1",
        schemaVersion: 1,
        actorId,
        projectId,
        runId,
        workItemId,
        claimedIdentity: "synthetic",
        scopes: ["run.bundle.submit"],
        issuedAt: now,
        expiresAt: now + 60,
        revokedAt: null,
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }),
    ).toBeTruthy();
    expect(
      eventBundleSchema.safeParse({
        format: "owd-event-bundle-v1",
        schemaVersion: 1,
        bundleId: ids(),
        projectId,
        runId,
        actorId,
        visibility: "run-shared-unvetted",
        createdAt: now,
        events: [
          {
            eventType: "result.provisional",
            eventId: ids(),
            actorId,
            runId,
            summary: "synthetic",
            claims: [],
          },
        ],
        requestedActions: [],
        normalizedRelativePath: null,
      }),
    ).toBeTruthy();
    expect(
      projectExceptionSchema.parse({
        format: "owd-project-exception-v1",
        schemaVersion: 1,
        exceptionId: ids(),
        projectId,
        runId,
        workItemId,
        actorId,
        kind: "budget-exhausted",
        status: "blocking",
        requestedAction: null,
        normalizedRelativePath: null,
        summary: "budget",
        evidenceRefs: [],
        createdAt: now,
        resolvedAt: null,
      }),
    ).toBeTruthy();
  });
  it("uses a stable problem code", () => {
    const problem = new LeadOperationProblem("lease_invalid");
    expect(problem.code).toBe("lease_invalid");
    expect(problem.message).toBe("lease_invalid");
  });
});
