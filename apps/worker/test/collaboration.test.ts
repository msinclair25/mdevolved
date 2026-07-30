import {
  canonicalizeIntegrityPayload,
  collaborationSubmissionSchema,
  type CollaborationProjectCreateRequest,
  type CollaborationSubmission,
  type CollaborationSubmissionReceipt,
  type WorkPacket,
} from "@owd/contracts";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Decrypter,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";
import { ensureAuthSchema } from "../src/auth-store";
import { ensureBackupSchema, saveBackupRecipient } from "../src/backup-store";
import { projectDecisionToNotebook } from "../src/collaboration-projection";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import {
  applyCollaborationRestore,
  createCollaborationRestore,
  stageCollaborationRestoreItem,
} from "../src/collaboration-restore";
import {
  queueCollaborationObjectCleanup,
  runCollaborationGarbageCollection,
} from "../src/collaboration-retention";
import {
  buildCollaborationSnapshotManifest,
  estimateCollaborationSnapshot,
  stageCollaborationSnapshot,
} from "../src/collaboration-snapshot";
import {
  applyOwnerRecordAction,
  buildPortableWorkPacket,
  createCollaborationProject,
  createContinuationWorkPacket,
  createOwnerDecision,
  getCurrentAuthorizedWorkPacket,
  getAuthorizedWorkPacket,
  getCollaborationDashboard,
  getLatestSharedHandoff,
  refreshContinuationWorkPacketIfNeeded,
  resumeAuthorizedProject,
  submitCollaborationRecord,
  type CollaborationAuthorizationContext,
} from "../src/collaboration-service";
import {
  activateCollaborationGrant,
  createPendingCollaborationGrant,
  listCollaborationConnections,
  readCollaborationParticipantClaims,
  revokeCollaborationGrant,
  setCollaborationProjectAgentVisibility,
  setCollaborationWorkItemReopened,
} from "../src/collaboration-store";
import {
  agentMayUseCurrentMaterializedPaths,
  ensureMaterializationSchema,
  publishMaterialization,
} from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { encodeBase64Url, sha256Hex, sha256HexBytes } from "../src/security";
import {
  buildPortableSnapshotExport,
  continueWorkspaceSnapshot,
  ensureSnapshotSchema,
  repairWorkspaceSnapshot,
  startWorkspaceSnapshot,
} from "../src/snapshot-store";
import {
  applyOnboardingLifecycleMigration,
  applyPhase9aCollaborationMigration,
  applyPhase9bAgentFirstMigration,
  applyProjectConnectionHardeningMigration,
  applyProjectCreationCommitMigration,
  applyProjectCreationIdentityMigration,
  applyProjectAgentVisibilityMigration,
  applyRestoredContentAuthorizationMigration,
  applyVaultPrimaryWriterMigration,
} from "./migration-fixture";

const NOW = 1_784_820_000;
const AUDIENCE = "https://owd.test/mcp";
const CLIENT_ID = "https://client.example/agent.json";
const encoder = new TextEncoder();

type ProjectFixture = {
  authorization: CollaborationAuthorizationContext;
  grantId: string;
  packet: WorkPacket;
  projectId: string;
  vaultId: string;
  workItemId: string;
};

type D1BudgetMetrics = {
  activeOperations: number;
  maxBoundParameters: number;
  maxConcurrentOperations: number;
  statementCount: number;
};

function budgetedDatabase(): {
  db: D1Database;
  metrics: D1BudgetMetrics;
} {
  const metrics: D1BudgetMetrics = {
    activeOperations: 0,
    maxBoundParameters: 0,
    maxConcurrentOperations: 0,
    statementCount: 0,
  };
  const rawStatements = new WeakMap<object, D1PreparedStatement>();
  const tracked = async <T>(operation: () => Promise<T>): Promise<T> => {
    metrics.activeOperations += 1;
    metrics.maxConcurrentOperations = Math.max(
      metrics.maxConcurrentOperations,
      metrics.activeOperations,
    );
    try {
      return await operation();
    } finally {
      metrics.activeOperations -= 1;
    }
  };
  const wrapStatement = (
    statement: D1PreparedStatement,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            metrics.maxBoundParameters = Math.max(
              metrics.maxBoundParameters,
              values.length,
            );
            if (values.length > 100) {
              throw new Error("D1 bound-parameter limit exceeded.");
            }
            return wrapStatement(target.bind(...values));
          };
        }
        if (
          property === "all" ||
          property === "first" ||
          property === "raw" ||
          property === "run"
        ) {
          const method = Reflect.get(target, property, target) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          return (...args: unknown[]) =>
            tracked(() => Reflect.apply(method, target, args));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          metrics.statementCount += 1;
          return wrapStatement(target.prepare(query));
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) =>
          tracked(() =>
            target.batch(
              statements.map(
                (statement) => rawStatements.get(statement) ?? statement,
              ),
            ),
          );
      }
      if (property === "exec") {
        return (query: string) => {
          metrics.statementCount += 1;
          return tracked(() => target.exec(query));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, metrics };
}

function budgetedBucket(): {
  bucket: R2Bucket;
  metrics: { activeOperations: number; maxConcurrentOperations: number };
} {
  const metrics = { activeOperations: 0, maxConcurrentOperations: 0 };
  const bucket = new Proxy(env.VAULT_STORAGE, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (
        (property === "delete" || property === "head") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          metrics.activeOperations += 1;
          metrics.maxConcurrentOperations = Math.max(
            metrics.maxConcurrentOperations,
            metrics.activeOperations,
          );
          try {
            return await Reflect.apply(value, target, args);
          } finally {
            metrics.activeOperations -= 1;
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bucket, metrics };
}

async function clearBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.VAULT_STORAGE.list({ cursor });
    if (page.objects.length > 0) {
      await env.VAULT_STORAGE.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function resetState(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await ensureBackupSchema(env.DB);
  await ensureAgentAccessSchema(env.DB);
  await ensureSnapshotSchema(env.DB);
  await applyPhase9aCollaborationMigration(env.DB);
  await applyPhase9bAgentFirstMigration(env.DB);
  await applyRestoredContentAuthorizationMigration(env.DB);
  await applyOnboardingLifecycleMigration(env.DB);
  await applyProjectConnectionHardeningMigration(env.DB);
  await applyProjectCreationIdentityMigration(env.DB);
  await applyProjectCreationCommitMigration(env.DB);
  await applyProjectAgentVisibilityMigration(env.DB);
  await applyVaultPrimaryWriterMigration(env.DB);
  await env.DB.exec(`
    DELETE FROM collaboration_restore_items;
    DELETE FROM collaboration_restore_jobs;
    DELETE FROM snapshot_intelligence_items;
    DELETE FROM snapshot_intelligence_selections;
    DELETE FROM snapshot_entries;
    DELETE FROM snapshot_objects;
    DELETE FROM snapshot_vaults;
    DELETE FROM workspace_snapshots;
    DELETE FROM snapshot_gc_objects;
    DELETE FROM collaboration_submission_receipts;
    DELETE FROM collaboration_gc_objects;
    DELETE FROM collaboration_packet_rotations;
    DELETE FROM collaboration_grant_clients;
    DELETE FROM collaboration_grants;
    DELETE FROM project_initialization_approval_claims;
    DELETE FROM project_creation_requests;
    DELETE FROM project_creation_commits;
    DELETE FROM project_creation_reservations;
    DELETE FROM project_initialization_projects;
    DELETE FROM vault_local_writer_assignments;
    DELETE FROM project_initialization_requests;
    DELETE FROM collaboration_notebook_projections;
    DELETE FROM collaboration_provenance_edges;
    DELETE FROM collaboration_owner_events;
    DELETE FROM collaboration_dependencies;
    DELETE FROM collaboration_record_content;
    DELETE FROM collaboration_record_states;
    DELETE FROM collaboration_work_items;
    DELETE FROM collaboration_projects;
    DELETE FROM collaboration_content_objects;
    DELETE FROM collaboration_records;
    DELETE FROM backup_recipients;
    DELETE FROM agent_grant_restore_sources;
    DELETE FROM agent_grants;
    DELETE FROM restored_note_lineage;
    DELETE FROM restore_entries;
    DELETE FROM restore_jobs;
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vaults;
    DELETE FROM audit_events;
  `);
  await clearBucket();
}

function projectRequest(
  vaultId: string,
  sourceNotes: CollaborationProjectCreateRequest["sourceNotes"] = [],
): CollaborationProjectCreateRequest {
  return {
    knowledgeSpace: {
      label: "Walking skeleton sources",
      members: [
        {
          exclusions: [{ path: "OWD Projects", pathKey: "owd projects" }],
          pathPrefixes: [{ path: "", pathKey: "" }],
          vaultId,
        },
      ],
    },
    packetExpiresInSeconds: 600,
    project: {
      label: "Walking skeleton",
      objective: "Exercise one complete portable collaboration loop.",
    },
    requestedRole: "contributor",
    sourceNotes,
    workItem: {
      constraints: ["Use only the Work Packet."],
      definitionOfDone: ["Return one reviewed Artifact."],
      objective: "Produce and review a bounded Artifact.",
      requestedOutput: "Markdown",
    },
  };
}

async function createActiveSourceAgentGrant(
  vaultId: string,
  input: {
    clientId: string;
    clientName: string;
    clientOrigin: string;
    now: number;
  },
): Promise<string> {
  const grantId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO owners (
        id, webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at
      ) VALUES (1, 'collaboration-owner', 'collaboration-credential',
        'collaboration-public-key', 0, '[]', 'singleDevice', 0, ?)`,
    ).bind(input.now),
    env.DB.prepare(
      `INSERT INTO agent_grants (
        id, owner_id, oauth_client_id, client_name, client_origin,
        redirect_uri, audience, vault_id, scopes_json,
        path_prefixes_json, path_key_prefixes_json, status, created_at,
        activated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, '["vault.read"]',
        '[]', '[]', 'active', ?, ?)`,
    ).bind(
      grantId,
      input.clientId,
      input.clientName,
      input.clientOrigin,
      `${input.clientOrigin}/callback`,
      AUDIENCE,
      vaultId,
      input.now,
      input.now,
    ),
  ]);
  return grantId;
}

async function createFixture(
  clientId = CLIENT_ID,
  now = NOW,
): Promise<ProjectFixture> {
  const vaultId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at
      ) VALUES (?, 'Collaboration vault', 'active', ?, ?)`,
    ).bind(vaultId, now, now),
    env.DB.prepare(
      `INSERT INTO vault_sync_states (
        vault_id, plugin_version, schema_version,
        connection_confirmed_at, initial_sync_at, last_sync_at,
        current_state_vector_sha256, library_stale, updated_at
      ) VALUES (?, '0.1.6', 3, ?, ?, ?, ?, 1, ?)`,
    ).bind(vaultId, now, now, now, "b".repeat(64), now),
  ]);
  const sourceAgentGrantId = await createActiveSourceAgentGrant(vaultId, {
    clientId,
    clientName: "Agent A client",
    clientOrigin: "https://client.example",
    now,
  });
  const created = await createCollaborationProject(
    env.DB,
    env.VAULT_STORAGE,
    projectRequest(vaultId),
    now,
    crypto.randomUUID(),
  );
  const project = await env.DB.prepare(
    `SELECT active_knowledge_space_version_id
     FROM collaboration_projects WHERE project_id = ?`,
  )
    .bind(created.projectId)
    .first<{ active_knowledge_space_version_id: string }>();
  if (project === null) throw new Error("Project projection missing.");
  const grantId = await createPendingCollaborationGrant(env.DB, {
    audience: AUDIENCE,
    clientId,
    expiresAt: now + 10_000,
    issuedAt: now,
    knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
    projectId: created.projectId,
    scopes: [
      "project.read",
      "collaboration.submit",
      "review.submit",
      "proposal.status",
    ],
    source: {
      agentGrantId: sourceAgentGrantId,
      clientName: "Agent A client",
      clientOrigin: "https://client.example",
    },
  });
  expect(await activateCollaborationGrant(env.DB, { grantId, now })).toBe(true);
  return {
    authorization: {
      audience: AUDIENCE,
      clientId,
      grantId,
      tokenScopes: [
        "project.read",
        "collaboration.submit",
        "review.submit",
        "proposal.status",
      ],
    },
    grantId,
    packet: created.packet,
    projectId: created.projectId,
    vaultId,
    workItemId: created.workItemId,
  };
}

type EvidenceNote = {
  content: string;
  path: string;
};

async function publishEvidenceGeneration(
  vaultId: string,
  input: {
    notes: EvidenceNote[];
    now: number;
    stateVectorSha256: string;
  },
): Promise<void> {
  const notes = input.notes.map((note, index) => ({
    byteLength: encoder.encode(note.content).byteLength,
    content: note.content,
    fileId: `evidence-${index}`,
    modifiedAt: input.now,
    path: note.path,
    pathKey: note.path.toLocaleLowerCase("en-US"),
    title: note.path.split("/").at(-1)?.replace(/\.md$/u, "") ?? note.path,
  }));
  await env.DB.prepare(
    `UPDATE vault_sync_states
     SET current_state_vector_sha256 = ?, library_stale = 1,
       last_sync_at = ?, updated_at = ?
     WHERE vault_id = ?`,
  )
    .bind(input.stateVectorSha256, input.now, input.now, vaultId)
    .run();
  await publishMaterialization(env.DB, env.VAULT_STORAGE, {
    now: input.now,
    requestId: crypto.randomUUID(),
    snapshot: {
      notes,
      schemaVersion: 3,
      totalBytes: notes.reduce((total, note) => total + note.byteLength, 0),
    },
    sourceStateVectorSha256: input.stateVectorSha256,
    vaultId,
  });
}

async function createEvidenceFixture(): Promise<ProjectFixture> {
  const vaultId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at
      ) VALUES (?, 'Evidence durability vault', 'active', ?, ?)`,
    ).bind(vaultId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO vault_sync_states (
        vault_id, plugin_version, schema_version,
        connection_confirmed_at, initial_sync_at, last_sync_at,
        current_state_vector_sha256, library_stale, updated_at
      ) VALUES (?, '0.1.6', 3, ?, ?, ?, ?, 1, ?)`,
    ).bind(vaultId, NOW, NOW, NOW, "b".repeat(64), NOW),
  ]);
  const sourceAgentGrantId = await createActiveSourceAgentGrant(vaultId, {
    clientId: CLIENT_ID,
    clientName: "Evidence durability client",
    clientOrigin: "https://client.example",
    now: NOW,
  });
  await publishEvidenceGeneration(vaultId, {
    notes: [
      { content: "# Cited\nstable evidence", path: "Sources/Cited.md" },
      { content: "# Other\nfirst version", path: "Sources/Other.md" },
    ],
    now: NOW,
    stateVectorSha256: "b".repeat(64),
  });
  const created = await createCollaborationProject(
    env.DB,
    env.VAULT_STORAGE,
    projectRequest(vaultId, [
      {
        excerptByteRange: null,
        path: "Sources/Cited.md",
        vaultId,
      },
    ]),
    NOW + 1,
    crypto.randomUUID(),
  );
  const project = await env.DB.prepare(
    `SELECT active_knowledge_space_version_id
     FROM collaboration_projects WHERE project_id = ?`,
  )
    .bind(created.projectId)
    .first<{ active_knowledge_space_version_id: string }>();
  if (project === null) throw new Error("Project projection missing.");
  const grantId = await createPendingCollaborationGrant(env.DB, {
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    expiresAt: NOW + 20_000,
    issuedAt: NOW + 1,
    knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
    projectId: created.projectId,
    scopes: [
      "project.read",
      "collaboration.submit",
      "review.submit",
      "proposal.status",
    ],
    source: {
      agentGrantId: sourceAgentGrantId,
      clientName: "Evidence durability client",
      clientOrigin: "https://client.example",
    },
  });
  expect(
    await activateCollaborationGrant(env.DB, { grantId, now: NOW + 1 }),
  ).toBe(true);
  return {
    authorization: {
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      grantId,
      tokenScopes: [
        "project.read",
        "collaboration.submit",
        "review.submit",
        "proposal.status",
      ],
    },
    grantId,
    packet: created.packet,
    projectId: created.projectId,
    vaultId,
    workItemId: created.workItemId,
  };
}

function fixtureContextPolicy(fixture: ProjectFixture) {
  return {
    excludePaths: ["OWD Projects"],
    format: "owd-project-context-v1" as const,
    includePaths: [""],
    projectId: fixture.projectId,
  };
}

function participant(clientId: string, participantRefId: string, now = NOW) {
  return {
    claimedHarness: {
      assertedBy: "client" as const,
      name: "Synthetic Harness",
      verification: "claimed" as const,
      version: "1.0.0",
    },
    claimedModel: {
      assertedBy: "client" as const,
      name: "Synthetic Model",
      verification: "claimed" as const,
      version: "2026-07",
    },
    observedAt: now,
    oauthClient: {
      clientId,
      displayName: "Synthetic client",
      origin: "https://client.example",
      verification: "authorization-bound-client" as const,
    },
    participantRefId,
    recordType: "participant-ref" as const,
    schemaVersion: 1 as const,
  };
}

async function signedSubmission(
  fixture: ProjectFixture,
  input: {
    clientId?: string;
    grantId?: string | null;
    idempotencyKey: string;
    participantRefId: string;
    record: CollaborationSubmission["record"];
    submissionId?: string;
  },
): Promise<CollaborationSubmission> {
  const clientId = input.clientId ?? fixture.authorization.clientId;
  const grantId = input.grantId === undefined ? fixture.grantId : input.grantId;
  const value = {
    authorizationContext:
      grantId === null
        ? {
            grantId: null,
            mode: "owner-import" as const,
            oauthClientId: clientId,
          }
        : {
            grantId,
            mode: "authorized-client" as const,
            oauthClientId: clientId,
          },
    format: "owd-collaboration-submission-v1" as const,
    idempotencyKey: input.idempotencyKey,
    integrity: {
      algorithm: "sha-256-jcs-rfc8785" as const,
      digest: "0".repeat(64),
      scope: "object-with-integrity-digest-omitted" as const,
    },
    participantRef: participant(clientId, input.participantRefId),
    projectId: fixture.projectId,
    record: input.record,
    schemaVersion: 1 as const,
    submissionId: input.submissionId ?? crypto.randomUUID(),
    workItemId: fixture.workItemId,
    workPacketId: fixture.packet.packetId,
  };
  value.integrity.digest = await sha256Hex(
    canonicalizeIntegrityPayload(
      value as typeof value & Record<string, unknown>,
    ),
  );
  return collaborationSubmissionSchema.parse(value);
}

async function submitAttempt(
  fixture: ProjectFixture,
  input: {
    authorization?: CollaborationAuthorizationContext;
    clientId?: string;
    grantId?: string | null;
    idempotencyKey?: string;
    participantRefId?: string;
  } = {},
): Promise<{
  attemptId: string;
  participantRefId: string;
  receipt: CollaborationSubmissionReceipt;
  submission: CollaborationSubmission;
}> {
  const participantRefId = input.participantRefId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const submission = await signedSubmission(fixture, {
    clientId: input.clientId,
    grantId: input.grantId,
    idempotencyKey: input.idempotencyKey ?? `attempt-${crypto.randomUUID()}`,
    participantRefId,
    record: {
      attemptId,
      claimedCompletedAt: null,
      claimedStartedAt: NOW,
      grantId:
        input.grantId === null ? null : (input.grantId ?? fixture.grantId),
      participantRefId,
      projectId: fixture.projectId,
      recordType: "attempt",
      requestedRole: { authority: "none", label: "contributor" },
      schemaVersion: 1,
      supersedesRecordId: null,
      workItemId: fixture.workItemId,
      workPacketId: fixture.packet.packetId,
    },
  });
  return {
    attemptId,
    participantRefId,
    receipt: await submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
      authorization:
        input.grantId === null
          ? undefined
          : (input.authorization ?? fixture.authorization),
      now: NOW + 1,
      rawSubmission: submission,
    }),
    submission,
  };
}

async function submitArtifact(
  fixture: ProjectFixture,
  attemptId: string,
  participantRefId: string,
  body: string,
  idempotencyKey = `artifact-${crypto.randomUUID()}`,
): Promise<{
  artifactId: string;
  receipt: CollaborationSubmissionReceipt;
  submission: CollaborationSubmission;
}> {
  const artifactId = crypto.randomUUID();
  const submission = await signedSubmission(fixture, {
    idempotencyKey,
    participantRefId,
    record: {
      artifactId,
      attemptId,
      content: {
        byteLength: encoder.encode(body).byteLength,
        contentSha256: await sha256HexBytes(encoder.encode(body)),
        kind: "stored-object",
        mediaType: "text/markdown",
        portableObjectId: crypto.randomUUID(),
      },
      label: "Bounded result",
      projectId: fixture.projectId,
      recordType: "artifact",
      schemaVersion: 1,
      supersedesRecordId: null,
      workItemId: fixture.workItemId,
      workPacketId: fixture.packet.packetId,
    },
  });
  return {
    artifactId,
    receipt: await submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
      artifactBody: body,
      authorization: fixture.authorization,
      now: NOW + 2,
      rawSubmission: submission,
    }),
    submission,
  };
}

beforeEach(resetState);

describe("Phase 9B agent-first collaboration walking path", () => {
  it("revokes existing grants and prevents grant creation or activation once a Project becomes owner-only", async () => {
    const fixture = await createFixture();
    expect(
      await setCollaborationProjectAgentVisibility(env.DB, {
        now: NOW + 1,
        projectId: fixture.projectId,
        reason: "Keep this Project private to the owner.",
        requestId: crypto.randomUUID(),
        visibility: "owner-only",
      }),
    ).toBe(true);
    const revoked = await env.DB.prepare(
      `SELECT status FROM collaboration_grants WHERE id = ?`,
    )
      .bind(fixture.grantId)
      .first<{ status: string }>();
    expect(revoked?.status).toBe("revoked");
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 2,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).rejects.toThrow("collaboration_grant_revoked");

    const dashboard = await getCollaborationDashboard(
      env.DB,
      env.VAULT_STORAGE,
    );
    expect(
      dashboard.projects.find(
        (project) => project.projectId === fixture.projectId,
      ),
    ).toMatchObject({
      agentVisibility: "owner-only",
      label: "Walking skeleton",
      projectId: fixture.projectId,
    });

    const project = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (project === null) throw new Error("Project projection missing.");
    await expect(
      createPendingCollaborationGrant(env.DB, {
        audience: AUDIENCE,
        clientId: `${CLIENT_ID}/hidden`,
        expiresAt: NOW + 10_000,
        issuedAt: NOW + 2,
        knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
        projectId: fixture.projectId,
        scopes: ["project.read"],
      }),
    ).rejects.toThrow("project_reference_invalid");

    await env.DB.prepare(
      `UPDATE collaboration_projects
       SET agent_visibility = 'discoverable' WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .run();
    const raceClientId = `${CLIENT_ID}/race`;
    const raceSourceGrantId = await createActiveSourceAgentGrant(
      fixture.vaultId,
      {
        clientId: raceClientId,
        clientName: "Race client",
        clientOrigin: "https://race-client.example",
        now: NOW + 3,
      },
    );
    const raceGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: raceClientId,
      expiresAt: NOW + 10_000,
      issuedAt: NOW + 3,
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      projectId: fixture.projectId,
      scopes: ["project.read"],
      source: {
        agentGrantId: raceSourceGrantId,
        clientName: "Race client",
        clientOrigin: "https://race-client.example",
      },
    });
    await env.DB.prepare(
      `UPDATE collaboration_projects
       SET agent_visibility = 'owner-only' WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .run();
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: raceGrantId,
        now: NOW + 4,
      }),
    ).toBe(false);
    expect(
      await setCollaborationProjectAgentVisibility(env.DB, {
        now: NOW + 5,
        projectId: fixture.projectId,
        reason: "Finish the simulated concurrent hide.",
        requestId: crypto.randomUUID(),
        visibility: "owner-only",
      }),
    ).toBe(true);
    const raceGrant = await env.DB.prepare(
      `SELECT status FROM collaboration_grants WHERE id = ?`,
    )
      .bind(raceGrantId)
      .first<{ status: string }>();
    expect(raceGrant?.status).toBe("revoked");
  });

  it("shows a closed Work Item as an actionable Project repair and reopens only that exact item", async () => {
    const fixture = await createFixture();
    await env.DB.prepare(
      `UPDATE collaboration_work_items
       SET status = 'closed'
       WHERE project_id = ? AND work_item_id = ?`,
    )
      .bind(fixture.projectId, fixture.workItemId)
      .run();

    const closedDashboard = await getCollaborationDashboard(
      env.DB,
      env.VAULT_STORAGE,
    );
    expect(closedDashboard.projects[0]).toMatchObject({
      currentPacket: { workItemId: fixture.workItemId },
      projectId: fixture.projectId,
      state: "work-item-closed",
    });

    expect(
      await setCollaborationWorkItemReopened(env.DB, {
        now: NOW + 1,
        projectId: fixture.projectId,
        reason: "Resume the exact existing Project.",
        requestId: crypto.randomUUID(),
        workItemId: fixture.workItemId,
      }),
    ).toBe(true);
    const reopenedDashboard = await getCollaborationDashboard(
      env.DB,
      env.VAULT_STORAGE,
    );
    expect(reopenedDashboard.projects[0]?.state).not.toBe("work-item-closed");
    const projects = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM collaboration_projects`,
    ).first<{ count: number }>();
    expect(projects?.count).toBe(1);
  });

  it("caps polluted dashboard storage reads at six concurrent connections", async () => {
    const fixture = await createFixture();
    for (let index = 1; index < 12; index += 1) {
      await createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        projectRequest(fixture.vaultId),
        NOW + index,
        crypto.randomUUID(),
        { skipProjectCreationCommit: true },
      );
    }

    const storageMetrics = { active: 0, calls: 0, maximum: 0 };
    const delayedStorage = new Proxy(env.VAULT_STORAGE, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "get" && typeof value === "function") {
          return async (...args: unknown[]) => {
            storageMetrics.active += 1;
            storageMetrics.calls += 1;
            storageMetrics.maximum = Math.max(
              storageMetrics.maximum,
              storageMetrics.active,
            );
            try {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 10);
              });
              return await Reflect.apply(value, target, args);
            } finally {
              storageMetrics.active -= 1;
            }
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const dashboard = await getCollaborationDashboard(env.DB, delayedStorage);

    expect(dashboard.projects).toHaveLength(12);
    expect(
      dashboard.projects.every((project) => project.duplicateGroupSize === 12),
    ).toBe(true);
    expect(storageMetrics.calls).toBe(24);
    expect(storageMetrics.maximum).toBe(6);
  });

  it("cleans a 64-object collaboration GC batch within D1 and R2 budgets", async () => {
    const keys = Array.from(
      { length: 64 },
      (_, index) => `collaboration/test-orphan-${index}.json`,
    );
    const queueBudget = budgetedDatabase();
    await queueCollaborationObjectCleanup(queueBudget.db, keys, NOW);
    expect(queueBudget.metrics.statementCount).toBe(1);
    expect(queueBudget.metrics.maxBoundParameters).toBe(1);

    const gcBudget = budgetedDatabase();
    const storageBudget = budgetedBucket();
    expect(
      await runCollaborationGarbageCollection(
        gcBudget.db,
        storageBudget.bucket,
        NOW + 61,
      ),
    ).toBe(0);
    expect(gcBudget.metrics.statementCount).toBeLessThanOrEqual(4);
    expect(gcBudget.metrics.maxBoundParameters).toBeLessThanOrEqual(100);
    expect(gcBudget.metrics.maxConcurrentOperations).toBeLessThanOrEqual(1);
    expect(storageBudget.metrics.maxConcurrentOperations).toBeLessThanOrEqual(
      6,
    );
  });

  it("keeps 64-source Project creation and continuation inside D1 Free budgets", async () => {
    const vaultId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'D1 budget vault', 'active', ?, ?)`,
      ).bind(vaultId, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO vault_sync_states (
          vault_id, plugin_version, schema_version,
          connection_confirmed_at, initial_sync_at, last_sync_at,
          current_state_vector_sha256, library_stale, updated_at
        ) VALUES (?, '0.1.6', 3, ?, ?, ?, ?, 1, ?)`,
      ).bind(vaultId, NOW, NOW, NOW, "b".repeat(64), NOW),
    ]);
    const sourceGrantId = await createActiveSourceAgentGrant(vaultId, {
      clientId: CLIENT_ID,
      clientName: "D1 budget client",
      clientOrigin: "https://client.example",
      now: NOW,
    });
    const notes = Array.from({ length: 64 }, (_, index) => ({
      content: `# Budget source ${index}\nInitial evidence ${index}.`,
      path: `Sources/Budget-${String(index).padStart(2, "0")}.md`,
    }));
    await publishEvidenceGeneration(vaultId, {
      notes,
      now: NOW,
      stateVectorSha256: "b".repeat(64),
    });
    const authorizationBudget = budgetedDatabase();
    const allowed = await agentMayUseCurrentMaterializedPaths(
      authorizationBudget.db,
      {
        grantId: sourceGrantId,
        pathKeys: notes.map((note) => note.path.toLocaleLowerCase("en-US")),
        vaultId,
      },
    );
    expect([...allowed.values()]).toEqual(Array(64).fill(true));
    expect(authorizationBudget.metrics.statementCount).toBeLessThanOrEqual(3);
    expect(authorizationBudget.metrics.maxBoundParameters).toBeLessThanOrEqual(
      100,
    );
    expect(
      authorizationBudget.metrics.maxConcurrentOperations,
    ).toBeLessThanOrEqual(1);

    const creationBudget = budgetedDatabase();
    const created = await createCollaborationProject(
      creationBudget.db,
      env.VAULT_STORAGE,
      projectRequest(
        vaultId,
        notes.map((note) => ({
          excerptByteRange: null,
          path: note.path,
          vaultId,
        })),
      ),
      NOW + 1,
      crypto.randomUUID(),
    );
    expect(created.packet.sourceCitations).toHaveLength(64);
    expect(creationBudget.metrics).toMatchObject({
      maxBoundParameters: expect.any(Number),
      maxConcurrentOperations: expect.any(Number),
    });
    expect(creationBudget.metrics.statementCount).toBeLessThanOrEqual(20);
    expect(creationBudget.metrics.maxBoundParameters).toBeLessThanOrEqual(100);
    expect(creationBudget.metrics.maxConcurrentOperations).toBeLessThanOrEqual(
      6,
    );

    const selected = await Promise.all(
      Array.from({ length: 64 }, async (_, index) => ({
        bodyObjectKey: `tests/d1-budget/${index}.json`,
        contentSha256: await sha256Hex(`selected-${index}`),
        id: crypto.randomUUID(),
        portableObjectId: crypto.randomUUID(),
        receivedAt: NOW + 2 + index,
      })),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO collaboration_records (
            id, record_type, schema_version, project_id, work_item_id,
            portable_object_id, body_object_key, content_sha256,
            byte_length, received_at
          )
          SELECT
            json_extract(item.value, '$.id'), 'decision', 1, ?, ?,
            json_extract(item.value, '$.portableObjectId'),
            json_extract(item.value, '$.bodyObjectKey'),
            json_extract(item.value, '$.contentSha256'), 0,
            json_extract(item.value, '$.receivedAt')
          FROM json_each(?) AS item`,
      ).bind(created.projectId, created.workItemId, JSON.stringify(selected)),
      env.DB.prepare(
        `INSERT INTO collaboration_record_states (
            record_id, visibility, disposition, changed_at
          )
          SELECT json_extract(item.value, '$.id'),
            'owner-only', 'accepted',
            json_extract(item.value, '$.receivedAt')
          FROM json_each(?) AS item`,
      ).bind(JSON.stringify(selected)),
    ]);
    await publishEvidenceGeneration(vaultId, {
      notes: notes.map((note, index) => ({
        content: `# Budget source ${index}\nRefreshed evidence ${index}.`,
        path: note.path,
      })),
      now: NOW + 100,
      stateVectorSha256: "c".repeat(64),
    });

    const continuationBudget = budgetedDatabase();
    const successor = await createContinuationWorkPacket(
      continuationBudget.db,
      env.VAULT_STORAGE,
      created.projectId,
      {
        packetExpiresInSeconds: 600,
        workItemId: created.workItemId,
      },
      NOW + 101,
    );
    expect(successor.sourceCitations).toHaveLength(64);
    expect(successor.includedRecords).toHaveLength(64);
    expect(continuationBudget.metrics.statementCount).toBeLessThanOrEqual(25);
    expect(continuationBudget.metrics.maxBoundParameters).toBeLessThanOrEqual(
      100,
    );
    expect(
      continuationBudget.metrics.maxConcurrentOperations,
    ).toBeLessThanOrEqual(6);
    const persisted = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM collaboration_dependencies
         WHERE record_id = ?) AS dependency_count,
        (SELECT COUNT(*) FROM collaboration_record_content
         WHERE record_id = ?) AS content_count`,
    )
      .bind(successor.packetId, successor.packetId)
      .first<{ content_count: number; dependency_count: number }>();
    expect(persisted).toEqual({
      content_count: 64,
      dependency_count: 134,
    });
  }, 30_000);

  it("fails closed for an existing Project packet whose restored evidence was not approved", async () => {
    const fixture = await createFixture();
    const sourceContent = "# Recovered\nlegacy project evidence";
    await env.DB.prepare(
      `UPDATE vault_sync_states
       SET current_state_vector_sha256 = ?, library_stale = 1,
         last_sync_at = ?, updated_at = ?
       WHERE vault_id = ?`,
    )
      .bind("c".repeat(64), NOW + 1, NOW + 1, fixture.vaultId)
      .run();
    const generation = await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now: NOW + 1,
      requestId: crypto.randomUUID(),
      snapshot: {
        notes: [
          {
            byteLength: encoder.encode(sourceContent).byteLength,
            content: sourceContent,
            fileId: "restored-project-note",
            modifiedAt: NOW,
            path: "Projects/Recovered.md",
            pathKey: "projects/recovered.md",
            title: "Recovered",
          },
        ],
        schemaVersion: 3,
        totalBytes: encoder.encode(sourceContent).byteLength,
      },
      sourceStateVectorSha256: "c".repeat(64),
      vaultId: fixture.vaultId,
    });
    const restoredProjectRequest = projectRequest(fixture.vaultId, [
      {
        excerptByteRange: null,
        path: "Projects/Recovered.md",
        vaultId: fixture.vaultId,
      },
    ]);
    restoredProjectRequest.project.label = "Recovered evidence Project";
    const restoredProject = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      restoredProjectRequest,
      NOW + 2,
      crypto.randomUUID(),
    );
    const source = await env.DB.prepare(
      `SELECT source_agent_grant_id
       FROM collaboration_grants WHERE id = ?`,
    )
      .bind(fixture.grantId)
      .first<{ source_agent_grant_id: string }>();
    expect(source).not.toBeNull();
    const project = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(restoredProject.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    expect(project).not.toBeNull();
    const collaborationGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      expiresAt: NOW + 10_000,
      issuedAt: NOW + 2,
      knowledgeSpaceVersionId: project!.active_knowledge_space_version_id,
      projectId: restoredProject.projectId,
      scopes: ["project.read"],
      source: {
        agentGrantId: source!.source_agent_grant_id,
        clientName: "Agent A client",
        clientOrigin: "https://client.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: collaborationGrantId,
        now: NOW + 2,
      }),
    ).toBe(true);
    const restoreId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO restore_jobs (
          id, target_vault_id, source_backup_id, source_vault_id,
          source_vault_name, source_generation_id, status,
          expected_note_count, expected_bytes, uploaded_note_count,
          uploaded_bytes, applied_note_count, created_at, updated_at,
          expires_at, confirmed_at, applied_at, verified_generation_id
        ) VALUES (?, ?, ?, ?, 'Revoked recovery source', ?, 'applied',
          1, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        restoreId,
        fixture.vaultId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        encoder.encode(sourceContent).byteLength,
        encoder.encode(sourceContent).byteLength,
        NOW,
        NOW + 2,
        NOW + 3_600,
        NOW + 1,
        NOW + 2,
        generation.generationId,
      ),
      env.DB.prepare(
        `INSERT INTO restored_note_lineage (
          restore_id, target_vault_id, path_key, recorded_at
        ) VALUES (?, ?, 'projects/recovered.md', ?)`,
      ).bind(restoreId, fixture.vaultId, NOW + 2),
    ]);
    const authorization: CollaborationAuthorizationContext = {
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      grantId: collaborationGrantId,
      tokenScopes: ["project.read"],
    };
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 3,
        packetId: restoredProject.packet.packetId,
        projectId: restoredProject.projectId,
      }),
    ).rejects.toMatchObject({ code: "collaboration_grant_revoked" });

    await env.DB.prepare(
      `INSERT INTO agent_grant_restore_sources (
        grant_id, restore_id, approved_at
      ) VALUES (?, ?, ?)`,
    )
      .bind(source!.source_agent_grant_id, restoreId, NOW + 3)
      .run();
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 4,
        packetId: restoredProject.packet.packetId,
        projectId: restoredProject.projectId,
      }),
    ).resolves.toMatchObject({
      packetId: restoredProject.packet.packetId,
    });
  });

  it("attributes records to the exact historical grant after the same client reauthorizes", async () => {
    const fixture = await createFixture();
    const firstAttempt = await submitAttempt(fixture);
    const project = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (project === null) throw new Error("Project missing.");
    const secondSourceAgentGrantId = await createActiveSourceAgentGrant(
      fixture.vaultId,
      {
        clientId: CLIENT_ID,
        clientName: "Agent A reauthorized",
        clientOrigin: "https://client.example",
        now: NOW + 2,
      },
    );
    const secondGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      expiresAt: NOW + 20_000,
      issuedAt: NOW + 2,
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      projectId: fixture.projectId,
      scopes: [
        "project.read",
        "collaboration.submit",
        "review.submit",
        "proposal.status",
      ],
      source: {
        agentGrantId: secondSourceAgentGrantId,
        clientName: "Agent A reauthorized",
        clientOrigin: "https://client.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: secondGrantId,
        now: NOW + 2,
      }),
    ).toBe(true);
    const secondFixture: ProjectFixture = {
      ...fixture,
      authorization: {
        ...fixture.authorization,
        grantId: secondGrantId,
      },
      grantId: secondGrantId,
    };
    const secondAttempt = await submitAttempt(secondFixture, {
      authorization: secondFixture.authorization,
      clientId: CLIENT_ID,
      grantId: secondGrantId,
    });

    const dashboard = await getCollaborationDashboard(
      env.DB,
      env.VAULT_STORAGE,
    );
    const firstParticipant = dashboard.participants.find(
      (participant) => participant.grantId === fixture.grantId,
    );
    const secondParticipant = dashboard.participants.find(
      (participant) => participant.grantId === secondGrantId,
    );
    expect(firstParticipant?.attemptCount).toBe(1);
    expect(secondParticipant?.attemptCount).toBe(1);
    expect(
      dashboard.timeline.find(
        (item) => item.recordId === firstAttempt.receipt.recordId,
      )?.producerLabel,
    ).toBe("Agent A client");
    expect(
      dashboard.timeline.find(
        (item) => item.recordId === secondAttempt.receipt.recordId,
      )?.producerLabel,
    ).toBe("Agent A reauthorized");
  });

  it("crosses the real Agent A/owner/Agent B boundary and carries the Decision into a later packet", async () => {
    const fixture = await createFixture();
    const authorizedPacket = await getAuthorizedWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: fixture.authorization,
        now: NOW + 1,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      },
    );
    expect(authorizedPacket.integrity.digest).toMatch(/^[0-9a-f]{64}$/u);

    const attempt = await submitAttempt(fixture);
    const artifact = await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "# Result\nBounded and portable.",
    );
    const handoffSubmission = await signedSubmission(fixture, {
      idempotencyKey: `handoff-${crypto.randomUUID()}`,
      participantRefId: attempt.participantRefId,
      record: {
        artifactIds: [artifact.artifactId],
        attemptId: attempt.attemptId,
        completed: ["Produced one bounded Artifact."],
        evidenceCitationIds: [],
        handoffId: crypto.randomUUID(),
        projectId: fixture.projectId,
        recordType: "handoff",
        risks: [],
        schemaVersion: 1,
        suggestedNextActions: ["Owner review."],
        summary: "The walking-skeleton Artifact is ready for owner review.",
        supersedesRecordId: null,
        unresolvedQuestions: [],
        workItemId: fixture.workItemId,
        workPacketId: fixture.packet.packetId,
      },
    });
    const handoff = await submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
      authorization: fixture.authorization,
      now: NOW + 3,
      rawSubmission: handoffSubmission,
    });
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "share",
        reason: "Owner explicitly shared the Artifact for independent review.",
        recordId: artifact.artifactId,
      },
      NOW + 4,
    );
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "share",
        reason: "Owner explicitly shared the Handoff with the Project.",
        recordId: handoff.recordId,
      },
      NOW + 4,
    );
    const reviewPacket = await createContinuationWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        packetExpiresInSeconds: 600,
        workItemId: fixture.workItemId,
      },
      NOW + 5,
    );
    expect(reviewPacket.includedRecords).toContainEqual(
      expect.objectContaining({
        includedAs: "shared-handoff",
        recordId: handoff.recordId,
        visibilityAtAssembly: "shared",
      }),
    );

    const reviewerClient = "https://independent-reviewer.example/client.json";
    const reviewerSourceAgentGrantId = await createActiveSourceAgentGrant(
      fixture.vaultId,
      {
        clientId: reviewerClient,
        clientName: "Agent B reviewer",
        clientOrigin: "https://independent-reviewer.example",
        now: NOW + 5,
      },
    );
    const reviewerGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: reviewerClient,
      expiresAt: NOW + 10_000,
      issuedAt: NOW + 5,
      knowledgeSpaceVersionId: fixture.packet.knowledgeSpaceVersionId,
      projectId: fixture.projectId,
      scopes: ["project.read", "collaboration.submit", "review.submit"],
      source: {
        agentGrantId: reviewerSourceAgentGrantId,
        clientName: "Agent B reviewer",
        clientOrigin: "https://independent-reviewer.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: reviewerGrantId,
        now: NOW + 5,
      }),
    ).toBe(true);
    const reviewerAuthorization: CollaborationAuthorizationContext = {
      audience: AUDIENCE,
      clientId: reviewerClient,
      grantId: reviewerGrantId,
      tokenScopes: ["project.read", "collaboration.submit", "review.submit"],
    };
    const reviewerPacket = await getCurrentAuthorizedWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: reviewerAuthorization,
        now: NOW + 6,
        projectId: fixture.projectId,
      },
    );
    expect(reviewerPacket.packetId).toBe(reviewPacket.packetId);
    const shared = await getLatestSharedHandoff(env.DB, env.VAULT_STORAGE, {
      authorization: reviewerAuthorization,
      now: NOW + 6,
      projectId: fixture.projectId,
    });
    expect(shared.handoff.handoffId).toBe(handoff.recordId);
    expect(shared.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({ artifactId: artifact.artifactId }),
        body: "# Result\nBounded and portable.",
        visibility: "shared",
      }),
    ]);
    expect(shared.unavailableArtifactIds).toEqual([]);

    const reviewerFixture: ProjectFixture = {
      ...fixture,
      authorization: reviewerAuthorization,
      grantId: reviewerGrantId,
      packet: reviewerPacket,
    };
    const reviewerAttempt = await submitAttempt(reviewerFixture, {
      authorization: reviewerAuthorization,
      clientId: reviewerClient,
      grantId: reviewerGrantId,
    });
    const reviewSubmission = await signedSubmission(reviewerFixture, {
      clientId: reviewerClient,
      grantId: reviewerGrantId,
      idempotencyKey: `review-${crypto.randomUUID()}`,
      participantRefId: reviewerAttempt.participantRefId,
      record: {
        artifactIds: [artifact.artifactId],
        attemptId: reviewerAttempt.attemptId,
        findings: [
          {
            artifactIds: [artifact.artifactId],
            evidenceCitationIds: [],
            findingId: crypto.randomUUID(),
            severity: "info",
            summary: "The shared Artifact matches the bounded Handoff.",
          },
        ],
        projectId: fixture.projectId,
        recordType: "review",
        reviewId: crypto.randomUUID(),
        schemaVersion: 1,
        supersedesRecordId: null,
        verdict: "pass",
        verdictAuthority: "producer-claim",
        workItemId: fixture.workItemId,
        workPacketId: reviewerPacket.packetId,
      },
    });
    const review = await submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
      authorization: reviewerAuthorization,
      now: NOW + 7,
      rawSubmission: reviewSubmission,
    });
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "share",
        reason: "Owner shared Agent B's Review with this Project.",
        recordId: review.recordId,
      },
      NOW + 8,
    );
    const decision = await createOwnerDecision(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        inputRecordIds: [handoff.recordId, review.recordId],
        rationale:
          "The owner considered Agent A's Handoff and Agent B's independent Review.",
        resolution: "accepted",
        workItemId: fixture.workItemId,
      },
      NOW + 9,
    );
    const laterPacket = await createContinuationWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        packetExpiresInSeconds: 600,
        workItemId: fixture.workItemId,
      },
      NOW + 10,
    );
    expect(laterPacket.includedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          includedAs: "accepted-decision",
          recordId: decision.decisionId,
          visibilityAtAssembly: "accepted",
        }),
        expect.objectContaining({
          includedAs: "shared-handoff",
          recordId: handoff.recordId,
        }),
        expect.objectContaining({
          includedAs: "shared-review",
          recordId: review.recordId,
        }),
      ]),
    );

    const dashboard = await getCollaborationDashboard(
      env.DB,
      env.VAULT_STORAGE,
    );
    expect(dashboard.projects).toHaveLength(1);
    expect(dashboard.participants).toHaveLength(2);
    expect(
      dashboard.participants.map((value) => value.authorizationClientName),
    ).toEqual(expect.arrayContaining(["Agent A client", "Agent B reviewer"]));
    expect(
      dashboard.participants.flatMap((value) => value.claimedIdentityLabels),
    ).toEqual([]);
    const lazyClaims = (
      await Promise.all(
        dashboard.participants.map((participant) =>
          readCollaborationParticipantClaims(
            env.DB,
            env.VAULT_STORAGE,
            participant.grantId,
          ),
        ),
      )
    ).flatMap((labels) => labels ?? []);
    expect(lazyClaims).toEqual(
      expect.arrayContaining(["Synthetic Harness", "Synthetic Model"]),
    );
    expect(dashboard.contributionStatistics.reviewCount).toBe(1);
    expect(dashboard.contributionStatistics.decisionCount).toBe(1);
    expect(
      dashboard.timeline.some((item) => item.recordType === "decision"),
    ).toBe(true);
    expect(dashboard.inbox.map((item) => item.recordId)).toContain(
      artifact.artifactId,
    );

    const portable = await buildPortableWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      fixture.packet.packetId,
    );
    expect(portable.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "README.md",
        "packet.json",
        "submission/artifact.md",
        "submission/attempt.md",
        "submission/handoff.md",
        "submission/review.md",
        "submission/submission.json",
      ]),
    );
    const laterPortable = await buildPortableWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      laterPacket.packetId,
    );
    const packetJson = laterPortable.files.find(
      (file) => file.path === "packet.json",
    )?.text;
    expect(packetJson).toContain(decision.decisionId);
    expect(packetJson).toContain(review.recordId);

    const writes: Array<{ content: string; path: string }> = [];
    const projected = await projectDecisionToNotebook(
      env.DB,
      env.VAULT_STORAGE,
      {
        async create(input) {
          writes.push({ content: input.content, path: input.path });
          return { contentVersion: await sha256Hex(input.content), ok: true };
        },
      },
      {
        now: NOW + 11,
        projectId: fixture.projectId,
        rawRequest: {
          folder: { path: "OWD Projects", pathKey: "owd projects" },
          vaultId: fixture.vaultId,
        },
        recordId: decision.decisionId,
        requestId: crypto.randomUUID(),
      },
    );
    expect(projected.path).toContain(`/Decisions/${decision.decisionId}.md`);
    expect(writes[0]?.content).toContain("owd_projection: true");
    expect(writes[0]?.content).toContain(decision.decisionId);

    await projectDecisionToNotebook(
      env.DB,
      env.VAULT_STORAGE,
      {
        async create() {
          throw new Error("The idempotent projection must not write again.");
        },
      },
      {
        now: NOW + 12,
        projectId: fixture.projectId,
        rawRequest: {
          folder: { path: "OWD Projects", pathKey: "owd projects" },
          vaultId: fixture.vaultId,
        },
        recordId: decision.decisionId,
        requestId: crypto.randomUUID(),
      },
    );
  });

  it("fails closed for scope, project, packet, integrity, visibility, idempotency, revocation, and projection loops", async () => {
    const fixture = await createFixture();
    const missingScope = {
      ...fixture.authorization,
      tokenScopes: ["project.read"],
    };
    await expect(
      submitAttempt(fixture, { authorization: missingScope }),
    ).rejects.toMatchObject({ code: "collaboration_scope_required" });

    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 1,
        rawSubmission: {},
      }),
    ).rejects.toMatchObject({ code: "submission_invalid" });

    const expired = await createFixture(
      "https://expired.example/client.json",
      NOW - 20_000,
    );
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: expired.authorization,
        now: NOW,
        packetId: expired.packet.packetId,
        projectId: expired.projectId,
      }),
    ).rejects.toMatchObject({ code: "collaboration_grant_revoked" });

    const crossProject = await createFixture(
      "https://cross-project.example/client.json",
    );
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: crossProject.authorization,
        now: NOW + 1,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).rejects.toMatchObject({ code: "project_reference_invalid" });

    const sameClientProject = await createFixture(CLIENT_ID);
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 1,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).resolves.toMatchObject({ packetId: fixture.packet.packetId });
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: sameClientProject.authorization,
        now: NOW + 1,
        packetId: sameClientProject.packet.packetId,
        projectId: sameClientProject.projectId,
      }),
    ).resolves.toMatchObject({
      packetId: sameClientProject.packet.packetId,
    });

    const sourceContent = "trusted evidence";
    await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now: NOW + 1,
      requestId: crypto.randomUUID(),
      snapshot: {
        notes: [
          {
            byteLength: encoder.encode(sourceContent).byteLength,
            content: sourceContent,
            fileId: "evidence-note",
            modifiedAt: NOW,
            path: "Sources/Brief.md",
            pathKey: "sources/brief.md",
            title: "Brief",
          },
        ],
        schemaVersion: 3,
        totalBytes: encoder.encode(sourceContent).byteLength,
      },
      sourceStateVectorSha256: "b".repeat(64),
      vaultId: fixture.vaultId,
    });
    const sourceObject = await env.DB.prepare(
      `SELECT notes.r2_key, notes.content_sha256, notes.byte_length
       FROM current_materializations AS current
       JOIN materialized_notes AS notes
         ON notes.generation_id = current.generation_id
       WHERE current.vault_id = ? AND notes.path_key = ?`,
    )
      .bind(fixture.vaultId, "sources/brief.md")
      .first<{
        byte_length: number;
        content_sha256: string;
        r2_key: string;
      }>();
    if (sourceObject === null) throw new Error("Evidence object missing.");
    const tamperedBytes = encoder.encode("x".repeat(sourceObject.byte_length));
    const tamperedDigest = await crypto.subtle.digest("SHA-256", tamperedBytes);
    await env.VAULT_STORAGE.put(sourceObject.r2_key, tamperedBytes, {
      customMetadata: { sha256: sourceObject.content_sha256 },
      sha256: tamperedDigest,
    });
    const evidenceRequest = projectRequest(fixture.vaultId, [
      {
        excerptByteRange: null,
        path: "Sources/Brief.md",
        vaultId: fixture.vaultId,
      },
    ]);
    await expect(
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        evidenceRequest,
        NOW + 2,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "evidence_unavailable" });
    await env.VAULT_STORAGE.delete(sourceObject.r2_key);
    await expect(
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        evidenceRequest,
        NOW + 2,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "evidence_unavailable" });

    await env.DB.prepare(
      `UPDATE collaboration_projects
       SET active_knowledge_space_version_id = ? WHERE project_id = ?`,
    )
      .bind(crossProject.packet.knowledgeSpaceVersionId, fixture.projectId)
      .run();
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 1,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).rejects.toMatchObject({ code: "knowledge_space_version_mismatch" });
    await env.DB.prepare(
      `UPDATE collaboration_projects
       SET active_knowledge_space_version_id = ? WHERE project_id = ?`,
    )
      .bind(fixture.packet.knowledgeSpaceVersionId, fixture.projectId)
      .run();

    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 1,
        packetId: fixture.packet.packetId,
        projectId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "project_reference_invalid" });

    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 601,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).rejects.toMatchObject({ code: "work_packet_stale" });

    const attempt = await submitAttempt(fixture);
    const retry = await submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
      authorization: fixture.authorization,
      now: NOW + 2,
      rawSubmission: attempt.submission,
    });
    expect(retry).toEqual(attempt.receipt);

    const replayClient = "https://replay.example/client.json";
    const replaySourceAgentGrantId = await createActiveSourceAgentGrant(
      fixture.vaultId,
      {
        clientId: replayClient,
        clientName: "Replay test client",
        clientOrigin: "https://replay.example",
        now: NOW,
      },
    );
    const replayGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: replayClient,
      expiresAt: NOW + 10_000,
      issuedAt: NOW,
      knowledgeSpaceVersionId: fixture.packet.knowledgeSpaceVersionId,
      projectId: fixture.projectId,
      scopes: ["project.read", "collaboration.submit"],
      source: {
        agentGrantId: replaySourceAgentGrantId,
        clientName: "Replay test client",
        clientOrigin: "https://replay.example",
      },
    });
    await activateCollaborationGrant(env.DB, {
      grantId: replayGrantId,
      now: NOW,
    });
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: {
          audience: AUDIENCE,
          clientId: replayClient,
          grantId: replayGrantId,
          tokenScopes: ["project.read", "collaboration.submit"],
        },
        now: NOW + 2,
        rawSubmission: attempt.submission,
      }),
    ).rejects.toMatchObject({ code: "submission_replay_denied" });

    const conflicting = await signedSubmission(fixture, {
      idempotencyKey: attempt.submission.idempotencyKey,
      participantRefId: attempt.participantRefId,
      record: {
        ...(attempt.submission.record as Extract<
          CollaborationSubmission["record"],
          { recordType: "attempt" }
        >),
        attemptId: crypto.randomUUID(),
      },
    });
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 2,
        rawSubmission: conflicting,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const altered = structuredClone(attempt.submission);
    if (altered.record.recordType === "attempt") {
      altered.record.claimedStartedAt = NOW + 9;
    }
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 2,
        rawSubmission: altered,
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });

    const artifact = await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "private",
    );
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        artifactBody: "x".repeat(1024 * 1024 + 1),
        authorization: fixture.authorization,
        now: NOW + 3,
        rawSubmission: artifact.submission,
      }),
    ).rejects.toMatchObject({ code: "submission_too_large" });
    const unknownFieldSubmission = {
      ...attempt.submission,
      unexpectedAuthority: "owner",
    };
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 3,
        rawSubmission: unknownFieldSubmission,
      }),
    ).rejects.toMatchObject({ code: "submission_invalid" });
    const reviewerClient = "https://reviewer.example/client.json";
    const project = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (project === null) throw new Error("Project missing.");
    const reviewerSourceAgentGrantId = await createActiveSourceAgentGrant(
      fixture.vaultId,
      {
        clientId: reviewerClient,
        clientName: "Reviewer test client",
        clientOrigin: "https://reviewer.example",
        now: NOW,
      },
    );
    const reviewerGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: reviewerClient,
      expiresAt: NOW + 10_000,
      issuedAt: NOW,
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      projectId: fixture.projectId,
      scopes: ["project.read", "collaboration.submit", "review.submit"],
      source: {
        agentGrantId: reviewerSourceAgentGrantId,
        clientName: "Reviewer test client",
        clientOrigin: "https://reviewer.example",
      },
    });
    await activateCollaborationGrant(env.DB, {
      grantId: reviewerGrantId,
      now: NOW,
    });
    const reviewerAuthorization = {
      audience: AUDIENCE,
      clientId: reviewerClient,
      grantId: reviewerGrantId,
      tokenScopes: ["project.read", "collaboration.submit", "review.submit"],
    };
    const reviewerAttempt = await submitAttempt(fixture, {
      authorization: reviewerAuthorization,
      clientId: reviewerClient,
      grantId: reviewerGrantId,
    });
    const review = await signedSubmission(fixture, {
      clientId: reviewerClient,
      grantId: reviewerGrantId,
      idempotencyKey: `review-${crypto.randomUUID()}`,
      participantRefId: reviewerAttempt.participantRefId,
      record: {
        artifactIds: [artifact.artifactId],
        attemptId: reviewerAttempt.attemptId,
        findings: [],
        projectId: fixture.projectId,
        recordType: "review",
        reviewId: crypto.randomUUID(),
        schemaVersion: 1,
        supersedesRecordId: null,
        verdict: "inconclusive",
        verdictAuthority: "producer-claim",
        workItemId: fixture.workItemId,
        workPacketId: fixture.packet.packetId,
      },
    });
    await expect(
      submitCollaborationRecord(env.DB, env.VAULT_STORAGE, {
        authorization: reviewerAuthorization,
        now: NOW + 4,
        rawSubmission: review,
      }),
    ).rejects.toMatchObject({ code: "artifact_not_visible" });

    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "accept",
        reason: "Accepted only to exercise projection loop protection.",
        recordId: artifact.artifactId,
      },
      NOW + 5,
    );
    const decision = await createOwnerDecision(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        inputRecordIds: [artifact.artifactId],
        rationale: "Projection loop protection fixture.",
        resolution: "accepted",
        workItemId: fixture.workItemId,
      },
      NOW + 5,
    );
    await expect(
      projectDecisionToNotebook(
        env.DB,
        env.VAULT_STORAGE,
        {
          async create() {
            return { contentVersion: "a".repeat(64), ok: true };
          },
        },
        {
          now: NOW + 5,
          projectId: fixture.projectId,
          rawRequest: {
            folder: { path: "Included", pathKey: "included" },
            vaultId: fixture.vaultId,
          },
          recordId: decision.decisionId,
          requestId: crypto.randomUUID(),
        },
      ),
    ).rejects.toMatchObject({ code: "projection_origin_loop" });

    await revokeCollaborationGrant(env.DB, {
      grantId: fixture.grantId,
      now: NOW + 6,
    });
    expect(
      (await listCollaborationConnections(env.DB)).find(
        (connection) => connection.grantId === fixture.grantId,
      ),
    ).toMatchObject({
      projectId: fixture.projectId,
      status: "revoked",
    });
    await expect(
      getAuthorizedWorkPacket(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 7,
        packetId: fixture.packet.packetId,
        projectId: fixture.projectId,
      }),
    ).rejects.toMatchObject({ code: "collaboration_grant_revoked" });
  });

  it("round-trips Approved and Unvetted intelligence into a fresh quarantined ledger without authority", async () => {
    const fixture = await createFixture();
    const attempt = await submitAttempt(fixture);
    const acceptedArtifact = await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "accepted body",
    );
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "accept",
        reason: "Accepted for snapshot coverage.",
        recordId: acceptedArtifact.artifactId,
      },
      NOW + 3,
    );
    const unvettedArtifact = await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "unvetted body",
    );

    const approved = await estimateCollaborationSnapshot(env.DB, "approved");
    const full = await estimateCollaborationSnapshot(
      env.DB,
      "approved-and-unvetted",
    );
    expect(approved.approved?.recordCount).toBeGreaterThan(0);
    expect(approved.unvetted).toBeNull();
    expect(full.unvetted?.recordCount).toBeGreaterThan(0);

    const snapshotId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO workspace_snapshots (
        id, portable_snapshot_id, format_version, origin, scope, status,
        recipient_fingerprint, capture_started_at, vault_count, item_count,
        logical_bytes, included_sections, unavailable_sections,
        manifest_portable_object_id, created_at
      ) VALUES (?, ?, 'owd-snapshot-v2', 'created', 'all-active', 'creating',
        ?, ?, 1, 0, 0, '["notes"]', '[]', ?, ?)`,
    )
      .bind(
        snapshotId,
        crypto.randomUUID(),
        "a".repeat(64),
        NOW,
        crypto.randomUUID(),
        NOW,
      )
      .run();
    await stageCollaborationSnapshot(env.DB, {
      now: NOW,
      selection: "approved-and-unvetted",
      snapshotId,
    });
    await env.DB.prepare(
      `UPDATE snapshot_intelligence_items SET status = 'ready'
       WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .run();
    const manifest = await buildCollaborationSnapshotManifest(
      env.DB,
      snapshotId,
    );
    expect(manifest.selection).toBe("approved-and-unvetted");

    const sourceRows = await env.DB.prepare(
      `SELECT portable_object_id, source_object_key
       FROM snapshot_intelligence_items WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .all<{ portable_object_id: string; source_object_key: string }>();
    const bodies = new Map<string, Uint8Array>();
    for (const row of sourceRows.results) {
      const object = await env.VAULT_STORAGE.get(row.source_object_key);
      if (object === null) throw new Error("Snapshot source missing.");
      bodies.set(
        row.portable_object_id,
        new Uint8Array(await object.arrayBuffer()),
      );
    }

    await env.DB.exec(`
      DELETE FROM collaboration_submission_receipts;
      DELETE FROM collaboration_grant_clients;
      DELETE FROM collaboration_grants;
      DELETE FROM project_creation_requests;
      DELETE FROM project_creation_commits;
      DELETE FROM project_creation_reservations;
      DELETE FROM project_initialization_projects;
      DELETE FROM vault_local_writer_assignments;
      DELETE FROM project_initialization_requests;
      DELETE FROM collaboration_notebook_projections;
      DELETE FROM collaboration_provenance_edges;
      DELETE FROM collaboration_owner_events;
      DELETE FROM collaboration_dependencies;
      DELETE FROM collaboration_record_content;
      DELETE FROM collaboration_record_states;
      DELETE FROM collaboration_work_items;
      DELETE FROM collaboration_projects;
      DELETE FROM collaboration_content_objects;
      DELETE FROM collaboration_records;
    `);
    let job = await createCollaborationRestore(env.DB, { manifest }, NOW + 10);
    for (const item of [
      ...(manifest.approved?.records ?? []),
      ...(manifest.approved?.evidenceObjects ?? []),
      ...(manifest.unvetted?.records ?? []),
      ...(manifest.unvetted?.evidenceObjects ?? []),
    ]) {
      const bytes = bodies.get(item.portableObjectId);
      if (bytes === undefined) throw new Error("Restore body missing.");
      job = await stageCollaborationRestoreItem(
        env.DB,
        env.VAULT_STORAGE,
        job.restoreId,
        {
          bytesBase64Url: encodeBase64Url(bytes),
          portableObjectId: item.portableObjectId,
        },
      );
    }
    expect(job.status).toBe("preview");
    const restored = await applyCollaborationRestore(
      env.DB,
      env.VAULT_STORAGE,
      job.restoreId,
      NOW + 11,
    );
    expect(restored).toMatchObject({
      grantCount: 0,
      status: "applied",
    });
    expect(
      await env.DB.prepare(
        `SELECT vault_id, project_label_key, creation_payload_sha256,
          project_id, work_item_id, packet_id
         FROM project_creation_commits
         WHERE project_id = ?`,
      )
        .bind(fixture.projectId)
        .first(),
    ).toEqual({
      creation_payload_sha256: null,
      packet_id: fixture.packet.packetId,
      project_id: fixture.projectId,
      project_label_key: "walking skeleton",
      vault_id: fixture.vaultId,
      work_item_id: fixture.workItemId,
    });
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM collaboration_grants`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT s.visibility, s.disposition
         FROM collaboration_record_states s WHERE s.record_id = ?`,
      )
        .bind(unvettedArtifact.artifactId)
        .first(),
    ).toEqual({ disposition: "quarantined", visibility: "owner-only" });
    expect(
      await env.DB.prepare(
        `SELECT s.visibility, s.disposition
         FROM collaboration_record_states s WHERE s.record_id = ?`,
      )
        .bind(acceptedArtifact.artifactId)
        .first(),
    ).toEqual({ disposition: "accepted", visibility: "owner-only" });
  });

  it("converges a concurrent restore and owner create onto one Project identity", async () => {
    const fixture = await createFixture();
    const snapshotId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO workspace_snapshots (
        id, portable_snapshot_id, format_version, origin, scope, status,
        recipient_fingerprint, capture_started_at, vault_count, item_count,
        logical_bytes, included_sections, unavailable_sections,
        manifest_portable_object_id, created_at
      ) VALUES (?, ?, 'owd-snapshot-v2', 'created', 'all-active', 'creating',
        ?, ?, 1, 0, 0, '["notes"]', '[]', ?, ?)`,
    )
      .bind(
        snapshotId,
        crypto.randomUUID(),
        "c".repeat(64),
        NOW,
        crypto.randomUUID(),
        NOW,
      )
      .run();
    await stageCollaborationSnapshot(env.DB, {
      now: NOW,
      selection: "approved",
      snapshotId,
    });
    await env.DB.prepare(
      `UPDATE snapshot_intelligence_items SET status = 'ready'
       WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .run();
    const manifest = await buildCollaborationSnapshotManifest(
      env.DB,
      snapshotId,
    );
    const sourceRows = await env.DB.prepare(
      `SELECT portable_object_id, source_object_key
       FROM snapshot_intelligence_items WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .all<{ portable_object_id: string; source_object_key: string }>();
    const bodies = new Map<string, Uint8Array>();
    for (const source of sourceRows.results) {
      const object = await env.VAULT_STORAGE.get(source.source_object_key);
      if (object === null) throw new Error("Snapshot source missing.");
      bodies.set(
        source.portable_object_id,
        new Uint8Array(await object.arrayBuffer()),
      );
    }

    await env.DB.exec(`
      DELETE FROM collaboration_submission_receipts;
      DELETE FROM collaboration_grant_clients;
      DELETE FROM collaboration_grants;
      DELETE FROM project_creation_requests;
      DELETE FROM project_creation_commits;
      DELETE FROM project_creation_reservations;
      DELETE FROM project_initialization_projects;
      DELETE FROM vault_local_writer_assignments;
      DELETE FROM project_initialization_requests;
      DELETE FROM collaboration_notebook_projections;
      DELETE FROM collaboration_provenance_edges;
      DELETE FROM collaboration_owner_events;
      DELETE FROM collaboration_dependencies;
      DELETE FROM collaboration_record_content;
      DELETE FROM collaboration_record_states;
      DELETE FROM collaboration_work_items;
      DELETE FROM collaboration_projects;
      DELETE FROM collaboration_content_objects;
      DELETE FROM collaboration_records;
    `);

    let job = await createCollaborationRestore(env.DB, { manifest }, NOW + 10);
    for (const item of [
      ...(manifest.approved?.records ?? []),
      ...(manifest.approved?.evidenceObjects ?? []),
    ]) {
      const bytes = bodies.get(item.portableObjectId);
      if (bytes === undefined) throw new Error("Restore body missing.");
      job = await stageCollaborationRestoreItem(
        env.DB,
        env.VAULT_STORAGE,
        job.restoreId,
        {
          bytesBase64Url: encodeBase64Url(bytes),
          portableObjectId: item.portableObjectId,
        },
      );
    }
    expect(job.status).toBe("preview");

    const [restoreAttempt, createAttempt] = await Promise.allSettled([
      applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        job.restoreId,
        NOW + 11,
      ),
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        projectRequest(fixture.vaultId),
        NOW + 11,
        crypto.randomUUID(),
      ),
    ]);
    expect(
      [restoreAttempt, createAttempt].filter(
        (attempt) => attempt.status === "fulfilled",
      ),
    ).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM collaboration_projects`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM project_creation_commits
           WHERE vault_id = ? AND project_label_key = 'walking skeleton'`,
        )
          .bind(fixture.vaultId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    if (restoreAttempt.status === "fulfilled") {
      expect(createAttempt).toMatchObject({
        reason: { code: "project_identity_conflict" },
        status: "rejected",
      });
      expect(
        await env.DB.prepare(
          `SELECT project_id FROM collaboration_projects`,
        ).first(),
      ).toEqual({ project_id: fixture.projectId });
    } else {
      expect(restoreAttempt.reason).toMatchObject({
        code: "portable_identity_collision",
      });
      expect(createAttempt.status).toBe("fulfilled");
      expect(
        await env.DB.prepare(
          `SELECT status, failure_code FROM collaboration_restore_jobs
           WHERE id = ?`,
        )
          .bind(job.restoreId)
          .first(),
      ).toEqual({
        failure_code: "portable_identity_collision",
        status: "failed",
      });
    }
  });

  it("encrypts and publishes exact Approved/Unvetted snapshot sections and capabilities", async () => {
    const fixture = await createFixture();
    const attempt = await submitAttempt(fixture);
    const accepted = await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "approved snapshot body",
    );
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        action: "accept",
        reason: "Approved snapshot root.",
        recordId: accepted.artifactId,
      },
      NOW + 3,
    );
    await submitArtifact(
      fixture,
      attempt.attemptId,
      attempt.participantRefId,
      "unvetted snapshot body",
    );
    const generation = await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now: NOW + 4,
      requestId: crypto.randomUUID(),
      snapshot: { notes: [], schemaVersion: 3, totalBytes: 0 },
      sourceStateVectorSha256: "b".repeat(64),
      vaultId: fixture.vaultId,
    });
    const identity = await generateX25519Identity();
    await saveBackupRecipient(env.DB, {
      now: NOW + 4,
      recipient: await identityToRecipient(identity),
      requestId: crypto.randomUUID(),
    });
    let snapshot = await startWorkspaceSnapshot(env.DB, {
      captureStartedAt: NOW + 5,
      intelligenceSelection: "approved-and-unvetted",
      now: NOW + 5,
      requestId: crypto.randomUUID(),
      scope: "all-active",
      sources: [{ generation, vaultName: "Collaboration vault" }],
    });
    for (let step = 0; step < 20 && snapshot.status === "creating"; step += 1) {
      snapshot = await continueWorkspaceSnapshot(env.DB, env.VAULT_STORAGE, {
        now: NOW + 6 + step,
        requestId: crypto.randomUUID(),
        snapshotId: snapshot.snapshotId,
      });
    }
    expect(snapshot.status).toBe("ready");
    expect(snapshot.intelligence.approved?.recordCount).toBeGreaterThan(0);
    expect(snapshot.intelligence.unvetted?.recordCount).toBeGreaterThan(0);
    const portable = await buildPortableSnapshotExport(
      env.DB,
      snapshot.snapshotId,
    );
    expect(portable.index.intelligenceSelection).toBe("approved-and-unvetted");
    expect(portable.index.requiredCapabilities).toEqual(
      expect.arrayContaining([
        "owd.snapshot.approved-intelligence-v1",
        "owd.snapshot.quarantined-intelligence-v1",
      ]),
    );
    const manifestRow = await env.DB.prepare(
      `SELECT manifest_object_key FROM workspace_snapshots WHERE id = ?`,
    )
      .bind(snapshot.snapshotId)
      .first<{ manifest_object_key: string }>();
    const encrypted =
      manifestRow === null
        ? null
        : await env.VAULT_STORAGE.get(manifestRow.manifest_object_key);
    if (encrypted === null) throw new Error("Encrypted manifest missing.");
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await new Response(
          await decrypter.decrypt(encrypted.body),
        ).arrayBuffer(),
      ),
    ) as {
      intelligence?: {
        approved: { records: unknown[] } | null;
        selection: string;
        unvetted: { records: unknown[] } | null;
      };
      requiredCapabilities: string[];
    };
    expect(manifest.intelligence?.selection).toBe("approved-and-unvetted");
    expect(manifest.intelligence?.approved?.records.length).toBeGreaterThan(0);
    expect(manifest.intelligence?.unvetted?.records.length).toBeGreaterThan(0);

    const intelligenceObject = await env.DB.prepare(
      `SELECT item_id, encrypted_object_key
       FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'ready'
       ORDER BY portable_object_id LIMIT 1`,
    )
      .bind(snapshot.snapshotId)
      .first<{ encrypted_object_key: string; item_id: string }>();
    if (intelligenceObject === null) {
      throw new Error("Encrypted intelligence object missing.");
    }
    await env.VAULT_STORAGE.delete(intelligenceObject.encrypted_object_key);
    let repairCursor: string | null = null;
    do {
      const repaired = await repairWorkspaceSnapshot(
        env.DB,
        env.VAULT_STORAGE,
        {
          afterPortableObjectId: repairCursor,
          now: NOW + 30,
          snapshotId: snapshot.snapshotId,
        },
      );
      repairCursor = repaired.nextPortableObjectId;
    } while (repairCursor !== null);
    const repairedObject = await env.DB.prepare(
      `SELECT encrypted_object_key, encrypted_bytes, object_etag, object_version
       FROM snapshot_intelligence_items WHERE snapshot_id = ? AND item_id = ?`,
    )
      .bind(snapshot.snapshotId, intelligenceObject.item_id)
      .first<{
        encrypted_bytes: number;
        encrypted_object_key: string;
        object_etag: string;
        object_version: string;
      }>();
    expect(repairedObject?.encrypted_object_key).not.toBe(
      intelligenceObject.encrypted_object_key,
    );
    const repairedHead =
      repairedObject === null
        ? null
        : await env.VAULT_STORAGE.head(repairedObject.encrypted_object_key);
    expect(repairedHead).toMatchObject({
      etag: repairedObject?.object_etag,
      size: repairedObject?.encrypted_bytes,
      version: repairedObject?.object_version,
    });
  });

  it("converges concurrent automatic packet refreshes to one successor", async () => {
    const fixture = await createFixture();
    const refreshAt = fixture.packet.expiresAt + 1;
    const refreshed = await Promise.all(
      Array.from({ length: 6 }, () =>
        refreshContinuationWorkPacketIfNeeded(env.DB, env.VAULT_STORAGE, {
          now: refreshAt,
          packet: fixture.packet,
          projectId: fixture.projectId,
        }),
      ),
    );
    expect(new Set(refreshed.map((packet) => packet.packetId)).size).toBe(1);
    expect(refreshed[0]?.packetId).not.toBe(fixture.packet.packetId);
    const counts = await env.DB.prepare(
      `SELECT
           (SELECT COUNT(*) FROM collaboration_records
            WHERE project_id = ? AND record_type = 'work-packet')
             AS packet_count,
           (SELECT COUNT(*) FROM collaboration_packet_rotations
            WHERE project_id = ?) AS rotation_count`,
    )
      .bind(fixture.projectId, fixture.projectId)
      .first<{ packet_count: number; rotation_count: number }>();
    expect(counts).toEqual({ packet_count: 2, rotation_count: 1 });
    const queued = await env.DB.prepare(
      `SELECT object_key FROM collaboration_gc_objects ORDER BY object_key`,
    ).all<{ object_key: string }>();
    expect(queued.results.length).toBeGreaterThan(0);
    expect(
      await runCollaborationGarbageCollection(
        env.DB,
        env.VAULT_STORAGE,
        refreshAt + 61,
      ),
    ).toBe(0);
    for (const object of queued.results) {
      expect(await env.VAULT_STORAGE.head(object.object_key)).toBeNull();
    }
  });

  it("keeps the same unexpired packet when an unrelated note changes in a new library generation", async () => {
    const fixture = await createEvidenceFixture();
    await publishEvidenceGeneration(fixture.vaultId, {
      notes: [
        { content: "# Cited\nstable evidence", path: "Sources/Cited.md" },
        { content: "# Other\nsecond version", path: "Sources/Other.md" },
      ],
      now: NOW + 2,
      stateVectorSha256: "c".repeat(64),
    });

    const resumed = await resumeAuthorizedProject(env.DB, env.VAULT_STORAGE, {
      authorization: fixture.authorization,
      contextPolicy: fixtureContextPolicy(fixture),
      now: NOW + 3,
      projectId: fixture.projectId,
    });

    expect(resumed.packet.packetId).toBe(fixture.packet.packetId);
    expect(resumed.packet.sourceCitations).toEqual(
      fixture.packet.sourceCitations,
    );
    const rotation = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM collaboration_packet_rotations WHERE prior_packet_id = ?`,
    )
      .bind(fixture.packet.packetId)
      .first<{ count: number }>();
    expect(rotation?.count).toBe(0);
  });

  it("rotates exactly once when a cited note changes", async () => {
    const fixture = await createEvidenceFixture();
    await publishEvidenceGeneration(fixture.vaultId, {
      notes: [
        { content: "# Cited\nchanged evidence", path: "Sources/Cited.md" },
        { content: "# Other\nfirst version", path: "Sources/Other.md" },
      ],
      now: NOW + 2,
      stateVectorSha256: "c".repeat(64),
    });

    const first = await getCurrentAuthorizedWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: fixture.authorization,
        now: NOW + 3,
        projectId: fixture.projectId,
      },
    );
    const second = await getCurrentAuthorizedWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: fixture.authorization,
        now: NOW + 4,
        projectId: fixture.projectId,
      },
    );

    expect(first.packetId).not.toBe(fixture.packet.packetId);
    expect(second.packetId).toBe(first.packetId);
    expect(first.sourceCitations[0]).toMatchObject({
      sourceContentSha256: await sha256Hex("# Cited\nchanged evidence"),
    });
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM collaboration_records
          WHERE project_id = ? AND record_type = 'work-packet')
           AS packet_count,
         (SELECT COUNT(*) FROM collaboration_packet_rotations
          WHERE prior_packet_id = ?) AS rotation_count`,
    )
      .bind(fixture.projectId, fixture.packet.packetId)
      .first<{ packet_count: number; rotation_count: number }>();
    expect(counts).toEqual({ packet_count: 2, rotation_count: 1 });
  });

  it("rejects submissions against a packet after automatic evidence rotation", async () => {
    const fixture = await createEvidenceFixture();
    await publishEvidenceGeneration(fixture.vaultId, {
      notes: [
        { content: "# Cited\nchanged evidence", path: "Sources/Cited.md" },
        { content: "# Other\nfirst version", path: "Sources/Other.md" },
      ],
      now: NOW + 2,
      stateVectorSha256: "c".repeat(64),
    });
    const successor = await getCurrentAuthorizedWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: fixture.authorization,
        now: NOW + 3,
        projectId: fixture.projectId,
      },
    );
    expect(successor.packetId).not.toBe(fixture.packet.packetId);

    await expect(submitAttempt(fixture)).rejects.toMatchObject({
      code: "work_packet_stale",
    });
  });

  it("resumes the immutable unexpired packet while the current library is transiently unavailable", async () => {
    const fixture = await createEvidenceFixture();
    await env.DB.prepare(
      `UPDATE vault_sync_states
       SET current_state_vector_sha256 = ?, library_stale = 1,
         last_sync_at = ?, updated_at = ?
       WHERE vault_id = ?`,
    )
      .bind("d".repeat(64), NOW + 2, NOW + 2, fixture.vaultId)
      .run();

    const resumed = await resumeAuthorizedProject(env.DB, env.VAULT_STORAGE, {
      authorization: fixture.authorization,
      contextPolicy: fixtureContextPolicy(fixture),
      now: NOW + 3,
      projectId: fixture.projectId,
    });

    expect(resumed.packet.packetId).toBe(fixture.packet.packetId);
    expect(resumed.packet.sourceCitations).toEqual(
      fixture.packet.sourceCitations,
    );
  });

  it("fails closed when an expired packet cannot refresh from current evidence", async () => {
    const fixture = await createEvidenceFixture();
    await env.DB.prepare(
      `UPDATE vault_sync_states
       SET current_state_vector_sha256 = ?, library_stale = 1,
         last_sync_at = ?, updated_at = ?
       WHERE vault_id = ?`,
    )
      .bind("d".repeat(64), NOW + 2, NOW + 2, fixture.vaultId)
      .run();

    await expect(
      resumeAuthorizedProject(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        contextPolicy: fixtureContextPolicy(fixture),
        now: fixture.packet.expiresAt + 1,
        projectId: fixture.projectId,
      }),
    ).rejects.toMatchObject({ code: "evidence_unavailable" });
  });

  it("fails closed when an agent Project grant names a multi-vault Knowledge Space", async () => {
    const sourceVaultId = crypto.randomUUID();
    const supportingVaultId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Primary Project vault', 'active', ?, ?)`,
      ).bind(sourceVaultId, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Supporting Project vault', 'active', ?, ?)`,
      ).bind(supportingVaultId, NOW, NOW),
    ]);
    const sourceAgentGrantId = await createActiveSourceAgentGrant(
      sourceVaultId,
      {
        clientId: CLIENT_ID,
        clientName: "Multi-vault client",
        clientOrigin: "https://client.example",
        now: NOW,
      },
    );
    const created = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        knowledgeSpace: {
          label: "Two bounded vaults",
          members: [
            {
              exclusions: [],
              pathPrefixes: [{ path: "", pathKey: "" }],
              vaultId: sourceVaultId,
            },
            {
              exclusions: [],
              pathPrefixes: [{ path: "docs", pathKey: "docs" }],
              vaultId: supportingVaultId,
            },
          ],
        },
        packetExpiresInSeconds: 600,
        project: {
          label: "Multi-vault Project",
          objective: "Resume through the exact source-vault authorization.",
        },
        requestedRole: "implementer",
        sourceNotes: [],
        workItem: {
          constraints: ["Never collapse a multi-vault Knowledge Space."],
          definitionOfDone: ["Resume the exact Project and packet."],
          objective: "Prove multi-vault Project continuity.",
          requestedOutput: "A bounded handoff.",
        },
      },
      NOW,
      crypto.randomUUID(),
    );
    const projected = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(created.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (projected === null) throw new Error("Project projection missing.");
    const grantId = await createPendingCollaborationGrant(env.DB, {
      audience: AUDIENCE,
      clientId: CLIENT_ID,
      expiresAt: NOW + 10_000,
      issuedAt: NOW,
      knowledgeSpaceVersionId: projected.active_knowledge_space_version_id,
      projectId: created.projectId,
      scopes: ["project.read"],
      source: {
        agentGrantId: sourceAgentGrantId,
        clientName: "Multi-vault client",
        clientOrigin: "https://client.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, { grantId, now: NOW }),
    ).toBe(true);

    await expect(
      resumeAuthorizedProject(env.DB, env.VAULT_STORAGE, {
        authorization: {
          audience: AUDIENCE,
          clientId: CLIENT_ID,
          grantId,
          tokenScopes: ["project.read"],
        },
        contextPolicy: {
          excludePaths: [],
          format: "owd-project-context-v1",
          includePaths: [""],
          projectId: created.projectId,
        },
        now: NOW + 1,
        projectId: created.projectId,
      }),
    ).rejects.toMatchObject({ code: "context_policy_invalid" });
  });
});
