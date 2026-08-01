export type ProjectLocalVaultAccess = {
  basis:
    "first-project-agent" | "owner-transfer" | "project-creator" | "unassigned";
  enforcement: "advisory";
  handoffRule: "owner-dashboard-transfer-after-previous-writer-stops";
  humanOwnerRetainsAuthority: true;
  localWriteDefault: "owner-requested-bounded-task-only" | "read-only";
  role: "primary-writer" | "read-only-collaborator";
  scope: "vault";
  warning: string;
};

type PrimaryWriterRow = {
  basis: "first-project-agent" | "project-creator";
  oauth_client_id: string;
  transferred: number;
};

export async function projectLocalVaultAccess(
  db: D1Database,
  input: {
    collaborationGrantId: string;
    oauthClientId: string;
    projectId: string;
  },
): Promise<ProjectLocalVaultAccess> {
  const primaryWriter = await db
    .prepare(
      `WITH current_vault AS (
         SELECT source.vault_id
         FROM collaboration_grants grants
         JOIN agent_grants source
           ON source.id = grants.source_agent_grant_id
         WHERE grants.id = ? AND grants.oauth_client_id = ?
           AND grants.project_id = ?
           AND source.oauth_client_id = grants.oauth_client_id
           AND source.vault_id IS NOT NULL
         LIMIT 1
       )
       SELECT assignments.oauth_client_id,
         assignments.assignment_basis AS basis,
         CASE WHEN EXISTS (
           SELECT 1
           FROM vault_local_writer_transfers transfers
           WHERE transfers.vault_id = assignments.vault_id
             AND transfers.to_oauth_client_id = assignments.oauth_client_id
         ) THEN 1 ELSE 0 END AS transferred
       FROM vault_local_writer_assignments assignments
       JOIN current_vault ON current_vault.vault_id = assignments.vault_id`,
    )
    .bind(input.collaborationGrantId, input.oauthClientId, input.projectId)
    .first<PrimaryWriterRow>();

  if (primaryWriter === null) {
    return {
      basis: "unassigned",
      enforcement: "advisory",
      handoffRule: "owner-dashboard-transfer-after-previous-writer-stops",
      humanOwnerRetainsAuthority: true,
      localWriteDefault: "read-only",
      role: "read-only-collaborator",
      scope: "vault",
      warning:
        "OWD cannot identify a primary vault writer for this legacy Project connection. Treat local Obsidian, CLI, shell, and filesystem access as read-only and warn the human owner before any direct vault change.",
    };
  }

  if (primaryWriter.oauth_client_id === input.oauthClientId) {
    return {
      basis:
        primaryWriter.transferred === 1
          ? "owner-transfer"
          : primaryWriter.basis,
      enforcement: "advisory",
      handoffRule: "owner-dashboard-transfer-after-previous-writer-stops",
      humanOwnerRetainsAuthority: true,
      localWriteDefault: "owner-requested-bounded-task-only",
      role: "primary-writer",
      scope: "vault",
      warning:
        primaryWriter.transferred === 1
          ? "You are the primary vault writer because the human owner explicitly moved the vault-wide role to this OWD client. A session restart does not change this assignment. OWD MCP remains read-only. Use local Obsidian, CLI, shell, or filesystem writes only for an owner-requested bounded task, with the exact vault and paths and no overlapping writer."
          : "You are the primary vault writer because this OWD client was the first agent to establish a Project for this vault. A session restart using the same client does not change this assignment. The human remains the owner, and OWD MCP remains read-only. Use local Obsidian, CLI, shell, or filesystem writes only for an owner-requested bounded task, with the exact vault and paths and no overlapping writer.",
    };
  }

  return {
    basis:
      primaryWriter.transferred === 1 ? "owner-transfer" : primaryWriter.basis,
    enforcement: "advisory",
    handoffRule: "owner-dashboard-transfer-after-previous-writer-stops",
    humanOwnerRetainsAuthority: true,
    localWriteDefault: "read-only",
    role: "read-only-collaborator",
    scope: "vault",
    warning:
      "Another OWD client is the primary writer for this vault. Treat local Obsidian, CLI, shell, and filesystem access as read-only. If this client should replace it, ask the human owner to open OWD → Agents and choose Make primary only after the previous writer has stopped.",
  };
}
