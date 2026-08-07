import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  collaborationSubmissionSchema,
  completeContinuityDrillReceiptSchema,
  completeWorkItemReceiptSchema,
  continuityReceiptSchema,
  continuityPointSchema,
  createWorkItemReceiptSchema,
  evaluateRunPolicyReceiptSchema,
  getPolicyOperationsReceiptSchema,
  registerActorReceiptSchema,
  runContextSchema,
  runSchema,
  startRunReceiptSchema,
  startElasticRunReceiptSchema,
  submitBundleReceiptSchema,
  snapshotIntelligenceManifestSchema,
  workPacketSchema,
  type CollaborationProjectCreateRequest,
  type CollaborationSubmission,
  type CollaborationSubmissionReceipt,
  type ContinuityReceipt,
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
  buildPortableContinuityBundle,
  checkpointProject,
  claimProjectLead,
  renewProjectLead,
  revokeProjectLead,
} from "../src/continuity-service";
import {
  getRunDeltas,
  getElasticOperationOverview,
  projectRunOrcaMetadata,
  recoverRunActor,
  registerRunActorsBatch,
  submitRunBundlesBatch,
  submitRunBudgetEntry,
  submitRunObservation,
} from "../src/elastic-operation-service";
import {
  completeLeadWorkItem,
  createLeadWorkItem,
  getLeadRunContext,
  getLeadOperationOverview,
  listLeadProjectExceptions,
  registerRunActor,
  startLeadRun,
  submitRunBundle,
} from "../src/lead-operation-service";
import {
  insertLeadOperationRecordStatement,
  prepareLeadOperationRecord,
  readLeadOperationRecord,
} from "../src/lead-operation-store";
import {
  activateProjectPolicyBinding,
  buildPortableOperationalExport,
  completeContinuityDrill,
  evaluateRunPolicy,
  getPolicyOperations,
  resolveProjectException,
  runScheduledPolicyOperations,
} from "../src/policy-operation-service";
import {
  insertOperationalDependencyStatement,
  insertPolicyOperationalRecordStatement,
  preparePolicyOperationalRecord,
} from "../src/policy-operation-store";
import {
  queueCollaborationObjectCleanup,
  runCollaborationGarbageCollection,
  runElasticRetention,
  runOperationalRetention,
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
  insertRecordStatement,
  insertStateStatement,
  listCollaborationConnections,
  prepareCollaborationRecord,
  readCollaborationRecord,
  readCollaborationParticipantClaims,
  revokeCollaborationGrant,
  setCollaborationProjectAgentVisibility,
  setCollaborationWorkItemReopened,
} from "../src/collaboration-store";
import { readLatestContinuityPoint } from "../src/continuity-store";
import {
  agentMayUseCurrentMaterializedPaths,
  ensureMaterializationSchema,
  publishMaterialization,
} from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { projectContextSelectorSha256 } from "../src/project-context-policy";
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
  applyContinuityR1Migration,
  applyElasticActorPlaneR3Migration,
  applyHandsOffLeadR2Migration,
  applyPolicyAutopilotR4Migration,
  applyRestoredContentAuthorizationMigration,
  applyVaultPrimaryWriterMigration,
} from "./migration-fixture";

const NOW = Math.floor(Date.now() / 1_000);
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
  await applyContinuityR1Migration(env.DB);
  await applyHandsOffLeadR2Migration(env.DB);
  await applyElasticActorPlaneR3Migration(env.DB);
  await applyPolicyAutopilotR4Migration(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM project_continuity_drill_receipts"),
    env.DB.prepare("DELETE FROM project_operational_integrity_reports"),
    env.DB.prepare("DELETE FROM project_operational_requests"),
    env.DB.prepare("DELETE FROM project_policy_decisions"),
    env.DB.prepare("DELETE FROM project_operational_schedules"),
    env.DB.prepare("DELETE FROM project_policy_bindings"),
    env.DB.prepare("DELETE FROM project_operational_dependencies"),
    env.DB.prepare("DELETE FROM project_operational_records"),
    env.DB.prepare(
      `UPDATE project_operational_job_clock
       SET last_scheduled_time = 0, last_completed_at = 0
       WHERE singleton_id = 1`,
    ),
  ]);
  await env.DB.prepare(`DELETE FROM continuity_checkpoint_receipts`).run();
  await env.DB.prepare(`DELETE FROM continuity_point_dependencies`).run();
  for (;;) {
    const deleted = await env.DB.prepare(
      `DELETE FROM project_continuity_points
         WHERE NOT EXISTS (
           SELECT 1 FROM project_continuity_points child
           WHERE child.project_id = project_continuity_points.project_id
             AND child.previous_continuity_point_id =
               project_continuity_points.continuity_point_id
         )`,
    ).run();
    if (deleted.meta.changes === 0) break;
  }
  await env.DB.prepare(`DELETE FROM project_lead_leases`).run();
  await env.DB.exec(`
    DELETE FROM project_run_deltas;
    DELETE FROM project_orca_projections;
    DELETE FROM project_run_observations;
    DELETE FROM project_run_budget_entries;
    DELETE FROM project_run_budget_versions;
    DELETE FROM project_run_budgets;
    DELETE FROM project_actor_recoveries;
    DELETE FROM project_elastic_actor_slots;
    DELETE FROM project_elastic_accounts;
    DELETE FROM project_elastic_planes;
    DELETE FROM project_elastic_records;
    DELETE FROM project_operation_receipts;
    DELETE FROM project_run_claims;
    DELETE FROM project_exceptions;
    DELETE FROM project_event_bundles;
    DELETE FROM project_actors;
    DELETE FROM project_runs;
    DELETE FROM project_operation_policies;
    DELETE FROM project_operation_records;
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

async function createLeadAuthorization(
  fixture: ProjectFixture,
  input: {
    clientId?: string;
    now?: number;
    reuseFixtureGrant?: boolean;
  } = {},
): Promise<CollaborationAuthorizationContext> {
  const clientId = input.clientId ?? fixture.authorization.clientId;
  const now = input.now ?? NOW;
  const scopes = ["project.read", "project.lead"] as const;
  if (
    input.reuseFixtureGrant !== false &&
    clientId === fixture.authorization.clientId
  ) {
    const grantScopes = [
      "project.read",
      "collaboration.submit",
      "review.submit",
      "proposal.status",
      "project.lead",
    ] as const;
    await env.DB.prepare(
      `UPDATE collaboration_grants SET scopes_json = ? WHERE id = ?`,
    )
      .bind(JSON.stringify(grantScopes), fixture.grantId)
      .run();
    return {
      ...fixture.authorization,
      tokenScopes: [...grantScopes],
    };
  }
  const sourceAgentGrantId = await createActiveSourceAgentGrant(
    fixture.vaultId,
    {
      clientId,
      clientName: "Replacement lead client",
      clientOrigin: new URL(clientId).origin,
      now,
    },
  );
  const project = await env.DB.prepare(
    `SELECT active_knowledge_space_version_id
     FROM collaboration_projects WHERE project_id = ?`,
  )
    .bind(fixture.projectId)
    .first<{ active_knowledge_space_version_id: string }>();
  if (project === null) throw new Error("Project projection missing.");
  const grantId = await createPendingCollaborationGrant(env.DB, {
    audience: AUDIENCE,
    clientId,
    expiresAt: now + 10_000,
    issuedAt: now,
    knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
    projectId: fixture.projectId,
    scopes: [...scopes],
    source: {
      agentGrantId: sourceAgentGrantId,
      clientName: "Replacement lead client",
      clientOrigin: new URL(clientId).origin,
    },
  });
  expect(await activateCollaborationGrant(env.DB, { grantId, now })).toBe(true);
  return {
    audience: AUDIENCE,
    clientId,
    grantId,
    tokenScopes: [...scopes],
  };
}

function leadIdentity(displayName: string) {
  return {
    claimedHarness: null,
    claimedModel: null,
    displayName,
  };
}

function checkpointRequest(
  fixture: ProjectFixture,
  lease: { fencingToken: number; leaseId: string },
  input: Partial<{
    acceptedDecisionIds: string[];
    artifactIds: string[];
    citationIds: string[];
    idempotencyKey: string;
    previousContinuityPointId: string | null;
  }> = {},
) {
  return {
    acceptedDecisionIds: input.acceptedDecisionIds ?? [],
    artifactIds: input.artifactIds ?? [],
    blockers: [],
    citationIds: input.citationIds ?? [],
    completedWork: ["Established the bounded continuity spine."],
    fencingToken: lease.fencingToken,
    idempotencyKey: input.idempotencyKey ?? `checkpoint-${crypto.randomUUID()}`,
    knownRejectedApproaches: ["Restoring live authority from backup."],
    leaseId: lease.leaseId,
    nextAction: "Authorize a replacement lead and resume from this point.",
    openWork: ["Complete the next bounded Project step."],
    packetId: fixture.packet.packetId,
    previousContinuityPointId: input.previousContinuityPointId ?? null,
    projectId: fixture.projectId,
    risks: ["The packet expires and must then be refreshed explicitly."],
    workItemId: fixture.workItemId,
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
    const fixture = await createEvidenceFixture();
    const leadAuthorization = await createLeadAuthorization(fixture);
    const leadLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: leadAuthorization,
      now: NOW,
      request: {
        idempotencyKey: `claim-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Original lead"),
        leaseExpiresInSeconds: 300,
        projectId: fixture.projectId,
      },
    });
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
    const acceptedDecision = await createOwnerDecision(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      {
        inputRecordIds: [acceptedArtifact.artifactId],
        rationale: "Preserve the reviewed decision for replacement continuity.",
        resolution: "accepted",
        workItemId: fixture.workItemId,
      },
      NOW + 4,
    );
    const checkpoint = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: leadAuthorization,
      now: NOW + 5,
      request: checkpointRequest(fixture, leadLease, {
        acceptedDecisionIds: [acceptedDecision.decisionId],
        artifactIds: [acceptedArtifact.artifactId],
      }),
    });
    const recoveryRun = startRunReceiptSchema.parse(
      await startLeadRun(env.DB, env.VAULT_STORAGE, {
        authorization: leadAuthorization,
        now: NOW + 6,
        request: {
          fencingToken: leadLease.fencingToken,
          idempotencyKey: `recovery-run-${crypto.randomUUID()}`,
          leaseId: leadLease.leaseId,
          projectId: fixture.projectId,
          purpose: "research",
          workItemId: fixture.workItemId,
        },
      }),
    );
    await activateProjectPolicyBinding(
      env.DB,
      env.VAULT_STORAGE,
      {
        checkpointIntervalSeconds: 3_600,
        drillIntervalSeconds: 604_800,
        projectId: fixture.projectId,
      },
      NOW + 6,
    );
    const recoveryActors = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (let index = 0; index < recoveryActors.length; index += 1) {
      await registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: leadAuthorization,
        now: NOW + 7 + index,
        request: {
          actorId: recoveryActors[index],
          claimedIdentity: `Recovery actor ${index + 1}`,
          fencingToken: leadLease.fencingToken,
          idempotencyKey: `recovery-actor-${index}-${crypto.randomUUID()}`,
          leaseId: leadLease.leaseId,
          lifetimeSeconds: 120,
          projectId: fixture.projectId,
          runId: recoveryRun.run.runId,
          scopes: index === 2 ? ["run.review.submit"] : ["run.bundle.submit"],
          workItemId: fixture.workItemId,
        },
      });
    }
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: leadAuthorization,
      now: NOW + 10,
      request: {
        bundle: {
          actorId: recoveryActors[0],
          bundleId: crypto.randomUUID(),
          createdAt: NOW + 10,
          events: [
            {
              actorId: recoveryActors[0],
              claims: [],
              eventId: crypto.randomUUID(),
              eventType: "result.provisional",
              runId: recoveryRun.run.runId,
              summary: "Synthetic operation-ledger recovery evidence.",
            },
          ],
          format: "owd-event-bundle-v1",
          normalizedRelativePath: null,
          projectId: fixture.projectId,
          requestedActions: ["destructive-action"],
          runId: recoveryRun.run.runId,
          schemaVersion: 1,
          visibility: "run-shared-unvetted",
        },
        fencingToken: leadLease.fencingToken,
        idempotencyKey: `recovery-bundle-${crypto.randomUUID()}`,
        leaseId: leadLease.leaseId,
        projectId: fixture.projectId,
        runId: recoveryRun.run.runId,
      },
    });
    await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
      authorization: leadAuthorization,
      now: NOW + 10,
      request: {
        fencingToken: leadLease.fencingToken,
        idempotencyKey: `recovery-policy-${crypto.randomUUID()}`,
        leaseId: leadLease.leaseId,
        normalizedRelativePath: null,
        projectId: fixture.projectId,
        requestedOwnerActions: ["destructive-action"],
        runId: recoveryRun.run.runId,
        workItemId: fixture.workItemId,
      },
    });
    await seedContinuityReceipt(
      continuityReceiptSchema.parse({
        authority: {
          actorAuthorityIncluded: false,
          credentialAuthorityIncluded: false,
          grantAuthorityIncluded: false,
          leaseAuthorityIncluded: false,
          liveAuthorityIncluded: false,
          oauthAuthorityIncluded: false,
          policyAuthorityIncluded: false,
          restoredAuthorityAllowed: false,
          schedulerAuthorityIncluded: false,
        },
        cleanup: {
          completed: true,
          remainingAuthorityCount: 0,
          temporaryObjectsRemoved: 4,
        },
        disposable: true,
        drillId: crypto.randomUUID(),
        emittedAt: NOW + 11,
        format: "owd-continuity-receipt-v1",
        freshCommunityInstall: true,
        leadReplaced: true,
        metrics: {
          continuityAgeSeconds: 6,
          recoveryChecksPassed: 8,
          recoveryChecksTotal: 8,
          recoveryQualityBps: 10_000,
          rpoSeconds: 1,
          rtoSeconds: 4,
          runtimeIndependent: true,
        },
        outcome: "pass",
        projectId: fixture.projectId,
        receiptId: crypto.randomUUID(),
        redaction: {
          credentialsIncluded: false,
          customerDataIncluded: false,
          filenamesIncluded: false,
          hiddenReasoningIncluded: false,
          hostnamesIncluded: false,
          oauthStateIncluded: false,
          productionLogsIncluded: false,
          providerRuntimeIncluded: false,
          rawBodiesIncluded: false,
          terminalHistoryIncluded: false,
          transcriptsIncluded: false,
        },
        restoredContinuityPointId: checkpoint.continuityPoint.continuityPointId,
        schemaVersion: 1,
        sourceTimes: {
          latestAcknowledgedPointAt: NOW + 5,
          receiptEmittedAt: NOW + 11,
          replacementProductiveAt: NOW + 10,
          restoredPointAcknowledgedAt: NOW + 5,
          simulatedLeadLossAt: NOW + 6,
        },
      }),
      NOW + 11,
    );
    expect(
      await buildPortableContinuityBundle(
        env.DB,
        env.VAULT_STORAGE,
        fixture.projectId,
      ),
    ).toMatchObject({
      continuityPointId: checkpoint.continuityPoint.continuityPointId,
      files: [
        expect.objectContaining({ path: "README.md" }),
        expect.objectContaining({ path: "continuity-point.json" }),
      ],
    });

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
    expect(manifest.approved?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originalState: expect.objectContaining({
            disposition: "checkpointed",
          }),
          recordId: checkpoint.continuityPoint.continuityPointId,
          recordType: "continuity-point",
          restoreDisposition: "restore-approved",
        }),
      ]),
    );

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
    const sourceProject = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (sourceProject === null) throw new Error("Source Project missing.");
    const targetVaultId = crypto.randomUUID();
    const unusedTargetVaultId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at, last_connected_at
      ) VALUES
        (?, 'Fresh restored vault', 'active', ?, ?, ?),
        (?, 'Unused restored vault', 'active', ?, ?, ?)`,
    )
      .bind(
        targetVaultId,
        NOW + 9,
        NOW + 9,
        NOW + 9,
        unusedTargetVaultId,
        NOW + 9,
        NOW + 9,
        NOW + 9,
      )
      .run();

    await env.DB.batch([
      env.DB.prepare("DELETE FROM project_continuity_drill_receipts"),
      env.DB.prepare("DELETE FROM project_operational_integrity_reports"),
      env.DB.prepare("DELETE FROM project_operational_requests"),
      env.DB.prepare("DELETE FROM project_policy_decisions"),
      env.DB.prepare("DELETE FROM project_operational_schedules"),
      env.DB.prepare("DELETE FROM project_policy_bindings"),
      env.DB.prepare("DELETE FROM project_operational_dependencies"),
      env.DB.prepare("DELETE FROM project_operational_records"),
    ]);
    await env.DB.exec(`
      DELETE FROM project_operation_receipts;
      DELETE FROM project_run_claims;
      DELETE FROM project_exceptions;
      DELETE FROM project_event_bundles;
      DELETE FROM project_actors;
      DELETE FROM project_runs;
      DELETE FROM project_operation_policies;
      DELETE FROM project_operation_records;
      DELETE FROM collaboration_submission_receipts;
      DELETE FROM continuity_checkpoint_receipts;
      DELETE FROM continuity_point_dependencies;
      DELETE FROM project_continuity_points;
      DELETE FROM project_lead_leases;
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
    const stageRestore = async (
      vaultMappings: Array<{
        sourceVaultId: string;
        targetVaultId: string;
      }>,
    ) => {
      let stagedJob = await createCollaborationRestore(
        env.DB,
        {
          manifest,
          vaultMappings,
        },
        NOW + 10,
      );
      for (const item of [
        ...(manifest.approved?.records ?? []),
        ...(manifest.approved?.evidenceObjects ?? []),
        ...(manifest.unvetted?.records ?? []),
        ...(manifest.unvetted?.evidenceObjects ?? []),
      ]) {
        const bytes = bodies.get(item.portableObjectId);
        if (bytes === undefined) throw new Error("Restore body missing.");
        stagedJob = await stageCollaborationRestoreItem(
          env.DB,
          env.VAULT_STORAGE,
          stagedJob.restoreId,
          {
            bytesBase64Url: encodeBase64Url(bytes),
            portableObjectId: item.portableObjectId,
          },
        );
      }
      return stagedJob;
    };

    const invalidJob = await stageRestore([
      { sourceVaultId: fixture.vaultId, targetVaultId },
      {
        sourceVaultId: crypto.randomUUID(),
        targetVaultId: unusedTargetVaultId,
      },
    ]);
    await expect(
      applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        invalidJob.restoreId,
        NOW + 11,
      ),
    ).rejects.toMatchObject({ code: "project_reference_invalid" });
    expect(
      await env.DB.prepare(
        `SELECT status, failure_code FROM collaboration_restore_jobs
         WHERE id = ?`,
      )
        .bind(invalidJob.restoreId)
        .first(),
    ).toEqual({
      failure_code: "project_reference_invalid",
      status: "failed",
    });
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM collaboration_projects`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);

    const job = await stageRestore([
      { sourceVaultId: fixture.vaultId, targetVaultId },
    ]);
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
        `SELECT DISTINCT record_type, restore_state
         FROM project_operation_records ORDER BY record_type`,
      ).all(),
    ).toMatchObject({
      results: [
        { record_type: "actor", restore_state: "quarantined" },
        { record_type: "event-bundle", restore_state: "quarantined" },
        { record_type: "exception", restore_state: "quarantined" },
        { record_type: "policy", restore_state: "quarantined" },
        { record_type: "run", restore_state: "quarantined" },
      ],
    });
    expect(
      await env.DB.prepare(
        `SELECT DISTINCT record_type, restore_state,
          restored_authority_allowed, live_authority_included,
          scheduler_authority_included
         FROM project_operational_records ORDER BY record_type`,
      ).all(),
    ).toMatchObject({
      results: [
        "continuity-receipt",
        "evidence",
        "policy-binding",
        "policy-decision",
        "schedule",
      ].map((record_type) => ({
        live_authority_included: 0,
        record_type,
        restore_state: "quarantined",
        restored_authority_allowed: 0,
        scheduler_authority_included: 0,
      })),
    });
    for (const table of [
      "project_policy_bindings",
      "project_policy_decisions",
      "project_operational_schedules",
      "project_operational_requests",
      "project_operational_integrity_reports",
      "project_continuity_drill_receipts",
    ]) {
      expect(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
    for (const table of [
      "project_operation_policies",
      "project_runs",
      "project_actors",
      "project_event_bundles",
      "project_exceptions",
      "project_operation_receipts",
      "project_lead_leases",
      "collaboration_grants",
    ]) {
      expect(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
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
      vault_id: targetVaultId,
      work_item_id: fixture.workItemId,
    });
    const restoredSpace = await readCollaborationRecord(
      env.DB,
      env.VAULT_STORAGE,
      sourceProject.active_knowledge_space_version_id,
    );
    expect(restoredSpace?.record).toMatchObject({
      members: [expect.objectContaining({ vaultId: targetVaultId })],
      recordType: "knowledge-space-version",
    });
    if (restoredSpace?.record.recordType !== "knowledge-space-version") {
      throw new Error("Restored Knowledge Space missing.");
    }
    expect(restoredSpace.record.selectorSha256).toBe(
      await projectContextSelectorSha256(restoredSpace.record.members),
    );
    const restoredPacket = await readCollaborationRecord(
      env.DB,
      env.VAULT_STORAGE,
      fixture.packet.packetId,
    );
    expect(restoredPacket?.record).toMatchObject({
      recordType: "work-packet",
      sourceCitations: [expect.objectContaining({ vaultId: targetVaultId })],
    });
    expect(
      (
        await readLatestContinuityPoint(
          env.DB,
          env.VAULT_STORAGE,
          fixture.projectId,
        )
      )?.point,
    ).toEqual(checkpoint.continuityPoint);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM collaboration_grants`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      await env.DB.prepare(
        `SELECT source_lease_id, producer_client_id, restored_at
         FROM project_continuity_points WHERE continuity_point_id = ?`,
      )
        .bind(checkpoint.continuityPoint.continuityPointId)
        .first(),
    ).toEqual({
      producer_client_id: null,
      restored_at: NOW + 11,
      source_lease_id: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM project_lead_leases) AS lease_count,
          (SELECT COUNT(*) FROM continuity_checkpoint_receipts) AS receipt_count`,
      ).first(),
    ).toEqual({ lease_count: 0, receipt_count: 0 });
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

    const restoredFixture = { ...fixture, vaultId: targetVaultId };
    const recoveryStartedAt = Date.now();
    const replacementAuthorization = await createLeadAuthorization(
      restoredFixture,
      {
        clientId: "https://replacement.example/agent.json",
        now: NOW + 12,
        reuseFixtureGrant: false,
      },
    );
    const replacementLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: replacementAuthorization,
      now: NOW + 12,
      request: {
        idempotencyKey: `replacement-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Replacement lead"),
        leaseExpiresInSeconds: 300,
        projectId: fixture.projectId,
      },
    });
    expect(replacementLease.fencingToken).toBe(1);
    const continued = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: replacementAuthorization,
      now: NOW + 13,
      request: checkpointRequest(restoredFixture, replacementLease, {
        previousContinuityPointId: checkpoint.continuityPoint.continuityPointId,
      }),
    });
    expect(continued.continuityPoint.previousContinuityPointId).toBe(
      checkpoint.continuityPoint.continuityPointId,
    );
    expect(Date.now() - recoveryStartedAt).toBeLessThan(5 * 60 * 1_000);
  });

  it("rejects a restored Continuity Point whose predecessor belongs to another Project", async () => {
    const first = await createFixture();
    const firstAuthorization = await createLeadAuthorization(first);
    const firstLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: firstAuthorization,
      now: NOW,
      request: {
        idempotencyKey: `first-predecessor-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("First Project lead"),
        leaseExpiresInSeconds: 300,
        projectId: first.projectId,
      },
    });
    const firstPoint = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: firstAuthorization,
      now: NOW + 1,
      request: checkpointRequest(first, firstLease),
    });

    const foreign = await createFixture(
      "https://foreign-predecessor.example/agent.json",
    );
    const foreignAuthorization = await createLeadAuthorization(foreign);
    const foreignLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: foreignAuthorization,
      now: NOW,
      request: {
        idempotencyKey: `foreign-predecessor-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Foreign Project lead"),
        leaseExpiresInSeconds: 300,
        projectId: foreign.projectId,
      },
    });
    const foreignPoint = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: foreignAuthorization,
      now: NOW + 1,
      request: checkpointRequest(foreign, foreignLease),
    });

    const hostile = structuredClone(firstPoint.continuityPoint);
    hostile.continuityPointId = crypto.randomUUID();
    hostile.previousContinuityPointId =
      foreignPoint.continuityPoint.continuityPointId;
    hostile.provenance.acknowledgedAt = NOW + 2;
    hostile.integrity.digest = "0".repeat(64);
    hostile.integrity.digest = await sha256Hex(
      canonicalizeIntegrityPayload(
        hostile as typeof hostile & Record<string, unknown>,
      ),
    );
    const hostilePoint = continuityPointSchema.parse(hostile);
    const bytes = encoder.encode(canonicalizeCollaborationJson(hostilePoint));
    const portableObjectId = crypto.randomUUID();
    const contentSha256 = await sha256HexBytes(bytes);
    const manifest = {
      approved: {
        classification: "approved",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes: bytes.byteLength,
        newlyStoredBytes: bytes.byteLength,
        recordCount: 1,
        records: [
          {
            byteLength: bytes.byteLength,
            classification: "approved",
            contentSha256,
            dependencies: [],
            evidenceOnly: false,
            originalState: {
              disposition: "checkpointed",
              visibility: "owner-only",
            },
            portableObjectId,
            projectId: first.projectId,
            recordId: hostilePoint.continuityPointId,
            recordType: "continuity-point",
            restoreDisposition: "restore-approved",
            schemaVersion: 1,
            workItemId: first.workItemId,
          },
        ],
      },
      excludedAuthority: [
        "oauth-access-tokens",
        "oauth-refresh-tokens",
        "oauth-authorization-codes",
        "oauth-protocol-storage",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "vault-credentials",
        "live-agent-grants",
        "recovery-private-keys",
        "harness-context",
        "provider-credentials",
        "runtime-caches",
      ],
      format: "owd-snapshot-intelligence-v1",
      requiredCapabilities: [APPROVED_INTELLIGENCE_CAPABILITY],
      schemaVersion: 1,
      selection: "approved",
      unvetted: null,
    };
    let restore = await createCollaborationRestore(
      env.DB,
      { manifest },
      NOW + 3,
    );
    restore = await stageCollaborationRestoreItem(
      env.DB,
      env.VAULT_STORAGE,
      restore.restoreId,
      { bytesBase64Url: encodeBase64Url(bytes), portableObjectId },
    );
    expect(restore.status).toBe("preview");
    await expect(
      applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        NOW + 4,
      ),
    ).rejects.toMatchObject({ code: "snapshot_dependency_missing" });
    expect(
      await env.DB.prepare(
        `SELECT continuity_point_id FROM project_continuity_points
         WHERE continuity_point_id = ?`,
      )
        .bind(hostilePoint.continuityPointId)
        .first(),
    ).toBeNull();
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

  it("keeps legacy Project clients compatible while requiring an additive lead scope", async () => {
    const fixture = await createFixture();
    await expect(
      resumeAuthorizedProject(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        contextPolicy: fixtureContextPolicy(fixture),
        now: NOW + 1,
        projectId: fixture.projectId,
      }),
    ).resolves.toMatchObject({
      packet: { packetId: fixture.packet.packetId },
    });
    await expect(
      claimProjectLead(env.DB, env.VAULT_STORAGE, {
        authorization: fixture.authorization,
        now: NOW + 1,
        request: {
          idempotencyKey: `legacy-${crypto.randomUUID()}`,
          leadIdentity: leadIdentity("Legacy client"),
          leaseExpiresInSeconds: 60,
          projectId: fixture.projectId,
        },
      }),
    ).rejects.toMatchObject({ code: "collaboration_scope_required" });
  });

  it("serializes simultaneous lead claims and fences expired or revoked holders", async () => {
    const fixture = await createFixture();
    const authorizations = [
      await createLeadAuthorization(fixture),
      await createLeadAuthorization(fixture, {
        clientId: "https://contender.example/agent.json",
        reuseFixtureGrant: false,
      }),
    ];
    const claims = authorizations.map((authorization, index) =>
      claimProjectLead(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 1,
        request: {
          idempotencyKey: `simultaneous-${index}-${crypto.randomUUID()}`,
          leadIdentity: leadIdentity(`Contender ${index + 1}`),
          leaseExpiresInSeconds: 60,
          projectId: fixture.projectId,
        },
      }),
    );
    const results = await Promise.allSettled(claims);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winnerIndex = results.findIndex(
      (result) => result.status === "fulfilled",
    );
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const firstLease = (
      results[winnerIndex] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof claimProjectLead>>
      >
    ).value;
    expect(results[loserIndex]).toMatchObject({
      reason: { code: "lead_lease_conflict" },
      status: "rejected",
    });

    const takeover = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: authorizations[loserIndex]!,
      now: firstLease.expiresAt + 1,
      request: {
        idempotencyKey: `takeover-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Expiry replacement"),
        leaseExpiresInSeconds: 60,
        projectId: fixture.projectId,
      },
    });
    expect(takeover.fencingToken).toBe(firstLease.fencingToken + 1);
    await expect(
      renewProjectLead(env.DB, env.VAULT_STORAGE, {
        authorization: authorizations[winnerIndex]!,
        now: firstLease.expiresAt + 2,
        request: {
          fencingToken: firstLease.fencingToken,
          leaseExpiresInSeconds: 60,
          leaseId: firstLease.leaseId,
          projectId: fixture.projectId,
        },
      }),
    ).rejects.toMatchObject({ code: "lead_lease_invalid" });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization: authorizations[winnerIndex]!,
        now: firstLease.expiresAt + 2,
        request: checkpointRequest(fixture, firstLease),
      }),
    ).rejects.toMatchObject({ code: "lead_lease_invalid" });

    await revokeCollaborationGrant(env.DB, {
      grantId: authorizations[loserIndex]!.grantId,
      now: firstLease.expiresAt + 3,
    });
    const afterRevocation = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: authorizations[winnerIndex]!,
      now: firstLease.expiresAt + 4,
      request: {
        idempotencyKey: `revocation-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Revocation replacement"),
        leaseExpiresInSeconds: 60,
        projectId: fixture.projectId,
      },
    });
    expect(afterRevocation.fencingToken).toBe(takeover.fencingToken + 1);
    expect(
      await revokeProjectLead(env.DB, {
        now: firstLease.expiresAt + 5,
        projectId: fixture.projectId,
      }),
    ).toBe(true);
  });

  it("rechecks lead expiry at the D1 checkpoint commit boundary", async () => {
    const fixture = await createFixture();
    const authorization = await createLeadAuthorization(fixture);
    const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW,
      request: {
        idempotencyKey: `expiry-boundary-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Expiring lead"),
        leaseExpiresInSeconds: 60,
        projectId: fixture.projectId,
      },
    });
    await env.DB.prepare(
      `UPDATE project_lead_leases
       SET claimed_at = unixepoch() - 20,
         renewed_at = unixepoch() - 10,
         expires_at = unixepoch() - 1
       WHERE project_id = ?`,
    )
      .bind(fixture.projectId)
      .run();
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW - 30,
        request: checkpointRequest(fixture, lease),
      }),
    ).rejects.toMatchObject({ code: "lead_lease_invalid" });
    expect(
      await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM project_continuity_points) AS point_count,
          (SELECT COUNT(*) FROM continuity_checkpoint_receipts) AS receipt_count`,
      ).first(),
    ).toEqual({ point_count: 0, receipt_count: 0 });
  });

  it("makes checkpoints replay-safe and rejects hostile references and stale packets", async () => {
    const fixture = await createFixture();
    const authorization = await createLeadAuthorization(fixture);
    const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW,
      request: {
        idempotencyKey: `checkpoint-lead-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Checkpoint lead"),
        leaseExpiresInSeconds: 900,
        projectId: fixture.projectId,
      },
    });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 1,
        request: {
          ...checkpointRequest(fixture, lease),
          completedWork: Array.from({ length: 65 }, () => "oversize"),
        },
      }),
    ).rejects.toMatchObject({ code: "submission_invalid" });

    const request = checkpointRequest(fixture, lease, {
      idempotencyKey: `checkpoint-replay-${crypto.randomUUID()}`,
    });
    const first = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 2,
      request,
    });
    const replay = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 3,
      request,
    });
    expect(replay).toEqual(first);
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 3,
        request: { ...request, nextAction: "A different replay payload." },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 3,
        request: checkpointRequest(fixture, lease),
      }),
    ).rejects.toMatchObject({ code: "continuity_point_conflict" });

    const foreign = await createFixture("https://foreign.example/agent.json");
    const foreignAttempt = await submitAttempt(foreign);
    const foreignArtifact = await submitArtifact(
      foreign,
      foreignAttempt.attemptId,
      foreignAttempt.participantRefId,
      "foreign artifact",
    );
    await applyOwnerRecordAction(
      env.DB,
      env.VAULT_STORAGE,
      foreign.projectId,
      {
        action: "accept",
        reason: "Hostile cross-Project fixture.",
        recordId: foreignArtifact.artifactId,
      },
      NOW + 4,
    );
    const foreignDecision = await createOwnerDecision(
      env.DB,
      env.VAULT_STORAGE,
      foreign.projectId,
      {
        inputRecordIds: [foreignArtifact.artifactId],
        rationale: "Hostile cross-Project decision fixture.",
        resolution: "accepted",
        workItemId: foreign.workItemId,
      },
      NOW + 4,
    );
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 5,
        request: checkpointRequest(fixture, lease, {
          acceptedDecisionIds: [foreignDecision.decisionId],
          previousContinuityPointId: first.continuityPoint.continuityPointId,
        }),
      }),
    ).rejects.toMatchObject({ code: "project_reference_invalid" });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 5,
        request: checkpointRequest(fixture, lease, {
          artifactIds: [foreignArtifact.artifactId],
          previousContinuityPointId: first.continuityPoint.continuityPointId,
        }),
      }),
    ).rejects.toMatchObject({ code: "artifact_not_visible" });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 5,
        request: checkpointRequest(fixture, lease, {
          citationIds: [crypto.randomUUID()],
          previousContinuityPointId: first.continuityPoint.continuityPointId,
        }),
      }),
    ).rejects.toMatchObject({ code: "evidence_unavailable" });

    const competingCheckpoints = await Promise.allSettled([
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 6,
        request: checkpointRequest(fixture, lease, {
          idempotencyKey: `fork-a-${crypto.randomUUID()}`,
          previousContinuityPointId: first.continuityPoint.continuityPointId,
        }),
      }),
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 6,
        request: checkpointRequest(fixture, lease, {
          idempotencyKey: `fork-b-${crypto.randomUUID()}`,
          previousContinuityPointId: first.continuityPoint.continuityPointId,
        }),
      }),
    ]);
    expect(
      competingCheckpoints.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      competingCheckpoints.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      competingCheckpoints.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "continuity_point_conflict" },
      status: "rejected",
    });
    const latestPointId = (
      competingCheckpoints.find(
        (result) => result.status === "fulfilled",
      ) as PromiseFulfilledResult<Awaited<ReturnType<typeof checkpointProject>>>
    ).value.continuityPoint.continuityPointId;

    const mismatchedPacket = structuredClone(fixture.packet);
    mismatchedPacket.packetId = crypto.randomUUID();
    mismatchedPacket.projectVersionId = crypto.randomUUID();
    mismatchedPacket.createdAt = NOW + 7;
    mismatchedPacket.expiresAt = NOW + 607;
    mismatchedPacket.integrity.digest = "0".repeat(64);
    mismatchedPacket.integrity.digest = await sha256Hex(
      canonicalizeIntegrityPayload(
        mismatchedPacket as WorkPacket & Record<string, unknown>,
      ),
    );
    const preparedMismatchedPacket = await prepareCollaborationRecord(
      env.VAULT_STORAGE,
      {
        now: NOW + 7,
        record: workPacketSchema.parse(mismatchedPacket),
      },
    );
    await env.DB.batch([
      insertRecordStatement(env.DB, preparedMismatchedPacket),
      insertStateStatement(env.DB, {
        changedAt: NOW + 7,
        disposition: "accepted",
        recordId: mismatchedPacket.packetId,
        visibility: "owner-only",
      }),
    ]);
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 8,
        request: {
          ...checkpointRequest(fixture, lease, {
            previousContinuityPointId: latestPointId,
          }),
          packetId: mismatchedPacket.packetId,
        },
      }),
    ).rejects.toMatchObject({ code: "work_packet_stale" });

    await createContinuationWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      fixture.projectId,
      { packetExpiresInSeconds: 600, workItemId: fixture.workItemId },
      NOW + 9,
    );
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 10,
        request: checkpointRequest(fixture, lease, {
          previousContinuityPointId: latestPointId,
        }),
      }),
    ).rejects.toMatchObject({ code: "work_packet_stale" });

    await revokeCollaborationGrant(env.DB, {
      grantId: authorization.grantId,
      now: NOW + 11,
    });
    await expect(
      checkpointProject(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 12,
        request: checkpointRequest(fixture, lease, {
          previousContinuityPointId: latestPointId,
        }),
      }),
    ).rejects.toMatchObject({ code: "collaboration_grant_revoked" });
  });
});

type R2Harness = {
  actors: [string, string, string];
  authorization: CollaborationAuthorizationContext;
  fixture: ProjectFixture;
  lease: { fencingToken: number; leaseId: string };
  runId: string;
  workItemId: string;
};

async function createR2Harness(): Promise<R2Harness> {
  const fixture = await createFixture();
  const authorization = await createLeadAuthorization(fixture);
  const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
    authorization,
    now: NOW,
    request: {
      idempotencyKey: `r2-claim-${crypto.randomUUID()}`,
      leadIdentity: leadIdentity("Synthetic Hermes lead"),
      leaseExpiresInSeconds: 600,
      projectId: fixture.projectId,
    },
  });
  const created = createWorkItemReceiptSchema.parse(
    await createLeadWorkItem(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 1,
      request: {
        fencingToken: lease.fencingToken,
        idempotencyKey: `r2-create-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        packetExpiresInSeconds: 600,
        projectId: fixture.projectId,
        requestedRole: { authority: "none", label: "claimed-run-actor" },
        workItemBrief: {
          constraints: ["Use only bounded synthetic evidence."],
          definitionOfDone: [
            "Share a provisional result and pass independent review.",
          ],
          objective: "Exercise the R2 hands-off lead slice.",
          requestedOutput: "Markdown",
        },
      },
    }),
  );
  const started = startRunReceiptSchema.parse(
    await startLeadRun(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 2,
      request: {
        fencingToken: lease.fencingToken,
        idempotencyKey: `r2-start-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: fixture.projectId,
        purpose: "coding",
        workItemId: created.workItemId,
      },
    }),
  );
  const actorIds: [string, string, string] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  const actorScopes = [
    ["run.context.read", "run.bundle.submit"],
    ["run.context.read", "run.bundle.submit"],
    ["run.context.read", "run.review.submit"],
  ] as const;
  for (let index = 0; index < actorIds.length; index += 1) {
    registerActorReceiptSchema.parse(
      await registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 3 + index,
        request: {
          actorId: actorIds[index],
          claimedIdentity: `Synthetic actor ${index + 1}`,
          fencingToken: lease.fencingToken,
          idempotencyKey: `r2-actor-${index}-${crypto.randomUUID()}`,
          leaseId: lease.leaseId,
          lifetimeSeconds: 300,
          projectId: fixture.projectId,
          runId: started.run.runId,
          scopes: [...actorScopes[index]!],
          workItemId: created.workItemId,
        },
      }),
    );
  }
  return {
    actors: actorIds,
    authorization,
    fixture,
    lease,
    runId: started.run.runId,
    workItemId: created.workItemId,
  };
}

function r2BundleBase(harness: R2Harness, actorId: string, now: number) {
  return {
    actorId,
    bundleId: crypto.randomUUID(),
    createdAt: now,
    format: "owd-event-bundle-v1" as const,
    normalizedRelativePath: null,
    projectId: harness.fixture.projectId,
    requestedActions: [] as Array<
      "authority-expansion" | "destructive-action" | "protected-path-access"
    >,
    runId: harness.runId,
    schemaVersion: 1 as const,
    visibility: "run-shared-unvetted" as const,
  };
}

describe("R2 hands-off lead operation", () => {
  it("never starts a live Run from a quarantined or restored Work Packet", async () => {
    const fixture = await createFixture();
    const authorization = await createLeadAuthorization(fixture);
    const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW,
      request: {
        idempotencyKey: `r2-quarantine-claim-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Synthetic Hermes lead"),
        leaseExpiresInSeconds: 600,
        projectId: fixture.projectId,
      },
    });
    const created = createWorkItemReceiptSchema.parse(
      await createLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 1,
        request: {
          fencingToken: lease.fencingToken,
          idempotencyKey: `r2-quarantine-create-${crypto.randomUUID()}`,
          leaseId: lease.leaseId,
          packetExpiresInSeconds: 600,
          projectId: fixture.projectId,
          requestedRole: { authority: "none", label: "claimed-run-actor" },
          workItemBrief: {
            constraints: ["Use only bounded synthetic evidence."],
            definitionOfDone: ["Do not resume quarantined authority."],
            objective: "Exercise restored packet denial.",
            requestedOutput: "Markdown",
          },
        },
      }),
    );
    const packet = await env.DB.prepare(
      `SELECT id FROM collaboration_records
       WHERE record_type = 'work-packet' AND project_id = ? AND work_item_id = ?
       ORDER BY received_at DESC, id DESC LIMIT 1`,
    )
      .bind(fixture.projectId, created.workItemId)
      .first<{ id: string }>();
    expect(packet).not.toBeNull();
    await env.DB.prepare(
      `UPDATE collaboration_record_states
       SET disposition = 'quarantined', visibility = 'owner-only'
       WHERE record_id = ?`,
    )
      .bind(packet!.id)
      .run();
    const startRequest = {
      fencingToken: lease.fencingToken,
      leaseId: lease.leaseId,
      projectId: fixture.projectId,
      purpose: "coding" as const,
      workItemId: created.workItemId,
    };
    await expect(
      startLeadRun(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 2,
        request: {
          ...startRequest,
          idempotencyKey: `r2-quarantined-start-${crypto.randomUUID()}`,
        },
      }),
    ).rejects.toMatchObject({ code: "work_item_invalid" });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE collaboration_record_states SET disposition = 'accepted'
           WHERE record_id = ?`,
      ).bind(packet!.id),
      env.DB.prepare(
        `UPDATE collaboration_records SET restored_at = ? WHERE id = ?`,
      ).bind(NOW + 2, packet!.id),
    ]);
    await expect(
      startLeadRun(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 3,
        request: {
          ...startRequest,
          idempotencyKey: `r2-restored-start-${crypto.randomUUID()}`,
        },
      }),
    ).rejects.toMatchObject({ code: "work_item_invalid" });
  });

  it("delegates to three claimed actors, routes review, checkpoints, and closes without routine owner action", async () => {
    const harness = await createR2Harness();
    const [producerId, coordinatorId, reviewerId] = harness.actors;
    const context = await getLeadRunContext(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 6,
      request: {
        actorId: producerId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    expect(context).toMatchObject({
      acceptedBundles: [],
      actors: [
        { actorId: producerId },
        { actorId: coordinatorId },
        { actorId: reviewerId },
      ],
      authority: {
        liveAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
      },
      format: "owd-run-context-v1",
      run: { status: "active", workItemId: harness.workItemId },
    });

    const provisional = {
      ...r2BundleBase(harness, producerId, NOW + 7),
      events: [
        {
          actorId: producerId,
          claims: [
            {
              evidenceSha256: "b".repeat(64),
              key: "synthetic.build.status",
              valueSha256: "a".repeat(64),
            },
          ],
          eventId: crypto.randomUUID(),
          eventType: "result.provisional" as const,
          runId: harness.runId,
          summary: "The synthetic candidate passes its focused checks.",
        },
      ],
    };
    submitBundleReceiptSchema.parse(
      await submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 7,
        request: {
          bundle: provisional,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-bundle-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    );
    const reviewRequest = {
      ...r2BundleBase(harness, coordinatorId, NOW + 8),
      events: [
        {
          actorId: coordinatorId,
          eventId: crypto.randomUUID(),
          eventType: "review.requested" as const,
          reviewerActorId: reviewerId,
          runId: harness.runId,
          targetBundleId: provisional.bundleId,
        },
      ],
    };
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 8,
      request: {
        bundle: reviewRequest,
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-review-request-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 9,
      request: {
        bundle: {
          ...r2BundleBase(harness, reviewerId, NOW + 9),
          events: [
            {
              actorId: reviewerId,
              eventId: crypto.randomUUID(),
              eventType: "review.completed",
              findings: [],
              runId: harness.runId,
              summary: "Independent synthetic review passed.",
              targetBundleId: provisional.bundleId,
              verdict: "pass",
            },
          ],
        },
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-review-result-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    await expect(
      completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 10,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-complete-before-checkpoint-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          outcome: "Synthetic R2 slice completed.",
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "checkpoint_required" });
    await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 10,
      request: {
        acceptedDecisionIds: [],
        artifactIds: [],
        blockers: [],
        citationIds: [],
        completedWork: [
          "Three actors produced and independently reviewed a result.",
        ],
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-checkpoint-${crypto.randomUUID()}`,
        knownRejectedApproaches: ["Executing exception-only actions."],
        leaseId: harness.lease.leaseId,
        nextAction: "Close the reviewed Work Item.",
        openWork: [],
        packetId: context.workPacket.packetId,
        previousContinuityPointId: null,
        projectId: harness.fixture.projectId,
        risks: [],
        workItemId: harness.workItemId,
      },
    });
    const checkpoint = await env.DB.prepare(
      `SELECT continuity_point_id FROM project_continuity_points
       WHERE project_id = ? AND work_item_id = ? AND work_packet_id = ?
       ORDER BY acknowledged_at DESC LIMIT 1`,
    )
      .bind(
        harness.fixture.projectId,
        harness.workItemId,
        context.workPacket.packetId,
      )
      .first<{ continuity_point_id: string }>();
    expect(checkpoint).not.toBeNull();
    const successorPacket = await createContinuationWorkPacket(
      env.DB,
      env.VAULT_STORAGE,
      harness.fixture.projectId,
      { packetExpiresInSeconds: 600, workItemId: harness.workItemId },
      NOW + 11,
    );
    await env.DB.prepare(
      `UPDATE project_continuity_points SET work_packet_id = ?
       WHERE continuity_point_id = ?`,
    )
      .bind(successorPacket.packetId, checkpoint!.continuity_point_id)
      .run();
    await expect(
      completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 12,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-complete-wrong-checkpoint-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          outcome: "Must not close against a different packet checkpoint.",
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "checkpoint_required" });
    await env.DB.prepare(
      `UPDATE project_continuity_points SET work_packet_id = ?
       WHERE continuity_point_id = ?`,
    )
      .bind(context.workPacket.packetId, checkpoint!.continuity_point_id)
      .run();
    completeWorkItemReceiptSchema.parse(
      await completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 13,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-complete-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          outcome: "Synthetic R2 slice completed.",
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    );
    expect(
      await env.DB.prepare(`SELECT status FROM project_runs WHERE run_id = ?`)
        .bind(harness.runId)
        .first(),
    ).toEqual({ status: "completed" });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_actors
         WHERE run_id = ? AND status = 'revoked'`,
      )
        .bind(harness.runId)
        .first(),
    ).toEqual({ count: 3 });
  });

  it("records exception-only requests and conflicting evidence without executing them", async () => {
    const harness = await createR2Harness();
    const [producerId, coordinatorId] = harness.actors;
    const first = {
      ...r2BundleBase(harness, producerId, NOW + 7),
      events: [
        {
          actorId: producerId,
          claims: [
            {
              evidenceSha256: null,
              key: "synthetic.claim",
              valueSha256: "a".repeat(64),
            },
          ],
          eventId: crypto.randomUUID(),
          eventType: "result.provisional" as const,
          runId: harness.runId,
          summary: "First synthetic claim.",
        },
      ],
    };
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 7,
      request: {
        bundle: first,
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-first-claim-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 8,
      request: {
        bundle: {
          ...r2BundleBase(harness, coordinatorId, NOW + 8),
          events: [
            {
              actorId: coordinatorId,
              claims: [
                {
                  evidenceSha256: "c".repeat(64),
                  key: "synthetic.claim",
                  valueSha256: "b".repeat(64),
                },
              ],
              eventId: crypto.randomUUID(),
              eventType: "result.provisional",
              runId: harness.runId,
              summary: "Conflicting synthetic claim.",
            },
          ],
          normalizedRelativePath: ".git/config",
          requestedActions: [
            "authority-expansion",
            "destructive-action",
            "protected-path-access",
          ],
        },
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-conflict-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    const listed = await listLeadProjectExceptions(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 9,
      request: { projectId: harness.fixture.projectId },
    });
    expect(listed.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "authority-expansion" }),
        expect.objectContaining({ kind: "destructive-action" }),
        expect.objectContaining({
          kind: "protected-path-access",
          normalizedRelativePath: ".git/config",
        }),
        expect.objectContaining({ kind: "evidence-conflict" }),
      ]),
    );
    expect(
      (await getLeadOperationOverview(env.DB, env.VAULT_STORAGE)).projects,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activeActorCount: 3,
          activeRunCount: 1,
          blockingExceptionCount: 4,
          projectId: harness.fixture.projectId,
        }),
      ]),
    );
    await expect(
      completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 10,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-blocked-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          outcome: "Must not close.",
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "exception_blocking" });
    const exception = await env.DB.prepare(
      `SELECT exception_id FROM project_exceptions
       WHERE project_id = ? AND status = 'blocking' LIMIT 1`,
    )
      .bind(harness.fixture.projectId)
      .first<{ exception_id: string }>();
    expect(exception).not.toBeNull();
    await expect(
      resolveProjectException(
        env.DB,
        harness.fixture.projectId,
        crypto.randomUUID(),
        NOW + 14,
      ),
    ).resolves.toBe(false);
    await expect(
      resolveProjectException(
        env.DB,
        harness.fixture.projectId,
        exception!.exception_id,
        NOW + 14,
      ),
    ).resolves.toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT status, resolved_at FROM project_exceptions
         WHERE exception_id = ?`,
      )
        .bind(exception!.exception_id)
        .first(),
    ).toEqual({ resolved_at: NOW + 14, status: "resolved" });
  });

  it("rolls back the exact mutation when the lead grant is revoked at commit time", async () => {
    const harness = await createR2Harness();
    const producerId = harness.actors[0];
    const bundle = {
      ...r2BundleBase(harness, producerId, NOW + 7),
      events: [
        {
          actorId: producerId,
          claims: [],
          eventId: crypto.randomUUID(),
          eventType: "result.provisional" as const,
          runId: harness.runId,
          summary: "This bundle must roll back with its stale authority.",
        },
      ],
    };
    const commitRevokingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                `UPDATE collaboration_grants
                 SET status = 'revoked', revoked_at = ? WHERE id = ?`,
              )
              .bind(NOW + 7, harness.authorization.grantId)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(
      submitRunBundle(commitRevokingDb, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 7,
        request: {
          bundle,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-commit-revoke-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toBeTruthy();
    expect(
      await env.DB.prepare(
        `SELECT 1 AS found FROM project_event_bundles WHERE bundle_id = ?`,
      )
        .bind(bundle.bundleId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT 1 AS found FROM project_operation_records
         WHERE operation_record_id = ?`,
      )
        .bind(bundle.bundleId)
        .first(),
    ).toBeNull();
    await expect(
      getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 8,
        request: {
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "grant_invalid" });
  });

  it.each(["source-grant", "source-vault"] as const)(
    "rolls back the exact mutation when the %s is revoked at commit time",
    async (revokedSource) => {
      const harness = await createR2Harness();
      const producerId = harness.actors[0];
      const bundle = {
        ...r2BundleBase(harness, producerId, NOW + 7),
        events: [
          {
            actorId: producerId,
            claims: [],
            eventId: crypto.randomUUID(),
            eventType: "result.provisional" as const,
            runId: harness.runId,
            summary:
              "This bundle must roll back with revoked source authority.",
          },
        ],
      };
      const source = await env.DB.prepare(
        `SELECT source_agent_grant_id FROM collaboration_grants WHERE id = ?`,
      )
        .bind(harness.authorization.grantId)
        .first<{ source_agent_grant_id: string }>();
      expect(source).not.toBeNull();
      const commitRevokingDb = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (revokedSource === "source-grant") {
                await target
                  .prepare(
                    `UPDATE agent_grants SET status = 'revoked', revoked_at = ?
                     WHERE id = ?`,
                  )
                  .bind(NOW + 7, source!.source_agent_grant_id)
                  .run();
              } else {
                await target
                  .prepare(`UPDATE vaults SET status = 'revoked' WHERE id = ?`)
                  .bind(harness.fixture.vaultId)
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as D1Database;
      await expect(
        submitRunBundle(commitRevokingDb, env.VAULT_STORAGE, {
          authorization: harness.authorization,
          now: NOW + 7,
          request: {
            bundle,
            fencingToken: harness.lease.fencingToken,
            idempotencyKey: `r2-commit-source-revoke-${crypto.randomUUID()}`,
            leaseId: harness.lease.leaseId,
            projectId: harness.fixture.projectId,
            runId: harness.runId,
          },
        }),
      ).rejects.toBeTruthy();
      expect(
        await env.DB.prepare(
          `SELECT 1 AS found FROM project_event_bundles WHERE bundle_id = ?`,
        )
          .bind(bundle.bundleId)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          `SELECT 1 AS found FROM project_operation_records
           WHERE operation_record_id = ?`,
        )
          .bind(bundle.bundleId)
          .first(),
      ).toBeNull();
    },
  );

  it("fails closed for actor scope, expiry, replay conflict, cross-Run/Project access, and actor budget", async () => {
    const harness = await createR2Harness();
    const reviewerId = harness.actors[2];
    await expect(
      submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 7,
        request: {
          bundle: {
            ...r2BundleBase(harness, reviewerId, NOW + 7),
            events: [
              {
                actorId: reviewerId,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional",
                runId: harness.runId,
                summary: "Out-of-scope submission.",
              },
            ],
          },
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-scope-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "scope_required" });
    const scopeExceptions = await listLeadProjectExceptions(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: harness.authorization,
        now: NOW + 8,
        request: {
          projectId: harness.fixture.projectId,
          status: "blocking",
        },
      },
    );
    expect(scopeExceptions.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "actor-scope" }),
      ]),
    );

    const shortLivedActorId = crypto.randomUUID();
    await registerRunActor(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 8,
      request: {
        actorId: shortLivedActorId,
        claimedIdentity: "Short-lived synthetic actor",
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-short-actor-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        lifetimeSeconds: 1,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
        scopes: ["run.bundle.submit"],
        workItemId: harness.workItemId,
      },
    });
    await expect(
      getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 8,
        request: {
          actorId: shortLivedActorId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "scope_required" });
    await expect(
      submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 10,
        request: {
          bundle: {
            ...r2BundleBase(harness, shortLivedActorId, NOW + 10),
            events: [
              {
                actorId: shortLivedActorId,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional",
                runId: harness.runId,
                summary: "Expired actor submission.",
              },
            ],
          },
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-expired-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "actor_invalid" });

    const replayKey = `r2-replay-${crypto.randomUUID()}`;
    const valid = {
      ...r2BundleBase(harness, harness.actors[0], NOW + 11),
      events: [
        {
          actorId: harness.actors[0],
          claims: [],
          eventId: crypto.randomUUID(),
          eventType: "result.provisional" as const,
          runId: harness.runId,
          summary: "Replay baseline.",
        },
      ],
    };
    const replayRequest = {
      bundle: valid,
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: replayKey,
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
    };
    const firstReceipt = await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 11,
      request: replayRequest,
    });
    expect(
      await submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 11,
        request: replayRequest,
      }),
    ).toEqual(firstReceipt);
    await expect(
      submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 11,
        request: {
          ...replayRequest,
          bundle: { ...valid, bundleId: crypto.randomUUID() },
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 11,
        request: {
          actorId: harness.actors[0],
          projectId: harness.fixture.projectId,
          runId: crypto.randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "actor_invalid" });

    const foreignHarness = await createR2Harness();
    await expect(
      getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 11,
        request: {
          projectId: foreignHarness.fixture.projectId,
          runId: foreignHarness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "grant_invalid" });

    for (let index = 0; index < 4; index += 1) {
      await registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 12 + index,
        request: {
          actorId: crypto.randomUUID(),
          claimedIdentity: `Budget actor ${index + 1}`,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-budget-actor-${index}-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          lifetimeSeconds: 120,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          scopes: ["run.context.read"],
          workItemId: harness.workItemId,
        },
      });
    }
    expect(
      (
        await env.DB.prepare(
          `SELECT actor_count FROM project_runs WHERE run_id = ?`,
        )
          .bind(harness.runId)
          .first<{ actor_count: number }>()
      )?.actor_count,
    ).toBe(8);
    await expect(
      registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 20,
        request: {
          actorId: crypto.randomUUID(),
          claimedIdentity: "Over-budget actor",
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r2-over-budget-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          lifetimeSeconds: 120,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          scopes: ["run.context.read"],
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  it("snapshots every R2 record as Unvetted and restores only quarantined bodies without authority", async () => {
    const harness = await createR2Harness();
    const producerId = harness.actors[0];
    await submitRunBundle(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 7,
      request: {
        bundle: {
          ...r2BundleBase(harness, producerId, NOW + 7),
          events: [
            {
              actorId: producerId,
              claims: [],
              eventId: crypto.randomUUID(),
              eventType: "result.provisional",
              runId: harness.runId,
              summary: "Synthetic recovery candidate.",
            },
          ],
          requestedActions: ["destructive-action"],
        },
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r2-recovery-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    const rows = await env.DB.prepare(
      `SELECT operation_record_id, record_type, project_id, work_item_id,
        portable_object_id, body_object_key, content_sha256, byte_length
       FROM project_operation_records
       WHERE project_id = ? ORDER BY record_type, operation_record_id`,
    )
      .bind(harness.fixture.projectId)
      .all<{
        body_object_key: string;
        byte_length: number;
        content_sha256: string;
        operation_record_id: string;
        portable_object_id: string;
        project_id: string;
        record_type: "actor" | "event-bundle" | "exception" | "policy" | "run";
        work_item_id: string | null;
      }>();
    expect(new Set(rows.results.map((row) => row.record_type))).toEqual(
      new Set(["policy", "run", "actor", "event-bundle", "exception"]),
    );
    const estimate = await estimateCollaborationSnapshot(
      env.DB,
      "approved-and-unvetted",
    );
    expect(estimate.unvetted?.recordCount).toBeGreaterThanOrEqual(
      rows.results.length,
    );
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
        "d".repeat(64),
        NOW + 7,
        crypto.randomUUID(),
        NOW + 7,
      )
      .run();
    await stageCollaborationSnapshot(env.DB, {
      now: NOW + 7,
      selection: "approved-and-unvetted",
      snapshotId,
    });
    await env.DB.prepare(
      `UPDATE snapshot_intelligence_items SET status = 'ready'
       WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .run();
    const stagedManifest = await buildCollaborationSnapshotManifest(
      env.DB,
      snapshotId,
    );
    expect(
      new Set(
        (stagedManifest.unvetted?.records ?? [])
          .filter((record) =>
            ["policy", "run", "actor", "event-bundle", "exception"].includes(
              record.recordType,
            ),
          )
          .map((record) => record.recordType),
      ),
    ).toEqual(new Set(["policy", "run", "actor", "event-bundle", "exception"]));
    expect(
      (stagedManifest.approved?.records ?? []).some((record) =>
        ["policy", "run", "actor", "event-bundle", "exception"].includes(
          record.recordType,
        ),
      ),
    ).toBe(false);
    const bodies = new Map<string, Uint8Array>();
    for (const row of rows.results) {
      const object = await env.VAULT_STORAGE.get(row.body_object_key);
      if (object === null) throw new Error("R2 recovery body missing.");
      bodies.set(
        row.portable_object_id,
        new Uint8Array(await object.arrayBuffer()),
      );
    }
    const logicalBytes = rows.results.reduce(
      (total, row) => total + row.byte_length,
      0,
    );
    const manifest = snapshotIntelligenceManifestSchema.parse({
      approved: {
        classification: "approved",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes: 0,
        newlyStoredBytes: 0,
        recordCount: 0,
        records: [],
      },
      excludedAuthority: [
        "oauth-access-tokens",
        "oauth-refresh-tokens",
        "oauth-authorization-codes",
        "oauth-protocol-storage",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "vault-credentials",
        "live-agent-grants",
        "recovery-private-keys",
        "harness-context",
        "provider-credentials",
        "runtime-caches",
      ],
      format: "owd-snapshot-intelligence-v1",
      requiredCapabilities: [
        APPROVED_INTELLIGENCE_CAPABILITY,
        QUARANTINED_INTELLIGENCE_CAPABILITY,
      ],
      schemaVersion: 1,
      selection: "approved-and-unvetted",
      unvetted: {
        classification: "unvetted",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes,
        newlyStoredBytes: logicalBytes,
        recordCount: rows.results.length,
        records: rows.results.map((row) => ({
          byteLength: row.byte_length,
          classification: "unvetted",
          contentSha256: row.content_sha256,
          dependencies: [],
          evidenceOnly: false,
          originalState: {
            disposition: "pending",
            visibility: "owner-only",
          },
          portableObjectId: row.portable_object_id,
          projectId: row.project_id,
          recordId: row.operation_record_id,
          recordType: row.record_type,
          restoreDisposition: "restore-quarantined",
          schemaVersion: 1,
          workItemId: row.work_item_id,
        })),
      },
    });
    await env.DB.exec(`
      DELETE FROM project_operation_receipts;
      DELETE FROM project_run_claims;
      DELETE FROM project_exceptions;
      DELETE FROM project_event_bundles;
      DELETE FROM project_actors;
      DELETE FROM project_runs;
      DELETE FROM project_operation_policies;
      DELETE FROM project_operation_records;
      DELETE FROM project_lead_leases;
      DELETE FROM collaboration_grant_clients;
      DELETE FROM collaboration_grants;
    `);
    let restore = await createCollaborationRestore(
      env.DB,
      { manifest },
      NOW + 8,
    );
    for (const descriptor of manifest.unvetted?.records ?? []) {
      const bytes = bodies.get(descriptor.portableObjectId);
      if (bytes === undefined) throw new Error("R2 recovery body not staged.");
      restore = await stageCollaborationRestoreItem(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        {
          bytesBase64Url: encodeBase64Url(bytes),
          portableObjectId: descriptor.portableObjectId,
        },
      );
    }
    expect(restore.status).toBe("preview");
    expect(
      await applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        NOW + 9,
      ),
    ).toMatchObject({ grantCount: 0, status: "applied" });
    expect(
      await env.DB.prepare(
        `SELECT record_type, restore_state FROM project_operation_records
         ORDER BY record_type`,
      ).all(),
    ).toMatchObject({
      results: expect.arrayContaining([
        { record_type: "actor", restore_state: "quarantined" },
        { record_type: "event-bundle", restore_state: "quarantined" },
        { record_type: "exception", restore_state: "quarantined" },
        { record_type: "policy", restore_state: "quarantined" },
        { record_type: "run", restore_state: "quarantined" },
      ]),
    });
    for (const table of [
      "project_operation_policies",
      "project_runs",
      "project_actors",
      "project_event_bundles",
      "project_exceptions",
      "project_lead_leases",
      "collaboration_grants",
    ]) {
      expect(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
  });
});

type R3Harness = {
  actorIds: string[];
  authorization: CollaborationAuthorizationContext;
  fixture: ProjectFixture;
  lease: { fencingToken: number; leaseId: string };
  runId: string;
  workItemId: string;
};

async function createR3Harness(actorCount: number): Promise<R3Harness> {
  const fixture = await createFixture();
  const authorization = await createLeadAuthorization(fixture);
  const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
    authorization,
    now: NOW,
    request: {
      idempotencyKey: `r3-claim-${crypto.randomUUID()}`,
      leadIdentity: leadIdentity("Synthetic provider-neutral lead"),
      leaseExpiresInSeconds: 600,
      projectId: fixture.projectId,
    },
  });
  const created = createWorkItemReceiptSchema.parse(
    await createLeadWorkItem(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 1,
      request: {
        fencingToken: lease.fencingToken,
        idempotencyKey: `r3-create-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        packetExpiresInSeconds: 600,
        projectId: fixture.projectId,
        requestedRole: { authority: "none", label: "elastic-run-actor" },
        workItemBrief: {
          constraints: ["Synthetic metadata only."],
          definitionOfDone: ["Exercise bounded elastic continuity."],
          objective: "Exercise the R3 elastic actor plane.",
          requestedOutput: "JSON",
        },
      },
    }),
  );
  const started = startElasticRunReceiptSchema.parse(
    await startLeadRun(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 2,
      request: {
        elastic: { profile: "owd-elastic-run-plane-v1" },
        fencingToken: lease.fencingToken,
        idempotencyKey: `r3-start-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: fixture.projectId,
        purpose: "coding",
        workItemId: created.workItemId,
      },
    }),
  );
  const run = runSchema.parse(started.run);
  const actorIds = Array.from({ length: actorCount }, () =>
    crypto.randomUUID(),
  );
  for (let offset = 0; offset < actorIds.length; offset += 16) {
    const slice = actorIds.slice(offset, offset + 16);
    await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 3 + offset / 16,
      request: {
        actors: slice.map((actorId, index) => ({
          actorId,
          claimedIdentity: `Synthetic actor ${offset + index + 1}`,
          lifetimeSeconds: 300,
          metadata: { syntheticLane: `${offset + index + 1}` },
          scopes: [
            "run.context.read",
            "run.bundle.submit",
            "run.review.submit",
          ],
        })),
        fencingToken: lease.fencingToken,
        idempotencyKey: `r3-register-${offset}-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: fixture.projectId,
        runId: run.runId,
        workItemId: created.workItemId,
      },
    });
  }
  return {
    actorIds,
    authorization,
    fixture,
    lease,
    runId: run.runId,
    workItemId: created.workItemId,
  };
}

function r3BundleBase(harness: R3Harness, actorId: string, now: number) {
  return {
    actorId,
    bundleId: crypto.randomUUID(),
    createdAt: now,
    format: "owd-event-bundle-v1" as const,
    normalizedRelativePath: null,
    projectId: harness.fixture.projectId,
    requestedActions: [] as Array<
      "authority-expansion" | "destructive-action" | "protected-path-access"
    >,
    runId: harness.runId,
    schemaVersion: 1 as const,
    visibility: "run-shared-unvetted" as const,
  };
}

describe("R3 elastic actor plane", () => {
  it("preserves solo parity and admits 24 actors in bounded batches without loss or duplicate records", async () => {
    const solo = await createR3Harness(1);
    expect(
      await env.DB.prepare(
        `SELECT active_actor_count, actor_record_count
         FROM project_elastic_planes WHERE run_id = ?`,
      )
        .bind(solo.runId)
        .first(),
    ).toMatchObject({ active_actor_count: 1, actor_record_count: 1 });
    const legacyContext = runContextSchema.parse(
      await getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: solo.authorization,
        now: NOW + 10,
        request: {
          projectId: solo.fixture.projectId,
          runId: solo.runId,
        },
      }),
    );
    expect(legacyContext.actors).toHaveLength(1);
    await expect(
      registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: solo.authorization,
        now: NOW + 10,
        request: {
          actorId: crypto.randomUUID(),
          claimedIdentity: "Legacy mutation must not bypass elastic slots",
          fencingToken: solo.lease.fencingToken,
          idempotencyKey: `r3-legacy-actor-${crypto.randomUUID()}`,
          leaseId: solo.lease.leaseId,
          lifetimeSeconds: 120,
          projectId: solo.fixture.projectId,
          runId: solo.runId,
          scopes: ["run.context.read"],
          workItemId: solo.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "submission_invalid" });
    await expect(
      submitRunBundle(env.DB, env.VAULT_STORAGE, {
        authorization: solo.authorization,
        now: NOW + 10,
        request: {
          bundle: {
            ...r3BundleBase(solo, solo.actorIds[0]!, NOW + 10),
            events: [
              {
                actorId: solo.actorIds[0]!,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional",
                runId: solo.runId,
                summary: "Legacy mutation must not bypass elastic accounting",
              },
            ],
          },
          fencingToken: solo.lease.fencingToken,
          idempotencyKey: `r3-legacy-bundle-${crypto.randomUUID()}`,
          leaseId: solo.lease.leaseId,
          projectId: solo.fixture.projectId,
          runId: solo.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "submission_invalid" });

    const loadStartedAt = performance.now();
    const elastic = await createR3Harness(24);
    const loadLatencyMs = Math.max(
      1,
      Math.ceil(performance.now() - loadStartedAt),
    );
    expect(
      await env.DB.prepare(
        `SELECT active_actor_count, actor_record_count
         FROM project_elastic_planes WHERE run_id = ?`,
      )
        .bind(elastic.runId)
        .first(),
    ).toMatchObject({ active_actor_count: 24, actor_record_count: 24 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT actor_id) AS distinct_count
         FROM project_actors WHERE run_id = ?`,
      )
        .bind(elastic.runId)
        .first(),
    ).toMatchObject({ count: 24, distinct_count: 24 });
    const legacyElasticContext = runContextSchema.parse(
      await getLeadRunContext(env.DB, env.VAULT_STORAGE, {
        authorization: elastic.authorization,
        now: NOW + 10,
        request: {
          projectId: elastic.fixture.projectId,
          runId: elastic.runId,
        },
      }),
    );
    expect(legacyElasticContext.actors).toHaveLength(8);
    await submitRunObservation(env.DB, env.VAULT_STORAGE, {
      authorization: elastic.authorization,
      now: NOW + 10,
      request: {
        fencingToken: elastic.lease.fencingToken,
        idempotencyKey: `r3-load-observation-${crypto.randomUUID()}`,
        leaseId: elastic.lease.leaseId,
        observation: {
          acceptedBundleCount: 0,
          activeActorCount: 24,
          actorCount: 24,
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          credentialsIncluded: false,
          deltaPageCount: 4,
          format: "owd-run-observation-v1",
          hiddenReasoningIncluded: false,
          measuredAt: NOW + 10,
          metadata: { retentionTier: "warm", retainUntil: NOW + 3_600 },
          observationId: crypto.randomUUID(),
          oauthStateIncluded: false,
          ownerActionCount: 2,
          p50LatencyMs: Math.max(1, Math.floor(loadLatencyMs / 2)),
          p95LatencyMs: loadLatencyMs,
          productionLogsIncluded: false,
          projectId: elastic.fixture.projectId,
          providerRuntimeIncluded: false,
          rawContentIncluded: false,
          rejectedCount: 0,
          retryCount: 0,
          runId: elastic.runId,
          schemaVersion: 1,
          terminalHistoryIncluded: false,
          transcriptsIncluded: false,
        },
        projectId: elastic.fixture.projectId,
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT actor_count, active_actor_count, owner_action_count,
          p50_latency_ms, p95_latency_ms, raw_content_included,
          transcripts_included, hidden_reasoning_included,
          terminal_history_included, credentials_included,
          oauth_state_included, provider_runtime_included,
          production_logs_included
         FROM project_run_observations WHERE run_id = ?`,
      )
        .bind(elastic.runId)
        .first(),
    ).toMatchObject({
      active_actor_count: 24,
      actor_count: 24,
      credentials_included: 0,
      hidden_reasoning_included: 0,
      oauth_state_included: 0,
      owner_action_count: 2,
      production_logs_included: 0,
      provider_runtime_included: 0,
      raw_content_included: 0,
      terminal_history_included: 0,
      transcripts_included: 0,
    });

    let cursor: string | undefined;
    const actorDeltaIds: string[] = [];
    do {
      const result = (await getRunDeltas(env.DB, env.VAULT_STORAGE, {
        authorization: elastic.authorization,
        now: NOW + 10,
        request: {
          cursor,
          limit: 7,
          mode: "delta",
          projectId: elastic.fixture.projectId,
          runId: elastic.runId,
        },
      })) as {
        page: {
          cursor: string | null;
          deltas: Array<{
            evidenceMetadata?: Record<string, string>;
            recordId: string;
            recordType: string;
            sequence: number;
          }>;
          hasMore: boolean;
        };
      };
      expect(result.page.deltas.map((delta) => delta.sequence)).toEqual(
        result.page.deltas
          .map((delta) => delta.sequence)
          .sort((left, right) => left - right),
      );
      actorDeltaIds.push(
        ...result.page.deltas
          .filter((delta) => delta.recordType === "actor")
          .map((delta) => delta.recordId),
      );
      for (const delta of result.page.deltas.filter(
        (candidate) => candidate.recordType === "actor",
      )) {
        expect(delta.evidenceMetadata?.syntheticLane).toMatch(/^\d+$/u);
      }
      cursor = result.page.cursor ?? undefined;
      if (!result.page.hasMore) break;
    } while (cursor !== undefined);
    expect(actorDeltaIds).toHaveLength(24);
    expect(new Set(actorDeltaIds).size).toBe(24);
  });

  it("admits 24 actors and eight budgeted bundles through concurrent retry waves without loss", async () => {
    const harness = await createR3Harness(0);
    const actorIds = Array.from({ length: 24 }, () => crypto.randomUUID());
    const registrationRequests = Array.from({ length: 6 }, (_, batchIndex) => ({
      actors: actorIds
        .slice(batchIndex * 4, batchIndex * 4 + 4)
        .map((actorId, actorIndex) => ({
          actorId,
          claimedIdentity: `Concurrent actor ${batchIndex * 4 + actorIndex + 1}`,
          lifetimeSeconds: 300,
          metadata: { concurrentBatch: `${batchIndex + 1}` },
          scopes: ["run.context.read" as const, "run.bundle.submit" as const],
        })),
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: `r3-concurrent-register-${batchIndex}-${crypto.randomUUID()}`,
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
      workItemId: harness.workItemId,
    }));
    let pendingRegistrations = [...registrationRequests];
    let registrationWaves = 0;
    while (pendingRegistrations.length > 0) {
      registrationWaves += 1;
      expect(registrationWaves).toBeLessThanOrEqual(8);
      const outcomes = await Promise.all(
        pendingRegistrations.map(async (request) => {
          try {
            await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
              authorization: harness.authorization,
              now: NOW + 20 + registrationWaves,
              request,
            });
            return { request, succeeded: true as const };
          } catch (error) {
            expect(error).toMatchObject({
              code: "backpressure",
              retry: { retryable: true },
            });
            return { request, succeeded: false as const };
          }
        }),
      );
      pendingRegistrations = outcomes.flatMap((outcome) =>
        outcome.succeeded ? [] : [outcome.request],
      );
    }
    expect(registrationWaves).toBeGreaterThan(1);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT actor_id) AS distinct_count
         FROM project_actors WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({ count: 24, distinct_count: 24 });

    const bundleRequests = actorIds.slice(0, 8).map((actorId, index) => ({
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: `r3-concurrent-bundle-${index}-${crypto.randomUUID()}`,
      items: [
        {
          bundle: {
            ...r3BundleBase(harness, actorId, NOW + 40),
            events: [
              {
                actorId,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional" as const,
                runId: harness.runId,
                summary: `Concurrent synthetic result ${index + 1}`,
              },
            ],
          },
          usage: {
            costMicrounits: 1,
            logicalUnits: 1,
            reportedBy: "synthetic-concurrent-harness",
          },
        },
      ],
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
    }));
    let pendingBundles = [...bundleRequests];
    let bundleWaves = 0;
    while (pendingBundles.length > 0) {
      bundleWaves += 1;
      expect(bundleWaves).toBeLessThanOrEqual(10);
      const outcomes = await Promise.all(
        pendingBundles.map(async (request) => {
          try {
            await submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
              authorization: harness.authorization,
              now: NOW + 40 + bundleWaves,
              request,
            });
            return { request, succeeded: true as const };
          } catch (error) {
            expect(error).toMatchObject({
              code: "backpressure",
              retry: { retryable: true },
            });
            return { request, succeeded: false as const };
          }
        }),
      );
      pendingBundles = outcomes.flatMap((outcome) =>
        outcome.succeeded ? [] : [outcome.request],
      );
    }
    expect(bundleWaves).toBeGreaterThan(1);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT bundle_id) AS distinct_count
         FROM project_event_bundles WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({ count: 8, distinct_count: 8 });
    expect(
      await env.DB.prepare(
        `SELECT logical_units_used, cost_microunits_used, accounting_version
         FROM project_run_budgets WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({
      accounting_version: 8,
      cost_microunits_used: 8,
      logical_units_used: 8,
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_run_budget_versions
         WHERE budget_id = (
           SELECT budget_id FROM project_run_budgets WHERE run_id = ?
         )`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({ count: 9 });
    expect(
      await env.DB.prepare(
        `SELECT record_type, COUNT(*) AS count,
          COUNT(DISTINCT record_id) AS distinct_count
         FROM project_run_deltas WHERE run_id = ?
         GROUP BY record_type ORDER BY record_type`,
      )
        .bind(harness.runId)
        .all(),
    ).toMatchObject({
      results: [
        { count: 24, distinct_count: 24, record_type: "actor" },
        { count: 8, distinct_count: 8, record_type: "budget" },
        { count: 8, distinct_count: 8, record_type: "event-bundle" },
      ],
    });

    const observationId = crypto.randomUUID();
    const concurrentObservationRequest = {
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: `r3-concurrent-replay-${crypto.randomUUID()}`,
      leaseId: harness.lease.leaseId,
      observation: {
        acceptedBundleCount: 8,
        activeActorCount: 24,
        actorCount: 24,
        authority: {
          liveAuthorityIncluded: false as const,
          restoredAuthorityAllowed: false as const,
        },
        credentialsIncluded: false as const,
        deltaPageCount: 1,
        format: "owd-run-observation-v1" as const,
        hiddenReasoningIncluded: false as const,
        measuredAt: NOW + 55,
        metadata: { retentionTier: "warm" as const, retainUntil: NOW + 3_600 },
        observationId,
        oauthStateIncluded: false as const,
        ownerActionCount: 2,
        p50LatencyMs: 1,
        p95LatencyMs: 2,
        productionLogsIncluded: false as const,
        projectId: harness.fixture.projectId,
        providerRuntimeIncluded: false as const,
        rawContentIncluded: false as const,
        rejectedCount: 0,
        retryCount: registrationWaves + bundleWaves - 2,
        runId: harness.runId,
        schemaVersion: 1 as const,
        terminalHistoryIncluded: false as const,
        transcriptsIncluded: false as const,
      },
      projectId: harness.fixture.projectId,
    };
    const exactRetries = await Promise.all(
      [0, 1].map(() =>
        submitRunObservation(env.DB, env.VAULT_STORAGE, {
          authorization: harness.authorization,
          now: NOW + 55,
          request: concurrentObservationRequest,
        }),
      ),
    );
    expect(
      exactRetries.map((result) => result.replayed ?? false).sort(),
    ).toEqual([false, true]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_run_observations
         WHERE observation_id = ?`,
      )
        .bind(observationId)
        .first(),
    ).toMatchObject({ count: 1 });
    await expect(
      submitRunObservation(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 56,
        request: {
          ...concurrentObservationRequest,
          idempotencyKey: `r3-duplicate-observation-${crypto.randomUUID()}`,
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("returns exact replays, rejects replay conflicts, and emits bounded capacity retry metadata", async () => {
    const harness = await createR3Harness(31);
    const idempotencyKey = `r3-final-actor-${crypto.randomUUID()}`;
    const request = {
      actors: [
        {
          actorId: crypto.randomUUID(),
          claimedIdentity: "Final synthetic actor",
          lifetimeSeconds: 300,
          scopes: ["run.context.read" as const],
        },
      ],
      fencingToken: harness.lease.fencingToken,
      idempotencyKey,
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
      workItemId: harness.workItemId,
    };
    expect(
      await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 20,
        request,
      }),
    ).toMatchObject({ replayed: false });
    expect(
      await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 20,
        request,
      }),
    ).toMatchObject({ replayed: true });
    await expect(
      registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 20,
        request: {
          ...request,
          actors: [
            {
              ...request.actors[0]!,
              claimedIdentity: "Changed replay payload",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 20,
        request: {
          ...request,
          actors: [
            {
              ...request.actors[0]!,
              actorId: crypto.randomUUID(),
            },
          ],
          idempotencyKey: `r3-capacity-${crypto.randomUUID()}`,
        },
      }),
    ).rejects.toMatchObject({
      code: "backpressure",
      retry: {
        reason: "capacity",
        reduceBatchTo: 1,
        retryAfterMs: 250,
        retryable: false,
      },
    });
  });

  it("keeps cursors Run-bound, replaces actors without widening scope, and resumes without Orca state", async () => {
    const first = await createR3Harness(2);
    const second = await createR3Harness(1);
    const firstPage = (await getRunDeltas(env.DB, env.VAULT_STORAGE, {
      authorization: first.authorization,
      now: NOW + 30,
      request: {
        limit: 1,
        mode: "delta",
        projectId: first.fixture.projectId,
        runId: first.runId,
      },
    })) as { page: { cursor: string } };
    await expect(
      getRunDeltas(env.DB, env.VAULT_STORAGE, {
        authorization: second.authorization,
        now: NOW + 30,
        request: {
          cursor: firstPage.page.cursor,
          mode: "delta",
          projectId: second.fixture.projectId,
          runId: second.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });

    const replacementId = crypto.randomUUID();
    const recovery = await recoverRunActor(env.DB, env.VAULT_STORAGE, {
      authorization: first.authorization,
      now: NOW + 31,
      request: {
        abandonedActorId: first.actorIds[0]!,
        allowedScopes: ["run.context.read", "run.bundle.submit"],
        detectedAt: NOW + 30,
        fencingToken: first.lease.fencingToken,
        idempotencyKey: `r3-recover-${crypto.randomUUID()}`,
        leaseId: first.lease.leaseId,
        projectId: first.fixture.projectId,
        reason: "abandoned",
        replacement: {
          actorId: replacementId,
          claimedIdentity: "Provider-neutral replacement",
          lifetimeSeconds: 120,
          scopes: ["run.context.read"],
        },
        runId: first.runId,
        workItemId: first.workItemId,
      },
    });
    expect(recovery).toMatchObject({
      recovery: {
        abandonedActorId: first.actorIds[0],
        replacementActorId: replacementId,
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT status FROM project_actors WHERE actor_id = ?`,
      )
        .bind(first.actorIds[0])
        .first(),
    ).toMatchObject({ status: "revoked" });

    const orcaProjection = {
      actorId: replacementId,
      authority: {
        liveAuthorityIncluded: false as const,
        restoredAuthorityAllowed: false as const,
      },
      branchRef: "codex/synthetic-r3",
      commitSha: "a".repeat(40),
      format: "owd-orca-projection-v1" as const,
      metadata: {
        retentionTier: "warm" as const,
        retainUntil: NOW + 3_600,
      },
      observedAt: NOW + 32,
      projectId: first.fixture.projectId,
      projectionId: crypto.randomUUID(),
      provider: "orca" as const,
      pullRequestRef: null,
      runId: first.runId,
      schemaVersion: 1 as const,
      sessionRef: "synthetic-session",
      worktreeRef: "/tmp/synthetic-worktree",
    };
    await projectRunOrcaMetadata(env.DB, env.VAULT_STORAGE, {
      authorization: first.authorization,
      now: NOW + 32,
      request: {
        fencingToken: first.lease.fencingToken,
        idempotencyKey: `r3-orca-${crypto.randomUUID()}`,
        leaseId: first.lease.leaseId,
        projectId: first.fixture.projectId,
        projection: orcaProjection,
      },
    });
    await expect(
      projectRunOrcaMetadata(env.DB, env.VAULT_STORAGE, {
        authorization: first.authorization,
        now: NOW + 32,
        request: {
          fencingToken: first.lease.fencingToken,
          idempotencyKey: `r3-orca-duplicate-${crypto.randomUUID()}`,
          leaseId: first.lease.leaseId,
          projectId: first.fixture.projectId,
          projection: orcaProjection,
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      projectRunOrcaMetadata(env.DB, env.VAULT_STORAGE, {
        authorization: first.authorization,
        now: NOW + 32,
        request: {
          fencingToken: first.lease.fencingToken,
          idempotencyKey: `r3-orca-revoked-${crypto.randomUUID()}`,
          leaseId: first.lease.leaseId,
          projectId: first.fixture.projectId,
          projection: {
            ...orcaProjection,
            actorId: first.actorIds[0]!,
            projectionId: crypto.randomUUID(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "actor_invalid" });
    await env.DB.prepare(
      `DELETE FROM project_orca_projections WHERE run_id = ?`,
    )
      .bind(first.runId)
      .run();
    expect(
      await revokeProjectLead(env.DB, {
        now: NOW + 33,
        projectId: first.fixture.projectId,
      }),
    ).toBe(true);
    const neutralAuthorization = await createLeadAuthorization(first.fixture, {
      clientId: "https://neutral.example/lead.json",
      now: NOW + 33,
      reuseFixtureGrant: false,
    });
    const neutralLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: neutralAuthorization,
      now: NOW + 33,
      request: {
        idempotencyKey: `r3-neutral-resume-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Non-Orca replacement lead"),
        leaseExpiresInSeconds: 120,
        projectId: first.fixture.projectId,
      },
    });
    expect(neutralLease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
    await expect(
      getRunDeltas(env.DB, env.VAULT_STORAGE, {
        authorization: neutralAuthorization,
        now: NOW + 33,
        request: {
          mode: "delta",
          projectId: first.fixture.projectId,
          runId: first.runId,
        },
      }),
    ).resolves.toMatchObject({ operation: "get_run_delta" });
  });

  it("replaces an expired actor without reviving it or restoring its scopes", async () => {
    const harness = await createR3Harness(1);
    const replacementId = crypto.randomUUID();
    await expect(
      recoverRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 400,
        request: {
          abandonedActorId: harness.actorIds[0]!,
          allowedScopes: ["run.context.read"],
          detectedAt: NOW + 399,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-expired-recovery-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          reason: "expired",
          replacement: {
            actorId: replacementId,
            claimedIdentity: "Expired actor replacement",
            lifetimeSeconds: 120,
            scopes: ["run.context.read"],
          },
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).resolves.toMatchObject({
      recovery: {
        abandonedActorId: harness.actorIds[0],
        replacementActorId: replacementId,
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT actor_id, scopes_json, status FROM project_actors
         WHERE run_id = ? ORDER BY issued_at, actor_id`,
      )
        .bind(harness.runId)
        .all(),
    ).toMatchObject({
      results: [
        { actor_id: harness.actorIds[0], status: "expired" },
        {
          actor_id: replacementId,
          scopes_json: '["run.context.read"]',
          status: "active",
        },
      ],
    });
    await expect(
      recoverRunActor(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 401,
        request: {
          abandonedActorId: harness.actorIds[0]!,
          allowedScopes: ["run.context.read"],
          detectedAt: NOW + 400,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-expired-recovery-replay-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          reason: "expired",
          replacement: {
            actorId: crypto.randomUUID(),
            claimedIdentity: "Invalid second replacement",
            lifetimeSeconds: 120,
            scopes: ["run.context.read"],
          },
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "actor_recovery_invalid" });

    const holeHarness = await createR3Harness(0);
    const originalIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
      authorization: holeHarness.authorization,
      now: NOW + 3,
      request: {
        actors: originalIds.map((actorId, index) => ({
          actorId,
          claimedIdentity: `Slot actor ${index + 1}`,
          lifetimeSeconds: index === 1 ? 100 : 500,
          scopes: ["run.context.read" as const],
        })),
        fencingToken: holeHarness.lease.fencingToken,
        idempotencyKey: `r3-slot-register-${crypto.randomUUID()}`,
        leaseId: holeHarness.lease.leaseId,
        projectId: holeHarness.fixture.projectId,
        runId: holeHarness.runId,
        workItemId: holeHarness.workItemId,
      },
    });
    const holeReplacementId = crypto.randomUUID();
    await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
      authorization: holeHarness.authorization,
      now: NOW + 200,
      request: {
        actors: [
          {
            actorId: holeReplacementId,
            claimedIdentity: "Reused active slot actor",
            lifetimeSeconds: 100,
            scopes: ["run.context.read"],
          },
        ],
        fencingToken: holeHarness.lease.fencingToken,
        idempotencyKey: `r3-slot-reuse-${crypto.randomUUID()}`,
        leaseId: holeHarness.lease.leaseId,
        projectId: holeHarness.fixture.projectId,
        runId: holeHarness.runId,
        workItemId: holeHarness.workItemId,
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT active_slot FROM project_elastic_actor_slots
         WHERE run_id = ? AND actor_id = ?`,
      )
        .bind(holeHarness.runId, holeReplacementId)
        .first(),
    ).toMatchObject({ active_slot: 2 });
  });

  it("accounts batch budgets and stores only aggregate privacy-safe observations", async () => {
    const harness = await createR3Harness(1);
    const bundleId = crypto.randomUUID();
    const secondBundleId = crypto.randomUUID();
    const request = {
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: `r3-bundles-${crypto.randomUUID()}`,
      items: [
        {
          bundle: {
            ...r3BundleBase(harness, harness.actorIds[0]!, NOW + 40),
            bundleId,
            events: [
              {
                actorId: harness.actorIds[0]!,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional" as const,
                runId: harness.runId,
                summary: "Synthetic bounded result",
              },
            ],
          },
          usage: {
            costMicrounits: 17,
            logicalUnits: 11,
            reportedBy: "synthetic-harness",
          },
        },
        {
          bundle: {
            ...r3BundleBase(harness, harness.actorIds[0]!, NOW + 40),
            bundleId: secondBundleId,
            events: [
              {
                actorId: harness.actorIds[0]!,
                claims: [],
                eventId: crypto.randomUUID(),
                eventType: "result.provisional" as const,
                runId: harness.runId,
                summary: "Second atomic budgeted bundle",
              },
            ],
          },
          usage: {
            costMicrounits: 19,
            logicalUnits: 13,
            reportedBy: "synthetic-harness",
          },
        },
      ],
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
    };
    expect(
      await submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 40,
        request,
      }),
    ).toMatchObject({
      bundleIds: [bundleId, secondBundleId],
      replayed: false,
    });
    expect(
      await submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 40,
        request,
      }),
    ).toMatchObject({
      bundleIds: [bundleId, secondBundleId],
      replayed: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT logical_units_used, cost_microunits_used, accounting_version
         FROM project_run_budgets WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({
      accounting_version: 2,
      cost_microunits_used: 36,
      logical_units_used: 24,
    });
    const budget = await env.DB.prepare(
      `SELECT budget_id FROM project_run_budgets WHERE run_id = ?`,
    )
      .bind(harness.runId)
      .first<{ budget_id: string }>();
    if (budget === null) throw new Error("R3 budget missing.");
    const directEntry = {
      actorId: harness.actorIds[0]!,
      authority: {
        liveAuthorityIncluded: false as const,
        restoredAuthorityAllowed: false as const,
      },
      budgetId: budget.budget_id,
      costMicrounits: 1,
      createdAt: NOW + 41,
      entryId: crypto.randomUUID(),
      format: "owd-budget-entry-v1" as const,
      harnessReported: true as const,
      logicalUnits: 1,
      metadata: { retentionTier: "warm" as const, retainUntil: NOW + 3_600 },
      projectId: harness.fixture.projectId,
      reportedBy: "synthetic-harness",
      runId: harness.runId,
      schemaVersion: 1 as const,
    };
    await expect(
      submitRunBudgetEntry(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 41,
        request: {
          entry: directEntry,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-budget-entry-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
        },
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      submitRunBudgetEntry(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 41,
        request: {
          entry: directEntry,
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-duplicate-budget-entry-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await submitRunObservation(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 41,
      request: {
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r3-observation-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        observation: {
          acceptedBundleCount: 2,
          activeActorCount: 1,
          actorCount: 1,
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          credentialsIncluded: false,
          deltaPageCount: 1,
          format: "owd-run-observation-v1",
          hiddenReasoningIncluded: false,
          measuredAt: NOW + 41,
          metadata: {
            retentionTier: "warm",
            retainUntil: NOW + 3_600,
          },
          observationId: crypto.randomUUID(),
          ownerActionCount: 2,
          oauthStateIncluded: false,
          p50LatencyMs: 3,
          p95LatencyMs: 9,
          productionLogsIncluded: false,
          projectId: harness.fixture.projectId,
          providerRuntimeIncluded: false,
          rawContentIncluded: false,
          rejectedCount: 0,
          retryCount: 1,
          runId: harness.runId,
          schemaVersion: 1,
          terminalHistoryIncluded: false,
          transcriptsIncluded: false,
        },
        projectId: harness.fixture.projectId,
      },
    });
    expect(
      await env.DB.prepare(
        `SELECT owner_action_count, raw_content_included,
          transcripts_included, credentials_included,
          provider_runtime_included FROM project_run_observations
         WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({
      credentials_included: 0,
      owner_action_count: 2,
      provider_runtime_included: 0,
      raw_content_included: 0,
      transcripts_included: 0,
    });
    await expect(getElasticOperationOverview(env.DB)).resolves.toMatchObject({
      runs: [
        expect.objectContaining({
          activeActorCount: 1,
          acceptedBundleCount: 2,
          ownerActionCount: 2,
          runId: harness.runId,
        }),
      ],
    });
  });

  it("raises durable budget/review Exceptions and never accepts the denied batch", async () => {
    const harness = await createR3Harness(2);
    const overBudgetId = crypto.randomUUID();
    await expect(
      submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 45,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-over-budget-${crypto.randomUUID()}`,
          items: [
            {
              bundle: {
                ...r3BundleBase(harness, harness.actorIds[0]!, NOW + 45),
                bundleId: overBudgetId,
                events: [
                  {
                    actorId: harness.actorIds[0]!,
                    claims: [],
                    eventId: crypto.randomUUID(),
                    eventType: "result.provisional",
                    runId: harness.runId,
                    summary: "Must be rejected before durable acceptance.",
                  },
                ],
              },
              usage: {
                costMicrounits: 0,
                logicalUnits: 1_000_001,
                reportedBy: "synthetic-harness",
              },
            },
          ],
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_event_bundles
         WHERE bundle_id = ?`,
      )
        .bind(overBudgetId)
        .first(),
    ).toMatchObject({ count: 0 });

    const reviewBundleId = crypto.randomUUID();
    await expect(
      submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 46,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-unrouted-review-${crypto.randomUUID()}`,
          items: [
            {
              bundle: {
                ...r3BundleBase(harness, harness.actorIds[1]!, NOW + 46),
                bundleId: reviewBundleId,
                events: [
                  {
                    actorId: harness.actorIds[1]!,
                    eventId: crypto.randomUUID(),
                    eventType: "review.completed",
                    findings: [],
                    runId: harness.runId,
                    summary: "Unrouted review must be denied.",
                    targetBundleId: crypto.randomUUID(),
                    verdict: "pass",
                  },
                ],
              },
              usage: {
                costMicrounits: 1,
                logicalUnits: 1,
                reportedBy: "synthetic-harness",
              },
            },
          ],
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
        },
      }),
    ).rejects.toMatchObject({ code: "review_independence" });
    const kinds = await env.DB.prepare(
      `SELECT kind FROM project_exceptions WHERE run_id = ? ORDER BY kind`,
    )
      .bind(harness.runId)
      .all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual([
      "budget-exhausted",
      "review-independence",
    ]);
  });

  it("rolls back every R3 projection when authority is revoked at commit time", async () => {
    const harness = await createR3Harness(1);
    const actorId = crypto.randomUUID();
    const commitRevokingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                `UPDATE collaboration_grants
                 SET status = 'revoked', revoked_at = ? WHERE id = ?`,
              )
              .bind(NOW + 47, harness.authorization.grantId)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(
      registerRunActorsBatch(commitRevokingDb, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 47,
        request: {
          actors: [
            {
              actorId,
              claimedIdentity: "Must roll back",
              lifetimeSeconds: 60,
              scopes: ["run.context.read"],
            },
          ],
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r3-commit-revoke-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.workItemId,
        },
      }),
    ).rejects.toBeTruthy();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_actors WHERE actor_id = ?`,
      )
        .bind(actorId)
        .first(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT active_actor_count, actor_record_count
         FROM project_elastic_planes WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({ active_actor_count: 1, actor_record_count: 1 });
  });

  it("exports every R3 body and restores it only as quarantined evidence", async () => {
    const harness = await createR3Harness(1);
    await submitRunObservation(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 50,
      request: {
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r3-restore-observation-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        observation: {
          acceptedBundleCount: 0,
          activeActorCount: 1,
          actorCount: 1,
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          credentialsIncluded: false,
          deltaPageCount: 1,
          format: "owd-run-observation-v1",
          hiddenReasoningIncluded: false,
          measuredAt: NOW + 50,
          metadata: { retentionTier: "warm", retainUntil: NOW + 3_600 },
          observationId: crypto.randomUUID(),
          oauthStateIncluded: false,
          ownerActionCount: 2,
          p50LatencyMs: 2,
          p95LatencyMs: 5,
          productionLogsIncluded: false,
          projectId: harness.fixture.projectId,
          providerRuntimeIncluded: false,
          rawContentIncluded: false,
          rejectedCount: 0,
          retryCount: 0,
          runId: harness.runId,
          schemaVersion: 1,
          terminalHistoryIncluded: false,
          transcriptsIncluded: false,
        },
        projectId: harness.fixture.projectId,
      },
    });
    const rows = await env.DB.prepare(
      `SELECT elastic_record_id, record_type, project_id, portable_object_id,
        body_object_key, content_sha256, byte_length
       FROM project_elastic_records WHERE project_id = ?
       ORDER BY record_type, elastic_record_id`,
    )
      .bind(harness.fixture.projectId)
      .all<{
        body_object_key: string;
        byte_length: number;
        content_sha256: string;
        elastic_record_id: string;
        portable_object_id: string;
        project_id: string;
        record_type:
          | "account"
          | "budget"
          | "budget-entry"
          | "delta"
          | "observation"
          | "orca"
          | "plane"
          | "recovery";
      }>();
    expect(new Set(rows.results.map((row) => row.record_type))).toEqual(
      new Set(["plane", "account", "budget", "delta", "observation"]),
    );
    const context = await getLeadRunContext(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 50,
      request: {
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 51,
      request: {
        acceptedDecisionIds: [],
        artifactIds: [],
        blockers: [],
        citationIds: [],
        completedWork: ["Captured the synthetic R3 portable export."],
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r3-portable-checkpoint-${crypto.randomUUID()}`,
        knownRejectedApproaches: [],
        leaseId: harness.lease.leaseId,
        nextAction: "Restore the R3 records as inert evidence.",
        openWork: [],
        packetId: context.workPacket.packetId,
        previousContinuityPointId: null,
        projectId: harness.fixture.projectId,
        risks: [],
        workItemId: harness.workItemId,
      },
    });
    const portable = await buildPortableContinuityBundle(
      env.DB,
      env.VAULT_STORAGE,
      harness.fixture.projectId,
    );
    const elasticFile = portable.files.find(
      (file) => file.path === "elastic-records.json",
    );
    expect(elasticFile).toBeDefined();
    expect(
      (
        JSON.parse(elasticFile?.text ?? "{}") as {
          records?: Array<{ elasticRecordId: string }>;
        }
      ).records?.map((record) => record.elasticRecordId),
    ).toEqual(
      expect.arrayContaining(rows.results.map((row) => row.elastic_record_id)),
    );
    expect(
      (
        JSON.parse(elasticFile?.text ?? "{}") as {
          records?: Array<{ elasticRecordId: string }>;
        }
      ).records,
    ).toHaveLength(rows.results.length);
    const estimate = await estimateCollaborationSnapshot(
      env.DB,
      "approved-and-unvetted",
    );
    expect(estimate.unvetted?.recordCount).toBeGreaterThanOrEqual(
      rows.results.length,
    );
    const bodies = new Map<string, Uint8Array>();
    for (const row of rows.results) {
      const object = await env.VAULT_STORAGE.get(row.body_object_key);
      if (object === null) throw new Error("R3 recovery body missing.");
      bodies.set(
        row.portable_object_id,
        new Uint8Array(await object.arrayBuffer()),
      );
    }
    const recordType = (value: (typeof rows.results)[number]["record_type"]) =>
      ({
        account: "elastic-account",
        budget: "run-budget",
        "budget-entry": "budget-entry",
        delta: "run-delta",
        observation: "run-observation",
        orca: "orca-projection",
        plane: "elastic-plane",
        recovery: "actor-recovery",
      })[value] as
        | "actor-recovery"
        | "budget-entry"
        | "elastic-account"
        | "elastic-plane"
        | "orca-projection"
        | "run-budget"
        | "run-delta"
        | "run-observation";
    const logicalBytes = rows.results.reduce(
      (sum, row) => sum + row.byte_length,
      0,
    );
    const manifest = snapshotIntelligenceManifestSchema.parse({
      approved: {
        classification: "approved",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes: 0,
        newlyStoredBytes: 0,
        recordCount: 0,
        records: [],
      },
      excludedAuthority: [
        "oauth-access-tokens",
        "oauth-refresh-tokens",
        "oauth-authorization-codes",
        "oauth-protocol-storage",
        "sessions",
        "passkeys",
        "pairing-secrets",
        "vault-credentials",
        "live-agent-grants",
        "recovery-private-keys",
        "harness-context",
        "provider-credentials",
        "runtime-caches",
      ],
      format: "owd-snapshot-intelligence-v1",
      requiredCapabilities: [
        APPROVED_INTELLIGENCE_CAPABILITY,
        QUARANTINED_INTELLIGENCE_CAPABILITY,
      ],
      schemaVersion: 1,
      selection: "approved-and-unvetted",
      unvetted: {
        classification: "unvetted",
        evidenceObjectCount: 0,
        evidenceObjects: [],
        logicalBytes,
        newlyStoredBytes: logicalBytes,
        recordCount: rows.results.length,
        records: rows.results.map((row) => ({
          byteLength: row.byte_length,
          classification: "unvetted",
          contentSha256: row.content_sha256,
          dependencies: [],
          evidenceOnly: false,
          originalState: {
            disposition: "pending",
            visibility: "owner-only",
          },
          portableObjectId: row.portable_object_id,
          projectId: row.project_id,
          recordId: row.elastic_record_id,
          recordType: recordType(row.record_type),
          restoreDisposition: "restore-quarantined",
          schemaVersion: 1,
          workItemId: null,
        })),
      },
    });
    await resetState();
    let restore = await createCollaborationRestore(
      env.DB,
      { manifest },
      NOW + 51,
    );
    for (const descriptor of manifest.unvetted?.records ?? []) {
      const bytes = bodies.get(descriptor.portableObjectId);
      if (bytes === undefined) throw new Error("R3 recovery body not staged.");
      restore = await stageCollaborationRestoreItem(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        {
          bytesBase64Url: encodeBase64Url(bytes),
          portableObjectId: descriptor.portableObjectId,
        },
      );
    }
    expect(restore.status).toBe("preview");
    await expect(
      applyCollaborationRestore(
        env.DB,
        env.VAULT_STORAGE,
        restore.restoreId,
        NOW + 52,
      ),
    ).resolves.toMatchObject({ grantCount: 0, status: "applied" });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_elastic_records
         WHERE restore_state = 'quarantined'
           AND restored_authority_allowed = 0 AND live_authority_included = 0`,
      ).first(),
    ).toMatchObject({ count: rows.results.length });
    const restoredIds = await env.DB.prepare(
      `SELECT elastic_record_id FROM project_elastic_records
       ORDER BY elastic_record_id`,
    ).all<{ elastic_record_id: string }>();
    expect(restoredIds.results.map((row) => row.elastic_record_id)).toEqual(
      rows.results.map((row) => row.elastic_record_id).sort(),
    );
    for (const table of [
      "project_elastic_planes",
      "project_elastic_accounts",
      "project_elastic_actor_slots",
      "project_actor_recoveries",
      "project_run_budgets",
      "project_run_budget_versions",
      "project_run_budget_entries",
      "project_run_observations",
      "project_orca_projections",
      "project_run_deltas",
      "project_runs",
      "project_actors",
      "project_lead_leases",
      "collaboration_grants",
    ]) {
      expect(
        (
          await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
            count: number;
          }>()
        )?.count,
      ).toBe(0);
    }
  });

  it("performs bounded tier cleanup only after a Run closes", async () => {
    const harness = await createR3Harness(1);
    const observationId = crypto.randomUUID();
    const budget = await env.DB.prepare(
      `SELECT budget_id FROM project_run_budgets WHERE run_id = ?`,
    )
      .bind(harness.runId)
      .first<{ budget_id: string }>();
    if (budget === null) throw new Error("R3 retention budget missing.");
    await submitRunBudgetEntry(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 60,
      request: {
        entry: {
          actorId: harness.actorIds[0]!,
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          budgetId: budget.budget_id,
          costMicrounits: 1,
          createdAt: NOW + 60,
          entryId: crypto.randomUUID(),
          format: "owd-budget-entry-v1",
          harnessReported: true,
          logicalUnits: 1,
          metadata: { retentionTier: "hot", retainUntil: NOW + 61 },
          projectId: harness.fixture.projectId,
          reportedBy: "synthetic-retention-harness",
          runId: harness.runId,
          schemaVersion: 1,
        },
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r3-retention-budget-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
      },
    });
    await submitRunObservation(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 60,
      request: {
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r3-retention-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        observation: {
          acceptedBundleCount: 0,
          activeActorCount: 1,
          actorCount: 1,
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          credentialsIncluded: false,
          deltaPageCount: 0,
          format: "owd-run-observation-v1",
          hiddenReasoningIncluded: false,
          measuredAt: NOW + 60,
          metadata: { retentionTier: "hot", retainUntil: NOW + 61 },
          observationId,
          oauthStateIncluded: false,
          ownerActionCount: 1,
          p50LatencyMs: 1,
          p95LatencyMs: 1,
          productionLogsIncluded: false,
          projectId: harness.fixture.projectId,
          providerRuntimeIncluded: false,
          rawContentIncluded: false,
          rejectedCount: 0,
          retryCount: 0,
          runId: harness.runId,
          schemaVersion: 1,
          terminalHistoryIncluded: false,
          transcriptsIncluded: false,
        },
        projectId: harness.fixture.projectId,
      },
    });
    expect(await runElasticRetention(env.DB, NOW + 62)).toBe(0);
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
        "e".repeat(64),
        NOW + 61,
        crypto.randomUUID(),
        NOW + 61,
      )
      .run();
    await stageCollaborationSnapshot(env.DB, {
      now: NOW + 61,
      selection: "approved-and-unvetted",
      snapshotId,
    });
    await env.DB.prepare(
      `UPDATE project_runs SET status = 'aborted' WHERE run_id = ?`,
    )
      .bind(harness.runId)
      .run();
    expect(await runElasticRetention(env.DB, NOW + 62)).toBe(0);
    await env.DB.prepare(
      `DELETE FROM snapshot_intelligence_items WHERE snapshot_id = ?`,
    )
      .bind(snapshotId)
      .run();
    expect(await runElasticRetention(env.DB, NOW + 62)).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_run_observations
         WHERE observation_id = ?`,
      )
        .bind(observationId)
        .first(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_run_budget_entries
         WHERE budget_id = ?`,
      )
        .bind(budget.budget_id)
        .first(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_run_budget_versions
         WHERE budget_id = ?`,
      )
        .bind(budget.budget_id)
        .first(),
    ).toMatchObject({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_elastic_planes
         WHERE run_id = ?`,
      )
        .bind(harness.runId)
        .first(),
    ).toMatchObject({ count: 1 });
  });
});

type R4Harness = {
  actors: [string, string, string];
  authorization: CollaborationAuthorizationContext;
  elastic: boolean;
  fixture: ProjectFixture;
  lease: { fencingToken: number; leaseId: string };
  purpose: "coding" | "research";
  runId: string;
};

async function createR4Harness(
  purpose: "coding" | "research",
  elastic = false,
  drillIntervalSeconds = 604_800,
): Promise<R4Harness> {
  const fixture = await createEvidenceFixture();
  const authorization = await createLeadAuthorization(fixture);
  const lease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
    authorization,
    now: NOW + 2,
    request: {
      idempotencyKey: `r4-claim-${purpose}-${crypto.randomUUID()}`,
      leadIdentity: leadIdentity(`Synthetic R4 ${purpose} lead`),
      leaseExpiresInSeconds: 600,
      projectId: fixture.projectId,
    },
  });
  const started = await startLeadRun(env.DB, env.VAULT_STORAGE, {
    authorization,
    now: NOW + 3,
    request: {
      ...(elastic ? { elastic: { profile: "owd-elastic-run-plane-v1" } } : {}),
      fencingToken: lease.fencingToken,
      idempotencyKey: `r4-start-${purpose}-${crypto.randomUUID()}`,
      leaseId: lease.leaseId,
      projectId: fixture.projectId,
      purpose,
      workItemId: fixture.workItemId,
    },
  });
  const run = runSchema.parse(started.run);
  const actors: [string, string, string] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  const scopes = [
    ["run.context.read", "run.bundle.submit"],
    ["run.context.read", "run.bundle.submit"],
    ["run.context.read", "run.review.submit"],
  ] as const;
  if (elastic) {
    await registerRunActorsBatch(env.DB, env.VAULT_STORAGE, {
      authorization,
      now: NOW + 4,
      request: {
        actors: actors.map((actorId, index) => ({
          actorId,
          claimedIdentity: `Synthetic R4 actor ${index + 1}`,
          lifetimeSeconds: 300,
          scopes: [...scopes[index]!],
        })),
        fencingToken: lease.fencingToken,
        idempotencyKey: `r4-elastic-actors-${purpose}-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: fixture.projectId,
        runId: run.runId,
        workItemId: fixture.workItemId,
      },
    });
  } else {
    for (let index = 0; index < actors.length; index += 1) {
      await registerRunActor(env.DB, env.VAULT_STORAGE, {
        authorization,
        now: NOW + 4 + index,
        request: {
          actorId: actors[index],
          claimedIdentity: `Synthetic R4 actor ${index + 1}`,
          fencingToken: lease.fencingToken,
          idempotencyKey: `r4-actor-${purpose}-${index}-${crypto.randomUUID()}`,
          leaseId: lease.leaseId,
          lifetimeSeconds: 300,
          projectId: fixture.projectId,
          runId: run.runId,
          scopes: [...scopes[index]!],
          workItemId: fixture.workItemId,
        },
      });
    }
  }
  await activateProjectPolicyBinding(
    env.DB,
    env.VAULT_STORAGE,
    {
      checkpointIntervalSeconds: 3_600,
      drillIntervalSeconds,
      projectId: fixture.projectId,
    },
    NOW + 7,
  );
  return {
    actors,
    authorization,
    elastic,
    fixture,
    lease,
    purpose,
    runId: run.runId,
  };
}

function r4BundleBase(harness: R4Harness, actorId: string, createdAt: number) {
  return {
    actorId,
    bundleId: crypto.randomUUID(),
    createdAt,
    format: "owd-event-bundle-v1" as const,
    normalizedRelativePath: null,
    projectId: harness.fixture.projectId,
    requestedActions: [] as Array<
      "authority-expansion" | "destructive-action" | "protected-path-access"
    >,
    runId: harness.runId,
    schemaVersion: 1 as const,
    visibility: "run-shared-unvetted" as const,
  };
}

async function submitR4Bundle(
  harness: R4Harness,
  bundle: ReturnType<typeof r4BundleBase> & { events: unknown[] },
  now: number,
  idempotencyKey: string,
): Promise<void> {
  if (harness.elastic) {
    await submitRunBundlesBatch(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now,
      request: {
        fencingToken: harness.lease.fencingToken,
        idempotencyKey,
        items: [
          {
            bundle,
            usage: {
              costMicrounits: 1,
              logicalUnits: 1,
              reportedBy: "synthetic-r4-evidence-harness",
            },
          },
        ],
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
        runId: harness.runId,
      },
    });
    return;
  }
  await submitRunBundle(env.DB, env.VAULT_STORAGE, {
    authorization: harness.authorization,
    now,
    request: {
      bundle,
      fencingToken: harness.lease.fencingToken,
      idempotencyKey,
      leaseId: harness.lease.leaseId,
      projectId: harness.fixture.projectId,
      runId: harness.runId,
    },
  });
}

async function stageR4AcceptedEvidence(harness: R4Harness): Promise<void> {
  const [producerId, coordinatorId, reviewerId] = harness.actors;
  const evidence = harness.fixture.packet.evidenceObjects[0];
  if (evidence === undefined) throw new Error("R4 packet evidence missing.");
  const keys =
    harness.purpose === "research"
      ? ["research.finding", "research.source"]
      : ["coding.change", "coding.validation"];
  const provisional = {
    ...r4BundleBase(harness, producerId, NOW + 8),
    events: [
      {
        actorId: producerId,
        claims: keys.map((key, index) => ({
          evidenceSha256: evidence.contentSha256,
          key,
          valueSha256: index === 0 ? "a".repeat(64) : "b".repeat(64),
        })),
        eventId: crypto.randomUUID(),
        eventType: "result.provisional" as const,
        runId: harness.runId,
        summary: `Bounded synthetic ${harness.purpose} evidence is ready.`,
      },
    ],
  };
  await submitR4Bundle(
    harness,
    provisional,
    NOW + 8,
    `r4-evidence-${harness.purpose}-${crypto.randomUUID()}`,
  );
  const reviewRequest = {
    ...r4BundleBase(harness, coordinatorId, NOW + 9),
    events: [
      {
        actorId: coordinatorId,
        eventId: crypto.randomUUID(),
        eventType: "review.requested" as const,
        reviewerActorId: reviewerId,
        runId: harness.runId,
        targetBundleId: provisional.bundleId,
      },
    ],
  };
  await submitR4Bundle(
    harness,
    reviewRequest,
    NOW + 9,
    `r4-review-request-${crypto.randomUUID()}`,
  );
  await submitR4Bundle(
    harness,
    {
      ...r4BundleBase(harness, reviewerId, NOW + 10),
      events: [
        {
          actorId: reviewerId,
          eventId: crypto.randomUUID(),
          eventType: "review.completed" as const,
          findings: [],
          runId: harness.runId,
          summary: "Independent deterministic evidence review passed.",
          targetBundleId: provisional.bundleId,
          verdict: "pass" as const,
        },
      ],
    },
    NOW + 10,
    `r4-review-result-${crypto.randomUUID()}`,
  );
  await checkpointProject(env.DB, env.VAULT_STORAGE, {
    authorization: harness.authorization,
    now: NOW + 11,
    request: {
      acceptedDecisionIds: [],
      artifactIds: [],
      blockers: [],
      citationIds: [],
      completedWork: ["Bounded evidence passed independent review."],
      fencingToken: harness.lease.fencingToken,
      idempotencyKey: `r4-checkpoint-${crypto.randomUUID()}`,
      knownRejectedApproaches: ["Self-approval and policy editing."],
      leaseId: harness.lease.leaseId,
      nextAction: "Evaluate the standing deterministic policy.",
      openWork: [],
      packetId: harness.fixture.packet.packetId,
      previousContinuityPointId: null,
      projectId: harness.fixture.projectId,
      risks: [],
      workItemId: harness.fixture.workItemId,
    },
  });
}

function syntheticContinuityReceipt(input: {
  acknowledgedAt: number;
  drillId: string;
  emittedAt: number;
  leadLossAt: number;
  productiveAt: number;
  projectId: string;
  receiptId: string;
  restoredContinuityPointId: string;
}) {
  return continuityReceiptSchema.parse({
    authority: {
      actorAuthorityIncluded: false,
      credentialAuthorityIncluded: false,
      grantAuthorityIncluded: false,
      leaseAuthorityIncluded: false,
      liveAuthorityIncluded: false,
      oauthAuthorityIncluded: false,
      policyAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
      schedulerAuthorityIncluded: false,
    },
    cleanup: {
      completed: true,
      remainingAuthorityCount: 0,
      temporaryObjectsRemoved: 4,
    },
    disposable: true,
    drillId: input.drillId,
    emittedAt: input.emittedAt,
    format: "owd-continuity-receipt-v1",
    freshCommunityInstall: true,
    leadReplaced: true,
    metrics: {
      continuityAgeSeconds: input.emittedAt - input.acknowledgedAt,
      recoveryChecksPassed: 8,
      recoveryChecksTotal: 8,
      recoveryQualityBps: 10_000,
      rpoSeconds: Math.max(0, input.leadLossAt - input.acknowledgedAt),
      rtoSeconds: input.productiveAt - input.leadLossAt,
      runtimeIndependent: true,
    },
    outcome: "pass",
    projectId: input.projectId,
    receiptId: input.receiptId,
    redaction: {
      credentialsIncluded: false,
      customerDataIncluded: false,
      filenamesIncluded: false,
      hiddenReasoningIncluded: false,
      hostnamesIncluded: false,
      oauthStateIncluded: false,
      productionLogsIncluded: false,
      providerRuntimeIncluded: false,
      rawBodiesIncluded: false,
      terminalHistoryIncluded: false,
      transcriptsIncluded: false,
    },
    restoredContinuityPointId: input.restoredContinuityPointId,
    schemaVersion: 1,
    sourceTimes: {
      latestAcknowledgedPointAt: input.acknowledgedAt,
      receiptEmittedAt: input.emittedAt,
      replacementProductiveAt: input.productiveAt,
      restoredPointAcknowledgedAt: input.acknowledgedAt,
      simulatedLeadLossAt: input.leadLossAt,
    },
  });
}

async function seedContinuityReceipt(
  receipt: ContinuityReceipt,
  now: number,
): Promise<ContinuityReceipt> {
  const prepared = await preparePolicyOperationalRecord(env.VAULT_STORAGE, {
    now,
    record: receipt,
  });
  await env.DB.batch([
    insertPolicyOperationalRecordStatement(env.DB, prepared),
    env.DB.prepare(
      `INSERT INTO project_continuity_drill_receipts (
        receipt_id, operational_record_id, project_id, drill_id,
        restored_continuity_point_id, outcome, rpo_seconds, rto_seconds,
        continuity_age_seconds, recovery_quality_bps, recovery_checks_passed,
        recovery_checks_total, runtime_independent, redacted,
        remaining_authority_count, emitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    ).bind(
      receipt.receiptId,
      receipt.receiptId,
      receipt.projectId,
      receipt.drillId,
      receipt.restoredContinuityPointId,
      receipt.outcome,
      receipt.metrics.rpoSeconds,
      receipt.metrics.rtoSeconds,
      receipt.metrics.continuityAgeSeconds,
      receipt.metrics.recoveryQualityBps,
      receipt.metrics.recoveryChecksPassed,
      receipt.metrics.recoveryChecksTotal,
      receipt.metrics.runtimeIndependent ? 1 : 0,
      receipt.emittedAt,
    ),
    insertOperationalDependencyStatement(env.DB, {
      dependencyId: receipt.restoredContinuityPointId,
      dependencyKind: "record",
      operationalRecordId: receipt.receiptId,
    }),
  ]);
  return receipt;
}

describe("R4 policy autopilot and operational continuity", () => {
  it("completes one synthetic research Run and one coding Run without routine owner action", async () => {
    for (const purpose of ["research", "coding"] as const) {
      const harness = await createR4Harness(purpose);
      await stageR4AcceptedEvidence(harness);
      const evaluation = evaluateRunPolicyReceiptSchema.parse(
        await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
          authorization: harness.authorization,
          now: NOW + 12,
          request: {
            fencingToken: harness.lease.fencingToken,
            idempotencyKey: `r4-evaluate-${purpose}-${crypto.randomUUID()}`,
            leaseId: harness.lease.leaseId,
            normalizedRelativePath: null,
            projectId: harness.fixture.projectId,
            requestedOwnerActions: [],
            runId: harness.runId,
            workItemId: harness.fixture.workItemId,
          },
        }),
      );
      expect(evaluation.decision).toMatchObject({
        outcome: "allow",
        purpose,
        requestedOwnerActions: [],
      });
      expect(evaluation.decision.checks.every((check) => check.passed)).toBe(
        true,
      );
      if (purpose === "research") {
        const portable = await buildPortableOperationalExport(
          env.DB,
          env.VAULT_STORAGE,
          harness.fixture.projectId,
        );
        expect(portable.records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              operationalRecordId: evaluation.decision.decisionId,
              dependencies: expect.arrayContaining([
                expect.objectContaining({ dependencyKind: "evidence" }),
                expect.objectContaining({ dependencyKind: "record" }),
              ]),
            }),
          ]),
        );
        expect(portable.referencedBodies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              dependencyId:
                harness.fixture.packet.evidenceObjects[0]!.evidenceObjectId,
              dependencyKind: "evidence",
            }),
          ]),
        );
      }
      const completion = completeWorkItemReceiptSchema.parse(
        await completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
          authorization: harness.authorization,
          now: NOW + 13,
          request: {
            fencingToken: harness.lease.fencingToken,
            idempotencyKey: `r4-complete-${purpose}-${crypto.randomUUID()}`,
            leaseId: harness.lease.leaseId,
            outcome: `Synthetic ${purpose} Run completed under standing policy.`,
            projectId: harness.fixture.projectId,
            runId: harness.runId,
            workItemId: harness.fixture.workItemId,
          },
        }),
      );
      expect(completion.completed).toBe(true);
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM project_exceptions
           WHERE project_id = ?`,
        )
          .bind(harness.fixture.projectId)
          .first(),
      ).toMatchObject({ count: 0 });
    }
  });

  it("fails policy editing and self-approval closed as explicit Exceptions", async () => {
    const harness = await createR4Harness("coding");
    await expect(
      activateProjectPolicyBinding(
        env.DB,
        env.VAULT_STORAGE,
        {
          checkpointIntervalSeconds: 7_200,
          drillIntervalSeconds: 604_800,
          projectId: harness.fixture.projectId,
        },
        NOW + 8,
      ),
    ).rejects.toMatchObject({ code: "policy_edit_forbidden" });
    await stageR4AcceptedEvidence(harness);
    const denied = evaluateRunPolicyReceiptSchema.parse(
      await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 12,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-self-approval-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: ["self-approval"],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    );
    expect(denied.decision).toMatchObject({
      exceptionReason: "self-approval",
      outcome: "exception",
    });
    await expect(
      completeLeadWorkItem(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 13,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-denied-complete-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          outcome: "Must remain incomplete.",
          projectId: harness.fixture.projectId,
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "exception_blocking" });
  });

  it("supersedes the old binding and pauses its schedule on Project version change", async () => {
    const harness = await createR4Harness("research");
    const initial = getPolicyOperationsReceiptSchema.parse(
      await getPolicyOperations(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 8,
        request: { projectId: harness.fixture.projectId },
      }),
    );
    expect(initial.binding).not.toBeNull();
    expect(initial.schedule).not.toBeNull();

    const currentVersion = await readCollaborationRecord(
      env.DB,
      env.VAULT_STORAGE,
      initial.binding!.projectVersionId,
    );
    const currentPolicy = await readLeadOperationRecord(
      env.DB,
      env.VAULT_STORAGE,
      initial.binding!.policyId,
    );
    if (
      currentVersion?.record.recordType !== "project-version" ||
      currentPolicy?.format !== "owd-project-policy-v1"
    ) {
      throw new Error("R4 standing inputs missing.");
    }

    const projectVersionId = crypto.randomUUID();
    const policyId = crypto.randomUUID();
    const nextVersion = {
      ...currentVersion.record,
      createdAt: NOW + 20,
      previousVersionId: currentVersion.record.projectVersionId,
      projectVersionId,
      version: currentVersion.record.version + 1,
    };
    const nextPolicy = {
      ...currentPolicy,
      createdAt: NOW + 20,
      policyId,
      projectVersionId,
    };
    const preparedVersion = await prepareCollaborationRecord(
      env.VAULT_STORAGE,
      {
        now: NOW + 20,
        record: nextVersion,
      },
    );
    const preparedPolicy = await prepareLeadOperationRecord(env.VAULT_STORAGE, {
      now: NOW + 20,
      record: nextPolicy,
    });
    await env.DB.batch([
      insertRecordStatement(env.DB, preparedVersion),
      insertStateStatement(env.DB, {
        changedAt: NOW + 20,
        disposition: "accepted",
        recordId: projectVersionId,
        visibility: "owner-only",
      }),
      insertLeadOperationRecordStatement(env.DB, preparedPolicy),
      env.DB.prepare(
        `INSERT INTO project_operation_policies (
          policy_id, operation_record_id, project_id, project_version_id,
          max_actors_per_run, max_bundles_per_run, max_events_per_bundle,
          max_bundle_bytes, max_run_logical_bytes, independent_review_required
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(
        policyId,
        policyId,
        harness.fixture.projectId,
        projectVersionId,
        nextPolicy.maxActorsPerRun,
        nextPolicy.maxBundlesPerRun,
        nextPolicy.maxEventsPerBundle,
        nextPolicy.maxBundleBytes,
        nextPolicy.maxRunLogicalBytes,
      ),
      env.DB.prepare(
        `UPDATE collaboration_projects
         SET active_project_version_id = ?
         WHERE project_id = ?`,
      ).bind(projectVersionId, harness.fixture.projectId),
    ]);

    const replacement = await activateProjectPolicyBinding(
      env.DB,
      env.VAULT_STORAGE,
      {
        checkpointIntervalSeconds: initial.binding!.checkpointIntervalSeconds,
        drillIntervalSeconds: initial.binding!.drillIntervalSeconds,
        projectId: harness.fixture.projectId,
      },
      NOW + 21,
    );
    expect(replacement).toMatchObject({
      policyId,
      projectVersionId,
    });
    expect(replacement.bindingId).not.toBe(initial.binding!.bindingId);
    expect(
      await env.DB.prepare(
        `SELECT status FROM project_policy_bindings WHERE binding_id = ?`,
      )
        .bind(initial.binding!.bindingId)
        .first(),
    ).toMatchObject({ status: "superseded" });
    expect(
      await env.DB.prepare(
        `SELECT status FROM project_operational_schedules WHERE schedule_id = ?`,
      )
        .bind(initial.schedule!.scheduleId)
        .first(),
    ).toMatchObject({ status: "paused" });
  });

  it("fails missing evidence and cross-Project access closed", async () => {
    const harness = await createR4Harness("research");
    const denied = evaluateRunPolicyReceiptSchema.parse(
      await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 8,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-missing-evidence-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    );
    expect(denied.decision).toMatchObject({
      exceptionReason: "integrity-failure",
      outcome: "exception",
    });
    expect(
      denied.decision.checks.find((check) => check.key === "purpose-evidence"),
    ).toMatchObject({ passed: false });

    const otherProject = await createEvidenceFixture();
    await expect(
      evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 9,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-cross-project-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: otherProject.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "grant_invalid" });
  });

  it("rolls back a policy Decision when lead authority is revoked at commit time", async () => {
    const harness = await createR4Harness("coding");
    await stageR4AcceptedEvidence(harness);
    const commitRevokingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                `UPDATE collaboration_grants
                 SET status = 'revoked', revoked_at = ? WHERE id = ?`,
              )
              .bind(NOW + 12, harness.authorization.grantId)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(
      evaluateRunPolicy(commitRevokingDb, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 12,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-revoked-decision-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    ).rejects.toBeTruthy();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_policy_decisions
         WHERE project_id = ?`,
      )
        .bind(harness.fixture.projectId)
        .first(),
    ).toMatchObject({ count: 0 });
  });

  it("turns an exhausted elastic budget into an explicit Exception", async () => {
    const harness = await createR4Harness("coding", true);
    await stageR4AcceptedEvidence(harness);
    const budget = await env.DB.prepare(
      `SELECT budget_id, logical_unit_limit, logical_units_used,
        cost_microunit_limit, cost_microunits_used
       FROM project_run_budgets WHERE run_id = ?`,
    )
      .bind(harness.runId)
      .first<{
        budget_id: string;
        cost_microunit_limit: number;
        cost_microunits_used: number;
        logical_unit_limit: number;
        logical_units_used: number;
      }>();
    expect(budget).not.toBeNull();
    await submitRunBudgetEntry(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 12,
      request: {
        entry: {
          actorId: harness.actors[0],
          authority: {
            liveAuthorityIncluded: false,
            restoredAuthorityAllowed: false,
          },
          budgetId: budget!.budget_id,
          costMicrounits:
            budget!.cost_microunit_limit - budget!.cost_microunits_used,
          createdAt: NOW + 12,
          entryId: crypto.randomUUID(),
          format: "owd-budget-entry-v1",
          harnessReported: true,
          logicalUnits: budget!.logical_unit_limit - budget!.logical_units_used,
          metadata: { retentionTier: "warm", retainUntil: NOW + 3_600 },
          projectId: harness.fixture.projectId,
          reportedBy: "synthetic-r4-budget-harness",
          runId: harness.runId,
          schemaVersion: 1,
        },
        fencingToken: harness.lease.fencingToken,
        idempotencyKey: `r4-exhaust-budget-${crypto.randomUUID()}`,
        leaseId: harness.lease.leaseId,
        projectId: harness.fixture.projectId,
      },
    });
    const denied = evaluateRunPolicyReceiptSchema.parse(
      await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 13,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-budget-decision-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    );
    expect(denied.decision).toMatchObject({
      exceptionReason: "budget-exhaustion",
      outcome: "exception",
    });
  });

  it("detects body tampering and keeps referenced operational evidence", async () => {
    const harness = await createR4Harness("research");
    await stageR4AcceptedEvidence(harness);
    const evidence = harness.fixture.packet.evidenceObjects[0]!;
    const content = await env.DB.prepare(
      `SELECT object_key FROM collaboration_content_objects WHERE id = ?`,
    )
      .bind(evidence.evidenceObjectId)
      .first<{ object_key: string }>();
    expect(content).not.toBeNull();
    await env.VAULT_STORAGE.put(
      content!.object_key,
      encoder.encode("synthetic tampering"),
      { customMetadata: { sha256: "0".repeat(64) } },
    );
    for (const renewedAt of [500, 1_300, 2_100, 2_900]) {
      await renewProjectLead(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + renewedAt,
        request: {
          fencingToken: harness.lease.fencingToken,
          leaseExpiresInSeconds: 900,
          leaseId: harness.lease.leaseId,
          projectId: harness.fixture.projectId,
        },
      });
    }
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      NOW + 7 + 3_600,
    );
    expect(
      await env.DB.prepare(
        `SELECT status, mismatched_count FROM project_operational_integrity_reports
         WHERE project_id = ? ORDER BY measured_at DESC LIMIT 1`,
      )
        .bind(harness.fixture.projectId)
        .first(),
    ).toMatchObject({ mismatched_count: 1, status: "degraded" });
    const denied = evaluateRunPolicyReceiptSchema.parse(
      await evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 7 + 3_601,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-tamper-decision-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    );
    expect(denied.decision).toMatchObject({
      exceptionReason: "integrity-failure",
      outcome: "exception",
    });

    const retention = await env.DB.prepare(
      `SELECT record.operational_record_id, record.received_at,
        dependency.operational_record_id AS referencing_record_id
       FROM project_operational_records record
       JOIN project_operational_dependencies dependency
         ON dependency.dependency_id = record.operational_record_id
       WHERE project_id = ? AND record_type = 'evidence'
         AND NOT EXISTS (
           SELECT 1 FROM project_operational_integrity_reports report
           WHERE report.operational_record_id = record.operational_record_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_operational_requests request
           WHERE request.operational_record_id = record.operational_record_id
         )
       ORDER BY record.received_at, record.operational_record_id LIMIT 1`,
    )
      .bind(harness.fixture.projectId)
      .first<{
        operational_record_id: string;
        received_at: number;
        referencing_record_id: string;
      }>();
    expect(retention).not.toBeNull();
    await env.DB.prepare(
      `UPDATE project_operational_records SET retain_until = ?
       WHERE operational_record_id = ?`,
    )
      .bind(retention!.received_at, retention!.operational_record_id)
      .run();
    await expect(runOperationalRetention(env.DB, NOW + 10_000)).resolves.toBe(
      0,
    );
    await env.DB.prepare(
      `DELETE FROM project_operational_dependencies
       WHERE operational_record_id = ? AND dependency_id = ?`,
    )
      .bind(retention!.referencing_record_id, retention!.operational_record_id)
      .run();
    await expect(runOperationalRetention(env.DB, NOW + 10_000)).resolves.toBe(
      1,
    );
  });

  it("revalidates the exact owner policy body before every Decision", async () => {
    const harness = await createR4Harness("coding");
    await stageR4AcceptedEvidence(harness);
    const policy = await env.DB.prepare(
      `SELECT record.body_object_key
       FROM project_policy_bindings binding
       JOIN project_operation_records record
         ON record.operation_record_id = binding.policy_id
       WHERE binding.project_id = ? AND binding.status = 'active'`,
    )
      .bind(harness.fixture.projectId)
      .first<{ body_object_key: string }>();
    expect(policy).not.toBeNull();
    await env.VAULT_STORAGE.put(
      policy!.body_object_key,
      encoder.encode("synthetic policy tampering"),
      { customMetadata: { sha256: "0".repeat(64) } },
    );
    await expect(
      evaluateRunPolicy(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 12,
        request: {
          fencingToken: harness.lease.fencingToken,
          idempotencyKey: `r4-policy-tamper-${crypto.randomUUID()}`,
          leaseId: harness.lease.leaseId,
          normalizedRelativePath: null,
          projectId: harness.fixture.projectId,
          requestedOwnerActions: [],
          runId: harness.runId,
          workItemId: harness.fixture.workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: "integrity_mismatch" });
  });

  it("fails a bounded partial integrity scan closed", async () => {
    const harness = await createR4Harness("research");
    const checkpoint = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 11,
      request: checkpointRequest(harness.fixture, harness.lease),
    });
    for (let index = 0; index < 70; index += 1) {
      const emittedAt = NOW + 20 + index;
      await seedContinuityReceipt(
        syntheticContinuityReceipt({
          acknowledgedAt: NOW + 11,
          drillId: crypto.randomUUID(),
          emittedAt,
          leadLossAt: NOW + 12,
          productiveAt: NOW + 13,
          projectId: harness.fixture.projectId,
          receiptId: crypto.randomUUID(),
          restoredContinuityPointId:
            checkpoint.continuityPoint.continuityPointId,
        }),
        emittedAt,
      );
    }
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      NOW + 7 + 3_600,
    );
    expect(
      await env.DB.prepare(
        `SELECT coverage, status, inspected_body_count
         FROM project_operational_integrity_reports
         WHERE project_id = ? ORDER BY measured_at DESC LIMIT 1`,
      )
        .bind(harness.fixture.projectId)
        .first(),
    ).toEqual({
      coverage: "partial",
      inspected_body_count: 64,
      status: "degraded",
    });
  });

  it("retains both the latest integrity result and the last complete good result", async () => {
    const harness = await createR4Harness("research");
    const evidence = await env.DB.prepare(
      `SELECT operational_record_id, received_at
       FROM project_operational_records
       WHERE project_id = ? AND record_type = 'evidence'
       ORDER BY received_at, operational_record_id LIMIT 2`,
    )
      .bind(harness.fixture.projectId)
      .all<{ operational_record_id: string; received_at: number }>();
    expect(evidence.results).toHaveLength(2);
    const [good, degraded] = evidence.results;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE project_operational_records SET retain_until = received_at
         WHERE operational_record_id IN (?, ?)`,
      ).bind(good!.operational_record_id, degraded!.operational_record_id),
      env.DB.prepare(
        `INSERT INTO project_operational_integrity_reports (
          evidence_id, operational_record_id, project_id, coverage,
          inspected_record_count, inspected_body_count, missing_count,
          mismatched_count, status, measured_at
        ) VALUES (?, ?, ?, 'complete', 1, 1, 0, 0, 'ok', ?)`,
      ).bind(
        good!.operational_record_id,
        good!.operational_record_id,
        harness.fixture.projectId,
        NOW + 20,
      ),
      env.DB.prepare(
        `INSERT INTO project_operational_integrity_reports (
          evidence_id, operational_record_id, project_id, coverage,
          inspected_record_count, inspected_body_count, missing_count,
          mismatched_count, status, measured_at
        ) VALUES (?, ?, ?, 'complete', 1, 1, 0, 1, 'degraded', ?)`,
      ).bind(
        degraded!.operational_record_id,
        degraded!.operational_record_id,
        harness.fixture.projectId,
        NOW + 21,
      ),
    ]);
    await runOperationalRetention(env.DB, NOW + 10_000);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_operational_records
         WHERE operational_record_id IN (?, ?)`,
      )
        .bind(good!.operational_record_id, degraded!.operational_record_id)
        .first(),
    ).toMatchObject({ count: 2 });
  });

  it("completes an exact scheduled drill only under a distinct replacement lead fence", async () => {
    const harness = await createR4Harness("research", false, 3_600);
    const earlierCheckpoint = await checkpointProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        authorization: harness.authorization,
        now: NOW + 10,
        request: checkpointRequest(harness.fixture, harness.lease),
      },
    );
    const checkpoint = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 11,
      request: checkpointRequest(harness.fixture, harness.lease, {
        previousContinuityPointId:
          earlierCheckpoint.continuityPoint.continuityPointId,
      }),
    });
    const scheduledTime = NOW + 7 + 3_600;
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      scheduledTime,
    );
    const request = await env.DB.prepare(
      `SELECT request_id FROM project_operational_requests
       WHERE project_id = ? AND request_kind = 'continuity-drill'
         AND status = 'pending' LIMIT 1`,
    )
      .bind(harness.fixture.projectId)
      .first<{ request_id: string }>();
    expect(request).not.toBeNull();
    const replacementAuthorization = await createLeadAuthorization(
      harness.fixture,
      {
        clientId: "https://r4-replacement.example/agent.json",
        now: scheduledTime + 1,
        reuseFixtureGrant: false,
      },
    );
    const replacementLease = await claimProjectLead(env.DB, env.VAULT_STORAGE, {
      authorization: replacementAuthorization,
      now: scheduledTime + 1,
      request: {
        idempotencyKey: `r4-drill-replacement-${crypto.randomUUID()}`,
        leadIdentity: leadIdentity("Synthetic R4 replacement lead"),
        leaseExpiresInSeconds: 900,
        projectId: harness.fixture.projectId,
      },
    });
    const receipt = continuityReceiptSchema.parse({
      authority: {
        actorAuthorityIncluded: false,
        credentialAuthorityIncluded: false,
        grantAuthorityIncluded: false,
        leaseAuthorityIncluded: false,
        liveAuthorityIncluded: false,
        oauthAuthorityIncluded: false,
        policyAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
        schedulerAuthorityIncluded: false,
      },
      cleanup: {
        completed: true,
        remainingAuthorityCount: 0,
        temporaryObjectsRemoved: 4,
      },
      disposable: true,
      drillId: request!.request_id,
      emittedAt: scheduledTime + 5,
      format: "owd-continuity-receipt-v1",
      freshCommunityInstall: true,
      leadReplaced: true,
      metrics: {
        continuityAgeSeconds: scheduledTime + 5 - (NOW + 11),
        recoveryChecksPassed: 8,
        recoveryChecksTotal: 8,
        recoveryQualityBps: 10_000,
        rpoSeconds: scheduledTime - (NOW + 11),
        rtoSeconds: 3,
        runtimeIndependent: true,
      },
      outcome: "pass",
      projectId: harness.fixture.projectId,
      receiptId: crypto.randomUUID(),
      redaction: {
        credentialsIncluded: false,
        customerDataIncluded: false,
        filenamesIncluded: false,
        hiddenReasoningIncluded: false,
        hostnamesIncluded: false,
        oauthStateIncluded: false,
        productionLogsIncluded: false,
        providerRuntimeIncluded: false,
        rawBodiesIncluded: false,
        terminalHistoryIncluded: false,
        transcriptsIncluded: false,
      },
      restoredContinuityPointId: checkpoint.continuityPoint.continuityPointId,
      schemaVersion: 1,
      sourceTimes: {
        latestAcknowledgedPointAt: NOW + 11,
        receiptEmittedAt: scheduledTime + 5,
        replacementProductiveAt: scheduledTime + 3,
        restoredPointAcknowledgedAt: NOW + 11,
        simulatedLeadLossAt: scheduledTime,
      },
    });
    const completionRequest = {
      fencingToken: replacementLease.fencingToken,
      idempotencyKey: `r4-complete-drill-${crypto.randomUUID()}`,
      leaseId: replacementLease.leaseId,
      projectId: harness.fixture.projectId,
      receipt,
      requestId: request!.request_id,
    };
    await expect(
      completeContinuityDrill(env.DB, env.VAULT_STORAGE, {
        authorization: replacementAuthorization,
        now: scheduledTime + 5,
        request: {
          ...completionRequest,
          idempotencyKey: `r4-wrong-point-${crypto.randomUUID()}`,
          receipt: {
            ...receipt,
            restoredContinuityPointId:
              earlierCheckpoint.continuityPoint.continuityPointId,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    const beforeDueLossAt = scheduledTime - 1;
    await expect(
      completeContinuityDrill(env.DB, env.VAULT_STORAGE, {
        authorization: replacementAuthorization,
        now: scheduledTime + 5,
        request: {
          ...completionRequest,
          idempotencyKey: `r4-before-due-${crypto.randomUUID()}`,
          receipt: {
            ...receipt,
            metrics: {
              ...receipt.metrics,
              rpoSeconds: beforeDueLossAt - (NOW + 11),
              rtoSeconds: scheduledTime + 3 - beforeDueLossAt,
            },
            sourceTimes: {
              ...receipt.sourceTimes,
              simulatedLeadLossAt: beforeDueLossAt,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "evidence_invalid" });
    await expect(
      completeContinuityDrill(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: scheduledTime + 5,
        request: {
          ...completionRequest,
          fencingToken: harness.lease.fencingToken,
          leaseId: harness.lease.leaseId,
        },
      }),
    ).rejects.toMatchObject({ code: "lease_invalid" });
    const completed = completeContinuityDrillReceiptSchema.parse(
      await completeContinuityDrill(env.DB, env.VAULT_STORAGE, {
        authorization: replacementAuthorization,
        now: scheduledTime + 5,
        request: completionRequest,
      }),
    );
    expect(completed.receipt.metrics).toMatchObject({
      recoveryQualityBps: 10_000,
      runtimeIndependent: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT status, completed_at FROM project_operational_requests
         WHERE request_id = ?`,
      )
        .bind(request!.request_id)
        .first(),
    ).toEqual({ completed_at: scheduledTime + 5, status: "completed" });
    await expect(
      completeContinuityDrill(env.DB, env.VAULT_STORAGE, {
        authorization: replacementAuthorization,
        now: scheduledTime + 5,
        request: completionRequest,
      }),
    ).resolves.toMatchObject({
      receipt: { receiptId: receipt.receiptId },
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_continuity_drill_receipts
         WHERE drill_id = ?`,
      )
        .bind(request!.request_id)
        .first(),
    ).toMatchObject({ count: 1 });
  });

  it("coalesces scheduled replay, backpressures overlapping drills, and records exact redacted metrics", async () => {
    const harness = await createR4Harness("research", false, 3_600);
    const point = await checkpointProject(env.DB, env.VAULT_STORAGE, {
      authorization: harness.authorization,
      now: NOW + 11,
      request: checkpointRequest(harness.fixture, harness.lease),
    });
    const firstScheduledTime = NOW + 7 + 3_600;
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      firstScheduledTime,
    );
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      firstScheduledTime,
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_operational_requests
         WHERE project_id = ? AND request_kind = 'continuity-drill'`,
      )
        .bind(harness.fixture.projectId)
        .first(),
    ).toMatchObject({ count: 1 });
    await runScheduledPolicyOperations(
      env.DB,
      env.VAULT_STORAGE,
      firstScheduledTime + 3_600,
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM project_operational_requests
         WHERE project_id = ? AND request_kind = 'continuity-drill'`,
      )
        .bind(harness.fixture.projectId)
        .first(),
    ).toMatchObject({ count: 1 });

    const receipt = continuityReceiptSchema.parse({
      authority: {
        actorAuthorityIncluded: false,
        credentialAuthorityIncluded: false,
        grantAuthorityIncluded: false,
        leaseAuthorityIncluded: false,
        liveAuthorityIncluded: false,
        oauthAuthorityIncluded: false,
        policyAuthorityIncluded: false,
        restoredAuthorityAllowed: false,
        schedulerAuthorityIncluded: false,
      },
      cleanup: {
        completed: true,
        remainingAuthorityCount: 0,
        temporaryObjectsRemoved: 9,
      },
      disposable: true,
      drillId: crypto.randomUUID(),
      emittedAt: NOW + 30,
      format: "owd-continuity-receipt-v1",
      freshCommunityInstall: true,
      leadReplaced: true,
      metrics: {
        continuityAgeSeconds: 19,
        recoveryChecksPassed: 8,
        recoveryChecksTotal: 8,
        recoveryQualityBps: 10_000,
        rpoSeconds: 9,
        rtoSeconds: 8,
        runtimeIndependent: true,
      },
      outcome: "pass",
      projectId: harness.fixture.projectId,
      receiptId: crypto.randomUUID(),
      redaction: {
        credentialsIncluded: false,
        customerDataIncluded: false,
        filenamesIncluded: false,
        hiddenReasoningIncluded: false,
        hostnamesIncluded: false,
        oauthStateIncluded: false,
        productionLogsIncluded: false,
        providerRuntimeIncluded: false,
        rawBodiesIncluded: false,
        terminalHistoryIncluded: false,
        transcriptsIncluded: false,
      },
      restoredContinuityPointId: harness.fixture.packet.packetId,
      schemaVersion: 1,
      sourceTimes: {
        latestAcknowledgedPointAt: NOW + 11,
        receiptEmittedAt: NOW + 30,
        replacementProductiveAt: NOW + 28,
        restoredPointAcknowledgedAt: NOW + 11,
        simulatedLeadLossAt: NOW + 20,
      },
    });
    const stored = await seedContinuityReceipt(
      {
        ...receipt,
        restoredContinuityPointId: point.continuityPoint.continuityPointId,
      },
      NOW + 30,
    );
    expect(stored.metrics).toMatchObject({
      continuityAgeSeconds: 19,
      recoveryQualityBps: 10_000,
      rpoSeconds: 9,
      rtoSeconds: 8,
      runtimeIndependent: true,
    });
    const operations = getPolicyOperationsReceiptSchema.parse(
      await getPolicyOperations(env.DB, env.VAULT_STORAGE, {
        authorization: harness.authorization,
        now: NOW + 31,
        request: { projectId: harness.fixture.projectId },
      }),
    );
    expect(operations.pendingRequests).toHaveLength(2);
  });
});
