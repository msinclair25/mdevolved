export type VaultLocalWriterConnectionState = {
  assignmentBasis:
    "first-project-agent" | "owner-transfer" | "project-creator" | null;
  assignedAt: number | null;
  eligible: boolean;
  role: "primary-writer" | "read-only-collaborator" | "unassigned";
  updatedAt: number | null;
};

type ConnectionWriterRow = {
  assigned_at: number | null;
  assignment_basis: "first-project-agent" | "project-creator" | null;
  eligible: number;
  grant_id: string;
  grant_oauth_client_id: string;
  primary_oauth_client_id: string | null;
  transferred: number;
  updated_at: number | null;
};

export async function listVaultLocalWriterConnectionStates(
  db: D1Database,
): Promise<Map<string, VaultLocalWriterConnectionState>> {
  const rows = await db
    .prepare(
      `SELECT grants.id AS grant_id,
         grants.oauth_client_id AS grant_oauth_client_id,
         assignments.oauth_client_id AS primary_oauth_client_id,
         assignments.assignment_basis,
         assignments.assigned_at,
         assignments.updated_at,
         CASE WHEN EXISTS (
           SELECT 1
           FROM collaboration_grants project_grants
           WHERE project_grants.source_agent_grant_id = grants.id
             AND project_grants.oauth_client_id = grants.oauth_client_id
             AND project_grants.status = 'active'
         ) THEN 1 ELSE 0 END AS eligible,
         CASE WHEN EXISTS (
           SELECT 1
           FROM vault_local_writer_transfers transfers
           WHERE transfers.vault_id = grants.vault_id
             AND transfers.to_oauth_client_id = assignments.oauth_client_id
         ) THEN 1 ELSE 0 END AS transferred
       FROM agent_grants grants
       LEFT JOIN vault_local_writer_assignments assignments
         ON assignments.vault_id = grants.vault_id
       WHERE grants.owner_id = 1
         AND grants.status IN ('active', 'revoked')
       ORDER BY grants.created_at DESC
       LIMIT 1000`,
    )
    .all<ConnectionWriterRow>();

  return new Map(
    rows.results.map((row) => {
      const unassigned = row.primary_oauth_client_id === null;
      return [
        row.grant_id,
        {
          assignedAt: row.assigned_at,
          assignmentBasis: unassigned
            ? null
            : row.transferred === 1
              ? "owner-transfer"
              : row.assignment_basis,
          eligible: row.eligible === 1,
          role: unassigned
            ? "unassigned"
            : row.grant_oauth_client_id === row.primary_oauth_client_id
              ? "primary-writer"
              : "read-only-collaborator",
          updatedAt: row.updated_at,
        },
      ];
    }),
  );
}
