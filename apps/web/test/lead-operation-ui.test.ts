import {
  elasticOperationOverviewSchema,
  leadOperationOverviewSchema,
  operationalOverviewSchema,
} from "@owd/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ElasticOperationStatus,
  LeadOperationStatus,
  PolicyContinuityStatus,
} from "../src/CollaborationPanel";

function operation(blocking: boolean) {
  return leadOperationOverviewSchema.parse({
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    format: "owd-lead-operation-overview-v1",
    projects: [
      {
        activeActorCount: 3,
        activeRunCount: 1,
        blockingExceptionCount: blocking ? 1 : 0,
        lastRunActivityAt: 1_800_000_000,
        projectId: "10000000-0000-4000-8000-000000000001",
        recentExceptions: blocking
          ? [
              {
                actorId: "20000000-0000-4000-8000-000000000002",
                createdAt: 1_800_000_000,
                evidenceRefs: [],
                exceptionId: "30000000-0000-4000-8000-000000000003",
                format: "owd-project-exception-v1",
                kind: "destructive-action",
                normalizedRelativePath: null,
                projectId: "10000000-0000-4000-8000-000000000001",
                requestedAction: "destructive-action",
                resolvedAt: null,
                runId: "40000000-0000-4000-8000-000000000004",
                schemaVersion: 1,
                status: "blocking",
                summary: "A destructive request was recorded but not executed.",
                workItemId: "50000000-0000-4000-8000-000000000005",
              },
            ]
          : [],
      },
    ],
    schemaVersion: 1,
  }).projects[0]!;
}

describe("hands-off lead operation UI", () => {
  it("shows an explicit blocking exception without presenting routine approval", () => {
    const html = renderToStaticMarkup(
      createElement(LeadOperationStatus, { operation: operation(true) }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("1 blocking Run exception");
    expect(html).toContain("did not expand authority");
    expect(html).toContain("destructive-action");
    expect(html).not.toContain("Approve");
  });

  it("offers only an explicit owner resolution for a surfaced exception", () => {
    const html = renderToStaticMarkup(
      createElement(LeadOperationStatus, {
        onResolve: () => undefined,
        operation: operation(true),
      }),
    );
    expect(html).toContain("Resolve exception as owner");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Execute exception");
  });

  it("shows three claimed actors continuing without routine owner action", () => {
    const html = renderToStaticMarkup(
      createElement(LeadOperationStatus, { operation: operation(false) }),
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("1 active hands-off Run");
    expect(html).toContain("3 claimed actors are operating");
    expect(html).toContain("without routine owner action");
  });

  it("shows bounded elastic load, budget use, latency, and owner-action evidence", () => {
    const run = elasticOperationOverviewSchema.parse({
      authority: {
        liveAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
      },
      format: "owd-elastic-operation-overview-v1",
      runs: [
        {
          acceptedBundleCount: 24,
          activeActorCount: 24,
          actorRecordCount: 24,
          blockingExceptionCount: 0,
          costMicrounitLimit: 100_000_000,
          costMicrounitsUsed: 240,
          logicalUnitLimit: 1_000_000,
          logicalUnitsUsed: 240,
          measuredAt: 1_800_000_000,
          ownerActionCount: 2,
          p95LatencyMs: 9,
          projectId: "10000000-0000-4000-8000-000000000001",
          runId: "40000000-0000-4000-8000-000000000004",
          status: "active",
        },
      ],
      schemaVersion: 1,
    }).runs[0]!;
    const html = renderToStaticMarkup(
      createElement(ElasticOperationStatus, { run }),
    );
    expect(html).toContain("24 active / 24 actor records");
    expect(html).toContain("2 owner actions reported");
    expect(html).toContain("p95 9 ms");
    expect(html).not.toContain("transcript");
  });

  function policyOperation(
    overrides: Partial<{
      continuityAgeSeconds: number | null;
      integrityStatus: "ok" | "degraded" | "unknown";
      policyBinding: { bindingId: string; activatedAt: number } | null;
      latestDecision: {
        decisionId: string;
        runId: string;
        purpose: "research" | "coding";
        outcome: "allow" | "exception";
        evaluatedAt: number;
      } | null;
      pendingRequestCount: number;
      latestReceipt: {
        receiptId: string;
        rpoSeconds: number;
        rtoSeconds: number;
        continuityAgeSeconds: number;
        recoveryQualityBps: number;
        runtimeIndependent: boolean;
        emittedAt: number;
      } | null;
    }> = {},
  ) {
    return operationalOverviewSchema.parse({
      authority: {
        liveAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
      },
      format: "owd-operational-overview-v1",
      projects: [
        {
          continuityAgeSeconds: null,
          integrityStatus: "unknown",
          latestDecision: null,
          latestReceipt: null,
          pendingRequestCount: 0,
          policyBinding: null,
          projectId: "10000000-0000-4000-8000-000000000001",
          ...overrides,
        },
      ],
      schemaVersion: 1,
    }).projects[0]!;
  }

  it("shows inactive activation copy without routine approval language", () => {
    const html = renderToStaticMarkup(
      createElement(PolicyContinuityStatus, {
        onActivate: () => undefined,
        operation: policyOperation(),
      }),
    );
    expect(html).toContain("Standing policy not active");
    expect(html).toContain("Activate the fixed standing policy once");
    expect(html).toContain("routine requests do not need owner approval");
    expect(html).toContain("Execution remains external to MDevolved");
    expect(html).toContain("Community remains independent");
    expect(html).not.toContain("Cloudflare");
    expect(html).not.toContain("secret provider");
  });

  it.each(["allow", "exception"] as const)(
    "shows active latest Decision outcome: %s",
    (outcome) => {
      const html = renderToStaticMarkup(
        createElement(PolicyContinuityStatus, {
          operation: policyOperation({
            continuityAgeSeconds: 12,
            integrityStatus: "ok",
            latestDecision: {
              decisionId: "20000000-0000-4000-8000-000000000002",
              evaluatedAt: 1_800_000_000,
              outcome,
              purpose: "research",
              runId: "30000000-0000-4000-8000-000000000003",
            },
            latestReceipt: {
              continuityAgeSeconds: 12,
              emittedAt: 1_800_000_001,
              recoveryQualityBps: 9876,
              receiptId: "40000000-0000-4000-8000-000000000004",
              rpoSeconds: 3600,
              rtoSeconds: 7200,
              runtimeIndependent: true,
            },
            pendingRequestCount: 2,
            policyBinding: {
              activatedAt: 1_799_999_000,
              bindingId: "50000000-0000-4000-8000-000000000005",
            },
          }),
        }),
      );
      expect(html).toContain(`latest Decision ${outcome}`);
      expect(html).toContain("research");
      expect(html).toContain("12 seconds");
      expect(html).toContain("RPO 3600s");
      expect(html).toContain("RTO 7200s");
      expect(html).toContain("recovery quality 9876 bps");
      expect(html).toContain("runtime-independent");
      expect(html).toContain("Receipt 40000000…");
      expect(html).not.toContain("40000000-0000-4000-8000-000000000004");
      expect(html).not.toContain("secret provider");
    },
  );
});
