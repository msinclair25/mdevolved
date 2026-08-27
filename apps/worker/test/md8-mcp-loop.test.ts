import {
  completeWorkItemReceiptSchema,
  createWorkItemReceiptSchema,
  evaluateRunPolicyReceiptSchema,
  registerActorReceiptSchema,
  runContextSchema,
  startRunReceiptSchema,
  submitBundleReceiptSchema,
  type CollaborationProjectCreateRequest,
} from "@owd/contracts";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ensureAuthSchema,
  commitFirstOwner,
  createSessionMaterial,
} from "../src/auth-store";
import { ensureBackupSchema } from "../src/backup-store";
import { ensureAgentAccessSchema } from "../src/agent-access-store";
import { createCollaborationProject } from "../src/collaboration-service";
import {
  ensureMaterializationSchema,
  publishMaterialization,
} from "../src/materialization-store";
import { ensurePairingSchema } from "../src/pairing-store";
import { ensureSnapshotSchema } from "../src/snapshot-store";
import { encodeBase64Url, sha256Hex } from "../src/security";
import worker from "../src/index";
import {
  applyAgentGrantContinuityMigration,
  applyAutonomousCompletionModeMigration,
  applyContinuityR1Migration,
  applyElasticActorPlaneR3Migration,
  applyHandsOffLeadR2Migration,
  applyOnboardingLifecycleMigration,
  applyPhase9aCollaborationMigration,
  applyPhase9bAgentFirstMigration,
  applyPolicyAutopilotR4Migration,
  applyPreparedProjectHandoffsMigration,
  applyProjectAgentVisibilityMigration,
  applyProjectConnectionHardeningMigration,
  applyProjectCreationCommitMigration,
  applyProjectCreationIdentityMigration,
  applyRestoredContentAuthorizationMigration,
  applyVaultPrimaryWriterMigration,
  applyVaultPrimaryWriterTransferMigration,
  executableMigration,
  workingProfileSkillsMigrationEntry,
} from "./migration-fixture";

const ORIGIN = "https://owd.test";
const REDIRECT_URI = "https://md8-mcp.test/callback";
const AUDIENCE = `${ORIGIN}/mcp`;
const NOW = Math.floor(Date.now() / 1_000);
const NO_ROOT_MARKDOWN = {
  decision: "no-root-markdown" as const,
  proposedMoves: [],
  retainedRootPaths: [],
  rootMarkdownPaths: [],
};

type OwnerSession = { cookie: string; csrf: string };
type MpcEnvelope = {
  jsonrpc: "2.0";
  id: number;
  result: {
    content?: Array<{ text?: string; type: string }>;
    isError?: boolean;
    structuredContent: Record<string, unknown>;
  };
};

async function fetchWorker(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return worker.fetch(new Request(input, init), env, createExecutionContext());
}

async function clearKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({ cursor });
    await Promise.all(page.keys.map((key) => env.OAUTH_KV.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
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
  await applyAgentGrantContinuityMigration(env.DB);
  await applyProjectAgentVisibilityMigration(env.DB);
  await applyVaultPrimaryWriterMigration(env.DB);
  await applyVaultPrimaryWriterTransferMigration(env.DB);
  await applyPreparedProjectHandoffsMigration(env.DB);
  await applyContinuityR1Migration(env.DB);
  await applyHandsOffLeadR2Migration(env.DB);
  await applyElasticActorPlaneR3Migration(env.DB);
  await applyPolicyAutopilotR4Migration(env.DB);
  await applyAutonomousCompletionModeMigration(env.DB);
  await env.DB.exec(
    executableMigration(workingProfileSkillsMigrationEntry.source),
  );
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
  await env.DB.prepare("DELETE FROM continuity_checkpoint_receipts").run();
  await env.DB.prepare("DELETE FROM continuity_point_dependencies").run();
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
  await env.DB.prepare("DELETE FROM project_lead_leases").run();
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
    DELETE FROM collaboration_submission_receipts;
    DELETE FROM collaboration_gc_objects;
    DELETE FROM collaboration_packet_rotations;
    DELETE FROM collaboration_grant_clients;
    DELETE FROM collaboration_grants;
    DELETE FROM prepared_project_handoffs;
    DELETE FROM project_initialization_approval_claims;
    DELETE FROM project_creation_requests;
    DELETE FROM project_creation_commits;
    DELETE FROM project_creation_reservations;
    DELETE FROM project_initialization_projects;
    DELETE FROM vault_local_writer_transfers;
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
    DELETE FROM agent_grant_replacements;
    DELETE FROM agent_grants;
    DELETE FROM restored_note_lineage;
    DELETE FROM restore_entries;
    DELETE FROM restore_jobs;
    DELETE FROM snapshot_archives;
    DELETE FROM snapshot_entries;
    DELETE FROM snapshot_vaults;
    DELETE FROM workspace_snapshots;
    DELETE FROM snapshot_gc_objects;
    DELETE FROM snapshot_objects;
    DELETE FROM materialized_note_search;
    DELETE FROM current_materializations;
    DELETE FROM materialized_notes;
    DELETE FROM materialization_generations;
    DELETE FROM vault_credentials;
    DELETE FROM pairing_grant_origins;
    DELETE FROM pairing_grants;
    DELETE FROM vault_sync_states;
    DELETE FROM vaults;
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM oauth_consent_flows;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
  await clearKv();
  await clearBucket();
}

async function createOwnerSession(): Promise<OwnerSession> {
  const now = Math.floor(Date.now() / 1_000);
  const session = await createSessionMaterial(now);
  await commitFirstOwner(
    env.DB,
    {
      backedUp: true,
      counter: 0,
      credentialId: `md8-passkey-${crypto.randomUUID()}`,
      deviceType: "multiDevice",
      publicKey: new Uint8Array([1, 2, 3]),
      transports: ["internal"],
      webauthnUserId: `md8-owner-${crypto.randomUUID()}`,
    },
    session,
    crypto.randomUUID(),
    now,
  );
  return {
    cookie: `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`,
    csrf: session.csrfToken,
  };
}

async function createProject(): Promise<{
  evidenceSha256: string;
  initialPacketId: string;
  owner: OwnerSession;
  projectId: string;
  projectVersionId: string;
  vaultId: string;
}> {
  const owner = await createOwnerSession();
  const vaultId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO vaults (id, display_name, status, created_at, paired_at)
       VALUES (?, 'MD8 synthetic source', 'active', ?, ?)`,
    ).bind(vaultId, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO vault_sync_states (
        vault_id, plugin_version, schema_version,
        connection_confirmed_at, initial_sync_at, last_sync_at,
        current_state_vector_sha256, library_stale, updated_at
      ) VALUES (?, '0.1.6', 3, ?, ?, ?, ?, 1, ?)`,
    ).bind(vaultId, NOW, NOW, NOW, "b".repeat(64), NOW),
  ]);
  const source = "# MD8 evidence\nSynthetic bounded evidence.";
  await publishMaterialization(env.DB, env.VAULT_STORAGE, {
    now: NOW,
    requestId: crypto.randomUUID(),
    snapshot: {
      notes: [
        {
          byteLength: new TextEncoder().encode(source).byteLength,
          content: source,
          fileId: "md8-evidence",
          modifiedAt: NOW,
          path: "Sources/MD8-evidence.md",
          pathKey: "sources/md8-evidence.md",
          title: "MD8 evidence",
        },
      ],
      schemaVersion: 3,
      totalBytes: new TextEncoder().encode(source).byteLength,
    },
    sourceStateVectorSha256: "b".repeat(64),
    vaultId,
  });
  const request: CollaborationProjectCreateRequest = {
    knowledgeSpace: {
      label: "MD8 synthetic sources",
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
      label: "MD8 MCP autonomous loop",
      objective: "Complete one bounded synthetic coding Work Item.",
    },
    requestedRole: "contributor",
    sourceNotes: [
      { excerptByteRange: null, path: "Sources/MD8-evidence.md", vaultId },
    ],
    workItem: {
      constraints: ["Use only the exact Work Packet and synthetic evidence."],
      definitionOfDone: ["Submit purpose evidence and a fresh checkpoint."],
      objective: "Exercise the provider-neutral MCP completion loop.",
      requestedOutput: "A bounded coding result.",
    },
  };
  const created = await createCollaborationProject(
    env.DB,
    env.VAULT_STORAGE,
    request,
    NOW,
    crypto.randomUUID(),
  );
  const version = await env.DB.prepare(
    `SELECT active_project_version_id
       FROM collaboration_projects WHERE project_id = ?`,
  )
    .bind(created.projectId)
    .first<{ active_project_version_id: string }>();
  if (version === null) throw new Error("Project version projection missing.");
  return {
    evidenceSha256: await sha256Hex(source),
    initialPacketId: created.packet.packetId,
    owner,
    projectId: created.projectId,
    projectVersionId: version.active_project_version_id,
    vaultId,
  };
}

async function registerClient(): Promise<string> {
  const response = await fetchWorker(`${ORIGIN}/register`, {
    body: JSON.stringify({
      client_name: "MD8 synthetic MCP client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: {
      Accept: "application/json",
      "CF-Connecting-IP": `md8-${crypto.randomUUID()}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = z
    .object({ client_id: z.string().min(1) })
    .parse(await response.json());
  return body.client_id;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function authorize(
  owner: OwnerSession,
  clientId: string,
  vaultId: string,
): Promise<{ accessToken: string; sourceGrantId: string }> {
  const verifier = "md8-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const authorizeUrl = new URL(`${ORIGIN}/api/agent/oauth/context`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set(
    "scope",
    ["vault.read", "project.connect.request"].join(" "),
  );
  authorizeUrl.searchParams.set("state", "md8-state");
  authorizeUrl.searchParams.set(
    "code_challenge",
    await pkceChallenge(verifier),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", AUDIENCE);
  const context = await fetchWorker(authorizeUrl, {
    headers: { Cookie: owner.cookie },
  });
  expect(context.status).toBe(200);
  const consent = z
    .object({
      authorizationKind: z.literal("vault"),
      flowToken: z.string().min(1),
    })
    .passthrough()
    .parse(await context.json());
  const approval = await fetchWorker(`${ORIGIN}/api/agent/oauth/approve`, {
    body: JSON.stringify({
      authorizationKind: "vault",
      approvedRestoreIds: [],
      flowToken: consent.flowToken,
      pathPrefixes: [""],
      vaultId,
    }),
    headers: {
      Cookie: owner.cookie,
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "X-OWD-CSRF": owner.csrf,
    },
    method: "POST",
  });
  expect(approval.status).toBe(200);
  const redirect = z
    .object({ redirectTo: z.string().url() })
    .parse(await approval.json());
  const code = new URL(redirect.redirectTo).searchParams.get("code");
  expect(code).not.toBeNull();
  const token = await fetchWorker(`${ORIGIN}/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code: code ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: AUDIENCE,
    }),
    headers: {
      Accept: "application/json",
      "CF-Connecting-IP": `md8-token-${crypto.randomUUID()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  expect(token.status).toBe(200);
  const tokenBody = z
    .object({ access_token: z.string().min(1) })
    .parse(await token.json());
  const grant = await env.DB.prepare(
    `SELECT id FROM agent_grants WHERE oauth_client_id = ? AND status = 'active'`,
  )
    .bind(clientId)
    .first<{ id: string }>();
  if (grant === null) throw new Error("Synthetic source grant missing.");
  return { accessToken: tokenBody.access_token, sourceGrantId: grant.id };
}

let rpcId = 0;
async function callMcp(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<MpcEnvelope["result"]["structuredContent"]> {
  const id = ++rpcId;
  const response = await fetchWorker(`${ORIGIN}/mcp`, {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "MD8 synthetic provider-neutral client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
        arguments: args,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as MpcEnvelope;
  expect(body.jsonrpc).toBe("2.0");
  if (body.result.isError === true) {
    throw new Error(
      `MCP ${name} denied: ${JSON.stringify(body.result.structuredContent)}`,
    );
  }
  return body.result.structuredContent;
}

async function callMcpError(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = ++rpcId;
  const response = await fetchWorker(`${ORIGIN}/mcp`, {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as MpcEnvelope;
  expect(body.result.isError).toBe(true);
  return body.result.structuredContent;
}

async function policyConsent(
  owner: OwnerSession,
  projectId: string,
  completionMode: "orchestrated-reviewed" | "solo-verified" = "solo-verified",
): Promise<void> {
  const response = await fetchWorker(
    `${ORIGIN}/api/collaboration/projects/${projectId}/policy-bindings`,
    {
      body: JSON.stringify({
        checkpointIntervalSeconds: 3_600,
        ...(completionMode === "solo-verified" ? { completionMode } : {}),
        drillIntervalSeconds: 604_800,
      }),
      headers: {
        Cookie: owner.cookie,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-OWD-CSRF": owner.csrf,
      },
      method: "POST",
    },
  );
  expect(response.status).toBe(204);
}

async function setup(): Promise<{
  accessToken: string;
  evidenceSha256: string;
  initialPacketId: string;
  owner: OwnerSession;
  projectId: string;
}> {
  const project = await createProject();
  const clientId = await registerClient();
  const authorization = await authorize(
    project.owner,
    clientId,
    project.vaultId,
  );
  const opened = await callMcp(authorization.accessToken, "open_project", {
    documentationPlan: NO_ROOT_MARKDOWN,
    projectId: project.projectId,
  });
  const accessRequestId = z
    .string()
    .uuid()
    .parse(
      z.object({ accessRequestId: z.string() }).parse(opened.access)
        .accessRequestId,
    );
  const contextResponse = await fetchWorker(
    `${ORIGIN}/api/project-initializations/context?requestId=${accessRequestId}`,
    { headers: { Cookie: project.owner.cookie } },
  );
  expect(contextResponse.status).toBe(200);
  const consent = z
    .object({
      contextPolicy: z.object({}).passthrough(),
      initializationToken: z.string().min(1),
    })
    .parse(await contextResponse.json());
  const approved = await fetchWorker(
    `${ORIGIN}/api/project-initializations/approve`,
    {
      body: JSON.stringify({
        contextPolicy: consent.contextPolicy,
        initializationToken: consent.initializationToken,
      }),
      headers: {
        Cookie: project.owner.cookie,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-OWD-CSRF": project.owner.csrf,
      },
      method: "POST",
    },
  );
  expect(approved.status).toBe(200);
  return {
    accessToken: authorization.accessToken,
    evidenceSha256: project.evidenceSha256,
    initialPacketId: project.initialPacketId,
    owner: project.owner,
    projectId: project.projectId,
  };
}

beforeEach(async () => {
  rpcId = 0;
  await resetState();
});

describe("MD8 MCP autonomous Project loop", () => {
  it("completes a synthetic coding Work Item through the actual MCP transport after owner consent", async () => {
    const setupState = await setup();
    const lead = await callMcp(setupState.accessToken, "claim_project_lead", {
      idempotencyKey: `md8-claim-${crypto.randomUUID()}`,
      leadIdentity: {
        claimedHarness: null,
        claimedModel: null,
        displayName: "MD8 synthetic MCP lead",
      },
      leaseExpiresInSeconds: 600,
      projectId: setupState.projectId,
    });
    const lease = z
      .object({
        fencingToken: z.number().int().positive(),
        leaseId: z.string().uuid(),
      })
      .parse(lead.lease);
    const created = createWorkItemReceiptSchema.parse(
      await callMcp(setupState.accessToken, "create_work_item", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-work-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        packetExpiresInSeconds: 600,
        projectId: setupState.projectId,
        requestedRole: { authority: "none", label: "solo coding actor" },
        sourceWorkPacketId: setupState.initialPacketId,
        workItemBrief: {
          constraints: ["Use synthetic evidence only."],
          definitionOfDone: ["A purpose-specific bundle and checkpoint exist."],
          objective: "Produce one bounded coding result.",
          requestedOutput: "A short verified result.",
        },
      }),
    );
    const started = startRunReceiptSchema.parse(
      await callMcp(setupState.accessToken, "start_run", {
        completionMode: "solo-verified",
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-run-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: setupState.projectId,
        purpose: "coding",
        workItemId: created.workItemId,
      }),
    );
    await policyConsent(setupState.owner, setupState.projectId);
    const actorId = crypto.randomUUID();
    const actor = registerActorReceiptSchema.parse(
      await callMcp(setupState.accessToken, "register_actor", {
        actorId,
        claimedIdentity: "MD8 synthetic solo actor",
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-actor-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        lifetimeSeconds: 300,
        projectId: setupState.projectId,
        runId: started.run.runId,
        scopes: ["run.context.read", "run.bundle.submit"],
        workItemId: created.workItemId,
      }),
    );
    expect(actor.actor.actorId).toBe(actorId);
    const context = runContextSchema.parse(
      (
        await callMcp(setupState.accessToken, "get_run_context", {
          actorId,
          projectId: setupState.projectId,
          runId: started.run.runId,
        })
      ).context,
    );
    expect(context.run).toMatchObject({
      completionMode: "solo-verified",
      runId: started.run.runId,
      workItemId: created.workItemId,
    });
    expect(context.actors).toHaveLength(1);
    expect(context.workPacket.evidenceObjects).toEqual([
      expect.objectContaining({ contentSha256: setupState.evidenceSha256 }),
    ]);
    const inheritedDependencies = await env.DB.prepare(
      `SELECT dependency_id, dependency_kind
       FROM collaboration_dependencies WHERE record_id = ?`,
    )
      .bind(context.workPacket.packetId)
      .all<{ dependency_id: string; dependency_kind: string }>();
    expect(inheritedDependencies.results).toEqual(
      expect.arrayContaining([
        {
          dependency_id: setupState.initialPacketId,
          dependency_kind: "record",
        },
        {
          dependency_id:
            context.workPacket.evidenceObjects[0]!.evidenceObjectId,
          dependency_kind: "evidence",
        },
      ]),
    );
    const bundleReceipt = submitBundleReceiptSchema.parse(
      await callMcp(setupState.accessToken, "submit_bundle", {
        bundle: {
          actorId,
          bundleId: crypto.randomUUID(),
          createdAt: NOW + 5,
          events: [
            {
              actorId,
              claims: [
                {
                  evidenceSha256: setupState.evidenceSha256,
                  key: "coding.change",
                  valueSha256: "c".repeat(64),
                },
                {
                  evidenceSha256: setupState.evidenceSha256,
                  key: "coding.validation",
                  valueSha256: "d".repeat(64),
                },
              ],
              eventId: crypto.randomUUID(),
              eventType: "result.provisional",
              runId: started.run.runId,
              summary: "Synthetic coding result is ready for verification.",
            },
          ],
          format: "owd-event-bundle-v1",
          normalizedRelativePath: null,
          projectId: setupState.projectId,
          requestedActions: [],
          runId: started.run.runId,
          schemaVersion: 1,
          visibility: "run-shared-unvetted",
        },
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-bundle-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: setupState.projectId,
        runId: started.run.runId,
      }),
    );
    expect(bundleReceipt.accepted).toBe(true);
    const checkpoint = await callMcp(
      setupState.accessToken,
      "checkpoint_project",
      {
        acceptedDecisionIds: [],
        artifactIds: [],
        blockers: [],
        citationIds: [],
        completedWork: ["Submitted exact coding evidence through MCP."],
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-checkpoint-${crypto.randomUUID()}`,
        knownRejectedApproaches: [],
        leaseId: lease.leaseId,
        nextAction: "Evaluate the owner-consented solo completion policy.",
        openWork: [],
        packetId: context.workPacket.packetId,
        previousContinuityPointId: null,
        projectId: setupState.projectId,
        risks: [],
        workItemId: created.workItemId,
      },
    );
    expect(checkpoint.ok).toBe(true);
    const evaluation = evaluateRunPolicyReceiptSchema.parse(
      await callMcp(setupState.accessToken, "evaluate_run_policy", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-evaluate-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedOwnerActions: [],
        runId: started.run.runId,
        workItemId: created.workItemId,
      }),
    );
    expect(evaluation.decision).toMatchObject({
      completionMode: "solo-verified",
      outcome: "allow",
      purpose: "coding",
    });
    const completed = completeWorkItemReceiptSchema.parse(
      await callMcp(setupState.accessToken, "complete_work_item", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-complete-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        outcome: "Synthetic coding Work Item completed through MCP.",
        projectId: setupState.projectId,
        runId: started.run.runId,
        workItemId: created.workItemId,
      }),
    );
    expect(completed.completed).toBe(true);
  });

  it("completes a three-actor reviewed Work Item through a lead-mediated MCP connection", async () => {
    const setupState = await setup();
    const lead = await callMcp(setupState.accessToken, "claim_project_lead", {
      idempotencyKey: `md8-mediated-claim-${crypto.randomUUID()}`,
      leadIdentity: {
        claimedHarness: {
          assertedBy: "client",
          name: "synthetic-manager",
          verification: "claimed",
          version: "1.0.0",
        },
        claimedModel: null,
        displayName: "MD8 synthetic orchestration lead",
      },
      leaseExpiresInSeconds: 600,
      projectId: setupState.projectId,
    });
    const lease = z
      .object({
        fencingToken: z.number().int().positive(),
        leaseId: z.string().uuid(),
      })
      .parse(lead.lease);
    const created = createWorkItemReceiptSchema.parse(
      await callMcp(setupState.accessToken, "create_work_item", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-mediated-work-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        packetExpiresInSeconds: 600,
        projectId: setupState.projectId,
        requestedRole: { authority: "none", label: "managed coding actors" },
        sourceWorkPacketId: setupState.initialPacketId,
        workItemBrief: {
          constraints: ["Use synthetic evidence only."],
          definitionOfDone: ["Three actors route an independent review."],
          objective: "Exercise a lead-mediated reviewed coding Run.",
          requestedOutput: "A bounded reviewed result.",
        },
      }),
    );
    const started = startRunReceiptSchema.parse(
      await callMcp(setupState.accessToken, "start_run", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-mediated-run-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: setupState.projectId,
        purpose: "coding",
        workItemId: created.workItemId,
      }),
    );
    await policyConsent(
      setupState.owner,
      setupState.projectId,
      "orchestrated-reviewed",
    );
    const actorIds = {
      coordinator: crypto.randomUUID(),
      producer: crypto.randomUUID(),
      reviewer: crypto.randomUUID(),
    };
    for (const [role, actorId] of Object.entries(actorIds)) {
      registerActorReceiptSchema.parse(
        await callMcp(setupState.accessToken, "register_actor", {
          actorId,
          claimedIdentity: `MD8 synthetic ${role}`,
          fencingToken: lease.fencingToken,
          idempotencyKey: `md8-mediated-actor-${role}-${crypto.randomUUID()}`,
          leaseId: lease.leaseId,
          lifetimeSeconds: 300,
          projectId: setupState.projectId,
          runId: started.run.runId,
          scopes:
            role === "reviewer"
              ? ["run.context.read", "run.review.submit"]
              : ["run.context.read", "run.bundle.submit"],
          workItemId: created.workItemId,
        }),
      );
    }
    const context = runContextSchema.parse(
      (
        await callMcp(setupState.accessToken, "get_run_context", {
          actorId: actorIds.producer,
          projectId: setupState.projectId,
          runId: started.run.runId,
        })
      ).context,
    );
    expect(context.run.completionMode).toBeUndefined();
    expect(context.actors).toHaveLength(3);
    const provisionalId = crypto.randomUUID();
    await callMcp(setupState.accessToken, "submit_bundle", {
      bundle: {
        actorId: actorIds.producer,
        bundleId: provisionalId,
        createdAt: NOW + 5,
        events: [
          {
            actorId: actorIds.producer,
            claims: [
              {
                evidenceSha256: setupState.evidenceSha256,
                key: "coding.change",
                valueSha256: "a".repeat(64),
              },
              {
                evidenceSha256: setupState.evidenceSha256,
                key: "coding.validation",
                valueSha256: "b".repeat(64),
              },
            ],
            eventId: crypto.randomUUID(),
            eventType: "result.provisional",
            runId: started.run.runId,
            summary: "Synthetic managed coding evidence is ready.",
          },
        ],
        format: "owd-event-bundle-v1",
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedActions: [],
        runId: started.run.runId,
        schemaVersion: 1,
        visibility: "run-shared-unvetted",
      },
      fencingToken: lease.fencingToken,
      idempotencyKey: `md8-mediated-result-${crypto.randomUUID()}`,
      leaseId: lease.leaseId,
      projectId: setupState.projectId,
      runId: started.run.runId,
    });
    await callMcp(setupState.accessToken, "submit_bundle", {
      bundle: {
        actorId: actorIds.coordinator,
        bundleId: crypto.randomUUID(),
        createdAt: NOW + 6,
        events: [
          {
            actorId: actorIds.coordinator,
            eventId: crypto.randomUUID(),
            eventType: "review.requested",
            reviewerActorId: actorIds.reviewer,
            runId: started.run.runId,
            targetBundleId: provisionalId,
          },
        ],
        format: "owd-event-bundle-v1",
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedActions: [],
        runId: started.run.runId,
        schemaVersion: 1,
        visibility: "run-shared-unvetted",
      },
      fencingToken: lease.fencingToken,
      idempotencyKey: `md8-mediated-review-request-${crypto.randomUUID()}`,
      leaseId: lease.leaseId,
      projectId: setupState.projectId,
      runId: started.run.runId,
    });
    await callMcp(setupState.accessToken, "submit_bundle", {
      bundle: {
        actorId: actorIds.reviewer,
        bundleId: crypto.randomUUID(),
        createdAt: NOW + 7,
        events: [
          {
            actorId: actorIds.reviewer,
            eventId: crypto.randomUUID(),
            eventType: "review.completed",
            findings: [],
            runId: started.run.runId,
            summary: "Independent managed review passed.",
            targetBundleId: provisionalId,
            verdict: "pass",
          },
        ],
        format: "owd-event-bundle-v1",
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedActions: [],
        runId: started.run.runId,
        schemaVersion: 1,
        visibility: "run-shared-unvetted",
      },
      fencingToken: lease.fencingToken,
      idempotencyKey: `md8-mediated-review-result-${crypto.randomUUID()}`,
      leaseId: lease.leaseId,
      projectId: setupState.projectId,
      runId: started.run.runId,
    });
    await callMcp(setupState.accessToken, "checkpoint_project", {
      acceptedDecisionIds: [],
      artifactIds: [],
      blockers: [],
      citationIds: [],
      completedWork: ["Three managed actors routed independent review."],
      fencingToken: lease.fencingToken,
      idempotencyKey: `md8-mediated-checkpoint-${crypto.randomUUID()}`,
      knownRejectedApproaches: ["Self-review."],
      leaseId: lease.leaseId,
      nextAction: "Evaluate the reviewed completion policy.",
      openWork: [],
      packetId: context.workPacket.packetId,
      previousContinuityPointId: null,
      projectId: setupState.projectId,
      risks: [],
      workItemId: created.workItemId,
    });
    const evaluation = evaluateRunPolicyReceiptSchema.parse(
      await callMcp(setupState.accessToken, "evaluate_run_policy", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-mediated-evaluate-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedOwnerActions: [],
        runId: started.run.runId,
        workItemId: created.workItemId,
      }),
    );
    expect(evaluation.decision).toMatchObject({
      outcome: "allow",
      purpose: "coding",
    });
    expect(evaluation.decision.completionMode).toBeUndefined();
    expect(
      completeWorkItemReceiptSchema.parse(
        await callMcp(setupState.accessToken, "complete_work_item", {
          fencingToken: lease.fencingToken,
          idempotencyKey: `md8-mediated-complete-${crypto.randomUUID()}`,
          leaseId: lease.leaseId,
          outcome: "Synthetic lead-mediated Work Item completed.",
          projectId: setupState.projectId,
          runId: started.run.runId,
          workItemId: created.workItemId,
        }),
      ).completed,
    ).toBe(true);
  });

  it("denies solo policy evaluation without the owner consent route", async () => {
    const setupState = await setup();
    const lead = await callMcp(setupState.accessToken, "claim_project_lead", {
      idempotencyKey: `md8-deny-claim-${crypto.randomUUID()}`,
      leadIdentity: {
        claimedHarness: null,
        claimedModel: null,
        displayName: "MD8 unconsented lead",
      },
      leaseExpiresInSeconds: 600,
      projectId: setupState.projectId,
    });
    const lease = z
      .object({
        fencingToken: z.number().int().positive(),
        leaseId: z.string().uuid(),
      })
      .parse(lead.lease);
    const created = createWorkItemReceiptSchema.parse(
      await callMcp(setupState.accessToken, "create_work_item", {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-deny-work-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        packetExpiresInSeconds: 600,
        projectId: setupState.projectId,
        requestedRole: { authority: "none", label: "unconsented actor" },
        sourceWorkPacketId: setupState.initialPacketId,
        workItemBrief: {
          constraints: ["Use synthetic evidence only."],
          definitionOfDone: ["Owner consent is required."],
          objective: "Prove solo mode is opt-in.",
          requestedOutput: "A denied policy evaluation.",
        },
      }),
    );
    const started = startRunReceiptSchema.parse(
      await callMcp(setupState.accessToken, "start_run", {
        completionMode: "solo-verified",
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-deny-run-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        projectId: setupState.projectId,
        purpose: "research",
        workItemId: created.workItemId,
      }),
    );
    const denied = await callMcpError(
      setupState.accessToken,
      "evaluate_run_policy",
      {
        fencingToken: lease.fencingToken,
        idempotencyKey: `md8-deny-evaluate-${crypto.randomUUID()}`,
        leaseId: lease.leaseId,
        normalizedRelativePath: null,
        projectId: setupState.projectId,
        requestedOwnerActions: [],
        runId: started.run.runId,
        workItemId: created.workItemId,
      },
    );
    expect(denied).toMatchObject({
      error: { code: "policy_required" },
      ok: false,
    });
  });
});
