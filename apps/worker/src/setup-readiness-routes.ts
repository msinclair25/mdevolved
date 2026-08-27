import {
  setupReadinessSchema,
  setupVaultNextStepSchema,
  type SetupVaultNextStep,
} from "@mdevolved/contracts";
import type { Hono } from "hono";
import { requireOwnerSession } from "./owner-session";
import type { AppBindings } from "./types";

type VaultReadinessRow = {
  active_agent_count: number;
  active_project_count: number;
  active_project_grant_count: number;
  display_name: string;
  id: string;
  initial_sync_at: number | null;
  last_error_code: string | null;
  last_sync_at: number | null;
  library_count: number;
  materialization_active_count: number;
  pending_project_request_count: number;
  pending_project_request_id: string | null;
  plugin_version: string | null;
  prepared_agent_grant_id: string | null;
  prepared_at: number | null;
  prepared_client_name: string | null;
  prepared_folder_path: string | null;
  prepared_project_label: string | null;
  verified_snapshot_count: number;
};

type PendingProjectRequestRow = {
  client_name: string;
  project_label: string | null;
  request_id: string;
  request_kind: string | null;
  vault_id: string;
};

function nextVaultStep(
  row: VaultReadinessRow,
): Exclude<SetupVaultNextStep, "ready"> | "ready" {
  if (row.initial_sync_at === null) return "sync-vault";
  if (row.library_count === 0) return "build-library";
  if (row.active_agent_count === 0) return "connect-agent";
  if (row.prepared_agent_grant_id !== null) {
    return "create-or-select-project";
  }
  if (row.pending_project_request_count > 0) {
    return "approve-project";
  }
  if (row.active_project_count === 0 || row.active_project_grant_count === 0) {
    return "prepare-project-handoff";
  }
  return "ready";
}

export function registerSetupReadinessRoutes(app: Hono<AppBindings>): void {
  app.get("/api/setup/readiness", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const now = Math.floor(Date.now() / 1_000);
    const [rows, pendingRequestRows] = await Promise.all([
      context.env.DB.prepare(
        `SELECT
        vaults.id,
        COALESCE(NULLIF(vaults.display_name, ''), vaults.id) AS display_name,
        sync.initial_sync_at,
        sync.last_sync_at,
        sync.plugin_version,
        sync.last_error_code,
        prepared_agent.id AS prepared_agent_grant_id,
        prepared_agent.client_name AS prepared_client_name,
        prepared_handoff.project_label AS prepared_project_label,
        prepared_handoff.folder_path AS prepared_folder_path,
        prepared_handoff.prepared_at,
        EXISTS(
          SELECT 1
          FROM current_materializations current
          JOIN materialization_generations generation
            ON generation.id = current.generation_id
          WHERE current.vault_id = vaults.id
            AND generation.status = 'published'
            AND sync.initial_sync_at IS NOT NULL
            AND sync.library_stale = 0
            AND sync.current_state_vector_sha256 =
              generation.source_state_vector_sha256
        ) AS library_count,
        EXISTS(
          SELECT 1
          FROM materialization_jobs jobs
          WHERE jobs.vault_id = vaults.id
            AND jobs.status IN ('queued', 'running')
        ) AS materialization_active_count,
        EXISTS(
          SELECT 1
          FROM workspace_snapshots snapshots
          JOIN snapshot_vaults snapshot_membership
            ON snapshot_membership.snapshot_id = snapshots.id
          JOIN current_materializations current
            ON current.vault_id = snapshot_membership.source_vault_id
          WHERE snapshot_membership.source_vault_id = vaults.id
            AND snapshot_membership.generation_id = current.generation_id
            AND snapshots.status = 'ready'
            AND snapshots.integrity_status = 'verified'
        ) AS verified_snapshot_count,
        (
          SELECT COUNT(*)
          FROM agent_grants grants
          WHERE grants.vault_id = vaults.id
            AND grants.status = 'active'
            AND instr(
              grants.scopes_json,
              '"project.initialize.request"'
            ) > 0
            AND instr(
              grants.scopes_json,
              '"project.connect.request"'
            ) > 0
        ) AS active_agent_count,
        (
          SELECT COUNT(*)
          FROM project_initialization_requests requests
          JOIN agent_grants request_grants
            ON request_grants.id = requests.bootstrap_agent_grant_id
          WHERE requests.vault_id = vaults.id
            AND requests.status IN ('pending', 'approving')
            AND requests.expires_at > ?
            AND request_grants.status = 'active'
        ) AS pending_project_request_count,
        (
          SELECT requests.id
          FROM project_initialization_requests requests
          JOIN agent_grants request_grants
            ON request_grants.id = requests.bootstrap_agent_grant_id
          WHERE requests.vault_id = vaults.id
            AND requests.status IN ('pending', 'approving')
            AND requests.expires_at > ?
            AND request_grants.status = 'active'
          ORDER BY requests.created_at DESC, requests.id DESC
          LIMIT 1
        ) AS pending_project_request_id,
        (
          SELECT COUNT(DISTINCT requests.result_project_id)
          FROM project_initialization_requests requests
          JOIN collaboration_projects projects
            ON projects.project_id = requests.result_project_id
          WHERE requests.vault_id = vaults.id
            AND requests.status = 'approved'
            AND projects.status = 'active'
            AND projects.agent_visibility = 'discoverable'
        ) AS active_project_count,
        (
          SELECT COUNT(DISTINCT project_grants.id)
          FROM collaboration_grants project_grants
          JOIN agent_grants source_grants
            ON source_grants.id = project_grants.source_agent_grant_id
          JOIN collaboration_projects projects
            ON projects.project_id = project_grants.project_id
          WHERE source_grants.vault_id = vaults.id
            AND source_grants.status = 'active'
            AND project_grants.status = 'active'
            AND project_grants.expires_at > ?
            AND projects.status = 'active'
            AND projects.agent_visibility = 'discoverable'
            AND EXISTS (
              SELECT 1
              FROM project_initialization_requests requests
              WHERE requests.result_project_id = project_grants.project_id
                AND requests.vault_id = vaults.id
                AND requests.oauth_client_id =
                  project_grants.oauth_client_id
                AND requests.audience = project_grants.audience
                AND requests.status = 'approved'
            )
        ) AS active_project_grant_count
       FROM vaults
       LEFT JOIN vault_sync_states sync ON sync.vault_id = vaults.id
       LEFT JOIN prepared_project_handoffs prepared_handoff
         ON prepared_handoff.vault_id = vaults.id
        AND prepared_handoff.status IN ('prepared', 'claiming')
       LEFT JOIN agent_grants prepared_agent
         ON prepared_agent.id = prepared_handoff.agent_grant_id
        AND prepared_agent.status = 'active'
       WHERE vaults.status = 'active'
       ORDER BY vaults.created_at, vaults.id
       LIMIT 100`,
      )
        .bind(now, now, now)
        .all<VaultReadinessRow>(),
      context.env.DB.prepare(
        `WITH ranked_requests AS (
             SELECT requests.id AS request_id, requests.vault_id,
               requests.client_name,
               json_extract(requests.draft_json, '$.project.label')
                 AS project_label,
               json_extract(requests.draft_json, '$.requestKind')
                 AS request_kind,
               ROW_NUMBER() OVER (
                 PARTITION BY requests.vault_id
                 ORDER BY requests.created_at, requests.id
               ) AS vault_rank
             FROM project_initialization_requests requests
             JOIN agent_grants request_grants
               ON request_grants.id = requests.bootstrap_agent_grant_id
             JOIN vaults ON vaults.id = requests.vault_id
             WHERE requests.status IN ('pending', 'approving')
               AND requests.expires_at > ?
               AND request_grants.status = 'active'
               AND vaults.status = 'active'
           )
           SELECT request_id, vault_id, client_name, project_label,
             request_kind
           FROM ranked_requests
           WHERE vault_rank <= 50
           ORDER BY vault_id, vault_rank`,
      )
        .bind(now)
        .all<PendingProjectRequestRow>(),
    ]);
    const pendingByVault = new Map<
      string,
      Array<{
        clientName: string;
        projectLabel: string;
        requestKind: "connect" | "create";
        reviewUrl: string;
      }>
    >();
    for (const request of pendingRequestRows.results) {
      const values = pendingByVault.get(request.vault_id) ?? [];
      values.push({
        clientName: request.client_name.slice(0, 120),
        projectLabel:
          request.project_label?.trim().slice(0, 120) || "Unnamed Project",
        requestKind: request.request_kind === "join" ? "connect" : "create",
        reviewUrl: `/${
          request.request_kind === "join" ? "connect" : "initialize"
        }?requestId=${encodeURIComponent(request.request_id)}`,
      });
      pendingByVault.set(request.vault_id, values);
    }
    const vaults = rows.results.map((row) => {
      const pendingProjectRequests = pendingByVault.get(row.id) ?? [];
      return {
        activeAgentCount: row.active_agent_count,
        activeProjectCount: row.active_project_count,
        activeProjectGrantCount: row.active_project_grant_count,
        displayName: row.display_name,
        id: row.id,
        initialSyncAt: row.initial_sync_at,
        lastSyncAt: row.last_sync_at,
        libraryState:
          row.materialization_active_count > 0
            ? ("building" as const)
            : row.last_error_code !== null
              ? ("failed" as const)
              : row.initial_sync_at === null
                ? ("missing" as const)
                : row.library_count > 0
                  ? ("current" as const)
                  : ("stale" as const),
        libraryReady: row.library_count > 0,
        nextStep: setupVaultNextStepSchema.parse(nextVaultStep(row)),
        pendingProjectRequestCount: row.pending_project_request_count,
        pendingProjectRequests,
        pendingProjectReviewUrl:
          pendingProjectRequests.length !== 1 ||
          row.pending_project_request_id === null
            ? null
            : pendingProjectRequests[0]!.reviewUrl,
        pluginVersion: row.plugin_version,
        preparedProjectHandoff:
          row.prepared_agent_grant_id === null ||
          row.prepared_client_name === null ||
          row.prepared_project_label === null ||
          row.prepared_folder_path === null ||
          row.prepared_at === null
            ? null
            : {
                agentGrantId: row.prepared_agent_grant_id,
                clientName: row.prepared_client_name,
                folderBoundary: row.prepared_folder_path,
                preparedAt: row.prepared_at,
                projectLabel: row.prepared_project_label,
              },
        syncConfirmed: row.initial_sync_at !== null,
        verifiedSnapshot: row.verified_snapshot_count > 0,
      };
    });
    const activeVaultCount = vaults.length;
    const activeAgentCount = vaults.reduce(
      (total, vault) => total + vault.activeAgentCount,
      0,
    );
    const activeProjectCount = vaults.reduce(
      (total, vault) => total + vault.activeProjectCount,
      0,
    );
    const activeProjectGrantCount = vaults.reduce(
      (total, vault) => total + vault.activeProjectGrantCount,
      0,
    );
    const libraryReady =
      vaults.length > 0 && vaults.every((vault) => vault.libraryReady);
    const verifiedSnapshot =
      vaults.length > 0 && vaults.every((vault) => vault.verifiedSnapshot);
    const nextStep =
      activeVaultCount === 0
        ? "connect-vault"
        : (vaults.find((vault) => vault.nextStep !== "ready")?.nextStep ??
          "ready");
    context.header("Cache-Control", "private, no-store");
    return context.json(
      setupReadinessSchema.parse({
        activeAgentCount,
        activeProjectCount,
        activeProjectGrantCount,
        activeVaultCount,
        libraryReady,
        nextStep,
        verifiedSnapshot,
        vaults,
      }),
    );
  });
}
