import { describe, expect, it } from "vitest";
import {
  MAX_R2_EVENTS_PER_BUNDLE,
  MAX_R3_BUNDLE_BATCH,
  MAX_R3_DELTA_PAGE,
  MAX_R3_REGISTER_BATCH,
  elasticRunPlaneSchema,
  eventBundleSchema,
  leadOperationCapabilitiesSchema,
  orcaProjectionSchema,
  projectExceptionSchema,
  projectPolicySchema,
  r3CapabilitiesSchema,
  registerActorsBatchRequestSchema,
  runObservationSchema,
  runContextSchema,
  runDeltaPageSchema,
  submitBundlesBatchRequestSchema,
} from "@owd/contracts";
import policyFixture from "../fixtures/owd-project-policy-v1.json";
import bundleFixture from "../fixtures/owd-event-bundle-v1.json";
import capabilitiesFixture from "../fixtures/owd-lead-operation-capabilities-v1.json";
import packetFixture from "../fixtures/owd-work-packet-v1.json";
import elasticFixture from "../fixtures/owd-elastic-run-plane-v1.json";

describe("R2 hands-off lead operation fixtures", () => {
  it("parses the frozen policy, bundle, and capabilities envelopes", () => {
    expect(projectPolicySchema.parse(policyFixture).protectedPaths).toEqual([
      ".git",
      ".owdignore",
      ".obsidian",
    ]);
    expect(eventBundleSchema.parse(bundleFixture).visibility).toBe(
      "run-shared-unvetted",
    );
    expect(
      leadOperationCapabilitiesSchema.parse(capabilitiesFixture).mcpTools,
    ).toHaveLength(7);
  });

  it("rejects duplicate or oversize events and cross-envelope IDs", () => {
    const duplicateClaims = structuredClone(bundleFixture);
    duplicateClaims.events[0]!.claims.push({
      key: duplicateClaims.events[0]!.claims[0]!.key,
      valueSha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      evidenceSha256: null,
    });
    expect(eventBundleSchema.safeParse(duplicateClaims).success).toBe(false);

    const tooManyEvents = structuredClone(bundleFixture);
    tooManyEvents.events = Array.from(
      { length: MAX_R2_EVENTS_PER_BUNDLE + 1 },
      () => ({ ...bundleFixture.events[0] }),
    );
    expect(eventBundleSchema.safeParse(tooManyEvents).success).toBe(false);

    const oversizedBytes = structuredClone(bundleFixture);
    oversizedBytes.events = Array.from(
      { length: MAX_R2_EVENTS_PER_BUNDLE },
      () => ({
        actorId: bundleFixture.actorId,
        eventId: crypto.randomUUID(),
        eventType: "review.completed" as const,
        findings: Array.from({ length: 16 }, () => "x".repeat(2_048)),
        runId: bundleFixture.runId,
        summary: "Oversized but otherwise bounded event fields.",
        targetBundleId: crypto.randomUUID(),
        verdict: "inconclusive" as const,
      }),
    );
    expect(eventBundleSchema.safeParse(oversizedBytes).success).toBe(false);

    const crossEnvelope = structuredClone(bundleFixture);
    crossEnvelope.events[0]!.runId = "72000000-0000-4000-8000-ffffffffffff";
    expect(eventBundleSchema.safeParse(crossEnvelope).success).toBe(false);
  });

  it("rejects unsafe protected paths, review self-routing, and restored authority", () => {
    const exception = {
      format: "owd-project-exception-v1",
      schemaVersion: 1,
      exceptionId: "73000000-0000-4000-8000-000000000001",
      projectId: policyFixture.projectId,
      runId: null,
      workItemId: null,
      actorId: null,
      kind: "protected-path-access",
      status: "open",
      requestedAction: "protected-path-access",
      normalizedRelativePath: "../.git/config",
      summary: "unsafe",
      evidenceRefs: [],
      createdAt: 1784820500,
      resolvedAt: null,
    };
    expect(projectExceptionSchema.safeParse(exception).success).toBe(false);
    expect(
      projectExceptionSchema.safeParse({
        ...exception,
        normalizedRelativePath: ".GIT/config",
      }).success,
    ).toBe(false);

    const selfReview = structuredClone(bundleFixture);
    selfReview.events[0] = {
      eventType: "review.requested",
      eventId: crypto.randomUUID(),
      actorId: bundleFixture.actorId,
      runId: bundleFixture.runId,
      targetBundleId: bundleFixture.bundleId,
      reviewerActorId: bundleFixture.actorId,
    };
    expect(eventBundleSchema.safeParse(selfReview).success).toBe(false);

    expect(
      runContextSchema.safeParse({
        format: "owd-run-context-v1",
        schemaVersion: 1,
        projectId: policyFixture.projectId,
        run: {
          format: "owd-run-v1",
          schemaVersion: 1,
          runId: bundleFixture.runId,
          projectId: policyFixture.projectId,
          workItemId: "74000000-0000-4000-8000-000000000001",
          policyId: policyFixture.policyId,
          purpose: "research",
          status: "active",
          createdAt: 1784820500,
          completedAt: null,
          logicalBytes: 0,
        },
        policy: policyFixture,
        workPacket: packetFixture,
        actors: [],
        acceptedBundles: [],
        exceptions: [],
        authority: {
          restoredAuthorityAllowed: true,
          liveAuthorityIncluded: true,
        },
      }).success,
    ).toBe(false);
  });

  it("parses the opt-in elastic profile and v2 capabilities", () => {
    expect(
      elasticRunPlaneSchema.parse(elasticFixture).profile.maxActiveActors,
    ).toBe(32);
    expect(
      r3CapabilitiesSchema.parse({
        format: "owd-lead-operation-capabilities-v2",
        schemaVersion: 2,
        mcpTools: [
          "create_work_item",
          "start_run",
          "register_actor",
          "register_actors_batch",
          "get_run_context",
          "get_run_delta",
          "submit_bundle",
          "submit_bundles_batch",
          "recover_actor",
          "submit_budget_entry",
          "submit_observation",
          "project_orca_metadata",
          "complete_work_item",
          "list_project_exceptions",
        ],
        formats: [
          "owd-project-policy-v1",
          "owd-run-v1",
          "owd-actor-v1",
          "owd-event-bundle-v1",
          "owd-project-exception-v1",
          "owd-run-context-v1",
          "owd-elastic-run-plane-v1",
          "owd-elastic-account-v1",
          "owd-actor-recovery-v1",
          "owd-run-delta-v1",
          "owd-run-budget-v1",
          "owd-budget-entry-v1",
          "owd-run-observation-v1",
          "owd-orca-projection-v1",
        ],
        mcpProtocolRevision: "2025-11-25",
        requiredScope: "project.lead",
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).schemaVersion,
    ).toBe(2);
  });

  it("rejects duplicate/oversize batches, cross-run deltas, and Orca authority", () => {
    const actor = {
      actorId: "72000000-0000-4000-8000-000000000003",
      claimedIdentity: "actor",
      scopes: ["run.context.read"],
      lifetimeSeconds: 60,
    };
    const base = {
      projectId: "71000000-0000-4000-8000-000000000002",
      leaseId: "71000000-0000-4000-8000-000000000003",
      fencingToken: 1,
      idempotencyKey: "r3-register-batch-0001",
      runId: "72000000-0000-4000-8000-000000000002",
      workItemId: "74000000-0000-4000-8000-000000000001",
    };
    const tooManyActors = {
      ...base,
      actors: Array.from({ length: MAX_R3_REGISTER_BATCH + 1 }, (_, index) => ({
        ...actor,
        actorId: `72000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      })),
    };
    expect(
      registerActorsBatchRequestSchema.safeParse(tooManyActors).success,
    ).toBe(false);
    expect(
      registerActorsBatchRequestSchema.safeParse({
        ...base,
        actors: [actor, actor],
      }).success,
    ).toBe(false);
    const tooManyBundles = {
      ...base,
      items: Array.from({ length: MAX_R3_BUNDLE_BATCH + 1 }, () => ({
        bundle: bundleFixture,
        usage: { logicalUnits: 1, costMicrounits: 1, reportedBy: "harness" },
      })),
    };
    expect(
      submitBundlesBatchRequestSchema.safeParse(tooManyBundles).success,
    ).toBe(false);
    expect(
      submitBundlesBatchRequestSchema.safeParse({
        ...base,
        items: [
          {
            bundle: bundleFixture,
            usage: {
              logicalUnits: 0,
              costMicrounits: 0,
              reportedBy: "harness",
            },
          },
        ],
      }).success,
    ).toBe(false);
    const delta = {
      format: "owd-run-delta-v1",
      schemaVersion: 1,
      projectId: base.projectId,
      runId: base.runId,
      recordType: "actor",
      recordId: actor.actorId,
      contentSha256: null,
      occurredAt: 1,
      metadata: { retentionTier: "hot", retainUntil: 2 },
      authority: {
        restoredAuthorityAllowed: false,
        liveAuthorityIncluded: false,
      },
    } as const;
    expect(
      runDeltaPageSchema.safeParse({
        format: "owd-run-delta-v1",
        schemaVersion: 1,
        projectId: base.projectId,
        runId: base.runId,
        cursor: null,
        hasMore: false,
        deltas: Array.from({ length: MAX_R3_DELTA_PAGE + 1 }, () => delta),
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
    expect(
      orcaProjectionSchema.safeParse({
        format: "owd-orca-projection-v1",
        schemaVersion: 1,
        projectionId: actor.actorId,
        projectId: base.projectId,
        runId: base.runId,
        actorId: actor.actorId,
        worktreeRef: "w",
        branchRef: "b",
        commitSha: null,
        pullRequestRef: null,
        sessionRef: null,
        provider: "orca",
        observedAt: 1,
        metadata: { retentionTier: "hot", retainUntil: 2 },
        authority: {
          restoredAuthorityAllowed: true,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
    expect(
      orcaProjectionSchema.safeParse({
        format: "owd-orca-projection-v1",
        schemaVersion: 1,
        projectionId: actor.actorId,
        projectId: base.projectId,
        runId: base.runId,
        actorId: null,
        worktreeRef: null,
        branchRef: null,
        commitSha: "a".repeat(41),
        pullRequestRef: null,
        sessionRef: null,
        provider: "orca",
        observedAt: 2,
        metadata: { retentionTier: "hot", retainUntil: 3 },
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
    expect(
      orcaProjectionSchema.safeParse({
        format: "owd-orca-projection-v1",
        schemaVersion: 1,
        projectionId: actor.actorId,
        projectId: base.projectId,
        runId: base.runId,
        actorId: null,
        worktreeRef: null,
        branchRef: null,
        commitSha: "a".repeat(40),
        pullRequestRef: null,
        sessionRef: null,
        provider: "orca",
        observedAt: 2,
        metadata: { retentionTier: "hot", retainUntil: 1 },
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
    expect(
      orcaProjectionSchema.safeParse({
        format: "owd-orca-projection-v1",
        schemaVersion: 1,
        projectionId: actor.actorId,
        projectId: base.projectId,
        runId: base.runId,
        actorId: null,
        worktreeRef: "https://orca.invalid/worktree?token=secret",
        branchRef: "main\nmalformed",
        commitSha: null,
        pullRequestRef: null,
        sessionRef: null,
        provider: "orca",
        observedAt: 1,
        metadata: { retentionTier: "hot", retainUntil: 2 },
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
    expect(
      runObservationSchema.safeParse({
        format: "owd-run-observation-v1",
        schemaVersion: 1,
        observationId: actor.actorId,
        projectId: base.projectId,
        runId: base.runId,
        actorCount: 24,
        activeActorCount: 24,
        acceptedBundleCount: 24,
        deltaPageCount: 1,
        retryCount: 0,
        rejectedCount: 0,
        p50LatencyMs: 1,
        p95LatencyMs: 2,
        ownerActionCount: 2,
        rawContentIncluded: false,
        transcriptsIncluded: false,
        hiddenReasoningIncluded: true,
        terminalHistoryIncluded: false,
        credentialsIncluded: false,
        oauthStateIncluded: false,
        providerRuntimeIncluded: false,
        productionLogsIncluded: false,
        measuredAt: 1,
        metadata: { retentionTier: "warm", retainUntil: 2 },
        authority: {
          restoredAuthorityAllowed: false,
          liveAuthorityIncluded: false,
        },
      }).success,
    ).toBe(false);
  });
});
