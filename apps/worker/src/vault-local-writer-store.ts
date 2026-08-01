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

type TransferRow = {
  from_oauth_client_id: string;
  id: string;
  target_agent_grant_id: string;
  to_oauth_client_id: string;
  transferred_at: number;
  vault_id: string;
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

export async function transferVaultLocalWriter(
  db: D1Database,
  input: {
    now: number;
    requestId: string;
    targetAgentGrantId: string;
  },
): Promise<TransferRow | null> {
  const transferId = crypto.randomUUID();
  const results = await db.batch<TransferRow>([
    db
      .prepare(
        `INSERT INTO vault_local_writer_transfers (
           id, vault_id, from_oauth_client_id, to_oauth_client_id,
           target_agent_grant_id, request_id, transferred_at
         )
         SELECT ?, target.vault_id, assignments.oauth_client_id,
           target.oauth_client_id, target.id, ?, ?
         FROM agent_grants target
         JOIN vaults ON vaults.id = target.vault_id
           AND vaults.status = 'active'
         JOIN vault_local_writer_assignments assignments
           ON assignments.vault_id = target.vault_id
         WHERE target.id = ? AND target.owner_id = 1
           AND target.status = 'active'
           AND assignments.oauth_client_id != target.oauth_client_id
           AND EXISTS (
             SELECT 1
             FROM collaboration_grants project_grants
             WHERE project_grants.source_agent_grant_id = target.id
               AND project_grants.oauth_client_id = target.oauth_client_id
               AND project_grants.status = 'active'
           )
         RETURNING id, vault_id, from_oauth_client_id, to_oauth_client_id,
           target_agent_grant_id, transferred_at`,
      )
      .bind(transferId, input.requestId, input.now, input.targetAgentGrantId),
    db
      .prepare(
        `UPDATE vault_local_writer_assignments
         SET oauth_client_id = (
           SELECT to_oauth_client_id
           FROM vault_local_writer_transfers
           WHERE id = ?
         ), updated_at = ?
         WHERE vault_id = (
           SELECT vault_id FROM vault_local_writer_transfers WHERE id = ?
         ) AND oauth_client_id = (
           SELECT from_oauth_client_id
           FROM vault_local_writer_transfers
           WHERE id = ?
         )
         RETURNING vault_id`,
      )
      .bind(transferId, input.now, transferId, transferId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'vault.primary_writer_transferred', request_id,
           transferred_at
         FROM vault_local_writer_transfers
         WHERE id = ?`,
      )
      .bind(crypto.randomUUID(), transferId),
  ]);

  return results[0]?.results[0] ?? null;
}
