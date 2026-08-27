import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import {
  OWD_SNAPSHOT_EXPORT_MAGIC,
  OWD_SNAPSHOT_FORMAT,
  BASE_SNAPSHOT_REQUIRED_CAPABILITIES,
  snapshotManifestSchema,
  type AgentConnection,
  type SnapshotExportIndex,
  type SnapshotSummary,
  type SetupReadiness,
  type SetupVaultReadiness,
} from "../packages/contracts/src/index";
import {
  Encrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

const targetVaultId = "11111111-1111-4111-8111-111111111111";
const disconnectedVaultId = "77777777-7777-4777-8777-777777777777";
const sourceVaultId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const restoreId = "44444444-4444-4444-8444-444444444444";
const generationId = "55555555-5555-4555-8555-555555555555";
const portableObjectId = "66666666-6666-4666-8666-666666666666";
const existingProjectId = "99999999-9999-4999-8999-999999999999";
const internalArchivedProjectId = "89898989-8989-4989-8989-898989898989";
const secondPendingProjectRequestId = "abababab-abab-4bab-8bab-abababababab";
const now = 1_785_000_000;
const encoder = new TextEncoder();
const e2eOrigin = `http://127.0.0.1:${process.env.OWD_E2E_PORT ?? "4173"}`;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
    ),
  );
}

async function encrypt(value: Uint8Array, recipient: string): Promise<Blob> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const stream = await encrypter.encrypt(
    new Blob([Uint8Array.from(value).buffer]).stream(),
  );
  return new Blob([await new Response(stream).arrayBuffer()]);
}

async function portableFixture(): Promise<{
  identity: string;
  snapshot: Uint8Array;
}> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const note = encoder.encode("# Portable recovery\n");
  const digest = await sha256Hex(note);
  const manifest = snapshotManifestSchema.parse({
    captureCompletedAt: now,
    captureStartedAt: now - 5,
    excludedSecuritySections: [
      "oauth",
      "sessions",
      "passkeys",
      "pairing-secrets",
      "agent-grants",
      "pending-agent-proposals",
      "harness-context",
      "unknown-obsidian-plugin-data",
    ],
    format: OWD_SNAPSHOT_FORMAT,
    includedSections: ["notes"],
    logicalBytes: note.byteLength,
    objects: [
      {
        byteLength: note.byteLength,
        contentSha256: digest,
        portableObjectId,
        section: "notes",
      },
    ],
    optionalCapabilities: [],
    recipientFingerprint: await sha256Hex(encoder.encode(recipient)),
    requiredCapabilities: [...BASE_SNAPSHOT_REQUIRED_CAPABILITIES],
    reservedSections: [
      "accepted-handoffs",
      "durable-knowledge",
      "skills",
      "evaluations",
      "provenance",
      "policy",
    ],
    scope: "selected",
    snapshotId,
    unavailableSections: ["attachments", "obsidian-allowlist"],
    vaults: [
      {
        entries: [
          {
            byteLength: note.byteLength,
            contentSha256: digest,
            modifiedAt: now - 10,
            path: "Recovery/Portable.md",
            portableObjectId,
            section: "notes",
          },
        ],
        snapshotVaultId: sourceVaultId,
        sourceGeneration: {
          completedAt: now - 6,
          createdAt: now - 7,
          generationId,
          noteCount: 1,
          sourceStateVectorSha256: "a".repeat(64),
          totalBytes: note.byteLength,
        },
        vaultName: "Portable source",
      },
    ],
  });
  const encryptedManifest = await encrypt(
    encoder.encode(JSON.stringify(manifest)),
    recipient,
  );
  const encryptedNote = await encrypt(note, recipient);
  const index: SnapshotExportIndex = {
    format: OWD_SNAPSHOT_FORMAT,
    optionalCapabilities: [],
    parts: [
      {
        ciphertextBytes: encryptedManifest.size,
        portableObjectId: "77777777-7777-4777-8777-777777777777",
        role: "manifest",
      },
      {
        ciphertextBytes: encryptedNote.size,
        portableObjectId,
        role: "content",
      },
    ],
    requiredCapabilities: [...BASE_SNAPSHOT_REQUIRED_CAPABILITIES],
    snapshotId,
  };
  const archive = new Blob([
    OWD_SNAPSHOT_EXPORT_MAGIC,
    `${JSON.stringify(index)}\n`,
    encryptedManifest,
    encryptedNote,
  ]);
  return {
    identity,
    snapshot: new Uint8Array(await archive.arrayBuffer()),
  };
}

function restoreJob(status: "staging" | "preview" | "applying" | "applied") {
  const uploaded = status === "staging" ? 0 : 1;
  return {
    addedCount: status === "staging" ? null : 1,
    appliedNoteCount: status === "applied" ? 1 : 0,
    changedCount: status === "staging" ? null : 0,
    createdAt: now,
    expiresAt: now + 86_400,
    expectedBytes: 20,
    expectedNoteCount: 1,
    materializationJobId: null,
    restoreId,
    sourceBackupId: snapshotId,
    sourceVaultId,
    sourceVaultName: "Portable source",
    status,
    targetVaultId,
    unchangedCount: status === "staging" ? null : 0,
    updatedAt: now,
    uploadedBytes: uploaded === 0 ? 0 : 20,
    uploadedNoteCount: uploaded,
    verifiedGenerationId: status === "applied" ? generationId : null,
  };
}

function setupVaultReadiness(
  overrides: Partial<SetupVaultReadiness> = {},
): SetupVaultReadiness {
  return {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    displayName: "Recovery target",
    id: targetVaultId,
    initialSyncAt: now - 90,
    lastSyncAt: now,
    libraryState: "current",
    libraryReady: true,
    nextStep: "connect-agent",
    pendingProjectRequestCount: 0,
    pendingProjectRequests: [],
    pendingProjectReviewUrl: null,
    pluginVersion: "0.1.7",
    preparedProjectHandoff: null,
    syncConfirmed: true,
    verifiedSnapshot: false,
    ...overrides,
  };
}

const defaultReadiness: SetupReadiness = {
  activeAgentCount: 0,
  activeProjectCount: 0,
  activeProjectGrantCount: 0,
  activeVaultCount: 1,
  libraryReady: true,
  nextStep: "connect-agent",
  verifiedSnapshot: false,
  vaults: [setupVaultReadiness()],
};

function preparedSetupHandoff(): NonNullable<
  SetupVaultReadiness["preparedProjectHandoff"]
> {
  return {
    agentGrantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    clientName: "Working agent",
    folderBoundary: "docs",
    preparedAt: now,
    projectLabel: "Research Project",
  };
}

function activeAgentConnection(
  overrides: Partial<AgentConnection> = {},
): AgentConnection {
  return {
    activatedAt: now - 20,
    approvedRestoredSources: [],
    clientId: "https://agent.example/client.json",
    clientName: "Working agent",
    clientOrigin: "https://agent.example",
    createdAt: now - 30,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    lastUsedAt: null,
    pathPrefixes: [],
    preparedProjectHandoff: null,
    revokedAt: null,
    scopes: [
      "vault.read",
      "project.initialize.request",
      "project.connect.request",
    ],
    status: "active",
    vaultId: targetVaultId,
    vaultName: "Recovery target",
    writerAssignedAt: null,
    writerAssignmentBasis: null,
    writerEligible: false,
    writerRole: "unassigned",
    writerUpdatedAt: null,
    ...overrides,
  };
}

function serverBoundProject() {
  return {
    activeGrantCount: 0,
    activeKnowledgeSpaceVersionId: "12121212-1212-4212-8212-121212121212",
    activeProjectVersionId: "13131313-1313-4313-8313-131313131313",
    agentVisibility: "discoverable",
    createdAt: now - 100,
    currentBrief: null,
    currentPacket: null,
    duplicateGroupSize: 1,
    label: "Agent-first review",
    lastActivityAt: now - 20,
    objective: "Review one bounded handoff with exact provenance.",
    pendingAuthorizationCount: 1,
    projectId: existingProjectId,
    recordCount: 7,
    sourceVaults: [{ id: targetVaultId, name: "Recovery target" }],
    state: "authorization-required",
    status: "active",
    workItemCount: 1,
  };
}

function projectConsentContext(requestKind: "create" | "join") {
  return {
    client: {
      id: "https://agent.example/client.json",
      name: "Independent review agent",
      origin: "https://agent.example",
    },
    contextPolicy: {
      excludePaths: ["Projects/Agent First/Personal"],
      format: "owd-project-context-v1",
      includePaths: ["Projects/Agent First"],
    },
    documentationPlan: {
      decision: "move-approved",
      proposedMoves: [
        { from: "PROJECT-NOTES.md", to: "docs/project-notes.md" },
      ],
      retainedRootPaths: ["README.md"],
      rootMarkdownPaths: ["README.md", "PROJECT-NOTES.md"],
    },
    expiresAt: now + 600,
    folderBoundary: "Projects/Agent First",
    initializationToken:
      "browser-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
    objective: "Review one bounded handoff with exact provenance.",
    projectId: requestKind === "join" ? existingProjectId : null,
    projectLabel: "Agent-first review",
    requestedScopes: ["project.read", "collaboration.submit", "review.submit"],
    requestKind,
    sourceNotePaths: ["Projects/Agent First/Brief.md"],
    vault: {
      id: targetVaultId,
      name: "Recovery target",
    },
    vaultPathPrefixes: ["Projects/"],
    workItemTitle: "Create and independently review the first handoff.",
  };
}

async function mockFoundation(
  context: BrowserContext,
  readiness: SetupReadiness = defaultReadiness,
): Promise<void> {
  const snapshots: SnapshotSummary[] = [];
  await mockFoundationWithSnapshots(context, snapshots, readiness);
}

async function mockFoundationWithSnapshots(
  context: BrowserContext,
  snapshots: SnapshotSummary[],
  readiness: SetupReadiness = defaultReadiness,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== e2eOrigin) {
      await route.continue();
      return;
    }
    const json = async (value: unknown, status = 200) =>
      route.fulfill({
        body: JSON.stringify(value),
        contentType: "application/json",
        status,
      });

    if (url.pathname === "/healthz") {
      await json({
        environment: "test",
        ok: true,
        requestId: "88888888-8888-4888-8888-888888888888",
        releaseId: "e2e-release-id",
        releaseTag: "e2e-release",
        service: "owd-platform",
        version: "1.0.0-alpha.7",
      });
    } else if (url.pathname === "/api/setup/status") {
      await json({
        authenticated: true,
        claimAvailable: false,
        claimExpiresAt: null,
        claimMode: "open",
        claimed: true,
        nextAction: "pair-vault",
        pairingEnabled: true,
        state: "ready",
        trialDays: null,
        trialEndsAt: null,
        trialExpired: false,
        maxVaults: null,
      });
    } else if (url.pathname === "/api/setup/readiness") {
      await json(readiness);
    } else if (url.pathname === "/api/agent/oauth/context") {
      await json({
        authorizationKind: "vault",
        client: {
          id: "https://agent.example/client.json",
          name: "Explicit-choice agent",
          origin: "https://agent.example",
          redirectUri: "https://agent.example/callback",
          verified: false,
        },
        expiresAt: now + 600,
        flowToken: "agent-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
        resource: `${e2eOrigin}/mcp`,
        restoredSources: [
          {
            appliedAt: now - 50,
            noteCount: 3,
            restoreId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sourceVaultId,
            sourceVaultName: "Synthetic restore source",
            targetVaultId,
          },
        ],
        scopes: [
          "vault.read",
          "project.initialize.request",
          "project.connect.request",
        ],
        vaults: [
          {
            createdAt: now - 100,
            displayName: "Recovery target",
            id: targetVaultId,
            lastConnectedAt: now,
            pairedAt: now - 90,
            status: "active",
          },
          {
            createdAt: now - 80,
            displayName: "Another active vault",
            id: sourceVaultId,
            lastConnectedAt: now,
            pairedAt: now - 70,
            status: "active",
          },
        ],
      });
    } else if (url.pathname === "/api/project-initializations/context") {
      await json(projectConsentContext("create"));
    } else if (url.pathname === "/api/auth/csrf") {
      await json({ csrfToken: "a".repeat(32) });
    } else if (url.pathname === "/api/pairing/grants") {
      await json({
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
        pairingUrl:
          "owd-pair://connect?deployment=http%3A%2F%2F127.0.0.1%3A4173&grant=abcdefghijklmnopqrstuvwxyz0123456789",
        obsidianUrl:
          "obsidian://owd-pair?deployment=http%3A%2F%2F127.0.0.1%3A4173&grant=abcdefghijklmnopqrstuvwxyz0123456789",
        vaultId: "99999999-9999-4999-8999-999999999999",
      });
    } else if (url.pathname === "/api/vaults") {
      await json({
        vaults: [
          {
            createdAt: now - 100,
            displayName: "Recovery target",
            id: targetVaultId,
            lastConnectedAt: now,
            pairedAt: now - 90,
            status: "active",
          },
          {
            createdAt: now - 200,
            displayName: "Disconnected archive",
            id: disconnectedVaultId,
            lastConnectedAt: now - 110,
            pairedAt: now - 190,
            status: "revoked",
          },
        ],
      });
    } else if (url.pathname === "/api/agent/connections") {
      await json({
        connections: [],
        mcpUrl: "http://127.0.0.1:4173/mcp",
      });
    } else if (url.pathname === "/api/collaboration/dashboard") {
      await json({
        contributionStatistics: {
          acceptedRecordCount: 0,
          artifactCount: 0,
          attemptCount: 0,
          authorizationClientCount: 0,
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
        projects: [],
        timeline: [],
        timelineNextCursor: null,
      });
    } else if (url.pathname === "/api/collaboration/connections") {
      await json({ connections: [] });
    } else if (url.pathname === "/api/collaboration/lead-operations") {
      await json({
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: "owd-lead-operation-overview-v1",
        projects: [],
        schemaVersion: 1,
      });
    } else if (url.pathname === "/api/collaboration/elastic-operations") {
      await json({
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: "owd-elastic-operation-overview-v1",
        runs: [],
        schemaVersion: 1,
      });
    } else if (url.pathname === "/api/collaboration/policy-operations") {
      await json({
        authority: {
          liveAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
        },
        format: "owd-operational-overview-v1",
        projects: [],
        schemaVersion: 1,
      });
    } else if (url.pathname.endsWith("/materialization")) {
      await json({
        generation: {
          completedAt: now,
          createdAt: now - 1,
          generationId,
          noteCount: 0,
          sourceStateVectorSha256: "b".repeat(64),
          totalBytes: 0,
          vaultId: targetVaultId,
        },
      });
    } else if (url.pathname.endsWith("/notes")) {
      await json({
        generation: {
          completedAt: now,
          createdAt: now - 1,
          generationId,
          noteCount: 0,
          sourceStateVectorSha256: "b".repeat(64),
          totalBytes: 0,
          vaultId: targetVaultId,
        },
        nextCursor: null,
        notes: [],
      });
    } else if (url.pathname === "/api/backups/recovery-recipient") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { recipient: string };
        await json({
          configured: true,
          fingerprint: await sha256Hex(encoder.encode(body.recipient)),
          recipient: body.recipient,
          updatedAt: now,
        });
      } else {
        await json({
          configured: false,
          fingerprint: null,
          recipient: null,
          updatedAt: null,
        });
      }
    } else if (url.pathname.endsWith("/backups")) {
      await json({ backups: [] });
    } else if (url.pathname === "/api/snapshots") {
      await json({ snapshots });
    } else if (
      url.pathname.startsWith("/api/snapshots/") &&
      url.pathname.endsWith("/archive") &&
      request.method() === "PUT"
    ) {
      const snapshotReference = url.pathname.split("/")[3];
      const body = request.postDataJSON() as { archived: boolean };
      const snapshot = snapshots.find(
        (candidate) => candidate.snapshotId === snapshotReference,
      );
      if (snapshot === undefined) {
        await json(
          {
            error: {
              code: "snapshot_not_found",
              message: "The snapshot was not found.",
              requestId: "88888888-8888-4888-8888-888888888888",
            },
          },
          404,
        );
      } else {
        snapshot.archivedAt = body.archived ? now : null;
        await json(snapshot);
      }
    } else if (url.pathname === "/api/snapshots/retention") {
      await json({
        currentRetainedCiphertextBytes: 0,
        enabled: false,
        keepReadyCount: 5,
        maxRetainedCiphertextBytes: null,
        protectedSnapshotCount: 0,
        readySnapshotCount: 0,
        updatedAt: now,
      });
    } else if (
      url.pathname === `/api/vaults/${targetVaultId}/restores` &&
      request.method() === "POST"
    ) {
      await json(restoreJob("staging"));
    } else if (url.pathname === `/api/restores/${restoreId}/note`) {
      await json({
        ...restoreJob("staging"),
        uploadedBytes: 20,
        uploadedNoteCount: 1,
      });
    } else if (url.pathname === `/api/restores/${restoreId}/complete`) {
      await json(restoreJob("preview"));
    } else if (url.pathname === `/api/restores/${restoreId}/confirm`) {
      await json(restoreJob("applying"));
    } else if (url.pathname === `/api/restores/${restoreId}/apply`) {
      await json({ complete: true, job: restoreJob("applied") });
    } else {
      await route.continue();
    }
  });
}

function operationalRegion(page: Page, id: string) {
  return page.locator(`[data-region="${id}"]`);
}

async function openOperationalRegion(page: Page, id: string): Promise<void> {
  const region = operationalRegion(page, id);
  const content = region.locator(".operational-region-content");
  await expect
    .poll(
      async () => {
        await page.evaluate((regionId) => {
          window.dispatchEvent(
            new CustomEvent("owd:open-operational-region", {
              detail: regionId,
            }),
          );
        }, id);
        return (await content.count()) > 0 && (await content.isVisible());
      },
      { intervals: [50, 100, 250], timeout: 10_000 },
    )
    .toBe(true);
}

async function mockOwdInstallerDirectory(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const files = new Map<string, Uint8Array>();

    const publishSnapshot = () => {
      const snapshot: Record<string, number | string> = {};
      for (const [path, bytes] of files) {
        snapshot[path] = path.endsWith(".json")
          ? decoder.decode(bytes)
          : bytes.byteLength;
      }
      Reflect.set(window, "__owdInstallerSnapshot", snapshot);
    };

    class MemoryFileHandle {
      readonly kind = "file";

      constructor(
        readonly name: string,
        private readonly path: string,
      ) {}

      async createWritable() {
        let pending = Uint8Array.from(files.get(this.path) ?? new Uint8Array());
        return {
          abort: async () => undefined,
          close: async () => {
            files.set(this.path, Uint8Array.from(pending));
            publishSnapshot();
          },
          write: async (data: ArrayBuffer) => {
            pending = new Uint8Array(data);
          },
        };
      }

      async getFile() {
        const bytes = Uint8Array.from(files.get(this.path) ?? new Uint8Array());
        return {
          arrayBuffer: async () => Uint8Array.from(bytes).buffer,
          size: bytes.byteLength,
        };
      }
    }

    class MemoryDirectoryHandle {
      readonly kind = "directory";
      private readonly directories = new Map<string, MemoryDirectoryHandle>();

      constructor(
        readonly name: string,
        private readonly path: string,
      ) {}

      addDirectory(name: string): MemoryDirectoryHandle {
        const directory = new MemoryDirectoryHandle(
          name,
          `${this.path}/${name}`,
        );
        this.directories.set(name, directory);
        return directory;
      }

      async getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
      ): Promise<MemoryDirectoryHandle> {
        const directory = this.directories.get(name);
        if (directory !== undefined) {
          return directory;
        }
        if (options?.create === true) {
          return this.addDirectory(name);
        }
        throw new DOMException(`${name} not found`, "NotFoundError");
      }

      async getFileHandle(
        name: string,
        options?: { create?: boolean },
      ): Promise<MemoryFileHandle> {
        const path = `${this.path}/${name}`;
        if (files.has(path) || options?.create === true) {
          if (!files.has(path)) {
            files.set(path, new Uint8Array());
          }
          return new MemoryFileHandle(name, path);
        }
        throw new DOMException(`${name} not found`, "NotFoundError");
      }

      async removeEntry(
        name: string,
        options?: { recursive?: boolean },
      ): Promise<void> {
        const filePath = `${this.path}/${name}`;
        if (files.delete(filePath)) {
          publishSnapshot();
          return;
        }
        const directory = this.directories.get(name);
        if (directory !== undefined && options?.recursive === true) {
          this.directories.delete(name);
          for (const path of files.keys()) {
            if (path.startsWith(`${filePath}/`)) {
              files.delete(path);
            }
          }
          publishSnapshot();
          return;
        }
        throw new DOMException(`${name} not found`, "NotFoundError");
      }
    }

    const vault = new MemoryDirectoryHandle("Tester Vault", "Tester Vault");
    vault.addDirectory(".obsidian");
    files.set(
      "Tester Vault/.obsidian/community-plugins.json",
      encoder.encode('["calendar"]\n'),
    );
    publishSnapshot();
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => vault,
    });
  });
}

function browserSnapshot(): SnapshotSummary {
  return {
    archivedAt: null,
    captureCompletedAt: now,
    captureStartedAt: now - 5,
    changedItemCount: 1,
    createdAt: now - 5,
    encryption: "age-x25519",
    failureCode: null,
    format: OWD_SNAPSHOT_FORMAT,
    includedSections: ["notes"],
    intelligence: {
      approved: null,
      selection: "none",
      unvetted: null,
    },
    integrityStatus: "verified",
    itemCount: 1,
    logicalBytes: 20,
    newlyStoredBytes: 128,
    pinned: false,
    processedObjectCount: 1,
    recipientFingerprint: "a".repeat(64),
    scope: "selected",
    snapshotId,
    status: "ready",
    totalObjectCount: 1,
    unavailableSections: ["attachments", "obsidian-allowlist"],
    vaults: [
      {
        generationId,
        itemCount: 1,
        logicalBytes: 20,
        snapshotVaultId: sourceVaultId,
        sourceVaultId: targetVaultId,
        vaultName: "Recovery target",
      },
    ],
    verifiedAt: now,
  };
}

test("reopens a downloaded recovery key before activation", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "vaults");
  await expect(
    page.getByText("1 disconnected vault", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Disconnected archive" }),
  ).not.toBeVisible();
  await page.getByText("Disconnected history", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Disconnected archive" }),
  ).toBeVisible();

  await openOperationalRegion(page, "recovery");
  await page.getByRole("button", { name: "Create recovery key" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download recovery key" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^mdevolved-recovery-key-.+Z\.txt$/u,
  );
  const savedKey = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedKey);

  await page
    .getByLabel("Standard saved recovery key file picker")
    .setInputFiles(savedKey);
  await expect(
    page.getByText(`Verified: ${download.suggestedFilename()}`),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByText("Ready for backup")).toBeVisible();
  await page.getByText("Advanced: choose a narrower scope").click();
  await page.getByRole("radio", { name: "Only selected Sources" }).click();
  await expect(
    page.getByText("0 Sources selected at capture start"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create snapshot" }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: "Recovery target" }).click();
  await expect(
    page.getByText("1 Source selected at capture start"),
  ).toBeVisible();
  await context.close();
});

test("archives snapshot history reversibly without hiding recovery controls", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { height: 800, width: 360 },
  });
  const snapshot = browserSnapshot();
  await mockFoundationWithSnapshots(context, [snapshot]);
  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "recovery");
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();

  const archivedHistory = page.locator(".snapshot-archive > summary");
  await expect(archivedHistory).toBeVisible();
  await expect(archivedHistory).toContainText("1 archived snapshot");
  await expect(
    page.getByRole("heading", { name: "Your snapshots" }),
  ).toBeFocused();
  await expect(
    page.getByText(
      "Snapshot archived. Its encrypted recovery data was not deleted.",
    ),
  ).toBeVisible();

  await archivedHistory.click();
  await expect(
    page.getByText("Archive is reversible presentation, not deletion."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("link", { name: "Download encrypted copy" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Return to current" }).click();
  await expect(
    page.getByRole("heading", { name: "Your snapshots" }),
  ).toBeFocused();
  await expect(archivedHistory).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("installs the pinned plugin from one primary tester action", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockOwdInstallerDirectory(context);
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "vaults");
  await expect(
    page.getByRole("heading", {
      name: "Install MDevolved Sync for Obsidian",
    }),
  ).toBeVisible();
  await expect(page.getByText(/MDevolved cannot bypass it/u)).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Choose vault and install MDevolved Sync for Obsidian 0.1.7",
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", {
      name: "Choose vault and install MDevolved Sync for Obsidian 0.1.7",
    })
    .click();
  await expect(
    page.getByText(
      /Installed in Tester Vault\. Installation is complete; pairing is next/u,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Wait up to 30 seconds.*switch the MDevolved plugin off and back on once/u,
    ),
  ).toBeVisible();
  const snapshot: unknown = await page.evaluate(() =>
    Reflect.get(window, "__owdInstallerSnapshot"),
  );
  expect(snapshot).toMatchObject({
    "Tester Vault/.obsidian/community-plugins.json":
      '[\n  "calendar",\n  "owd-sync"\n]\n',
    "Tester Vault/.obsidian/plugins/owd-sync/styles.css": 5_002,
  });
  expect(
    (snapshot as Record<string, unknown>)[
      "Tester Vault/.obsidian/plugins/owd-sync/main.js"
    ],
  ).toEqual(expect.any(Number));
  expect(
    (snapshot as Record<string, number>)[
      "Tester Vault/.obsidian/plugins/owd-sync/main.js"
    ],
  ).toBeGreaterThan(400_000);
  await expect(
    page.getByText(/does not enumerate notes, upload vault data/u),
  ).toBeVisible();
  await page
    .getByText("Manual BRAT fallback—only if direct install reports an error")
    .click();
  await expect(
    page.getByRole("link", { name: "BRAT in Obsidian" }),
  ).toHaveAttribute("href", "obsidian://show-plugin?id=obsidian42-brat");
  await expect(
    page.getByRole("link", {
      name: "Open the prefilled MDevolved Sync for Obsidian 0.1.7 form",
    }),
  ).toHaveAttribute(
    "href",
    "obsidian://brat?plugin=msinclair25/owd-sync&version=0.1.7",
  );
  await expect(
    page.getByText(/not the final Community Plugins experience/u),
  ).toBeVisible();
  await expect(
    page.getByText(/ZIP is not a normal tester installation path/u),
  ).toBeVisible();
  await context.close();
});

test("makes clean-Mac picker cancellation and permission recovery explicit", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    let attempt = 0;
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        attempt += 1;
        throw new DOMException(
          attempt === 1 ? "The user cancelled" : "Permission denied",
          attempt === 1 ? "AbortError" : "NotAllowedError",
        );
      },
    });
  });
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "vaults");
  await page
    .getByRole("button", {
      name: "Choose vault and install MDevolved Sync for Obsidian 0.1.7",
    })
    .click();
  await expect(
    page.getByText("No folder selected; nothing changed."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText(/Chrome did not receive permission to change that vault/u),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Open the prefilled MDevolved Sync for Obsidian 0.1.7 form",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /This link opens BRAT's form; it does not finish the install/u,
    ),
  ).toBeVisible();
  await context.close();
});

test("captures a managed invitation fragment into the fast claim screen", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.route("**/healthz", (route) =>
    route.fulfill({
      body: JSON.stringify({
        environment: "test",
        ok: true,
        requestId: "77777777-7777-4777-8777-777777777777",
        releaseId: "managed-e2e-release-id",
        releaseTag: "managed-e2e-release",
        service: "owd-platform",
        version: "1.0.0-alpha.7",
      }),
      contentType: "application/json",
    }),
  );
  await context.route("**/api/setup/status", (route) =>
    route.fulfill({
      body: JSON.stringify({
        authenticated: false,
        claimAvailable: true,
        claimExpiresAt: Math.floor(Date.now() / 1_000) + 600,
        claimMode: "invitation",
        claimed: false,
        nextAction: "claim-owner",
        pairingEnabled: true,
        state: "unclaimed",
        trialDays: 30,
        trialEndsAt: null,
        trialExpired: false,
        maxVaults: 2,
      }),
      contentType: "application/json",
    }),
  );
  const page = await context.newPage();
  await page.goto(`/#claim=${"a".repeat(43)}`);

  await expect(page).toHaveURL(/\/$/u);
  await expect(
    page.getByRole("heading", { name: "Your MDevolved workspace is ready." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start my workspace" }),
  ).toBeEnabled();
  await expect(
    page.getByText(/includes two active Sources with no agent-seat limit/u),
  ).toBeVisible();
  await expect(
    page.getByText(
      /operator can technically access live service data through Cloudflare administration/u,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/The private link is removed from the address bar/u),
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("shows the transport-neutral collaboration owner surface", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "collaboration");
  await expect(
    page.getByRole("heading", {
      name: "Your Projects",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No active MDevolved Projects yet.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /say “Connect this project to MDevolved” in the selected agent\. The matching prepared request finishes there/u,
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Project label")).not.toBeVisible();
  await page
    .getByText("Advanced: manually create a Project or exchange data")
    .click();
  await expect(page.getByLabel("Project label")).toHaveValue(
    "Research Project",
  );
  await expect(
    page.getByRole("heading", {
      name: "Use MCP or the provider-neutral fallback",
    }),
  ).toBeVisible();
  const totals = page.locator("details.collaboration-technical").filter({
    hasText: "Advanced / technical workspace activity",
  });
  await expect(totals).not.toHaveAttribute("open");
  await expect(page.getByText("0 pending inbox items")).not.toBeVisible();
  await totals.locator("summary").click();
  await expect(page.getByText("0 pending inbox items")).toBeVisible();
  const history = page.locator("details.collaboration-history");
  await expect(history.locator("summary")).toContainText("Provenance history");
  await expect(history).not.toHaveAttribute("open");
  await context.close();
});

test("keeps routine Work Packet rotation out of the owner workflow", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.route("**/api/collaboration/dashboard", (route) =>
    route.fulfill({
      body: JSON.stringify({
        contributionStatistics: {
          acceptedRecordCount: 0,
          artifactCount: 0,
          attemptCount: 0,
          authorizationClientCount: 0,
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
        projects: [
          {
            activeGrantCount: 0,
            activeKnowledgeSpaceVersionId:
              "12121212-1212-4212-8212-121212121212",
            activeProjectVersionId: "13131313-1313-4313-8313-131313131313",
            agentVisibility: "discoverable",
            createdAt: now - 100,
            currentBrief: {
              constraints: [],
              definitionOfDone: ["A fresh agent resumes the same Project."],
              latestCheckpoint: null,
              nextAction: "Resume this Project in the next agent.",
              objective:
                "Keep internal packet rotation out of routine owner work.",
              requestedOutput: "A bounded continuation.",
            },
            currentPacket: {
              createdAt: now - 86_401,
              expiresAt: now - 1,
              packetId: "14141414-1414-4414-8414-141414141414",
              workItemId: "15151515-1515-4515-8515-151515151515",
            },
            duplicateGroupSize: 1,
            label: "Automatic context Project",
            lastActivityAt: now - 20,
            objective:
              "Keep internal packet rotation out of routine owner work.",
            pendingAuthorizationCount: 0,
            projectId: existingProjectId,
            recordCount: 7,
            sourceVaults: [{ id: targetVaultId, name: "Recovery target" }],
            state: "packet-expired",
            status: "active",
            workItemCount: 1,
          },
        ],
        timeline: [],
        timelineNextCursor: null,
      }),
      contentType: "application/json",
    }),
  );
  await page.goto("/");

  await openOperationalRegion(page, "collaboration");
  await page.locator(".project-card-details > summary").click();
  await expect(page.getByText("Agent context")).toBeVisible();
  await expect(
    page.getByText("Automatic · refreshed when an agent connects or resumes"),
  ).toBeVisible();
  await expect(
    operationalRegion(page, "collaboration").getByText(
      "New session, same Project",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(
    operationalRegion(page, "collaboration").getByText(/Call owd_resume/u),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /Renew .*packet/u }),
  ).toHaveCount(0);
  await expect(page.getByText(/24-hour packet/u)).toHaveCount(0);
  await expect(page.getByText(/Phase 9[AB]/u)).toHaveCount(0);
  await context.close();
});

test("keeps archived internal acceptance Projects out of the end-user surface", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.route("**/api/collaboration/dashboard", (route) =>
    route.fulfill({
      body: JSON.stringify({
        contributionStatistics: {
          acceptedRecordCount: 0,
          artifactCount: 0,
          attemptCount: 0,
          authorizationClientCount: 0,
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
        projects: [
          serverBoundProject(),
          {
            activeGrantCount: 0,
            activeKnowledgeSpaceVersionId:
              "78787878-7878-4787-8787-787878787878",
            activeProjectVersionId: "79797979-7979-4797-8797-797979797979",
            agentVisibility: "owner-only",
            createdAt: now - 10_000,
            currentBrief: null,
            currentPacket: null,
            duplicateGroupSize: 1,
            label: "Phase 9A Production Acceptance",
            lastActivityAt: now - 9_000,
            objective:
              "Exercise internal release evidence and operator-only build notes.",
            pendingAuthorizationCount: 0,
            projectId: internalArchivedProjectId,
            recordCount: 17,
            sourceVaults: [{ id: sourceVaultId, name: "Operator rehearsal" }],
            state: "archived",
            status: "archived",
            workItemCount: 1,
          },
        ],
        timeline: [],
        timelineNextCursor: null,
      }),
      contentType: "application/json",
    }),
  );
  await page.goto("/");

  await openOperationalRegion(page, "collaboration");
  await expect(
    page.getByRole("heading", { name: "Agent-first review" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Phase 9A Production Acceptance/u),
  ).not.toBeVisible();
  await expect(page.getByText(/operator-only build notes/u)).not.toBeVisible();
  await expect(page.getByText(internalArchivedProjectId)).toHaveCount(0);
  await context.close();
});

test("keeps onboarding progress bound to one explicitly named vault", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 1,
    activeProjectGrantCount: 1,
    activeVaultCount: 2,
    libraryReady: false,
    nextStep: "build-library",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        nextStep: "ready",
        verifiedSnapshot: true,
      }),
      setupVaultReadiness({
        displayName: "Second vault",
        id: sourceVaultId,
        libraryReady: false,
        nextStep: "build-library",
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  const selector = setup.getByLabel("Set up this Source workspace");
  await expect(selector).toHaveValue(sourceVaultId);
  await expect(
    setup.getByText("Preparing Second vault's searchable library"),
  ).toBeVisible();
  await expect(
    setup.getByText(
      "Each Source completes this journey independently. Progress from another Source never fills these steps.",
    ),
  ).toBeVisible();
  const secondVaultReceipt = setup.locator(".setup-progress-receipt");
  await expect(secondVaultReceipt).toContainText(
    "2 verified milestones · show details",
  );
  await secondVaultReceipt.locator("summary").click();
  await expect(
    secondVaultReceipt.getByText("First sync confirmed"),
  ).toBeVisible();
  await expect(
    secondVaultReceipt.getByText("Current searchable library"),
  ).not.toBeVisible();

  await selector.selectOption(targetVaultId);
  await expect(
    setup.getByText("Recovery target is Project-ready"),
  ).toBeVisible();
  await expect(
    setup.getByText("Returning after a crash or new session?"),
  ).toBeVisible();
  await expect(
    setup.getByText("MDevolved resume project", { exact: true }),
  ).toBeVisible();
  await expect(setup.locator(".setup-progress-receipt")).toContainText(
    "7 verified milestones · show details",
  );
  await context.close();
});

test("advances onboarding immediately when same-page setup state changes", async ({
  browser,
}) => {
  const context = await browser.newContext();
  let readiness: SetupReadiness = {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: false,
    nextStep: "build-library",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        libraryReady: false,
        nextStep: "build-library",
      }),
    ],
  };
  await mockFoundation(context, readiness);
  await context.route("**/api/setup/readiness", (route) =>
    route.fulfill({
      body: JSON.stringify(readiness),
      contentType: "application/json",
    }),
  );
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("Preparing Recovery target's searchable library"),
  ).toBeVisible();

  readiness = {
    ...readiness,
    libraryReady: true,
    nextStep: "connect-agent",
    vaults: [
      setupVaultReadiness({
        libraryReady: true,
        nextStep: "connect-agent",
      }),
    ],
  };
  await page.evaluate(() =>
    window.dispatchEvent(new Event("owd:refresh-setup-readiness")),
  );

  await expect(
    setup.getByText("Connect an agent to Recovery target"),
  ).toBeVisible();
  await expect(
    setup.getByText(/agent you want coordinating .* edits first/u),
  ).toBeVisible();
  await expect(setup.getByText(/You remain the owner/u)).toBeVisible();
  await expect(
    setup.getByText(/later agents are warned to stay read-only/u),
  ).toBeVisible();
  await context.close();
});

test("keeps library and agent setup adjacent and advances after the first build", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  let libraryBuilt = false;
  let readiness: SetupReadiness = {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: false,
    nextStep: "build-library",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        libraryReady: false,
        libraryState: "missing",
        nextStep: "build-library",
      }),
    ],
  };
  const publishedGeneration = {
    completedAt: now,
    createdAt: now - 1,
    generationId,
    noteCount: 0,
    sourceStateVectorSha256: "b".repeat(64),
    totalBytes: 0,
    vaultId: targetVaultId,
  };
  await mockFoundation(context, readiness);
  await context.route("**/api/setup/readiness", (route) =>
    route.fulfill({
      body: JSON.stringify(readiness),
      contentType: "application/json",
    }),
  );
  await context.route(
    `**/api/vaults/${targetVaultId}/materialization`,
    (route) =>
      route.fulfill({
        body: JSON.stringify({
          generation: libraryBuilt ? publishedGeneration : null,
        }),
        contentType: "application/json",
      }),
  );
  await context.route(
    `**/api/vaults/${targetVaultId}/materializations`,
    (route) => {
      libraryBuilt = true;
      readiness = {
        ...readiness,
        libraryReady: true,
        nextStep: "connect-agent",
        vaults: [
          setupVaultReadiness({
            libraryReady: true,
            nextStep: "connect-agent",
          }),
        ],
      };
      return route.fulfill({
        body: JSON.stringify({
          failureCode: null,
          generation: publishedGeneration,
          jobId: "12121212-1212-4121-8121-121212121212",
          processedNoteCount: 0,
          status: "completed",
          totalNoteCount: 0,
          vaultId: targetVaultId,
        }),
        contentType: "application/json",
      });
    },
  );

  const page = await context.newPage();
  await page.goto("/");

  await openOperationalRegion(page, "library");
  const library = operationalRegion(page, "library");
  const flowOrder = await page
    .locator('[data-region="library"], [data-region="agents"]')
    .evaluateAll((regions) =>
      regions.map((region) => region.getAttribute("data-region")),
    );
  expect(flowOrder).toEqual(["library", "agents"]);

  await library.getByRole("button", { name: "Build now" }).click();

  const agents = operationalRegion(page, "agents");
  await expect(agents.locator(".operational-region-content")).toBeVisible();
  await expect(agents.locator(".agent-mcp-endpoint")).toHaveText(
    `${e2eOrigin}/mcp`,
  );
  await expect(agents.locator(".operational-region-header")).toBeInViewport();
  await expect(page).toHaveURL(/#agents$/u);
  if (testInfo.project.name === "chrome-narrow") {
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const heading = document.querySelector<HTMLElement>(
            "#agents-region-heading",
          );
          const navigation =
            document.querySelector<HTMLElement>(".workspace-sidebar");
          if (heading === null || navigation === null) {
            return Number.NEGATIVE_INFINITY;
          }
          return (
            heading.getBoundingClientRect().top -
            navigation.getBoundingClientRect().bottom
          );
        }),
      )
      .toBeGreaterThanOrEqual(0);
  }

  await openOperationalRegion(page, "library");
  await library.getByRole("button", { name: "Refresh now" }).click();
  await expect(library.locator(".operational-region-content")).toBeVisible();
  await expect(agents).not.toBeVisible();
  await expect(page).toHaveURL(/#library$/u);
  await context.close();
});

test("derives the agent-first next action on desktop and narrow screens", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "create-or-select-project",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "create-or-select-project",
        preparedProjectHandoff: preparedSetupHandoff(),
        verifiedSnapshot: true,
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("Finish in Working agent", { exact: true }),
  ).toBeVisible();
  await expect(
    setup.getByText(/say “Connect this project to MDevolved\.”/u),
  ).toBeVisible();
  await expect(
    setup.getByText(/matching first request finishes there/u),
  ).toBeVisible();
  await expect(
    setup.getByText(/no return to this website, copied prompt, reconnect/u),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: /copy|setup instruction/iu }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("shows a passive agent handoff after Project approval", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 1,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "reauthenticate-project",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        nextStep: "reauthenticate-project",
        verifiedSnapshot: true,
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("Your exact Project connection is ready"),
  ).toBeVisible();
  await expect(
    setup.getByText(/Continue in your agent—nothing to copy/u),
  ).toBeVisible();
  await expect(setup.getByText(/no reconnect is required/u)).toBeVisible();
  await expect(
    setup.getByRole("button", { name: /reauth|copy/iu }),
  ).toHaveCount(0);
  const receipt = setup.locator(".setup-progress-receipt");
  await expect(receipt).toContainText("6 verified milestones · show details");
  await receipt.locator("summary").click();
  await expect(receipt.locator("li")).toHaveCount(6);
  await expect(
    receipt.getByText("Project authorization active"),
  ).not.toBeVisible();
  await context.close();
});

test("recovers a pending Project approval without creating a duplicate", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "approve-project",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "approve-project",
        pendingProjectRequestCount: 1,
        pendingProjectRequests: [
          {
            clientName: "Test agent",
            projectLabel: "Test Project",
            requestKind: "create",
            reviewUrl: `/initialize?requestId=${existingProjectId}`,
          },
        ],
        pendingProjectReviewUrl: `/initialize?requestId=${existingProjectId}`,
        verifiedSnapshot: true,
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("An exact Project request needs owner review"),
  ).toBeVisible();
  await setup
    .getByRole("button", {
      name: "Review and approve Project",
    })
    .click();
  await expect(page).toHaveURL(`/initialize?requestId=${existingProjectId}`);
  await expect(
    page.getByRole("heading", { name: "Create this Project?" }),
  ).toBeVisible();
  await context.close();
});

test("surfaces a later Project approval after the first Project is ready", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const readyReadiness: SetupReadiness = {
    activeAgentCount: 1,
    activeProjectCount: 1,
    activeProjectGrantCount: 1,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "ready",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        nextStep: "ready",
        verifiedSnapshot: true,
      }),
    ],
  };
  const pendingReadiness: SetupReadiness = {
    ...readyReadiness,
    nextStep: "approve-project",
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        nextStep: "approve-project",
        pendingProjectRequestCount: 1,
        pendingProjectRequests: [
          {
            clientName: "Codex",
            projectLabel: "Project 2",
            requestKind: "create",
            reviewUrl: `/initialize?requestId=${existingProjectId}`,
          },
        ],
        pendingProjectReviewUrl: `/initialize?requestId=${existingProjectId}`,
        verifiedSnapshot: true,
      }),
    ],
  };
  let readinessChecks = 0;
  await mockFoundation(context, readyReadiness);
  await context.route("**/api/setup/readiness", (route) => {
    readinessChecks += 1;
    return route.fulfill({
      body: JSON.stringify(
        readinessChecks === 1 ? readyReadiness : pendingReadiness,
      ),
      contentType: "application/json",
    });
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("An exact Project request needs owner review"),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: "Review and approve Project" }),
  ).toBeVisible();
  expect(readinessChecks).toBeGreaterThanOrEqual(2);
  await context.close();
});

test("shows one compact agent setup path at a time", async ({ browser }) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", { name: "Install and authenticate" }),
  ).toBeVisible();
  await expect(agents.locator(".agent-client-guide")).toHaveCount(1);
  await expect(
    agents.getByRole("button", { name: "Copy setup" }),
  ).toBeVisible();

  await agents.getByRole("button", { name: "Antigravity" }).click();
  await expect(
    agents.getByRole("heading", { name: "Add one MCP entry" }),
  ).toBeVisible();
  await expect(
    agents.getByRole("button", { name: "Copy config" }),
  ).toBeVisible();
  await expect(
    agents.getByRole("heading", { name: "Install and authenticate" }),
  ).toHaveCount(0);
  await context.close();
});

test("offers a repeatable Project 2 and later launcher", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 1,
    activeProjectGrantCount: 1,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "ready",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        nextStep: "ready",
        verifiedSnapshot: true,
      }),
    ],
  });
  await context.route("**/api/agent/connections", (route) =>
    route.fulfill({
      body: JSON.stringify({
        connections: [
          activeAgentConnection({
            writerAssignedAt: now - 10,
            writerAssignmentBasis: "first-project-agent",
            writerEligible: true,
            writerRole: "primary-writer",
            writerUpdatedAt: now - 10,
          }),
        ],
        mcpUrl: `${e2eOrigin}/mcp`,
      }),
      contentType: "application/json",
    }),
  );
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await setup.getByRole("button", { name: "Start another Project" }).click();
  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", { name: "Start another Project" }),
  ).toBeVisible();
  await agents.getByLabel("Project name").fill("Project 2");
  await agents
    .getByLabel("What are you trying to get done? · optional")
    .fill("Polish the onboarding flow");
  await expect(agents.locator(".later-project-request code")).toContainText(
    'Start a new MDevolved Project named "Project 2"',
  );
  await expect(
    agents.getByRole("button", { name: "Copy request" }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/#agents$/u);
  await context.close();
});

test("keeps later Projects and unfinished vault onboarding distinct", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 2,
    activeProjectCount: 1,
    activeProjectGrantCount: 1,
    activeVaultCount: 2,
    libraryReady: true,
    nextStep: "ready",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        activeProjectCount: 1,
        activeProjectGrantCount: 1,
        nextStep: "ready",
        verifiedSnapshot: true,
      }),
      setupVaultReadiness({
        activeAgentCount: 1,
        displayName: "Second vault",
        id: sourceVaultId,
        nextStep: "prepare-project-handoff",
        verifiedSnapshot: true,
      }),
    ],
  });
  await context.route("**/api/agent/connections", (route) =>
    route.fulfill({
      body: JSON.stringify({
        connections: [
          activeAgentConnection({
            writerAssignedAt: now - 10,
            writerAssignmentBasis: "first-project-agent",
            writerEligible: true,
            writerRole: "primary-writer",
            writerUpdatedAt: now - 10,
          }),
          activeAgentConnection({
            clientName: "Second vault agent",
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            vaultId: sourceVaultId,
            vaultName: "Second vault",
          }),
        ],
        mcpUrl: `${e2eOrigin}/mcp`,
      }),
      contentType: "application/json",
    }),
  );
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", { name: "Start another Project" }),
  ).toBeVisible();
  await expect(
    agents.locator(".later-project-fields select option"),
  ).toHaveCount(1);
  await expect(
    agents.getByText(
      "1 connected Source still needs a separate Project 1 setup.",
    ),
  ).toBeVisible();
  await expect(
    agents.locator(".agent-project-vault-boundaries code"),
  ).toHaveText(sourceVaultId);
  await expect(
    agents.getByRole("button", { name: "Finish Project 1 setup" }),
  ).toBeVisible();
  await context.close();
});

test("asks the owner to choose when two exact Project approvals are pending", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 1,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "approve-project",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "approve-project",
        pendingProjectRequestCount: 2,
        pendingProjectRequests: [
          {
            clientName: "Claude Code",
            projectLabel: "Project 2026",
            requestKind: "connect",
            reviewUrl: `/connect?requestId=${existingProjectId}`,
          },
          {
            clientName: "Codex",
            projectLabel: "Other Project",
            requestKind: "create",
            reviewUrl: `/initialize?requestId=${secondPendingProjectRequestId}`,
          },
        ],
        pendingProjectReviewUrl: null,
        verifiedSnapshot: true,
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText(/More than one agent is waiting/u),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: /Review Project 2026.*Claude Code/u }),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: /Review Other Project.*Codex/u }),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: "Review and approve Project" }),
  ).toHaveCount(0);

  await setup
    .getByRole("button", { name: /Review Other Project.*Codex/u })
    .click();
  await expect(page).toHaveURL(
    `/initialize?requestId=${secondPendingProjectRequestId}`,
  );
  await context.close();
});

test("shows an agent-created Project approval without a reload or tab switch", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const waitingReadiness: SetupReadiness = {
    activeAgentCount: 1,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "create-or-select-project",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "create-or-select-project",
        preparedProjectHandoff: preparedSetupHandoff(),
        verifiedSnapshot: true,
      }),
    ],
  };
  const approvalReadiness: SetupReadiness = {
    ...waitingReadiness,
    nextStep: "approve-project",
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "approve-project",
        pendingProjectRequestCount: 1,
        pendingProjectRequests: [
          {
            clientName: "Test agent",
            projectLabel: "Test Project",
            requestKind: "create",
            reviewUrl: `/initialize?requestId=${existingProjectId}`,
          },
        ],
        pendingProjectReviewUrl: `/initialize?requestId=${existingProjectId}`,
        verifiedSnapshot: true,
      }),
    ],
  };
  let readinessChecks = 0;
  await mockFoundation(context, waitingReadiness);
  await context.route("**/api/setup/readiness", async (route) => {
    readinessChecks += 1;
    await route.fulfill({
      body: JSON.stringify(
        readinessChecks === 1 ? waitingReadiness : approvalReadiness,
      ),
      contentType: "application/json",
    });
  });
  const page = await context.newPage();
  await page.goto("/");

  const setup = page.locator(".setup-panel--active");
  await expect(
    setup.getByText("An exact Project request needs owner review"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    setup.getByRole("button", { name: "Review and approve Project" }),
  ).toBeVisible();
  expect(readinessChecks).toBeGreaterThanOrEqual(2);
  await context.close();
});

test("reveals the prepared Project handoff immediately after readiness changes", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  let connected = false;
  let delayDisconnectedRefresh = false;
  let signalStaleRequestStarted: () => void;
  let releaseStaleResponse: () => void;
  const staleRequestStarted = new Promise<void>((resolve) => {
    signalStaleRequestStarted = resolve;
  });
  const staleResponseReleased = new Promise<void>((resolve) => {
    releaseStaleResponse = resolve;
  });
  const disconnectedReadiness: SetupReadiness = {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "connect-agent",
    verifiedSnapshot: true,
    vaults: [
      setupVaultReadiness({
        nextStep: "connect-agent",
        verifiedSnapshot: true,
      }),
    ],
  };
  const connectedReadiness: SetupReadiness = {
    ...disconnectedReadiness,
    activeAgentCount: 2,
    nextStep: "create-or-select-project",
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 2,
        nextStep: "create-or-select-project",
        preparedProjectHandoff: preparedSetupHandoff(),
        verifiedSnapshot: true,
      }),
    ],
  };
  await mockFoundation(context, disconnectedReadiness);
  await context.route("**/api/setup/readiness", async (route) => {
    await route.fulfill({
      body: JSON.stringify(
        connected ? connectedReadiness : disconnectedReadiness,
      ),
      contentType: "application/json",
    });
  });
  await context.route("**/api/agent/connections", async (route) => {
    const connectedForRequest = connected;
    if (delayDisconnectedRefresh && !connectedForRequest) {
      signalStaleRequestStarted();
      await staleResponseReleased;
    }
    await route.fulfill({
      body: JSON.stringify({
        connections: connectedForRequest
          ? [
              activeAgentConnection({
                preparedProjectHandoff: {
                  folderBoundary: "docs",
                  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  preparedAt: now,
                  projectLabel: "Research Project",
                },
              }),
              activeAgentConnection({
                clientName: "Second working agent",
                id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              }),
            ]
          : [],
        mcpUrl: "http://127.0.0.1:4173/mcp",
      }),
      contentType: "application/json",
    });
  });

  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");
  const agents = operationalRegion(page, "agents");
  await expect(agents.getByText("No authorized clients.")).toBeVisible();
  await expect(
    agents.getByRole("heading", {
      name: /is prepared/u,
    }),
  ).not.toBeVisible();

  delayDisconnectedRefresh = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await staleRequestStarted;
  connected = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  releaseStaleResponse();

  await expect(
    agents.getByRole("heading", {
      name: "Research Project is prepared",
    }),
  ).toBeVisible();
  await expect(
    agents.getByText(/Next: continue in Working agent/u),
  ).toBeVisible();
  await expect(
    agents.getByRole("button", { name: /copy setup instruction/iu }),
  ).toHaveCount(0);
  await expect(
    agents.getByRole("button", { name: "Finish Project 1 setup" }),
  ).toHaveCount(0);

  await page.waitForTimeout(100);
  await expect(
    agents.getByRole("heading", {
      name: "Research Project is prepared",
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("owd:open-operational-region", {
        detail: "architecture",
      }),
    );
  });
  const setup = page.locator(".setup-panel--active");
  await expect(setup).toBeVisible();
  await expect(
    setup.getByText(/say “Connect this project to MDevolved\.”/u),
  ).toBeVisible();
  await expect(
    setup.getByText(/no return to this website, copied prompt, reconnect/u),
  ).toBeVisible();
  await expect(
    setup.getByRole("button", { name: /copy|setup instruction/iu }),
  ).toHaveCount(0);
  await expect(
    setup.getByRole("button", { name: "View Projects" }),
  ).not.toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("shows the exact Project boundary and a reconnect-free completion", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  await mockFoundation(context);
  await context.route("**/api/project-initializations/approve", async (route) =>
    route.fulfill({
      body: JSON.stringify({
        nextAction:
          "Legacy clients may otherwise ask the owner to reauthenticate.",
        projectId: existingProjectId,
        status: "approved",
      }),
      contentType: "application/json",
      status: 200,
    }),
  );
  const page = await context.newPage();
  await page.goto(
    "/initialize?request=browser-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
  );

  await expect(
    page.getByRole("heading", { name: "Create this Project?" }),
  ).toBeVisible();
  await expect(
    page.getByText("Confirm this request came from your agent"),
  ).toBeVisible();
  await expect(
    page.getByText("You stay the owner; one agent coordinates writes"),
  ).toBeVisible();
  await expect(
    page.getByText(/first agent that establishes a MDevolved Project/u),
  ).toBeVisible();
  await expect(
    page.getByText(/does not block local filesystem access/u),
  ).toBeVisible();
  const summary = page.locator(".consent-details").first();
  await expect(summary).toContainText("Recovery target");
  await expect(summary).toContainText("Agent-first review");
  await expect(summary).toContainText(
    "Review one bounded handoff with exact provenance.",
  );
  await page
    .getByText("Review access boundary and setup details", { exact: true })
    .click();
  const details = page.locator(".consent-advanced .consent-details").first();
  await expect(details).toContainText("Independent review agent");
  await expect(details).toContainText("Projects/Agent First");
  await expect(details).toContainText(
    "Review one bounded handoff with exact provenance.",
  );
  await expect(details).toContainText(
    "project.read, collaboration.submit, review.submit",
  );
  await expect(details).toContainText("Projects/Agent First/Brief.md");
  await expect(details).toContainText("README.md, PROJECT-NOTES.md");
  await expect(details).toContainText(
    "PROJECT-NOTES.md → docs/project-notes.md",
  );
  await expect(
    page.getByText("MDevolved does not move local repository files"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Choose legitimate Project context" }),
  ).toBeVisible();
  await expect(page.getByLabel("Included Project context paths")).toHaveValue(
    "Projects/Agent First",
  );
  await expect(page.getByLabel("Excluded Project context paths")).toHaveValue(
    "Projects/Agent First/Personal",
  );
  await expect(
    page.getByText(/This policy becomes the Project's \.owdignore file/u),
  ).toBeVisible();
  await expect(
    page.getByText(
      /It will not preserve private agent conversations, chain-of-thought, tokens, or model identity/u,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create Project" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(
    page.getByRole("heading", { name: "The exact connection is ready." }),
  ).toBeVisible();
  await expect(
    page.getByText("Continue in your agent—nothing to copy.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("No MCP reconnect is required")).toBeVisible();
  await expect(page.getByText("You remain the Source owner")).toBeVisible();
  await expect(page.getByText(/reauthenticate/u)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("shows an immutable same-Project confirmation for Agent B", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  await mockFoundation(context);
  await context.route(
    "**/api/project-initializations/context?request=*",
    async (route) =>
      route.fulfill({
        body: JSON.stringify(projectConsentContext("join")),
        contentType: "application/json",
        status: 200,
      }),
  );
  const page = await context.newPage();
  await page.goto(
    "/connect?request=browser-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
  );

  await expect(
    page.getByRole("heading", {
      name: "Connect this agent to this Project?",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("You stay the owner; one agent coordinates writes"),
  ).toBeVisible();
  await page
    .getByText("Review access boundary and setup details", { exact: true })
    .click();
  const details = page.locator(".consent-advanced .consent-details").first();
  await expect(details).toContainText(existingProjectId);
  await expect(details).toContainText("Projects/");
  await expect(details).toContainText("Current work item");
  await expect(
    page.getByRole("heading", {
      name: "Confirm the existing Project context",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Included Project context paths")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Projects/Agent First/Personal", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve connection" }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("imports and restores a named snapshot in a fresh narrow session", async ({
  browser,
}, testInfo) => {
  const fixture = await portableFixture();
  const snapshotPath = testInfo.outputPath(
    `owd-snapshot-${snapshotId}.owdsnapshot`,
  );
  const keyPath = testInfo.outputPath("owd-recovery-key-fixture.txt");
  await testInfo.attach("fixture-metadata", {
    body: JSON.stringify({ snapshotId }),
    contentType: "application/json",
  });
  const fs = await import("node:fs/promises");
  await fs.writeFile(snapshotPath, fixture.snapshot);
  await fs.writeFile(keyPath, `${fixture.identity}\n`);

  const context = await browser.newContext({
    viewport: { height: 800, width: 360 },
  });
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "vaults");
  await expect(
    page.getByText("1 disconnected vault", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Disconnected archive" }),
  ).not.toBeVisible();
  await openOperationalRegion(page, "recovery");
  await page
    .getByRole("button", { name: "Open encrypted copy to restore" })
    .click();

  const restore = page.locator(".snapshot-restore");
  const restoreHeading = restore.getByRole("heading", {
    name: "Open an encrypted snapshot copy",
  });
  await expect(restoreHeading).toBeFocused();
  await expect(restoreHeading).toBeInViewport();
  await restore
    .locator('input[type="file"]')
    .nth(0)
    .setInputFiles(snapshotPath);
  await expect(restore.getByText(/Selected owd-snapshot-/u)).toContainText(
    snapshotId,
  );
  await restore.locator('input[type="file"]').nth(1).setInputFiles(keyPath);
  await restore.getByRole("button", { name: "Check snapshot and key" }).click();

  await expect(restore.getByLabel("Loaded snapshot identity")).toContainText(
    "reference 33333333",
  );
  await restore.getByLabel("Restore into").selectOption(targetVaultId);
  await restore
    .getByText("I reviewed every source and target name in this mapping.")
    .click();
  await restore
    .getByRole("button", { name: "Review what will change" })
    .click();
  await restore
    .getByLabel("Type Recovery target to confirm")
    .fill("Recovery target");
  await restore.getByRole("button", { name: "Restore mapped Sources" }).click();

  const completion = restore.getByRole("status").filter({
    hasText: "Every mapped Source was restored.",
  });
  await expect(completion).toBeFocused();
  await expect(completion).toBeInViewport();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("preserves staged library input across workspace folder navigation", async ({
  browser,
}, testInfo) => {
  const narrow = testInfo.project.name === "chrome-narrow";
  const context = await browser.newContext(
    narrow
      ? {
          hasTouch: true,
          viewport: { height: 800, width: 360 },
        }
      : undefined,
  );
  let noteRequests = 0;
  await mockFoundation(context, {
    ...defaultReadiness,
    activeAgentCount: 1,
    nextStep: "create-or-select-project",
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "create-or-select-project",
      }),
    ],
  });
  await context.route("**/api/vaults/*/notes", async (route) => {
    noteRequests += 1;
    await route.fallback();
  });
  const page = await context.newPage();
  await page.goto("/");

  const library = operationalRegion(page, "library");
  const agents = operationalRegion(page, "agents");
  await expect(library).toContainText("Selected Source · open to load");
  await expect(library).not.toBeVisible();
  await expect(library.locator(".library-panel")).toHaveCount(0);
  expect(noteRequests).toBe(0);

  await openOperationalRegion(page, "library");
  await expect(library.locator(".library-panel")).toBeVisible();
  await expect.poll(() => noteRequests).toBe(1);

  const search = library.getByLabel("Search this generation");
  await search.fill("durable staged query");
  await openOperationalRegion(page, "agents");
  await expect(agents.locator(".operational-region-content")).toBeVisible();
  await expect(library).not.toBeVisible();
  await expect(search).toHaveValue("durable staged query");

  await openOperationalRegion(page, "library");
  await expect(search).toHaveValue("durable staged query");
  await search.focus();
  await expect(search).toBeFocused();
  expect(noteRequests).toBe(1);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("keeps the focused region stable during rapid background errors", async ({
  browser,
}, testInfo) => {
  const narrow = testInfo.project.name === "chrome-narrow";
  const context = await browser.newContext(
    narrow
      ? {
          hasTouch: true,
          viewport: { height: 800, width: 360 },
        }
      : undefined,
  );
  let failAgentRefresh = false;
  await mockFoundation(context, {
    ...defaultReadiness,
    activeAgentCount: 1,
    nextStep: "create-or-select-project",
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 1,
        nextStep: "create-or-select-project",
      }),
    ],
  });
  await context.route("**/api/agent/connections", async (route) => {
    if (!failAgentRefresh) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: "agent_status_unavailable",
          message: "Agent status is temporarily unavailable.",
          requestId: "88888888-8888-4888-8888-888888888888",
        },
      }),
      contentType: "application/json",
      status: 503,
    });
  });
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "library");

  const search = operationalRegion(page, "library").getByLabel(
    "Search this generation",
  );
  await search.fill("owner focus remains here");
  await search.focus();
  failAgentRefresh = true;
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(operationalRegion(page, "agents")).toContainText(
    "Agent access needs attention",
  );
  await expect(operationalRegion(page, "agents")).not.toBeVisible();
  await expect(page.locator("main.workspace-main")).toHaveAttribute(
    "data-active-section",
    "library",
  );
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("owner focus remains here");
  await context.close();
});

test("keeps a manual Project draft during an independent owner action", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? {
          hasTouch: true,
          viewport: { height: 800, width: 360 },
        }
      : undefined,
  );
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "collaboration");
  await page
    .getByText("Advanced: manually create a Project or exchange data")
    .click();

  const projectObjective = page.getByLabel("Project objective");
  await projectObjective.fill("This staged owner input must remain mounted.");
  await openOperationalRegion(page, "vaults");
  await expect(
    operationalRegion(page, "vaults").getByRole("link", {
      name: "Open Obsidian and pair",
    }),
  ).not.toBeVisible();
  await expect(
    operationalRegion(page, "vaults").getByRole("link", {
      name: "install or update the Obsidian adapter 0.1.7",
    }),
  ).toHaveAttribute("href", "#owd-sync-installer");
  await operationalRegion(page, "vaults")
    .getByRole("button", {
      name: "My folder app or Obsidian adapter is ready — create request",
    })
    .click();

  await expect(
    operationalRegion(page, "vaults").getByRole("heading", {
      name: "Pair the selected Source",
    }),
  ).toBeVisible();
  await expect(
    operationalRegion(page, "vaults").getByRole("link", {
      name: "Open MDevolved Sync",
    }),
  ).toHaveAttribute("href", /^mdevolved:\/\/connect\?/u);
  await expect(
    operationalRegion(page, "vaults").getByRole("link", {
      name: "Open Obsidian and pair",
    }),
  ).toHaveAttribute("href", /^obsidian:\/\/owd-pair\?/u);
  await openOperationalRegion(page, "collaboration");
  await expect(projectObjective).toHaveValue(
    "This staged owner input must remain mounted.",
  );
  await expect(operationalRegion(page, "collaboration")).toBeVisible();
  await expect(operationalRegion(page, "vaults")).not.toBeVisible();
  await context.close();
});

test("confirms a manually created Project beside the form and clears completed fields", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.route("**/api/collaboration/projects", (route) =>
    route.fulfill({
      body: JSON.stringify({
        packet: { packetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
      contentType: "application/json",
      status: 201,
    }),
  );
  await page.goto("/");
  await openOperationalRegion(page, "collaboration");
  await page
    .getByText("Advanced: manually create a Project or exchange data")
    .click();

  await page
    .getByLabel("Project objective")
    .fill("Create a calm, understandable onboarding path.");
  await page
    .getByLabel("First Work Item objective")
    .fill("Remove the dead ends from first setup.");
  await page
    .getByLabel("Requested output")
    .fill("A reviewed onboarding release.");
  await page.getByLabel("Project label").fill("   ");
  await page.getByRole("button", { name: "Create Project and packet" }).click();
  await expect(
    page.getByText(
      "Choose a Source and complete every required Project and Work Item field.",
    ),
  ).toBeVisible();
  await expect(page.locator(".project-create-receipt")).not.toBeVisible();
  await page.getByLabel("Project label").fill("Research Project");
  await page.getByRole("button", { name: "Create Project and packet" }).click();

  const receipt = page.locator(".project-create-receipt");
  await expect(receipt).toBeVisible();
  await expect(receipt).toBeFocused();
  await expect(receipt).toContainText("Research Project was created.");
  await expect(receipt).toContainText("The form was cleared");
  await expect(page.getByLabel("Project label")).toHaveValue("");
  await expect(page.getByLabel("Project objective")).toHaveValue("");
  await expect(page.getByLabel("First Work Item objective")).toHaveValue("");
  await expect(page.getByLabel("Requested output")).toHaveValue("");
  await context.close();
});

test("explains how to recover from a stopped agent authorization", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.route("**/api/agent/oauth/context*", (route) =>
    route.fulfill({
      body: JSON.stringify({
        error: {
          code: "authorization_request_invalid",
          message:
            "The agent requested an unsupported authorization flow or permission.",
          requestId: "88888888-8888-4888-8888-888888888888",
        },
      }),
      contentType: "application/json",
      status: 400,
    }),
  );

  await page.goto(
    "/authorize?response_type=code&client_id=stopped-request&state=test",
  );
  await expect(
    page.getByRole("heading", {
      name: "This authentication request cannot continue.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/No access was granted.*start Authenticate again/u),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Check MDevolved setup" }),
  ).toHaveAttribute("href", "/");
  await context.close();
});

test("routes the Advanced Project form to vault setup instead of leaving a disabled dead end", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context);
  const page = await context.newPage();
  await page.route("**/api/vaults", (route) =>
    route.fulfill({
      body: JSON.stringify({ vaults: [] }),
      contentType: "application/json",
      status: 200,
    }),
  );
  await page.goto("/");
  await openOperationalRegion(page, "collaboration");
  await page
    .getByText("Advanced: manually create a Project or exchange data")
    .click();

  await expect(
    page.getByText("Connect and sync a Source before creating a Project."),
  ).toBeVisible();
  await expect(
    page.getByLabel("Source workspace", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create Project and packet" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Open Source setup" }).click();
  await expect(operationalRegion(page, "vaults")).toBeVisible();
  await expect(page).toHaveURL(/#vaults$/u);
  await context.close();
});

test("requires an explicit vault choice before agent authorization", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  await mockFoundation(context);
  const page = await context.newPage();
  await page.goto(
    "/authorize?response_type=code&client_id=explicit-choice&state=test",
  );

  const vault = page.getByLabel("Source workspace");
  await expect(vault).toHaveValue("");
  await expect(
    vault.getByRole("option", {
      name: "Choose the Source for this Project…",
    }),
  ).toBeAttached();
  const approve = page.getByRole("button", { name: "Approve scoped access" });
  await expect(approve).toBeDisabled();

  await vault.selectOption(targetVaultId);
  await expect(
    page.getByText("Restored content · blocked by default"),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Synthetic restore source/u }),
  ).not.toBeChecked();
  await expect(approve).toBeEnabled();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await context.close();
});

test("locks legacy OAuth to its one server-bound Project", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext(
    testInfo.project.name === "chrome-narrow"
      ? { viewport: { height: 800, width: 360 } }
      : undefined,
  );
  await mockFoundation(context);
  let submittedDecision: unknown = null;
  await context.route("**/api/agent/oauth/context*", async (route) =>
    route.fulfill({
      body: JSON.stringify({
        authorizationKind: "collaboration",
        client: {
          id: "https://agent.example/client.json",
          name: "Independent review agent",
          origin: "https://agent.example",
          redirectUri: "https://agent.example/callback",
          verified: false,
        },
        expiresAt: now + 600,
        flowToken: "project-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
        projects: [serverBoundProject()],
        resource: `${e2eOrigin}/mcp`,
        scopes: ["project.read", "collaboration.submit", "review.submit"],
      }),
      contentType: "application/json",
      status: 200,
    }),
  );
  await context.route("**/api/agent/oauth/approve", async (route) => {
    submittedDecision = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({ redirectTo: `${e2eOrigin}/` }),
      contentType: "application/json",
      status: 200,
    });
  });
  const page = await context.newPage();
  await page.goto(
    "/authorize?response_type=code&client_id=bound-project&state=test",
  );

  await expect(
    page.getByRole("heading", {
      name: "Finish this exact Project connection.",
    }),
  ).toBeVisible();
  const project = page.getByRole("group", { name: "Project" });
  await expect(project).toContainText("Agent-first review");
  await expect(project).toContainText(existingProjectId);
  await expect(
    project.getByText(/server bound this authorization/u),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveCount(0);
  await expect(page.getByText("Choose a Project explicitly…")).toHaveCount(0);

  const finish = page.getByRole("button", { name: "Finish connection" });
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect
    .poll(() => submittedDecision)
    .toMatchObject({
      authorizationKind: "collaboration",
      flowToken: "project-consent-abcdefghijklmnopqrstuvwxyz-0123456789",
      projectId: existingProjectId,
    });
  await context.close();
});

test("keeps agent setup closed until a vault is active", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 0,
    libraryReady: false,
    nextStep: "connect-vault",
    verifiedSnapshot: false,
    vaults: [],
  });
  await context.route("**/api/vaults", (route) =>
    route.fulfill({
      body: JSON.stringify({ vaults: [] }),
      contentType: "application/json",
    }),
  );
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", {
      name: "Pair a Source for this workspace before adding agents",
    }),
  ).toBeVisible();
  await expect(agents.getByText(`${e2eOrigin}/mcp`)).not.toBeVisible();
  await agents.getByRole("button", { name: "Set up a Source" }).click();
  await expect(
    operationalRegion(page, "vaults").locator(".operational-region-content"),
  ).toBeVisible();
  await expect(page).toHaveURL(/#vaults$/u);
  await context.close();
});

test("keeps agent setup closed until the vault library is ready", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: false,
    nextStep: "build-library",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        libraryReady: false,
        nextStep: "build-library",
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", {
      name: "MDevolved is preparing the searchable library",
    }),
  ).toBeVisible();
  await expect(agents.getByText(`${e2eOrigin}/mcp`)).not.toBeVisible();
  await agents.getByRole("button", { name: "View library status" }).click();
  await expect(
    operationalRegion(page, "library").locator(".operational-region-content"),
  ).toBeVisible();
  await expect(page).toHaveURL(/#library$/u);
  await context.close();
});

test("allows read-only agent setup without a recovery point", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await mockFoundation(context, {
    activeAgentCount: 0,
    activeProjectCount: 0,
    activeProjectGrantCount: 0,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "connect-agent",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        libraryReady: true,
        nextStep: "connect-agent",
      }),
    ],
  });
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", {
      name: "Authorized clients and Project access.",
    }),
  ).toBeVisible();
  await expect(agents.locator(".agent-mcp-endpoint")).toHaveText(
    `${e2eOrigin}/mcp`,
  );
  await expect(
    agents.getByRole("heading", {
      name: "Verify a recovery point before adding a new agent",
    }),
  ).not.toBeVisible();
  await context.close();
});

test("keeps authorized clients compact without global writer promotion", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const readiness: SetupReadiness = {
    activeAgentCount: 2,
    activeProjectCount: 2,
    activeProjectGrantCount: 2,
    activeVaultCount: 1,
    libraryReady: true,
    nextStep: "ready",
    verifiedSnapshot: false,
    vaults: [
      setupVaultReadiness({
        activeAgentCount: 2,
        activeProjectCount: 2,
        activeProjectGrantCount: 2,
        nextStep: "ready",
      }),
    ],
  };
  let additionalClientConnected = false;
  let allRevoked = false;
  await mockFoundation(context, readiness);
  await context.route("**/api/agent/connections", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        connections: allRevoked
          ? []
          : [
              activeAgentConnection({
                clientName: "Shared client",
                writerAssignedAt: now - 30,
                writerAssignmentBasis: "project-creator",
                writerEligible: true,
                writerRole: "primary-writer",
                writerUpdatedAt: now - 30,
              }),
              activeAgentConnection({
                clientId: "https://replacement.example/client.json",
                clientName: "Shared client",
                clientOrigin: "https://replacement.example",
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                writerAssignedAt: now - 30,
                writerAssignmentBasis: "project-creator",
                writerEligible: true,
                writerRole: "read-only-collaborator",
                writerUpdatedAt: now - 30,
              }),
              ...(additionalClientConnected
                ? [
                    activeAgentConnection({
                      clientId: "https://third.example/client.json",
                      clientName: "Third client",
                      clientOrigin: "https://third.example",
                      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                      writerEligible: false,
                      writerRole: "read-only-collaborator",
                    }),
                  ]
                : []),
            ],
        mcpUrl: `${e2eOrigin}/mcp`,
      }),
      contentType: "application/json",
    });
  });
  await context.route("**/api/agent/connections/revoke-all", async (route) => {
    allRevoked = true;
    await route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  await page.goto("/");
  await openOperationalRegion(page, "agents");

  const agents = operationalRegion(page, "agents");
  await expect(
    agents.getByRole("heading", { name: "2 authorized clients" }),
  ).toBeVisible();
  await expect(agents.locator(".authorized-client-button")).toHaveCount(2);
  await expect(agents.locator(".agent-row")).toHaveCount(0);
  await expect(
    agents.getByRole("button", { name: "Make primary" }),
  ).toHaveCount(0);
  await expect(
    agents.getByRole("button", {
      name: "Shared client, Recovery target, authorization aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  ).toBeVisible();
  await expect(
    agents.getByRole("button", {
      name: "Shared client, Recovery target, authorization bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }),
  ).toBeVisible();
  await expect(
    agents.getByRole("heading", { name: "Choose one setup path." }),
  ).toHaveCount(0);

  const secondClientButton = agents.getByRole("button", {
    name: "Shared client, Recovery target, authorization bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  await secondClientButton.click();
  const clientWindow = agents.locator(".authorized-client-popover");
  await expect(clientWindow).toBeVisible();
  await expect(
    clientWindow.getByRole("heading", { name: "Shared client" }),
  ).toBeVisible();
  await expect(
    clientWindow.getByRole("button", { name: "Copy resume instruction" }),
  ).toBeVisible();
  await expect(
    clientWindow.getByText("Read-only authorization", { exact: true }),
  ).toBeVisible();
  await expect(
    clientWindow.getByText(/cannot be promoted from this global screen/u),
  ).toBeVisible();
  await expect(
    clientWindow.getByText("MDevolved resume project"),
  ).toBeVisible();
  await expect(
    agents.locator(".later-project-fields select option"),
  ).toHaveText([
    "Shared client · Recovery target · access 1",
    "Shared client · Recovery target · access 2",
  ]);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await clientWindow
    .getByRole("button", { name: "Revoke authorization" })
    .click();
  await expect(clientWindow).toBeVisible();
  await clientWindow.getByRole("button", { name: "Close" }).click();
  await expect(clientWindow).toHaveCount(0);
  await expect(secondClientButton).toBeFocused();

  await agents.getByRole("button", { name: "Connect another" }).click();
  await expect(
    agents.getByRole("heading", { name: "Choose one setup path." }),
  ).toBeVisible();
  additionalClientConnected = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    agents.getByRole("heading", { name: "3 authorized clients" }),
  ).toBeVisible();
  await expect(
    agents.getByRole("heading", { name: "Choose one setup path." }),
  ).toHaveCount(0);
  await agents
    .getByRole("button", { name: "Third client, Recovery target" })
    .click();
  await expect(
    agents.getByText(
      "No active Project command is available for this authorization.",
    ),
  ).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await agents.getByRole("button", { name: "Revoke all" }).click();
  await expect(agents.getByText("No authorized clients.")).toBeVisible();
  await expect(
    agents.getByRole("heading", { name: "Choose one setup path." }),
  ).toBeFocused();
  await context.close();
});
