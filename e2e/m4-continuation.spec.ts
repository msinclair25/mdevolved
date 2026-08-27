import {
  expect,
  test,
  type BrowserContext,
  type Route,
} from "@playwright/test";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../packages/contracts/fixtures/owd-m4-cross-agent-continuation-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  clientA: {
    checkpoint: {
      citedEvidence: Array<{ path: string }>;
      completedWork: string[];
      knownRejectedApproaches: string[];
    };
    label: string;
  };
  clientB: { resumeInstruction: string };
  project: {
    definitionOfDone: string[];
    label: string;
    nextAction: string;
    objective: string;
    projectId: string;
  };
};

const origin = `http://127.0.0.1:${process.env.OWD_E2E_PORT ?? "4173"}`;
const now = 1_785_000_000;
const vaultId = "22222222-2222-4222-8222-222222222222";
const projectId = fixture.project.projectId;
const generationId = "33333333-3333-4333-8333-333333333333";

const project = {
  activeGrantCount: 1,
  activeKnowledgeSpaceVersionId: "44444444-4444-4444-8444-444444444444",
  activeProjectVersionId: "55555555-5555-4555-8555-555555555555",
  activeWorkItemVersionId: "56565656-5656-4656-8656-565656565656",
  agentVisibility: "discoverable",
  createdAt: now - 200,
  currentBrief: {
    constraints: ["Keep the continuation provider-neutral."],
    definitionOfDone: fixture.project.definitionOfDone,
    latestCheckpoint: {
      acceptedDecisions: [],
      acknowledgedAt: now - 20,
      blockers: [],
      citedEvidence: fixture.clientA.checkpoint.citedEvidence,
      completedWork: fixture.clientA.checkpoint.completedWork,
      knownRejectedApproaches:
        fixture.clientA.checkpoint.knownRejectedApproaches,
      openWork: fixture.clientA.checkpoint.openWork,
    },
    nextAction: fixture.project.nextAction,
    objective: fixture.project.objective,
    requestedOutput: "A bounded continuation receipt.",
  },
  currentPacket: {
    createdAt: now - 30,
    expiresAt: now + 86_400,
    packetId: "66666666-6666-4666-8666-666666666666",
    workItemId: "77777777-7777-4777-8777-777777777777",
  },
  duplicateGroupSize: 1,
  label: fixture.project.label,
  lastActivityAt: now - 20,
  objective: fixture.project.objective,
  pendingAuthorizationCount: 0,
  projectId,
  recordCount: 4,
  sourceVaults: [{ id: vaultId, name: "Synthetic vault" }],
  state: "ready",
  status: "active",
  workItemCount: 1,
};

async function json(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(value),
    contentType: "application/json",
  });
}

async function mockM4(context: BrowserContext): Promise<void> {
  let currentProject = structuredClone(project);
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== origin) {
      await route.continue();
      return;
    }

    if (requestUrl.pathname === "/healthz") {
      await json(route, {
        environment: "test",
        ok: true,
        requestId: "88888888-8888-4888-8888-888888888888",
        releaseId: "m4-e2e",
        releaseTag: "m4-e2e",
        service: "mdevolved",
        version: "1.0.0-alpha.7",
      });
    } else if (requestUrl.pathname === "/api/setup/status") {
      await json(route, {
        authenticated: true,
        claimAvailable: false,
        claimExpiresAt: null,
        claimMode: "open",
        claimed: true,
        maxVaults: null,
        nextAction: "pair-vault",
        pairingEnabled: true,
        state: "ready",
        trialDays: null,
        trialEndsAt: null,
        trialExpired: false,
      });
    } else if (requestUrl.pathname === "/api/setup/readiness") {
      await json(route, {
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        activeVaultCount: 1,
        libraryReady: true,
        nextStep: "ready",
        verifiedSnapshot: true,
        vaults: [
          {
            activeAgentCount: 1,
            activeProjectCount: 1,
            activeProjectGrantCount: 1,
            displayName: "Synthetic vault",
            id: vaultId,
            initialSyncAt: now - 100,
            lastSyncAt: now,
            libraryReady: true,
            libraryState: "current",
            nextStep: "ready",
            pendingProjectRequestCount: 0,
            pendingProjectRequests: [],
            pendingProjectReviewUrl: null,
            pluginVersion: "0.2.0-alpha.1",
            preparedProjectHandoff: null,
            syncConfirmed: true,
            verifiedSnapshot: true,
          },
        ],
      });
    } else if (requestUrl.pathname === "/api/vaults") {
      await json(route, {
        vaults: [
          {
            createdAt: now - 200,
            displayName: "Synthetic vault",
            id: vaultId,
            lastConnectedAt: now,
            pairedAt: now - 190,
            status: "active",
          },
        ],
      });
    } else if (requestUrl.pathname === "/api/agent/connections") {
      await json(route, {
        connections: [
          {
            activatedAt: now - 100,
            approvedRestoredSources: [],
            clientId: "synthetic-client-a",
            clientName: fixture.clientA.label,
            clientOrigin: "https://client-a.example",
            createdAt: now - 110,
            id: "99999999-9999-4999-8999-999999999999",
            lastUsedAt: now - 20,
            pathPrefixes: [],
            preparedProjectHandoff: null,
            revokedAt: null,
            scopes: ["vault.read", "project.connect.request"],
            status: "active",
            vaultId,
            vaultName: "Synthetic vault",
            writerAssignedAt: now - 90,
            writerAssignmentBasis: "first-project-agent",
            writerEligible: true,
            writerRole: "primary-writer",
            writerUpdatedAt: now - 90,
          },
        ],
        mcpUrl: `${origin}/mcp`,
      });
    } else if (requestUrl.pathname === "/api/collaboration/dashboard") {
      await json(route, {
        contributionStatistics: {
          acceptedRecordCount: 1,
          artifactCount: 1,
          attemptCount: 1,
          authorizationClientCount: 1,
          decisionCount: 0,
          handoffCount: 0,
          reviewCount: 0,
        },
        inbox: [],
        inboxNextCursor: null,
        participants: [],
        pendingActions: {
          handoffsToShare: 0,
          recordsToReview: 0,
          reviewsToDecide: 0,
          total: 0,
        },
        projects: [currentProject],
        timeline: [],
        timelineNextCursor: null,
      });
    } else if (requestUrl.pathname === "/api/collaboration/connections") {
      await json(route, { connections: [] });
    } else if (
      requestUrl.pathname === "/api/collaboration/lead-operations" ||
      requestUrl.pathname === "/api/collaboration/elastic-operations"
    ) {
      await json(route, {
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: requestUrl.pathname.endsWith("lead-operations")
          ? "owd-lead-operation-overview-v1"
          : "owd-elastic-operation-overview-v1",
        projects: requestUrl.pathname.endsWith("lead-operations")
          ? []
          : undefined,
        runs: requestUrl.pathname.endsWith("elastic-operations")
          ? []
          : undefined,
        schemaVersion: 1,
      });
    } else if (requestUrl.pathname === "/api/collaboration/policy-operations") {
      await json(route, {
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: "owd-operational-overview-v1",
        projects: [],
        schemaVersion: 1,
      });
    } else if (requestUrl.pathname === "/api/auth/csrf") {
      await json(route, { csrfToken: "a".repeat(32) });
    } else if (
      requestUrl.pathname === `/api/collaboration/projects/${projectId}/brief`
    ) {
      const body = route.request().postDataJSON() as {
        idempotencyKey?: string;
        project?: { objective: string };
        workItem?: {
          constraints: string[];
          definitionOfDone: string[];
          objective: string;
          requestedOutput: string;
        };
      };
      expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
      currentProject = {
        ...currentProject,
        activeProjectVersionId: "57575757-5757-4757-8757-575757575757",
        activeWorkItemVersionId: "58585858-5858-4858-8858-585858585858",
        objective: body.project?.objective ?? currentProject.objective,
        currentBrief: {
          ...currentProject.currentBrief,
          ...body.workItem,
          nextAction:
            body.workItem?.objective ?? currentProject.currentBrief.nextAction,
        },
      };
      await json(route, {
        activeProjectVersionId: currentProject.activeProjectVersionId,
        activeWorkItemVersionId: currentProject.activeWorkItemVersionId,
        projectId,
        workItemId: currentProject.currentPacket.workItemId,
      });
    } else if (requestUrl.pathname === "/api/project-outcomes") {
      await json(route, {
        ok: true,
        outcome: {
          acceptedMemoryCount: 2,
          attention: "none",
          checkpointedByMultipleClients: true,
          latestCheckpointAt: now - 20,
          pendingSuggestionCount: 0,
          readiness: "ready",
        },
      });
    } else if (requestUrl.pathname.endsWith("/materialization")) {
      await json(route, {
        generation: {
          completedAt: now,
          createdAt: now - 1,
          generationId,
          noteCount: 1,
          sourceStateVectorSha256: "b".repeat(64),
          totalBytes: 42,
          vaultId,
        },
      });
    } else if (requestUrl.pathname.endsWith("/notes")) {
      await json(route, {
        generation: {
          completedAt: now,
          createdAt: now - 1,
          generationId,
          noteCount: 1,
          sourceStateVectorSha256: "b".repeat(64),
          totalBytes: 42,
          vaultId,
        },
        nextCursor: null,
        notes: [],
      });
    } else {
      await route.continue();
    }
  });
}

test("shows Client A checkpoint and fresh Client B continuation", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await mockM4(context);
  const page = await context.newPage();

  await page.goto("/#collaboration");
  const collaboration = page.locator('[data-region="collaboration"]');
  await expect(
    collaboration.getByRole("heading", { name: fixture.project.label }),
  ).toBeVisible();
  await expect(
    collaboration.getByText(fixture.clientA.checkpoint.completedWork[0]!),
  ).toBeVisible();
  await expect(
    collaboration.getByText(
      fixture.clientA.checkpoint.knownRejectedApproaches[0]!,
    ),
  ).toBeVisible();
  await expect(
    collaboration.getByText(fixture.clientA.checkpoint.citedEvidence[0]!.path),
  ).toBeVisible();
  await collaboration.getByRole("button", { name: "Edit brief" }).click();
  await collaboration
    .getByRole("textbox", { name: "Current objective" })
    .fill("Resume the edited brief in Client B.");
  await collaboration.getByRole("button", { name: "Save" }).click();
  await expect(
    collaboration.getByText("Resume the edited brief in Client B.").first(),
  ).toBeVisible();
  await collaboration.getByText("Project outcome evidence").click();
  await expect(
    collaboration.getByText("Ready for another client slot"),
  ).toBeVisible();
  await expect(collaboration.getByText("No attention needed")).toBeVisible();
  await collaboration
    .getByRole("button", { name: "Continue in another AI" })
    .click();
  await expect(
    collaboration.locator("code").filter({
      hasText: fixture.clientB.resumeInstruction,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    fixture.clientB.resumeInstruction,
  );

  await page.goto("/#agents");
  const agents = page.locator('[data-region="agents"]');
  await expect(
    agents.getByRole("heading", { name: "1 authorized client" }),
  ).toBeVisible();
  await agents.getByRole("button", { name: "Connect another" }).click();
  await agents.getByRole("button", { name: "Other" }).click();
  await expect(
    agents.getByRole("heading", { name: "Add a remote HTTP MCP server" }),
  ).toBeVisible();
  await expect(agents).not.toContainText(/Bearer |password|secret|token/iu);
  await agents.getByRole("button", { name: "Other" }).focus();
  await expect(agents.getByRole("button", { name: "Other" })).toBeFocused();
  expect(
    await agents.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await context.close();
});
