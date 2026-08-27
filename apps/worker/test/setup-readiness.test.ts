import {
  ownerDiagnosticsResponseSchema,
  setupReadinessSchema,
} from "@mdevolved/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import {
  commitFirstOwner,
  createSessionMaterial,
  ensureAuthSchema,
} from "../src/auth-store";
import { ensureBackupSchema } from "../src/backup-store";
import { createCollaborationProject } from "../src/collaboration-service";
import {
  activateCollaborationGrant,
  createPendingCollaborationGrant,
} from "../src/collaboration-store";
import {
  ensureMaterializationSchema,
  publishMaterialization,
} from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { ensureSnapshotSchema } from "../src/snapshot-store";
import {
  applyOnboardingLifecycleMigration,
  applyContinuityR1Migration,
  applyPhase9aCollaborationMigration,
  applyPhase9bAgentFirstMigration,
  applyPreparedProjectHandoffsMigration,
  applyProjectConnectionHardeningMigration,
  applyProjectCreationCommitMigration,
  applyProjectCreationIdentityMigration,
  applyProjectAgentVisibilityMigration,
  applyRestoredContentAuthorizationMigration,
  applyVaultPrimaryWriterMigration,
} from "./migration-fixture";

const ORIGIN = "https://owd.test";

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function resetState(): Promise<void> {
  await ensureAuthSchema(env.DB);
  await ensurePairingSchema(env.DB);
  await ensureMaterializationSchema(env.DB);
  await ensureBackupSchema(env.DB);
  await ensureSnapshotSchema(env.DB);
  await ensureAgentAccessSchema(env.DB);
  await applyPhase9aCollaborationMigration(env.DB);
  await applyPhase9bAgentFirstMigration(env.DB);
  await applyRestoredContentAuthorizationMigration(env.DB);
  await applyOnboardingLifecycleMigration(env.DB);
  await applyProjectConnectionHardeningMigration(env.DB);
  await applyProjectCreationIdentityMigration(env.DB);
  await applyProjectCreationCommitMigration(env.DB);
  await applyProjectAgentVisibilityMigration(env.DB);
  await applyVaultPrimaryWriterMigration(env.DB);
  await applyPreparedProjectHandoffsMigration(env.DB);
  await applyContinuityR1Migration(env.DB);
  await env.DB.exec(`
    DELETE FROM continuity_checkpoint_receipts;
    DELETE FROM continuity_point_dependencies;
    DELETE FROM project_continuity_points;
    DELETE FROM project_lead_leases;
    DELETE FROM collaboration_submission_receipts;
    DELETE FROM collaboration_grant_clients;
    DELETE FROM collaboration_grants;
    DELETE FROM prepared_project_handoffs;
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
    DELETE FROM agent_grants;
    DELETE FROM oauth_consent_flows;
    DELETE FROM snapshot_archives;
    DELETE FROM snapshot_entries;
    DELETE FROM snapshot_vaults;
    DELETE FROM snapshot_gc_objects;
    DELETE FROM snapshot_objects;
    DELETE FROM workspace_snapshots;
    DELETE FROM materialized_note_search;
    DELETE FROM current_materializations;
    DELETE FROM materialized_notes;
    DELETE FROM materialization_generations;
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vaults;
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
}

async function createOwnerSession(): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: `readiness-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `readiness-owner-${crypto.randomUUID()}`,
    },
    session,
    crypto.randomUUID(),
    now,
  );
  return `__Host-mdevolved_session=${session.token}`;
}

async function createVault(displayName: string, createdAt: number) {
  const vaultId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at
      ) VALUES (?, ?, 'active', ?, ?)`,
    ).bind(vaultId, displayName, createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO vault_sync_states (
        vault_id, plugin_version, schema_version,
        connection_confirmed_at, initial_sync_at, last_sync_at,
        current_state_vector_sha256, library_stale, updated_at
      ) VALUES (?, '0.1.6', 3, ?, ?, ?, ?, 1, ?)`,
    ).bind(vaultId, createdAt, createdAt, createdAt, "a".repeat(64), createdAt),
  ]);
  return vaultId;
}

beforeEach(async () => {
  await resetState();
});

describe("setup readiness", () => {
  it("allows read-only agent setup from a current library without a recovery point", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const sessionCookie = await createOwnerSession();
    const vaultId = await createVault("Read-only source", now);
    await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now,
      requestId: crypto.randomUUID(),
      snapshot: { notes: [], schemaVersion: 3, totalBytes: 0 },
      sourceStateVectorSha256: "a".repeat(64),
      vaultId,
    });

    const snapshotCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM workspace_snapshots",
    ).first<{ count: number }>();
    expect(snapshotCount?.count).toBe(0);

    const response = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const readiness = setupReadinessSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(readiness).toMatchObject({
      activeAgentCount: 0,
      activeProjectCount: 0,
      activeProjectGrantCount: 0,
      activeVaultCount: 1,
      libraryReady: true,
      nextStep: "connect-agent",
      verifiedSnapshot: false,
      vaults: [
        {
          id: vaultId,
          libraryReady: true,
          nextStep: "connect-agent",
          verifiedSnapshot: false,
        },
      ],
    });
  });

  it("prefers a prepared first Project and otherwise reveals pending owner review", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const sessionCookie = await createOwnerSession();
    const vaultId = await createVault("Prepared source", now);
    await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now,
      requestId: crypto.randomUUID(),
      snapshot: { notes: [], schemaVersion: 3, totalBytes: 0 },
      sourceStateVectorSha256: "a".repeat(64),
      vaultId,
    });
    const agentGrantId = crypto.randomUUID();
    const clientId = `prepared-client-${crypto.randomUUID()}`;
    const pendingRequestId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_grants (
          id, owner_id, oauth_client_id, client_name, client_origin,
          redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
          path_key_prefixes_json, status, created_at, activated_at
        ) VALUES (?, 1, ?, 'Prepared agent', 'https://agent.example',
          'https://agent.example/callback', ?, ?,
          '["vault.read","project.initialize.request","project.connect.request"]',
          '[]', '[]', 'active', ?, ?)`,
      ).bind(agentGrantId, clientId, `${ORIGIN}/mcp`, vaultId, now, now),
      env.DB.prepare(
        `INSERT INTO project_initialization_requests (
          id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
          client_name, client_origin, audience, vault_id, vault_name,
          folder_path, folder_path_key, draft_json, draft_sha256,
          authorization_url, requested_scopes_json,
          url_elicitation_supported, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'Prepared agent', 'https://agent.example', ?, ?,
          'Prepared source', '', '', ?, ?, ?, '["project.read"]', 1,
          'pending', ?, ?)`,
      ).bind(
        pendingRequestId,
        "9".repeat(64),
        agentGrantId,
        clientId,
        `${ORIGIN}/mcp`,
        vaultId,
        JSON.stringify({
          project: { label: "Older request" },
          requestKind: "create",
        }),
        "8".repeat(64),
        `${ORIGIN}/initialize?requestId=${pendingRequestId}`,
        now,
        now + 600,
      ),
      env.DB.prepare(
        `INSERT INTO prepared_project_handoffs (
          id, agent_grant_id, vault_id, project_label, project_label_key,
          folder_path, folder_path_key, status, prepared_at
        ) VALUES (?, ?, ?, 'Prepared Project', 'prepared project',
          '', '', 'prepared', ?)`,
      ).bind(crypto.randomUUID(), agentGrantId, vaultId, now + 1),
    ]);

    const response = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const readiness = setupReadinessSchema.parse(await response.json());
    expect(readiness.vaults[0]).toMatchObject({
      nextStep: "create-or-select-project",
      pendingProjectRequestCount: 1,
      preparedProjectHandoff: {
        agentGrantId,
        clientName: "Prepared agent",
        folderBoundary: "",
        projectLabel: "Prepared Project",
      },
    });

    await env.DB.prepare("DELETE FROM prepared_project_handoffs").run();
    const pendingResponse = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const pendingReadiness = setupReadinessSchema.parse(
      await pendingResponse.json(),
    );
    expect(pendingReadiness.vaults[0]).toMatchObject({
      nextStep: "approve-project",
      pendingProjectRequestCount: 1,
      pendingProjectReviewUrl: `/initialize?requestId=${pendingRequestId}`,
      preparedProjectHandoff: null,
    });
  });

  it("never combines unrelated vault, library, agent, and Project progress", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const sessionCookie = await createOwnerSession();
    const readySourceVaultId = await createVault("Ready source", now - 2);
    const incompleteVaultId = await createVault("Incomplete source", now - 1);
    const generation = await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now,
      requestId: crypto.randomUUID(),
      snapshot: { notes: [], schemaVersion: 3, totalBytes: 0 },
      sourceStateVectorSha256: "a".repeat(64),
      vaultId: readySourceVaultId,
    });
    const snapshotId = crypto.randomUUID();
    const activeAgentGrantId = crypto.randomUUID();
    const activeAgentClientId = `readiness-client-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_snapshots (
          id, portable_snapshot_id, format_version, origin, scope, status,
          integrity_status, recipient_fingerprint, capture_started_at,
          capture_completed_at, vault_count, item_count, logical_bytes,
          changed_item_count, processed_object_count, total_object_count,
          newly_stored_bytes, included_sections, unavailable_sections,
          manifest_portable_object_id, pinned, created_at, completed_at,
          verified_at
        ) VALUES (?, ?, 'owd-snapshot-v2', 'created', 'selected', 'ready',
          'verified', ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, '[]', '[]', ?, 0, ?, ?,
          ?)`,
      ).bind(
        snapshotId,
        crypto.randomUUID(),
        "readiness-fingerprint",
        now,
        now,
        crypto.randomUUID(),
        now,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO snapshot_vaults (
          snapshot_id, snapshot_vault_id, source_vault_id, source_vault_name,
          generation_id, source_state_vector_sha256, generation_created_at,
          generation_completed_at, item_count, logical_bytes, ordinal
        ) VALUES (?, ?, ?, 'Ready source', ?, ?, ?, ?, 0, 0, 0)`,
      ).bind(
        snapshotId,
        crypto.randomUUID(),
        readySourceVaultId,
        generation.generationId,
        generation.sourceStateVectorSha256,
        generation.createdAt,
        generation.completedAt,
      ),
      env.DB.prepare(
        `INSERT INTO agent_grants (
          id, owner_id, oauth_client_id, client_name, client_origin,
          redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
          path_key_prefixes_json, status, created_at, activated_at
        ) VALUES (?, 1, ?, 'Ready agent', 'https://agent.example',
          'https://agent.example/callback', ?, ?,
          '["vault.read","project.initialize.request","project.connect.request"]',
          '[]', '[]', 'active', ?, ?)`,
      ).bind(
        activeAgentGrantId,
        activeAgentClientId,
        `${ORIGIN}/mcp`,
        readySourceVaultId,
        now,
        now,
      ),
    ]);
    const unrelatedProject = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        knowledgeSpace: {
          label: "Unrelated Project context",
          members: [
            {
              exclusions: [],
              pathPrefixes: [{ path: "", pathKey: "" }],
              vaultId: incompleteVaultId,
            },
          ],
        },
        packetExpiresInSeconds: 600,
        project: {
          label: "Unrelated active Project",
          objective: "Remain unrelated to the active agent grant.",
        },
        requestedRole: "reviewer",
        sourceNotes: [],
        workItem: {
          constraints: ["Do not infer a vault relationship."],
          definitionOfDone: ["Readiness remains vault-bound."],
          objective: "Prove unrelated state never completes onboarding.",
          requestedOutput: "A readiness receipt.",
        },
      },
      now,
      crypto.randomUUID(),
    );

    const response = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const initialReadiness = setupReadinessSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(initialReadiness).toMatchObject({
      activeAgentCount: 1,
      activeProjectCount: 0,
      activeProjectGrantCount: 0,
      activeVaultCount: 2,
      libraryReady: false,
      nextStep: "prepare-project-handoff",
      verifiedSnapshot: false,
      vaults: [
        {
          activeAgentCount: 1,
          activeProjectCount: 0,
          activeProjectGrantCount: 0,
          displayName: "Ready source",
          id: readySourceVaultId,
          libraryReady: true,
          nextStep: "prepare-project-handoff",
          verifiedSnapshot: true,
        },
        {
          activeAgentCount: 0,
          activeProjectCount: 0,
          activeProjectGrantCount: 0,
          displayName: "Incomplete source",
          id: incompleteVaultId,
          libraryReady: false,
          nextStep: "build-library",
          verifiedSnapshot: false,
        },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const unrelatedProjectRow = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(unrelatedProject.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (unrelatedProjectRow === null) {
      throw new Error("Unrelated Project was not created.");
    }
    const unrelatedGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: `${ORIGIN}/mcp`,
      clientId: activeAgentClientId,
      expiresAt: now + 3_600,
      issuedAt: now,
      knowledgeSpaceVersionId:
        unrelatedProjectRow.active_knowledge_space_version_id,
      projectId: unrelatedProject.projectId,
      scopes: ["project.read"],
      source: {
        agentGrantId: activeAgentGrantId,
        clientName: "Ready agent",
        clientOrigin: "https://agent.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: unrelatedGrantId,
        now,
      }),
    ).toBe(true);
    const mismatchedGrantResponse = await fetchWorker(
      `${ORIGIN}/api/setup/readiness`,
      { headers: { Cookie: sessionCookie } },
    );
    const mismatchedGrantReadiness = setupReadinessSchema.parse(
      await mismatchedGrantResponse.json(),
    );
    expect(mismatchedGrantReadiness.vaults[0]).toMatchObject({
      activeProjectCount: 0,
      activeProjectGrantCount: 0,
      nextStep: "prepare-project-handoff",
    });

    const relatedProject = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        knowledgeSpace: {
          label: "Ready source Project context",
          members: [
            {
              exclusions: [],
              pathPrefixes: [{ path: "", pathKey: "" }],
              vaultId: readySourceVaultId,
            },
          ],
        },
        packetExpiresInSeconds: 600,
        project: {
          label: "Ready source Project",
          objective: "Exercise every remaining onboarding transition.",
        },
        requestedRole: "reviewer",
        sourceNotes: [],
        workItem: {
          constraints: ["Preserve the exact source grant."],
          definitionOfDone: ["Reach active Project authorization."],
          objective: "Complete the Project authorization path.",
          requestedOutput: "A readiness receipt.",
        },
      },
      now,
      crypto.randomUUID(),
    );
    const initializationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO project_initialization_requests (
        id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
        client_name, client_origin, audience, vault_id, vault_name,
        folder_path, folder_path_key, draft_json, draft_sha256,
        authorization_url, requested_scopes_json,
        url_elicitation_supported, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'Ready agent', 'https://agent.example', ?, ?,
        'Ready source', '', '', '{}', ?, ?, '["project.read"]', 1,
        'pending', ?, ?)`,
    )
      .bind(
        initializationId,
        "b".repeat(64),
        activeAgentGrantId,
        activeAgentClientId,
        `${ORIGIN}/mcp`,
        readySourceVaultId,
        "c".repeat(64),
        `${ORIGIN}/authorize`,
        now,
        now + 600,
      )
      .run();
    const pendingResponse = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const pendingReadiness = setupReadinessSchema.parse(
      await pendingResponse.json(),
    );
    expect(pendingReadiness.vaults[0]).toMatchObject({
      activeProjectCount: 0,
      activeProjectGrantCount: 0,
      nextStep: "approve-project",
      pendingProjectRequestCount: 1,
      pendingProjectRequests: [
        {
          clientName: "Ready agent",
          projectLabel: "Unnamed Project",
          requestKind: "create",
          reviewUrl: `/initialize?requestId=${initializationId}`,
        },
      ],
      pendingProjectReviewUrl: `/initialize?requestId=${initializationId}`,
    });

    const otherInitializationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO project_initialization_requests (
        id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
        client_name, client_origin, audience, vault_id, vault_name,
        folder_path, folder_path_key, draft_json, draft_sha256,
        authorization_url, requested_scopes_json,
        url_elicitation_supported, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'Second agent', 'https://second.example', ?, ?,
        'Ready source', '', '', ?, ?, ?, '["project.read"]', 1,
        'pending', ?, ?)`,
    )
      .bind(
        otherInitializationId,
        "f".repeat(64),
        activeAgentGrantId,
        activeAgentClientId,
        `${ORIGIN}/mcp`,
        readySourceVaultId,
        JSON.stringify({
          project: { label: "Another Project" },
          requestKind: "join",
        }),
        "1".repeat(64),
        `${ORIGIN}/authorize`,
        now + 1,
        now + 600,
      )
      .run();
    const multiplePendingResponse = await fetchWorker(
      `${ORIGIN}/api/setup/readiness`,
      { headers: { Cookie: sessionCookie } },
    );
    const multiplePending = setupReadinessSchema.parse(
      await multiplePendingResponse.json(),
    );
    expect(multiplePending.vaults[0]).toMatchObject({
      pendingProjectRequestCount: 2,
      pendingProjectRequests: [
        {
          clientName: "Ready agent",
          projectLabel: "Unnamed Project",
          requestKind: "create",
          reviewUrl: `/initialize?requestId=${initializationId}`,
        },
        {
          clientName: "Second agent",
          projectLabel: "Another Project",
          requestKind: "connect",
          reviewUrl: `/connect?requestId=${otherInitializationId}`,
        },
      ],
      pendingProjectReviewUrl: null,
    });
    await env.DB.prepare(
      `UPDATE project_initialization_requests
       SET status = 'rejected', decided_at = ?
       WHERE id = ?`,
    )
      .bind(now + 2, otherInitializationId)
      .run();

    await env.DB.prepare(
      `UPDATE project_initialization_requests
       SET status = 'approved', decided_at = ?, result_project_id = ?,
         result_work_item_id = ?, result_packet_id = ?,
         result_collaboration_grant_id = 'client-authorization-pending'
       WHERE id = ?`,
    )
      .bind(
        now,
        relatedProject.projectId,
        relatedProject.workItemId,
        relatedProject.packet.packetId,
        initializationId,
      )
      .run();
    const approvedResponse = await fetchWorker(
      `${ORIGIN}/api/setup/readiness`,
      { headers: { Cookie: sessionCookie } },
    );
    const approvedReadiness = setupReadinessSchema.parse(
      await approvedResponse.json(),
    );
    expect(approvedReadiness.vaults[0]).toMatchObject({
      activeProjectCount: 1,
      activeProjectGrantCount: 0,
      nextStep: "prepare-project-handoff",
      pendingProjectRequestCount: 0,
    });

    const project = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(relatedProject.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (project === null) throw new Error("Related Project was not created.");
    const projectGrantId = await createPendingCollaborationGrant(env.DB, {
      audience: `${ORIGIN}/mcp`,
      clientId: activeAgentClientId,
      expiresAt: now + 3_600,
      issuedAt: now,
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      projectId: relatedProject.projectId,
      scopes: ["project.read"],
      source: {
        agentGrantId: activeAgentGrantId,
        clientName: "Ready agent",
        clientOrigin: "https://agent.example",
      },
    });
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: projectGrantId,
        now,
      }),
    ).toBe(true);
    const readyResponse = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
      headers: { Cookie: sessionCookie },
    });
    const readyReadiness = setupReadinessSchema.parse(
      await readyResponse.json(),
    );
    expect(readyReadiness.vaults[0]).toMatchObject({
      activeProjectCount: 1,
      activeProjectGrantCount: 1,
      nextStep: "ready",
    });

    await env.DB.prepare(
      `INSERT INTO project_initialization_requests (
        id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
        client_name, client_origin, audience, vault_id, vault_name,
        folder_path, folder_path_key, draft_json, draft_sha256,
        authorization_url, requested_scopes_json,
        url_elicitation_supported, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'Ready agent', 'https://agent.example', ?, ?,
        'Ready source', '', '', '{}', ?, ?, '["project.read"]', 1,
        'pending', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        "d".repeat(64),
        activeAgentGrantId,
        activeAgentClientId,
        `${ORIGIN}/mcp`,
        readySourceVaultId,
        "e".repeat(64),
        `${ORIGIN}/authorize`,
        now,
        now + 600,
      )
      .run();
    const readyWithPendingResponse = await fetchWorker(
      `${ORIGIN}/api/setup/readiness`,
      { headers: { Cookie: sessionCookie } },
    );
    const readyWithPending = setupReadinessSchema.parse(
      await readyWithPendingResponse.json(),
    );
    expect(readyWithPending.vaults[0]).toMatchObject({
      activeProjectCount: 1,
      activeProjectGrantCount: 1,
      nextStep: "approve-project",
      pendingProjectRequestCount: 1,
    });

    const diagnosticsResponse = await fetchWorker(`${ORIGIN}/api/diagnostics`, {
      headers: { Cookie: sessionCookie },
    });
    const diagnostics = ownerDiagnosticsResponseSchema.parse(
      await diagnosticsResponse.json(),
    );
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnostics).toMatchObject({
      format: "owd-owner-diagnostics-v1",
      totals: {
        activeProjectCount: 2,
        activeVaultCount: 2,
        pendingProjectRequestCount: 1,
      },
    });
    expect(diagnostics.vaults.map((vault) => vault.id)).toEqual([
      readySourceVaultId,
      incompleteVaultId,
    ]);
    expect(serializedDiagnostics).not.toContain("Ready source");
    expect(serializedDiagnostics).not.toContain(
      "Exercise every remaining onboarding transition.",
    );
    expect(serializedDiagnostics).not.toContain("https://agent.example");
    expect(diagnosticsResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("keeps a Project visible across source OAuth replacement and stops calling a revoked Project ready", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const sessionCookie = await createOwnerSession();
    const vaultId = await createVault("Durable Project source", now);
    await publishMaterialization(env.DB, env.VAULT_STORAGE, {
      now,
      requestId: crypto.randomUUID(),
      snapshot: { notes: [], schemaVersion: 3, totalBytes: 0 },
      sourceStateVectorSha256: "a".repeat(64),
      vaultId,
    });
    const clientId = `durable-readiness-${crypto.randomUUID()}`;
    const originalSourceGrantId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO agent_grants (
        id, owner_id, oauth_client_id, client_name, client_origin,
        redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
        path_key_prefixes_json, status, created_at, activated_at
      ) VALUES (?, 1, ?, 'Durable agent', 'https://agent.example',
        'https://agent.example/callback', ?, ?,
        '["vault.read","project.initialize.request","project.connect.request"]',
        '[]', '[]', 'active', ?, ?)`,
    )
      .bind(originalSourceGrantId, clientId, `${ORIGIN}/mcp`, vaultId, now, now)
      .run();
    const project = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        knowledgeSpace: {
          label: "Durable Project context",
          members: [
            {
              exclusions: [],
              pathPrefixes: [{ path: "", pathKey: "" }],
              vaultId,
            },
          ],
        },
        packetExpiresInSeconds: 600,
        project: {
          label: "Durable Project",
          objective: "Remain visible while the source OAuth grant rotates.",
        },
        requestedRole: "reviewer",
        sourceNotes: [],
        workItem: {
          constraints: ["Keep the exact Project identity."],
          definitionOfDone: ["Readiness follows the durable Project grant."],
          objective: "Exercise replacement and explicit revocation.",
          requestedOutput: "A readiness receipt.",
        },
      },
      now,
      crypto.randomUUID(),
    );
    const projectRow = await env.DB.prepare(
      `SELECT active_knowledge_space_version_id
       FROM collaboration_projects WHERE project_id = ?`,
    )
      .bind(project.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (projectRow === null) throw new Error("Project was not created.");
    const originalProjectGrantId = await createPendingCollaborationGrant(
      env.DB,
      {
        audience: `${ORIGIN}/mcp`,
        clientId,
        expiresAt: now + 3_600,
        issuedAt: now,
        knowledgeSpaceVersionId: projectRow.active_knowledge_space_version_id,
        projectId: project.projectId,
        scopes: ["project.read"],
        source: {
          agentGrantId: originalSourceGrantId,
          clientName: "Durable agent",
          clientOrigin: "https://agent.example",
        },
      },
    );
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: originalProjectGrantId,
        now,
      }),
    ).toBe(true);
    const initializationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO project_initialization_requests (
        id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
        client_name, client_origin, audience, vault_id, vault_name,
        folder_path, folder_path_key, draft_json, draft_sha256,
        authorization_url, requested_scopes_json,
        url_elicitation_supported, status, created_at, expires_at, decided_at,
        result_project_id, result_work_item_id, result_packet_id,
        result_collaboration_grant_id
      ) VALUES (?, ?, ?, ?, 'Durable agent', 'https://agent.example', ?, ?,
        'Durable Project source', '', '', '{}', ?, ?, '["project.read"]', 1,
        'approved', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        initializationId,
        "f".repeat(64),
        originalSourceGrantId,
        clientId,
        `${ORIGIN}/mcp`,
        vaultId,
        "e".repeat(64),
        `${ORIGIN}/authorize`,
        now,
        now + 600,
        now,
        project.projectId,
        project.workItemId,
        project.packet.packetId,
        originalProjectGrantId,
      )
      .run();

    async function readVaultReadiness() {
      const response = await fetchWorker(`${ORIGIN}/api/setup/readiness`, {
        headers: { Cookie: sessionCookie },
      });
      expect(response.status).toBe(200);
      return setupReadinessSchema.parse(await response.json()).vaults[0];
    }

    expect(await readVaultReadiness()).toMatchObject({
      activeProjectCount: 1,
      activeProjectGrantCount: 1,
      nextStep: "ready",
    });

    await env.DB.prepare(
      `UPDATE collaboration_grants
       SET status = 'revoked', revoked_at = ?
       WHERE id = ?`,
    )
      .bind(now + 1, originalProjectGrantId)
      .run();
    expect(await readVaultReadiness()).toMatchObject({
      activeProjectCount: 1,
      activeProjectGrantCount: 0,
      nextStep: "prepare-project-handoff",
    });

    const replacementSourceGrantId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_grants
         SET status = 'revoked', revoked_at = ?
         WHERE id = ?`,
      ).bind(now + 2, originalSourceGrantId),
      env.DB.prepare(
        `INSERT INTO agent_grants (
          id, owner_id, oauth_client_id, client_name, client_origin,
          redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
          path_key_prefixes_json, status, created_at, activated_at
        ) VALUES (?, 1, ?, 'Durable agent', 'https://agent.example',
          'https://agent.example/callback', ?, ?,
          '["vault.read","project.initialize.request","project.connect.request"]',
          '[]', '[]', 'active', ?, ?)`,
      ).bind(
        replacementSourceGrantId,
        clientId,
        `${ORIGIN}/mcp`,
        vaultId,
        now + 2,
        now + 2,
      ),
    ]);
    const reboundProjectGrantId = await createPendingCollaborationGrant(
      env.DB,
      {
        audience: `${ORIGIN}/mcp`,
        clientId,
        expiresAt: now + 3_602,
        issuedAt: now + 2,
        knowledgeSpaceVersionId: projectRow.active_knowledge_space_version_id,
        projectId: project.projectId,
        scopes: ["project.read"],
        source: {
          agentGrantId: replacementSourceGrantId,
          clientName: "Durable agent",
          clientOrigin: "https://agent.example",
        },
      },
    );
    expect(
      await activateCollaborationGrant(env.DB, {
        grantId: reboundProjectGrantId,
        now: now + 2,
      }),
    ).toBe(true);
    await env.DB.prepare(
      `UPDATE project_initialization_requests
       SET result_collaboration_grant_id = ?
       WHERE id = ?`,
    )
      .bind(reboundProjectGrantId, initializationId)
      .run();

    expect(await readVaultReadiness()).toMatchObject({
      activeAgentCount: 1,
      activeProjectCount: 1,
      activeProjectGrantCount: 1,
      nextStep: "ready",
    });
  });
});
