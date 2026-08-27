import { ownerDiagnosticsResponseSchema } from "@mdevolved/contracts";
import type { Hono } from "hono";
import { getCollaborationDashboard } from "./collaboration-service";
import { requireOwnerSession } from "./owner-session";
import {
  readManagedTrialPolicy,
  readRuntimeDeploymentConfig,
} from "./runtime-config";
import type { AppBindings } from "./types";

type DiagnosticVaultRow = {
  active_agent_count: number;
  active_project_count: number;
  connection_confirmed_at: number | null;
  id: string;
  initial_sync_at: number | null;
  last_error_code: string | null;
  last_sync_at: number | null;
  library_count: number;
  library_stale: number | null;
  materialization_active_count: number;
  pending_project_request_count: number;
  plugin_version: string | null;
  schema_version: number | null;
  status: "active" | "pending" | "revoked";
};

export function registerDiagnosticsRoutes(app: Hono<AppBindings>): void {
  app.get("/api/diagnostics", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const generatedAt = Math.floor(Date.now() / 1_000);
    const deployment = readRuntimeDeploymentConfig(context.env);
    const [vaultRows, dashboard, trial] = await Promise.all([
      context.env.DB.prepare(
        `SELECT
          vaults.id,
          vaults.status,
          sync.plugin_version,
          sync.schema_version,
          sync.connection_confirmed_at,
          sync.initial_sync_at,
          sync.last_sync_at,
          sync.library_stale,
          sync.last_error_code,
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
          (
            SELECT COUNT(*)
            FROM agent_grants grants
            WHERE grants.vault_id = vaults.id
              AND grants.status = 'active'
          ) AS active_agent_count,
          (
            SELECT COUNT(*)
            FROM project_initialization_requests requests
            WHERE requests.vault_id = vaults.id
              AND requests.status IN ('pending', 'approving')
              AND requests.expires_at > ?
          ) AS pending_project_request_count,
          (
            SELECT COUNT(DISTINCT requests.result_project_id)
            FROM project_initialization_requests requests
            JOIN collaboration_projects projects
              ON projects.project_id = requests.result_project_id
            WHERE requests.vault_id = vaults.id
              AND requests.status = 'approved'
              AND projects.status = 'active'
          ) AS active_project_count
         FROM vaults
         LEFT JOIN vault_sync_states sync ON sync.vault_id = vaults.id
         ORDER BY vaults.created_at, vaults.id
         LIMIT 100`,
      )
        .bind(generatedAt)
        .all<DiagnosticVaultRow>(),
      getCollaborationDashboard(context.env.DB, context.env.VAULT_STORAGE),
      deployment.mode === "managed"
        ? readManagedTrialPolicy(context.env.DB, generatedAt)
        : Promise.resolve(null),
    ]);
    const vaults = vaultRows.results.map((row) => ({
      activeAgentCount: row.active_agent_count,
      activeProjectCount: row.active_project_count,
      connectionConfirmedAt: row.connection_confirmed_at,
      id: row.id,
      initialSyncAt: row.initial_sync_at,
      lastErrorCode: row.last_error_code,
      lastSyncAt: row.last_sync_at,
      libraryState:
        row.status === "revoked"
          ? ("revoked" as const)
          : row.materialization_active_count > 0
            ? ("building" as const)
            : row.library_count > 0
              ? ("current" as const)
              : row.last_error_code !== null
                ? ("failed" as const)
                : row.initial_sync_at === null
                  ? ("not-synced" as const)
                  : ("stale" as const),
      pendingProjectRequestCount: row.pending_project_request_count,
      pluginVersion: row.plugin_version,
      schemaVersion: row.schema_version,
      status: row.status,
    }));
    const projects = dashboard.projects.map((project) => ({
      activeGrantCount: project.activeGrantCount,
      createdAt: project.createdAt,
      currentPacketExpiresAt: project.currentPacket?.expiresAt ?? null,
      duplicateGroupSize: project.duplicateGroupSize,
      id: project.projectId,
      lastActivityAt: project.lastActivityAt,
      pendingAuthorizationCount: project.pendingAuthorizationCount,
      recordCount: project.recordCount,
      sourceVaultIds: project.sourceVaults.map((vault) => vault.id),
      state: project.state,
      status: project.status,
      workItemCount: project.workItemCount,
    }));
    const activeVaults = vaults.filter((vault) => vault.status === "active");
    const activeProjects = projects.filter(
      (project) => project.status === "active",
    );
    const releaseTag = context.env.WORKER_VERSION?.tag;

    context.header("Cache-Control", "private, no-store");
    return context.json(
      ownerDiagnosticsResponseSchema.parse({
        format: "owd-owner-diagnostics-v1",
        generatedAt,
        projects,
        requestId: context.get("requestId"),
        service: {
          deploymentMode: deployment.mode,
          environment: context.env.APP_ENVIRONMENT,
          releaseId: context.env.WORKER_VERSION?.id ?? "local-development",
          releaseTag:
            releaseTag === undefined || releaseTag.length === 0
              ? null
              : releaseTag,
          version: context.env.APP_VERSION,
        },
        totals: {
          activeAgentCount: activeVaults.reduce(
            (total, vault) => total + vault.activeAgentCount,
            0,
          ),
          activeProjectCount: activeProjects.length,
          activeVaultCount: activeVaults.length,
          duplicateProjectCount: projects.filter(
            (project) => project.duplicateGroupSize > 1,
          ).length,
          pendingProjectRequestCount: activeVaults.reduce(
            (total, vault) => total + vault.pendingProjectRequestCount,
            0,
          ),
        },
        trial:
          trial === null
            ? null
            : {
                endsAt: trial.endsAt,
                expired: trial.expired,
                maxVaults: trial.maxVaults,
              },
        vaults,
      }),
    );
  });
}
