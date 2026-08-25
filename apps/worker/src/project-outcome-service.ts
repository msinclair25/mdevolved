import { projectOutcomeSchema, type ProjectOutcome } from "@owd/contracts";

export class ProjectOutcomeProblem extends Error {
  constructor(readonly code: "project_not_found") {
    super(code);
    this.name = "ProjectOutcomeProblem";
  }
}

type ProjectOutcomeRow = {
  accepted_memory_count: number;
  checkpoint_client_count: number;
  latest_checkpoint_at: number | null;
  pending_suggestion_count: number;
  project_id: string | null;
};

/**
 * Read only aggregate evidence for the owner surface. The query intentionally
 * keeps client slots and all durable content server-side; only the threshold
 * and bounded counters leave this service.
 */
export async function getProjectOutcome(
  db: D1Database,
  projectId: string,
): Promise<ProjectOutcome> {
  const row = await db
    .prepare(
      `SELECT
         projects.project_id,
         COALESCE((
           SELECT COUNT(DISTINCT points.producer_client_id)
           FROM project_continuity_points points
           WHERE points.project_id = projects.project_id
             AND points.restored_at IS NULL
             AND points.producer_client_id IS NOT NULL
         ), 0) AS checkpoint_client_count,
         (
           SELECT MAX(points.acknowledged_at)
           FROM project_continuity_points points
           WHERE points.project_id = projects.project_id
             AND points.restored_at IS NULL
         ) AS latest_checkpoint_at,
         (
           SELECT COUNT(*)
           FROM working_preferences preferences
           WHERE preferences.status = 'active'
             AND (
               preferences.project_id IS NULL OR
               preferences.project_id = projects.project_id
             )
         ) + (
           SELECT COUNT(*)
           FROM project_skill_attachments attachments
           WHERE attachments.project_id = projects.project_id
         ) AS accepted_memory_count,
         (
           SELECT COUNT(*)
           FROM compounding_drafts drafts
           WHERE drafts.status = 'pending'
             AND (
               drafts.project_id = projects.project_id OR
               (drafts.scope = 'personal' AND drafts.project_id IS NULL)
             )
         ) AS pending_suggestion_count
       FROM collaboration_projects projects
       WHERE projects.project_id = ?
         AND projects.status = 'active'`,
    )
    .bind(projectId)
    .first<ProjectOutcomeRow>();

  if (row === null || row.project_id !== projectId) {
    throw new ProjectOutcomeProblem("project_not_found");
  }

  const checkpointedByMultipleClients = row.checkpoint_client_count >= 2;
  const latestCheckpointAt = row.latest_checkpoint_at;
  const readiness =
    latestCheckpointAt === null
      ? "not_started"
      : checkpointedByMultipleClients
        ? "ready"
        : "building";
  const attention =
    row.pending_suggestion_count > 0
      ? "review_suggestions"
      : checkpointedByMultipleClients
        ? "none"
        : "checkpoint_again";

  return projectOutcomeSchema.parse({
    acceptedMemoryCount: Math.min(
      10_000,
      Math.max(0, row.accepted_memory_count),
    ),
    attention,
    checkpointedByMultipleClients,
    latestCheckpointAt,
    pendingSuggestionCount: Math.min(
      10_000,
      Math.max(0, row.pending_suggestion_count),
    ),
    readiness,
  });
}
