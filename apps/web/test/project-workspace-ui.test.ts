import {
  collaborationConnectionSchema,
  collaborationProjectSummarySchema,
  operationalOverviewSchema,
} from "@owd/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProjectBrief,
  ProjectPrimaryAlerts,
  ProjectRepairStatus,
  ProjectWorkspaceNotice,
  applyLatestRefresh,
  applyLocalRevocations,
  copyProjectResumeInstruction,
  projectResumeInstruction,
  revokeLocallyThenRefresh,
} from "../src/CollaborationPanel";

const projectId = "10000000-0000-4000-8000-000000000001";
const project = collaborationProjectSummarySchema.parse({
  activeGrantCount: 1,
  activeKnowledgeSpaceVersionId: "20000000-0000-4000-8000-000000000002",
  activeProjectVersionId: "30000000-0000-4000-8000-000000000003",
  agentVisibility: "discoverable",
  createdAt: 1_800_000_000,
  currentBrief: {
    definitionOfDone: ["The owner can continue in another AI."],
    latestCheckpoint: {
      acceptedDecisions: [
        {
          createdAt: 1_800_000_050,
          rationale: "Keep the verified owner-approved approach.",
          resolution: "accepted",
        },
      ],
      acknowledgedAt: 1_800_000_100,
      blockers: [],
      citedEvidence: [
        {
          contentSha256: "a".repeat(64),
          label: "Brief.md",
          path: "Research/Brief.md",
        },
      ],
      completedWork: ["The durable brief was assembled."],
      knownRejectedApproaches: ["Do not replay a raw session."],
      openWork: ["Verify the owner workspace."],
    },
    nextAction: "Copy the resume instruction.",
    objective: "Present the current durable brief.",
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
  objective: "Make useful Project memory portable.",
  pendingAuthorizationCount: 0,
  projectId,
  recordCount: 8,
  sourceVaults: [],
  state: "ready",
  status: "active",
  workItemCount: 1,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

describe("owner Project workspace UI", () => {
  it("renders ordinary accepted Decisions, evidence metadata, and rejected approaches", () => {
    const html = renderToStaticMarkup(createElement(ProjectBrief, { project }));
    expect(html).toContain('aria-label="Durable project memory current brief"');
    expect(html).toContain("Accepted Decisions");
    expect(html).toContain("Keep the verified owner-approved approach.");
    expect(html).toContain("Cited evidence");
    expect(html).toContain("Research/Brief.md");
    expect(html).toContain(`SHA ${"a".repeat(64)}`);
    expect(html).toContain("Known rejected approaches");
    expect(html).not.toContain("provisional");
    expect(html).not.toContain("evidence body");
  });

  it.each(["packet-stale", "work-item-closed"] as const)(
    "withholds continuation for %s context and exposes repair directly",
    (state) => {
      const unavailable = { ...project, currentBrief: null, state };
      const brief = renderToStaticMarkup(
        createElement(ProjectBrief, { project: unavailable }),
      );
      const repair = renderToStaticMarkup(
        createElement(ProjectRepairStatus, { project: unavailable }),
      );
      expect(brief).not.toContain("Continue in another AI");
      expect(repair).toContain('role="alert"');
      expect(repair).toContain(
        state === "packet-stale"
          ? "Refresh Project context"
          : "Reopen current Work Item",
      );
      expect(repair).not.toContain("<details");
    },
  );

  it("places degraded integrity and exception Decisions in primary alerts", () => {
    const operation = operationalOverviewSchema.parse({
      authority: {
        liveAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
      },
      format: "owd-operational-overview-v1",
      projects: [
        {
          continuityAgeSeconds: 12,
          integrityStatus: "degraded",
          latestDecision: {
            decisionId: "60000000-0000-4000-8000-000000000006",
            evaluatedAt: 1_800_000_110,
            outcome: "exception",
            purpose: "coding",
            runId: "70000000-0000-4000-8000-000000000007",
          },
          latestReceipt: null,
          pendingRequestCount: 0,
          policyBinding: null,
          projectId,
        },
      ],
      schemaVersion: 1,
    }).projects[0]!;
    const html = renderToStaticMarkup(
      createElement(ProjectPrimaryAlerts, { operation, project }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("integrity check is degraded");
    expect(html).toContain("stopped an exceptional request");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("RPO");
    expect(html).not.toContain(operation.latestDecision!.runId);
  });

  it("copies the additive facade instruction and renders a useful fallback", async () => {
    let copied = "";
    expect(
      await copyProjectResumeInstruction(projectId, {
        writeText: async (value) => {
          copied = value;
        },
      }),
    ).toBe("copied");
    expect(copied).toBe(projectResumeInstruction(projectId));
    expect(await copyProjectResumeInstruction(projectId, undefined)).toBe(
      "unavailable",
    );
    const fallback = renderToStaticMarkup(
      createElement(ProjectBrief, { copyStatus: "unavailable", project }),
    );
    expect(fallback).toContain("instruction remains visible");
    expect(fallback).toContain("owd_resume");
  });

  it("keeps a revoked connection locally revoked when refresh degrades", async () => {
    const connection = collaborationConnectionSchema.parse({
      expiresAt: 1_800_010_000,
      grantId: "80000000-0000-4000-8000-000000000008",
      issuedAt: 1_800_000_000,
      lastUsedAt: null,
      oauthClientId: "client",
      projectId,
      projectLabel: "Durable project memory",
      revokedAt: null,
      scopes: ["project.read"],
      status: "active",
    });
    const revoked = new Map<string, number>();
    let local = [connection];
    const result = await revokeLocallyThenRefresh({
      markRevoked: () => {
        revoked.set(connection.grantId, 1_800_000_200);
        local = applyLocalRevocations(local, revoked);
      },
      refresh: () => Promise.reject(new Error("secondary refresh failed")),
      revoke: () => Promise.resolve(),
    });
    expect(result).toBe("degraded");
    expect(local[0]?.status).toBe("revoked");
    expect(applyLocalRevocations([connection], revoked)[0]?.status).toBe(
      "revoked",
    );
  });

  it("ignores out-of-order refresh success and failure", async () => {
    let generation = 1;
    const older = deferred<string>();
    const applied: string[] = [];
    const olderRun = applyLatestRefresh({
      apply: (value) => applied.push(value),
      currentGeneration: () => generation,
      generation: 1,
      load: () => older.promise,
    });
    generation = 2;
    const newer = deferred<string>();
    const newerRun = applyLatestRefresh({
      apply: (value) => applied.push(value),
      currentGeneration: () => generation,
      generation: 2,
      load: () => newer.promise,
    });
    newer.resolve("newer");
    expect(await newerRun).toBe("applied");
    older.resolve("older");
    expect(await olderRun).toBe("stale");
    expect(applied).toEqual(["newer"]);

    const staleFailure = deferred<string>();
    const staleFailureRun = applyLatestRefresh({
      apply: (value) => applied.push(value),
      currentGeneration: () => generation,
      generation: 1,
      load: () => staleFailure.promise,
    });
    staleFailure.reject(new Error("ignored old failure"));
    expect(await staleFailureRun).toBe("stale");
  });

  it("wraps hostile long content in the narrow-width Project DOM", () => {
    const hostile = "A".repeat(4_000);
    const html = renderToStaticMarkup(
      createElement(ProjectBrief, {
        project: {
          ...project,
          currentBrief: {
            ...project.currentBrief!,
            nextAction: hostile,
          },
        },
      }),
    );
    expect(html).toContain(hostile);
    expect(html).toContain("min-width:0");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("word-break:break-word");
    expect(html).toContain('class="project-continue"');
  });

  it.each(["loading", "error", "empty"] as const)(
    "renders a useful %s state with accessible semantics",
    (state) => {
      const html = renderToStaticMarkup(
        createElement(ProjectWorkspaceNotice, {
          error: state === "error" ? "Temporary read failure." : null,
          state,
        }),
      );
      expect(html).toContain("Project");
      if (state === "loading") expect(html).toContain('aria-live="polite"');
      if (state === "error") {
        expect(html).toContain('role="alert"');
        expect(html).toContain("Try again");
      }
      if (state === "empty") expect(html).toContain("No active OWD Projects");
    },
  );
});
