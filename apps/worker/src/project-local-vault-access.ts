export type ProjectLocalVaultAccess = {
  basis: "first-project-agent" | "project-creator" | "unassigned";
  enforcement: "advisory";
  handoffRule: "owner-explicit-bounded-task-after-primary-stops";
  humanOwnerRetainsAuthority: true;
  localWriteDefault: "owner-requested-bounded-task-only" | "read-only";
  role: "primary-writer" | "read-only-collaborator";
  scope: "vault";
  warning: string;
};

type PrimaryWriterRow = {
  basis: "first-project-agent" | "project-creator";
  oauth_client_id: string;
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
         assignments.assignment_basis AS basis
       FROM vault_local_writer_assignments assignments
       JOIN current_vault ON current_vault.vault_id = assignments.vault_id`,
    )
    .bind(input.collaborationGrantId, input.oauthClientId, input.projectId)
    .first<PrimaryWriterRow>();

  if (primaryWriter === null) {
    return {
      basis: "unassigned",
      enforcement: "advisory",
      handoffRule: "owner-explicit-bounded-task-after-primary-stops",
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
      basis: primaryWriter.basis,
      enforcement: "advisory",
      handoffRule: "owner-explicit-bounded-task-after-primary-stops",
      humanOwnerRetainsAuthority: true,
      localWriteDefault: "owner-requested-bounded-task-only",
      role: "primary-writer",
      scope: "vault",
      warning:
        "You are the primary vault writer because this client was the first agent to establish an OWD Project for this vault. The human remains the owner, and OWD MCP remains read-only. Use local Obsidian, CLI, shell, or filesystem writes only for an owner-requested bounded task, with the exact vault and paths and no overlapping writer.",
    };
  }

  return {
    basis: primaryWriter.basis,
    enforcement: "advisory",
    handoffRule: "owner-explicit-bounded-task-after-primary-stops",
    humanOwnerRetainsAuthority: true,
    localWriteDefault: "read-only",
    role: "read-only-collaborator",
    scope: "vault",
    warning:
      "Another agent is the primary writer for this vault. Treat local Obsidian, CLI, shell, and filesystem access as read-only. Warn the human owner and hand off proposed changes unless the owner explicitly transfers a bounded task after confirming the prior writer stopped.",
  };
}
