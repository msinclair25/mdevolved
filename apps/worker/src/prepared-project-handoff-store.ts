import type { PreparedProjectHandoff } from "@owd/contracts";
import type { ActiveAgentGrant } from "./agent-access-store";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";
import { projectCreationLabelKey } from "./project-initialization-store";

const HANDOFF_CLAIM_SECONDS = 60;

type PreparedProjectHandoffRow = {
  agent_grant_id: string;
  folder_path: string;
  folder_path_key: string;
  id: string;
  initialization_request_id: string | null;
  prepared_at: number;
  project_label: string;
  project_label_key: string;
  status: "claiming" | "consumed" | "prepared" | "revoked";
  vault_id: string;
};

export type PreparedProjectHandoffRecord = {
  agentGrantId: string;
  folderBoundary: string;
  folderPathKey: string;
  id: string;
  initializationRequestId: string | null;
  preparedAt: number;
  projectLabel: string;
  projectLabelKey: string;
  status: PreparedProjectHandoffRow["status"];
  vaultId: string;
};

function fromRow(row: PreparedProjectHandoffRow): PreparedProjectHandoffRecord {
  return {
    agentGrantId: row.agent_grant_id,
    folderBoundary: row.folder_path,
    folderPathKey: row.folder_path_key,
    id: row.id,
    initializationRequestId: row.initialization_request_id,
    preparedAt: row.prepared_at,
    projectLabel: row.project_label,
    projectLabelKey: row.project_label_key,
    status: row.status,
    vaultId: row.vault_id,
  };
}

function publicHandoff(
  value: PreparedProjectHandoffRecord,
): PreparedProjectHandoff {
  return {
    folderBoundary: value.folderBoundary,
    id: value.id,
    preparedAt: value.preparedAt,
    projectLabel: value.projectLabel,
  };
}

function normalizedFolder(value: string): {
  folderPath: string;
  folderPathKey: string;
} {
  const trimmed = value.normalize("NFC").trim().replace(/\/+$/u, "");
  if (trimmed === "") return { folderPath: "", folderPathKey: "" };
  const suffix = "/__owd_prepared_project__.md";
  try {
    const sentinel = validateMarkdownVaultPath(`${trimmed}${suffix}`);
    return {
      folderPath: sentinel.path.slice(0, -suffix.length),
      folderPathKey: sentinel.pathKey.slice(0, -suffix.length),
    };
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new Error(
        "The prepared Project folder is not a safe vault folder.",
      );
    }
    throw error;
  }
}

function folderAllowedByGrant(
  grant: Pick<ActiveAgentGrant, "pathKeyPrefixes">,
  folderPathKey: string,
): boolean {
  if (grant.pathKeyPrefixes.length === 0) return true;
  if (folderPathKey === "") return false;
  const candidatePrefix = `${folderPathKey}/`;
  return grant.pathKeyPrefixes.some((prefix) =>
    candidatePrefix.startsWith(prefix),
  );
}

export function normalizePreparedProjectHandoff(
  grant: Pick<ActiveAgentGrant, "pathKeyPrefixes" | "pathPrefixes" | "scopes">,
  input: { folderBoundary: string; projectLabel: string },
): {
  folderPath: string;
  folderPathKey: string;
  projectLabel: string;
  projectLabelKey: string;
} {
  if (
    !grant.scopes.some((scope) => scope === "project.initialize.request") ||
    !grant.scopes.some((scope) => scope === "project.connect.request")
  ) {
    throw new Error(
      "This agent connection cannot create and connect the first Project.",
    );
  }
  const projectLabel = input.projectLabel.normalize("NFC").trim();
  if (projectLabel.length === 0 || projectLabel.length > 120) {
    throw new Error("Enter a Project name between 1 and 120 characters.");
  }
  const requestedFolder =
    input.folderBoundary.trim() === "" && grant.pathPrefixes.length === 1
      ? (grant.pathPrefixes[0] ?? "")
      : input.folderBoundary;
  const folder = normalizedFolder(requestedFolder);
  if (!folderAllowedByGrant(grant, folder.folderPathKey)) {
    throw new Error(
      "The prepared Project folder must stay inside this agent's approved folder boundary.",
    );
  }
  return {
    ...folder,
    projectLabel,
    projectLabelKey: projectCreationLabelKey(projectLabel),
  };
}

export async function prepareProjectHandoff(
  db: D1Database,
  input: {
    agentGrantId: string;
    folderPath: string;
    folderPathKey: string;
    now: number;
    projectLabel: string;
    projectLabelKey: string;
    requestId: string;
    vaultId: string;
  },
): Promise<PreparedProjectHandoff | null> {
  const id = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const results = await db.batch<PreparedProjectHandoffRow>([
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'revoked', revoked_at = ?,
           claim_expires_at = NULL
         WHERE vault_id = ? AND status IN ('prepared', 'claiming')`,
      )
      .bind(input.now, input.vaultId),
    db
      .prepare(
        `INSERT INTO prepared_project_handoffs (
          id, agent_grant_id, vault_id, project_label, project_label_key,
          folder_path, folder_path_key, status, prepared_at
        )
        SELECT ?, grants.id, grants.vault_id, ?, ?, ?, ?, 'prepared', ?
        FROM agent_grants grants
        JOIN vaults ON vaults.id = grants.vault_id
        WHERE grants.id = ? AND grants.vault_id = ?
          AND grants.status = 'active' AND vaults.status = 'active'
          AND instr(
            grants.scopes_json,
            '"project.initialize.request"'
          ) > 0
          AND instr(
            grants.scopes_json,
            '"project.connect.request"'
          ) > 0
        RETURNING *`,
      )
      .bind(
        id,
        input.projectLabel,
        input.projectLabelKey,
        input.folderPath,
        input.folderPathKey,
        input.now,
        input.agentGrantId,
        input.vaultId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.handoff_prepared', ?, ?
         FROM prepared_project_handoffs
         WHERE id = ? AND status = 'prepared'
         RETURNING id`,
      )
      .bind(auditId, input.requestId, input.now, id),
  ]);
  const row = results[1]?.results[0];
  return row !== undefined && results[2]?.results[0]?.id === auditId
    ? publicHandoff(fromRow(row))
    : null;
}

export async function listPreparedProjectHandoffs(
  db: D1Database,
): Promise<Map<string, PreparedProjectHandoff>> {
  const rows = await db
    .prepare(
      `SELECT handoffs.*
       FROM prepared_project_handoffs handoffs
       JOIN agent_grants grants ON grants.id = handoffs.agent_grant_id
       JOIN vaults ON vaults.id = handoffs.vault_id
       WHERE handoffs.status IN ('prepared', 'claiming')
         AND grants.status = 'active' AND vaults.status = 'active'
       ORDER BY handoffs.prepared_at DESC, handoffs.id DESC
       LIMIT 1000`,
    )
    .all<PreparedProjectHandoffRow>();
  return new Map(
    rows.results.map((row) => {
      const value = fromRow(row);
      return [value.agentGrantId, publicHandoff(value)];
    }),
  );
}

export async function readPreparedProjectHandoffForAgent(
  db: D1Database,
  agentGrantId: string,
): Promise<PreparedProjectHandoffRecord | null> {
  const row = await db
    .prepare(
      `SELECT handoffs.*
       FROM prepared_project_handoffs handoffs
       JOIN agent_grants grants ON grants.id = handoffs.agent_grant_id
       JOIN vaults ON vaults.id = handoffs.vault_id
       WHERE handoffs.agent_grant_id = ?
         AND handoffs.status IN ('prepared', 'claiming')
         AND grants.status = 'active' AND vaults.status = 'active'
       ORDER BY handoffs.prepared_at DESC, handoffs.id DESC
       LIMIT 1`,
    )
    .bind(agentGrantId)
    .first<PreparedProjectHandoffRow>();
  return row === null ? null : fromRow(row);
}

export async function claimPreparedProjectHandoff(
  db: D1Database,
  input: {
    agentGrantId: string;
    folderPathKey: string;
    initializationRequestId: string;
    now: number;
    projectLabelKey: string;
    requestId: string;
    vaultId: string;
  },
): Promise<PreparedProjectHandoffRecord | null> {
  const auditId = crypto.randomUUID();
  const results = await db.batch<PreparedProjectHandoffRow>([
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'claiming', initialization_request_id = ?,
           claimed_at = ?, claim_expires_at = ?
         WHERE agent_grant_id = ? AND vault_id = ?
           AND project_label_key = ? AND folder_path_key = ?
           AND (
             status = 'prepared'
             OR (
               status = 'claiming'
               AND initialization_request_id = ?
               AND claim_expires_at <= ?
             )
           )
           AND EXISTS (
             SELECT 1
             FROM project_initialization_requests requests
             JOIN agent_grants grants
               ON grants.id = requests.bootstrap_agent_grant_id
             WHERE requests.id = ?
               AND requests.bootstrap_agent_grant_id =
                 prepared_project_handoffs.agent_grant_id
               AND requests.vault_id = prepared_project_handoffs.vault_id
               AND requests.status = 'pending'
               AND requests.expires_at > ?
               AND grants.status = 'active'
           )
         RETURNING *`,
      )
      .bind(
        input.initializationRequestId,
        input.now,
        input.now + HANDOFF_CLAIM_SECONDS,
        input.agentGrantId,
        input.vaultId,
        input.projectLabelKey,
        input.folderPathKey,
        input.initializationRequestId,
        input.now,
        input.initializationRequestId,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.handoff_claimed', ?, ?
         WHERE changes() > 0
         RETURNING id`,
      )
      .bind(auditId, input.requestId, input.now),
  ]);
  const row = results[0]?.results[0];
  return row !== undefined && results[1]?.results[0]?.id === auditId
    ? fromRow(row)
    : null;
}

export async function preparedProjectHandoffClaimInProgress(
  db: D1Database,
  input: {
    agentGrantId: string;
    folderPathKey: string;
    initializationRequestId: string;
    now: number;
    projectLabelKey: string;
    vaultId: string;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active
       FROM prepared_project_handoffs handoffs
       JOIN project_initialization_requests requests
         ON requests.id = handoffs.initialization_request_id
       JOIN agent_grants grants ON grants.id = handoffs.agent_grant_id
       WHERE handoffs.agent_grant_id = ? AND handoffs.vault_id = ?
         AND handoffs.project_label_key = ? AND handoffs.folder_path_key = ?
         AND handoffs.status = 'claiming'
         AND handoffs.initialization_request_id = ?
         AND requests.status IN ('pending', 'approving')
         AND requests.expires_at > ?
         AND grants.status = 'active'
       LIMIT 1`,
    )
    .bind(
      input.agentGrantId,
      input.vaultId,
      input.projectLabelKey,
      input.folderPathKey,
      input.initializationRequestId,
      input.now,
    )
    .first<{ active: number }>();
  return row?.active === 1;
}

export async function consumePreparedProjectHandoff(
  db: D1Database,
  input: {
    handoffId: string;
    initializationRequestId: string;
    now: number;
    requestId: string;
  },
): Promise<boolean> {
  const auditId = crypto.randomUUID();
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE prepared_project_handoffs
         SET status = 'consumed', consumed_at = ?,
           claim_expires_at = NULL
         WHERE id = ? AND status = 'claiming'
           AND initialization_request_id = ?
           AND EXISTS (
             SELECT 1 FROM project_initialization_requests requests
             WHERE requests.id = ?
               AND requests.status = 'approved'
           )
         RETURNING id`,
      )
      .bind(
        input.now,
        input.handoffId,
        input.initializationRequestId,
        input.initializationRequestId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.handoff_consumed', ?, ?
         WHERE changes() > 0
         RETURNING id`,
      )
      .bind(auditId, input.requestId, input.now),
  ]);
  return (
    results[0]?.results[0]?.id === input.handoffId &&
    results[1]?.results[0]?.id === auditId
  );
}

export async function releasePreparedProjectHandoff(
  db: D1Database,
  input: { handoffId: string; initializationRequestId: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE prepared_project_handoffs
       SET status = 'prepared', initialization_request_id = NULL,
         claimed_at = NULL, claim_expires_at = NULL
       WHERE id = ? AND status = 'claiming'
         AND initialization_request_id = ?`,
    )
    .bind(input.handoffId, input.initializationRequestId)
    .run();
}
