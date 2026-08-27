import {
  MDEVOLVED_PROJECT_CONTEXT_FORMAT,
  VaultPathError,
  canonicalizeCollaborationJson,
  collaborationScopeSchema,
  projectContextPolicySchema,
  projectInitializationStatusResponseSchema,
  storedProjectSetupDraftSchema,
  validateMarkdownVaultPath,
  type CollaborationScope,
  type ProjectInitializationConsentContext,
  type ProjectContextPolicy,
  type ProjectInitializationStatusResponse,
  type StoredProjectSetupDraft,
} from "@mdevolved/contracts";
import type { ActiveAgentGrant } from "./agent-access-store";
import {
  agentVisibilityForGrant,
  visibilityAllowsPath,
  visibilityAllowsPrefix,
} from "./agent-visibility";
import { agentMayUseCurrentMaterializedPaths } from "./materialization-store";
import { sha256Hex } from "./security";

export const INITIALIZATION_LIFETIME_SECONDS = 60 * 60;
const COLLABORATION_GRANT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const APPROVAL_CLAIM_LIFETIME_SECONDS = 60;

// Read-only compatibility marker for approvals created by releases that
// required a second OAuth flow. New approvals must store a real grant ID.
export const PROJECT_AUTHORIZATION_PENDING = "client-authorization-pending";

type InitializationRow = {
  audience: string;
  authorization_url: string;
  bootstrap_agent_grant_id: string;
  client_name: string;
  client_origin: string;
  created_at: number;
  decided_at: number | null;
  draft_json: string;
  draft_sha256: string;
  expires_at: number;
  folder_path: string;
  folder_path_key: string;
  id: string;
  oauth_client_id: string;
  requested_scopes_json: string;
  result_collaboration_grant_id: string | null;
  result_packet_id: string | null;
  result_project_id: string | null;
  result_work_item_id: string | null;
  semantic_key_sha256: string | null;
  status: "approved" | "approving" | "expired" | "pending" | "rejected";
  token_sha256: string;
  url_elicitation_supported: number;
  vault_id: string;
  vault_name: string;
};

export type StoredProjectInitialization = {
  audience: string;
  authorizationUrl: string;
  bootstrapAgentGrantId: string;
  clientName: string;
  clientOrigin: string;
  createdAt: number;
  decidedAt: number | null;
  draft: StoredProjectSetupDraft;
  draftSha256: string;
  expiresAt: number;
  folderPath: string;
  folderPathKey: string;
  id: string;
  oauthClientId: string;
  requestedScopes: CollaborationScope[];
  resultCollaborationGrantId: string | null;
  resultPacketId: string | null;
  resultProjectId: string | null;
  resultWorkItemId: string | null;
  semanticKeySha256: string | null;
  status: InitializationRow["status"];
  tokenSha256: string;
  urlElicitationSupported: boolean;
  vaultId: string;
  vaultName: string;
};

export type ProjectAuthorizationSourceGrant = Pick<
  ActiveAgentGrant,
  | "audience"
  | "clientId"
  | "clientName"
  | "clientOrigin"
  | "id"
  | "pathKeyPrefixes"
  | "runtimeProfile"
  | "scopes"
  | "vaultId"
>;

export type ActiveProjectAuthorization = {
  audience: string;
  expiresAt: number;
  grantId: string;
  issuedAt: number;
  knowledgeSpaceVersionId: string;
  oauthClientId: string;
  projectId: string;
  scopes: CollaborationScope[];
  sourceAgentGrantId: string;
};

export type ProjectCreationReservation = {
  creationContractSha256: string | null;
  creatorInitializationRequestId: string | null;
  packetId: string | null;
  projectId: string | null;
  projectLabelKey: string;
  vaultId: string;
  workItemId: string | null;
};

type ProjectCreationReservationRow = {
  creation_contract_sha256: string | null;
  creator_initialization_request_id: string | null;
  packet_id: string | null;
  project_id: string | null;
  project_label_key: string;
  vault_id: string;
  work_item_id: string | null;
};

type ProjectAuthorizationRow = {
  audience: string;
  expires_at: number;
  id: string;
  issued_at: number;
  knowledge_space_version_id: string;
  oauth_client_id: string;
  project_id: string;
  scopes_json: string;
  source_agent_grant_id: string;
};

const rowSelect = `SELECT id, token_sha256, bootstrap_agent_grant_id,
  oauth_client_id, client_name, client_origin, audience, vault_id, vault_name,
  folder_path, folder_path_key, draft_json, draft_sha256, authorization_url,
  requested_scopes_json, url_elicitation_supported, status, created_at,
  expires_at, decided_at, result_project_id, result_work_item_id,
  result_packet_id, result_collaboration_grant_id, semantic_key_sha256
  FROM project_initialization_requests`;

function fromRow(row: InitializationRow): StoredProjectInitialization {
  const rawDraft = JSON.parse(row.draft_json) as unknown;
  const compatibleDraftWithoutContext =
    typeof rawDraft === "object" &&
    rawDraft !== null &&
    !("contextPolicy" in rawDraft)
      ? {
          ...rawDraft,
          contextPolicy: {
            excludePaths: [],
            format: MDEVOLVED_PROJECT_CONTEXT_FORMAT,
            includePaths: [row.folder_path],
          },
        }
      : rawDraft;
  const compatibleDraft =
    typeof compatibleDraftWithoutContext === "object" &&
    compatibleDraftWithoutContext !== null &&
    !("requestKind" in compatibleDraftWithoutContext)
      ? { ...compatibleDraftWithoutContext, requestKind: "create" }
      : compatibleDraftWithoutContext;
  const compatibleDraftWithDocumentation =
    typeof compatibleDraft === "object" &&
    compatibleDraft !== null &&
    !("documentationPlan" in compatibleDraft)
      ? {
          ...compatibleDraft,
          documentationPlan: {
            decision: "no-root-markdown",
            proposedMoves: [],
            retainedRootPaths: [],
            rootMarkdownPaths: [],
          },
        }
      : compatibleDraft;
  return {
    audience: row.audience,
    authorizationUrl: row.authorization_url,
    bootstrapAgentGrantId: row.bootstrap_agent_grant_id,
    clientName: row.client_name,
    clientOrigin: row.client_origin,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    draft: storedProjectSetupDraftSchema.parse(
      compatibleDraftWithDocumentation,
    ),
    draftSha256: row.draft_sha256,
    expiresAt: row.expires_at,
    folderPath: row.folder_path,
    folderPathKey: row.folder_path_key,
    id: row.id,
    oauthClientId: row.oauth_client_id,
    requestedScopes: collaborationScopeSchema
      .array()
      .min(1)
      .max(5)
      .parse(JSON.parse(row.requested_scopes_json) as unknown),
    resultCollaborationGrantId: row.result_collaboration_grant_id,
    resultPacketId: row.result_packet_id,
    resultProjectId: row.result_project_id,
    resultWorkItemId: row.result_work_item_id,
    semanticKeySha256: row.semantic_key_sha256,
    status: row.status,
    tokenSha256: row.token_sha256,
    urlElicitationSupported: row.url_elicitation_supported === 1,
    vaultId: row.vault_id,
    vaultName: row.vault_name,
  };
}

function projectAuthorizationFromRow(
  row: ProjectAuthorizationRow,
): ActiveProjectAuthorization {
  return {
    audience: row.audience,
    expiresAt: row.expires_at,
    grantId: row.id,
    issuedAt: row.issued_at,
    knowledgeSpaceVersionId: row.knowledge_space_version_id,
    oauthClientId: row.oauth_client_id,
    projectId: row.project_id,
    scopes: collaborationScopeSchema
      .array()
      .min(1)
      .max(5)
      .parse(JSON.parse(row.scopes_json) as unknown),
    sourceAgentGrantId: row.source_agent_grant_id,
  };
}

function projectCreationReservationFromRow(
  row: ProjectCreationReservationRow,
): ProjectCreationReservation {
  return {
    creationContractSha256: row.creation_contract_sha256,
    creatorInitializationRequestId: row.creator_initialization_request_id,
    packetId: row.packet_id,
    projectId: row.project_id,
    projectLabelKey: row.project_label_key,
    vaultId: row.vault_id,
    workItemId: row.work_item_id,
  };
}

export function projectCreationLabelKey(label: string): string {
  return label.normalize("NFC").trim().toLowerCase();
}

export async function projectCreationContractSha256(input: {
  approvedContextPolicy: ProjectContextPolicy;
  draft: StoredProjectSetupDraft;
  folderPathKey: string;
  vaultId: string;
}): Promise<string> {
  const sourceNotePaths = [...input.draft.sourceNotePaths].sort((left, right) =>
    canonicalizeCollaborationJson(left).localeCompare(
      canonicalizeCollaborationJson(right),
    ),
  );
  return sha256Hex(
    canonicalizeCollaborationJson({
      contextPolicy: input.approvedContextPolicy,
      folderPathKey: input.folderPathKey,
      project: {
        label: projectCreationLabelKey(input.draft.project.label),
        objective: input.draft.project.objective,
      },
      requestedRole: input.draft.requestedRole,
      sourceNotePaths,
      vaultId: input.vaultId,
      workItem: input.draft.workItem,
    }),
  );
}

function sourceGrantMatchesInitialization(
  sourceGrant: ProjectAuthorizationSourceGrant,
  value: StoredProjectInitialization,
): boolean {
  return (
    value.bootstrapAgentGrantId === sourceGrant.id &&
    value.oauthClientId === sourceGrant.clientId &&
    value.clientName === sourceGrant.clientName &&
    value.clientOrigin === sourceGrant.clientOrigin &&
    value.audience === sourceGrant.audience &&
    value.vaultId === sourceGrant.vaultId
  );
}

function grantAllowsFolderPathKey(
  sourceGrant: ProjectAuthorizationSourceGrant,
  pathKey: string,
): boolean {
  return visibilityAllowsPrefix(agentVisibilityForGrant(sourceGrant), pathKey);
}

function grantAllowsNotePathKey(
  sourceGrant: ProjectAuthorizationSourceGrant,
  pathKey: string,
): boolean {
  return visibilityAllowsPath(agentVisibilityForGrant(sourceGrant), pathKey);
}

function folderPathKey(value: string): string | null {
  if (value === "") return "";
  try {
    const directory = value.endsWith("/") ? value.slice(0, -1) : value;
    const sentinel = validateMarkdownVaultPath(
      `${directory}/__owd_project_scope__.md`,
    );
    return sentinel.pathKey.slice(0, -"/__owd_project_scope__.md".length);
  } catch (error) {
    if (error instanceof VaultPathError) return null;
    throw error;
  }
}

async function sourceGrantCoversApprovedContext(
  db: D1Database,
  sourceGrant: ProjectAuthorizationSourceGrant,
  value: StoredProjectInitialization,
): Promise<boolean> {
  const requiredBootstrapScope =
    value.draft.requestKind === "create"
      ? "project.initialize.request"
      : "project.connect.request";
  if (!sourceGrant.scopes.some((scope) => scope === requiredBootstrapScope)) {
    return false;
  }
  if (!grantAllowsFolderPathKey(sourceGrant, value.folderPathKey)) return false;
  for (const includePath of value.draft.contextPolicy.includePaths) {
    const includePathKey = folderPathKey(includePath);
    if (
      includePathKey === null ||
      !grantAllowsFolderPathKey(sourceGrant, includePathKey)
    ) {
      return false;
    }
  }

  const pathKeys: string[] = [];
  for (const sourceNote of value.draft.sourceNotePaths) {
    try {
      const pathKey = validateMarkdownVaultPath(sourceNote.path).pathKey;
      if (!grantAllowsNotePathKey(sourceGrant, pathKey)) return false;
      pathKeys.push(pathKey);
    } catch (error) {
      if (error instanceof VaultPathError) return false;
      throw error;
    }
  }
  const allowed = await agentMayUseCurrentMaterializedPaths(db, {
    grantId: sourceGrant.id,
    pathKeys,
    visibility: agentVisibilityForGrant(sourceGrant),
    vaultId: sourceGrant.vaultId,
  });
  return pathKeys.every((pathKey) => allowed.get(pathKey) === true);
}

async function readActiveProjectAuthorization(
  db: D1Database,
  input: {
    initializationId?: string;
    now: number;
    projectId: string;
    sourceGrant: ProjectAuthorizationSourceGrant;
  },
): Promise<ActiveProjectAuthorization | null> {
  const row = await db
    .prepare(
      `SELECT grants.id, grants.source_agent_grant_id,
        grants.oauth_client_id, grants.audience, grants.project_id,
        grants.knowledge_space_version_id, grants.scopes_json,
        grants.issued_at, grants.expires_at
       FROM project_initialization_requests requests
       JOIN collaboration_grants grants
         ON grants.id = requests.result_collaboration_grant_id
       JOIN collaboration_grant_clients clients
         ON clients.grant_id = grants.id
       JOIN agent_grants approved_source
         ON approved_source.id = requests.bootstrap_agent_grant_id
       JOIN agent_grants source
         ON source.id = grants.source_agent_grant_id
       JOIN vaults source_vault
         ON source_vault.id = source.vault_id
       JOIN collaboration_projects projects
         ON projects.project_id = requests.result_project_id
       JOIN collaboration_records knowledge_space
         ON knowledge_space.id = grants.knowledge_space_version_id
        AND knowledge_space.record_type = 'knowledge-space-version'
       JOIN collaboration_records packet
         ON packet.id = requests.result_packet_id
        AND packet.record_type = 'work-packet'
        AND packet.project_id = requests.result_project_id
        AND packet.work_item_id = requests.result_work_item_id
       JOIN collaboration_dependencies packet_knowledge_space
         ON packet_knowledge_space.record_id = packet.id
        AND packet_knowledge_space.dependency_id =
          grants.knowledge_space_version_id
        AND packet_knowledge_space.dependency_kind = 'record'
       WHERE requests.status = 'approved'
         AND requests.result_project_id = ?
         AND (? IS NULL OR requests.id = ?)
         AND requests.oauth_client_id = ?
         AND requests.audience = ?
         AND requests.vault_id = ?
         AND approved_source.oauth_client_id = requests.oauth_client_id
         AND approved_source.client_name = requests.client_name
         AND approved_source.client_origin = requests.client_origin
         AND approved_source.audience = requests.audience
         AND approved_source.vault_id = requests.vault_id
         AND approved_source.status IN ('active', 'revoked')
         AND source.id = ?
         AND source.oauth_client_id = requests.oauth_client_id
         AND source.client_name = ?
         AND source.client_origin = ?
         AND source.audience = requests.audience
         AND source.vault_id = requests.vault_id
         AND source.scopes_json = ?
         AND source.status = 'active'
         AND source_vault.status = 'active'
         AND projects.status = 'active'
         AND projects.agent_visibility = 'discoverable'
         AND projects.active_knowledge_space_version_id =
           grants.knowledge_space_version_id
         AND grants.source_agent_grant_id = source.id
         AND grants.oauth_client_id = requests.oauth_client_id
         AND grants.audience = requests.audience
         AND grants.project_id = requests.result_project_id
         AND grants.scopes_json = requests.requested_scopes_json
         AND grants.status = 'active'
         AND grants.expires_at > ?
         AND clients.source_agent_grant_id = source.id
         AND clients.client_name = source.client_name
         AND clients.client_origin = source.client_origin
       ORDER BY requests.decided_at DESC, requests.id DESC
       LIMIT 1`,
    )
    .bind(
      input.projectId,
      input.initializationId ?? null,
      input.initializationId ?? null,
      input.sourceGrant.clientId,
      input.sourceGrant.audience,
      input.sourceGrant.vaultId,
      input.sourceGrant.id,
      input.sourceGrant.clientName,
      input.sourceGrant.clientOrigin,
      JSON.stringify(input.sourceGrant.scopes),
      input.now,
    )
    .first<ProjectAuthorizationRow>();
  return row === null ? null : projectAuthorizationFromRow(row);
}

export async function readInitializationByToken(
  db: D1Database,
  token: string,
): Promise<StoredProjectInitialization | null> {
  const row = await db
    .prepare(
      `${rowSelect}
       WHERE id = COALESCE(
         (
           SELECT id FROM project_initialization_requests
           WHERE token_sha256 = ?
         ),
         (
           SELECT initialization_request_id
           FROM project_initialization_token_aliases
           WHERE token_sha256 = ?
         )
       )`,
    )
    .bind(await sha256Hex(token), await sha256Hex(token))
    .first<InitializationRow>();
  return row === null ? null : fromRow(row);
}

export async function readInitializationById(
  db: D1Database,
  id: string,
): Promise<StoredProjectInitialization | null> {
  const row = await db
    .prepare(`${rowSelect} WHERE id = ?`)
    .bind(id)
    .first<InitializationRow>();
  return row === null ? null : fromRow(row);
}

export async function recoverInitializationForBrowser(
  db: D1Database,
  input: { initializationId: string; now: number },
): Promise<StoredProjectInitialization | null> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM project_initialization_approval_claims
         WHERE initialization_request_id = ? AND expires_at <= ?`,
      )
      .bind(input.initializationId, input.now),
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'pending'
         WHERE id = ? AND status = 'approving'
           AND expires_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM project_initialization_approval_claims claims
             WHERE claims.initialization_request_id =
               project_initialization_requests.id
               AND claims.expires_at > ?
           )`,
      )
      .bind(input.initializationId, input.now, input.now),
  ]);
  return readInitializationById(db, input.initializationId);
}

export async function rebindInitializationToEquivalentActiveSuccessor(
  db: D1Database,
  input: { initializationId: string; now: number },
): Promise<string | null> {
  const row = await db
    .prepare(
      `WITH RECURSIVE replacement_chain(grant_id, depth) AS (
         SELECT replacements.successor_grant_id, 1
         FROM agent_grant_replacements replacements
         WHERE replacements.prior_grant_id = (
           SELECT bootstrap_agent_grant_id
           FROM project_initialization_requests
           WHERE id = ?
         )
         UNION ALL
         SELECT replacements.successor_grant_id, chain.depth + 1
         FROM agent_grant_replacements replacements
         JOIN replacement_chain chain
           ON replacements.prior_grant_id = chain.grant_id
         WHERE chain.depth < 32
       ),
       candidate(grant_id) AS (
         SELECT successor.id
         FROM replacement_chain chain
         JOIN agent_grants successor ON successor.id = chain.grant_id
         JOIN project_initialization_requests requests ON requests.id = ?
         JOIN agent_grants original
           ON original.id = requests.bootstrap_agent_grant_id
         JOIN vaults source_vault ON source_vault.id = successor.vault_id
         WHERE successor.status = 'active'
           AND source_vault.status = 'active'
           AND successor.owner_id = original.owner_id
           AND successor.oauth_client_id = original.oauth_client_id
           AND successor.client_name = original.client_name
           AND successor.client_origin = original.client_origin
           AND successor.redirect_uri = original.redirect_uri
           AND successor.audience = original.audience
           AND successor.vault_id = original.vault_id
           AND successor.scopes_json = original.scopes_json
           AND successor.path_prefixes_json = original.path_prefixes_json
           AND successor.path_key_prefixes_json =
             original.path_key_prefixes_json
           AND NOT EXISTS (
             SELECT restore_id FROM agent_grant_restore_sources
             WHERE grant_id = original.id
             EXCEPT
             SELECT restore_id FROM agent_grant_restore_sources
             WHERE grant_id = successor.id
           )
           AND NOT EXISTS (
             SELECT restore_id FROM agent_grant_restore_sources
             WHERE grant_id = successor.id
             EXCEPT
             SELECT restore_id FROM agent_grant_restore_sources
             WHERE grant_id = original.id
           )
         ORDER BY chain.depth DESC
         LIMIT 1
       )
       UPDATE project_initialization_requests
       SET bootstrap_agent_grant_id = (SELECT grant_id FROM candidate),
         status = 'pending'
       WHERE id = ?
         AND status IN ('pending', 'approving')
         AND expires_at > ?
         AND EXISTS (SELECT 1 FROM candidate)
         AND NOT EXISTS (
           SELECT 1 FROM project_initialization_approval_claims claims
           WHERE claims.initialization_request_id =
             project_initialization_requests.id
             AND claims.expires_at > ?
         )
       RETURNING bootstrap_agent_grant_id`,
    )
    .bind(
      input.initializationId,
      input.initializationId,
      input.initializationId,
      input.now,
      input.now,
    )
    .first<{ bootstrap_agent_grant_id: string }>();
  return row?.bootstrap_agent_grant_id ?? null;
}

export async function renewExpiredInitializationRequest(
  db: D1Database,
  input: { id: string; now: number; requestId: string },
): Promise<StoredProjectInitialization | null> {
  const row = await db
    .prepare(
      `UPDATE project_initialization_requests
       SET status = 'pending', expires_at = ?, decided_at = NULL
       WHERE id = ? AND status IN ('pending', 'expired') AND expires_at <= ?
       RETURNING *`,
    )
    .bind(input.now + INITIALIZATION_LIFETIME_SECONDS, input.id, input.now)
    .first<InitializationRow>();
  if (row === null) return null;
  await db
    .prepare(
      `INSERT INTO audit_events (id, event_type, request_id, created_at)
       VALUES (?, 'project.initialization_renewed', ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.requestId, input.now)
    .run();
  return fromRow(row);
}

export async function readInitializationBySemanticKey(
  db: D1Database,
  input: {
    oauthClientId: string;
    semanticKeySha256: string;
    vaultId: string;
  },
): Promise<StoredProjectInitialization | null> {
  const row = await db
    .prepare(
      `${rowSelect}
       WHERE oauth_client_id = ? AND vault_id = ?
         AND semantic_key_sha256 = ?
         AND status IN ('pending', 'approving', 'approved')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(input.oauthClientId, input.vaultId, input.semanticKeySha256)
    .first<InitializationRow>();
  return row === null ? null : fromRow(row);
}

export async function insertInitializationTokenAlias(
  db: D1Database,
  input: {
    expiresAt: number;
    initializationId: string;
    now: number;
    token: string;
  },
): Promise<boolean> {
  const tokenSha256 = await sha256Hex(input.token);
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO project_initialization_token_aliases (
        token_sha256, initialization_request_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?)
      RETURNING initialization_request_id`,
    )
    .bind(
      tokenSha256,
      input.initializationId,
      input.now,
      Math.max(input.expiresAt, input.now + INITIALIZATION_LIFETIME_SECONDS),
    )
    .first<{ initialization_request_id: string }>();
  if (inserted?.initialization_request_id === input.initializationId) {
    return true;
  }
  const existing = await readInitializationByToken(db, input.token);
  return existing?.id === input.initializationId;
}

export async function insertInitializationRequest(
  db: D1Database,
  input: {
    authorizationUrl: string;
    bootstrapAgentGrantId: string;
    clientName: string;
    clientOrigin: string;
    draft: StoredProjectSetupDraft;
    draftSha256: string;
    folderPath: string;
    folderPathKey: string;
    id: string;
    now: number;
    oauthClientId: string;
    projectCreationIdentity?: {
      projectLabelKey: string;
    };
    requestId: string;
    resource: string;
    semanticKeySha256: string;
    token: string;
    urlElicitationSupported: boolean;
    vaultId: string;
    vaultName: string;
  },
): Promise<boolean> {
  const expiresAt = input.now + INITIALIZATION_LIFETIME_SECONDS;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO project_initialization_requests (
          id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
          client_name, client_origin, audience, vault_id, vault_name,
          folder_path, folder_path_key, draft_json, draft_sha256,
          authorization_url, requested_scopes_json,
          url_elicitation_supported, status, created_at, expires_at,
          semantic_key_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
          ?, ?, ?) RETURNING id`,
      )
      .bind(
        input.id,
        await sha256Hex(input.token),
        input.bootstrapAgentGrantId,
        input.oauthClientId,
        input.clientName,
        input.clientOrigin,
        input.resource,
        input.vaultId,
        input.vaultName,
        input.folderPath,
        input.folderPathKey,
        JSON.stringify(input.draft),
        input.draftSha256,
        input.authorizationUrl,
        JSON.stringify(input.draft.requestedScopes),
        input.urlElicitationSupported ? 1 : 0,
        input.now,
        expiresAt,
        input.semanticKeySha256,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.initialization_requested', ?, ?
         WHERE changes() > 0`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now),
  ];
  if (input.projectCreationIdentity !== undefined) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO project_creation_reservations (
            vault_id, project_label_key, creator_initialization_request_id,
            creation_contract_sha256, project_id, work_item_id, packet_id,
            created_at, updated_at
          )
          SELECT requests.vault_id, ?, NULL, NULL, NULL, NULL, NULL,
            requests.created_at, requests.created_at
          FROM project_initialization_requests requests
          WHERE requests.id = ? AND requests.vault_id = ?
            AND requests.bootstrap_agent_grant_id = ?
            AND requests.draft_sha256 = ?
            AND requests.semantic_key_sha256 = ?`,
        )
        .bind(
          input.projectCreationIdentity.projectLabelKey,
          input.id,
          input.vaultId,
          input.bootstrapAgentGrantId,
          input.draftSha256,
          input.semanticKeySha256,
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO project_creation_requests (
            initialization_request_id, vault_id, project_label_key, created_at
          )
          SELECT requests.id, requests.vault_id, ?, requests.created_at
          FROM project_initialization_requests requests
          JOIN project_creation_reservations reservations
            ON reservations.vault_id = requests.vault_id
           AND reservations.project_label_key = ?
          WHERE requests.id = ? AND requests.vault_id = ?
            AND requests.bootstrap_agent_grant_id = ?
            AND requests.draft_sha256 = ?
            AND requests.semantic_key_sha256 = ?
          RETURNING initialization_request_id AS id`,
        )
        .bind(
          input.projectCreationIdentity.projectLabelKey,
          input.projectCreationIdentity.projectLabelKey,
          input.id,
          input.vaultId,
          input.bootstrapAgentGrantId,
          input.draftSha256,
          input.semanticKeySha256,
        ),
    );
  }
  const results = await db.batch<{ id: string }>(statements);
  if (
    input.projectCreationIdentity !== undefined &&
    results[3]?.results[0]?.id !== input.id
  ) {
    return false;
  }
  return results[0]?.results[0]?.id === input.id;
}

export async function ensureProjectCreationIdentity(
  db: D1Database,
  input: {
    initializationId: string;
    now: number;
    projectLabelKey: string;
    vaultId: string;
  },
): Promise<ProjectCreationReservation | null> {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO project_creation_reservations (
          vault_id, project_label_key, creator_initialization_request_id,
          creation_contract_sha256, project_id, work_item_id, packet_id,
          created_at, updated_at
        )
        SELECT requests.vault_id, ?, NULL, NULL, NULL, NULL, NULL,
          requests.created_at, ?
        FROM project_initialization_requests requests
        WHERE requests.id = ? AND requests.vault_id = ?
          AND requests.semantic_key_sha256 IS NOT NULL
          AND COALESCE(
            json_extract(requests.draft_json, '$.requestKind'),
            'create'
          ) = 'create'`,
      )
      .bind(
        input.projectLabelKey,
        input.now,
        input.initializationId,
        input.vaultId,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO project_creation_requests (
          initialization_request_id, vault_id, project_label_key, created_at
        )
        SELECT requests.id, requests.vault_id, ?, requests.created_at
        FROM project_initialization_requests requests
        JOIN project_creation_reservations reservations
          ON reservations.vault_id = requests.vault_id
         AND reservations.project_label_key = ?
        WHERE requests.id = ? AND requests.vault_id = ?
          AND requests.semantic_key_sha256 IS NOT NULL
          AND COALESCE(
            json_extract(requests.draft_json, '$.requestKind'),
            'create'
          ) = 'create'`,
      )
      .bind(
        input.projectLabelKey,
        input.projectLabelKey,
        input.initializationId,
        input.vaultId,
      ),
  ]);
  return canonicalizeProjectCreationReservation(db, input);
}

export async function readProjectCreationReservation(
  db: D1Database,
  initializationId: string,
): Promise<ProjectCreationReservation | null> {
  const row = await db
    .prepare(
      `SELECT reservations.vault_id, reservations.project_label_key,
        reservations.creator_initialization_request_id,
        reservations.creation_contract_sha256, reservations.project_id,
        reservations.work_item_id, reservations.packet_id
       FROM project_creation_requests requests
       JOIN project_creation_reservations reservations
         ON reservations.vault_id = requests.vault_id
        AND reservations.project_label_key = requests.project_label_key
       WHERE requests.initialization_request_id = ?`,
    )
    .bind(initializationId)
    .first<ProjectCreationReservationRow>();
  return row === null ? null : projectCreationReservationFromRow(row);
}

async function canonicalizeProjectCreationReservation(
  db: D1Database,
  input: {
    initializationId: string;
    now: number;
    projectLabelKey: string;
    vaultId: string;
  },
): Promise<ProjectCreationReservation | null> {
  const rows = await db
    .prepare(
      `SELECT vault_id, project_label_key,
        creator_initialization_request_id, creation_contract_sha256,
        project_id, work_item_id, packet_id
       FROM project_creation_reservations
       WHERE vault_id = ?
       ORDER BY project_label_key
       LIMIT 1001`,
    )
    .bind(input.vaultId)
    .all<ProjectCreationReservationRow>();
  if (rows.results.length > 1_000) return null;
  const equivalent = rows.results.filter(
    (row) =>
      projectCreationLabelKey(row.project_label_key) === input.projectLabelKey,
  );
  const target = equivalent.find(
    (row) => row.project_label_key === input.projectLabelKey,
  );
  if (target === undefined) return null;
  if (equivalent.length === 1) {
    return readProjectCreationReservation(db, input.initializationId);
  }

  const bound = equivalent.filter((row) => row.project_id !== null);
  const boundIdentity = (row: ProjectCreationReservationRow): string =>
    JSON.stringify({
      packetId: row.packet_id,
      projectId: row.project_id,
      workItemId: row.work_item_id,
    });
  if (
    new Set(bound.map((row) => boundIdentity(row))).size > 1 ||
    equivalent.some(
      (row) =>
        row.project_id === null &&
        row.creator_initialization_request_id !== null,
    )
  ) {
    return null;
  }
  const boundSource = bound[0];
  const contractHashes = new Set(
    bound
      .map((row) => row.creation_contract_sha256)
      .filter((value): value is string => value !== null),
  );
  const creatorIds = new Set(
    bound
      .map((row) => row.creator_initialization_request_id)
      .filter((value): value is string => value !== null),
  );
  if (contractHashes.size > 1 || creatorIds.size > 1) return null;

  const statements: D1PreparedStatement[] = [];
  if (boundSource !== undefined && target.project_id === null) {
    statements.push(
      db
        .prepare(
          `UPDATE project_creation_reservations
           SET creator_initialization_request_id = ?,
             creation_contract_sha256 = ?, project_id = ?,
             work_item_id = ?, packet_id = ?, updated_at = ?
           WHERE vault_id = ? AND project_label_key = ?
             AND project_id IS NULL
             AND creator_initialization_request_id IS NULL`,
        )
        .bind(
          boundSource.creator_initialization_request_id,
          contractHashes.values().next().value ?? null,
          boundSource.project_id,
          boundSource.work_item_id,
          boundSource.packet_id,
          input.now,
          input.vaultId,
          input.projectLabelKey,
        ),
    );
  }
  const sourceKeys = equivalent
    .map((row) => row.project_label_key)
    .filter((key) => key !== input.projectLabelKey);
  if (sourceKeys.length > 0) {
    const sourceKeysJson = JSON.stringify(sourceKeys);
    statements.push(
      db
        .prepare(
          `UPDATE project_creation_requests
           SET project_label_key = ?
           WHERE vault_id = ?
             AND project_label_key IN (
               SELECT CAST(value AS TEXT) FROM json_each(?)
             )`,
        )
        .bind(input.projectLabelKey, input.vaultId, sourceKeysJson),
      db
        .prepare(
          `DELETE FROM project_creation_reservations
           WHERE vault_id = ?
             AND project_label_key IN (
               SELECT CAST(value AS TEXT) FROM json_each(?)
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_creation_requests requests
               WHERE requests.vault_id =
                   project_creation_reservations.vault_id
                 AND requests.project_label_key =
                   project_creation_reservations.project_label_key
             )
             AND (
               project_id IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM project_creation_reservations target
                 WHERE target.vault_id = ?
                   AND target.project_label_key = ?
                   AND target.project_id =
                     project_creation_reservations.project_id
                   AND target.work_item_id =
                     project_creation_reservations.work_item_id
                   AND target.packet_id =
                     project_creation_reservations.packet_id
               )
             )`,
        )
        .bind(
          input.vaultId,
          sourceKeysJson,
          input.vaultId,
          input.projectLabelKey,
        ),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  const reservation = await readProjectCreationReservation(
    db,
    input.initializationId,
  );
  return reservation?.projectLabelKey === input.projectLabelKey
    ? reservation
    : null;
}

export async function bindProjectCreationReservation(
  db: D1Database,
  initializationId: string,
  now: number,
): Promise<ProjectCreationReservation | null> {
  await db
    .prepare(
      `UPDATE project_creation_reservations
       SET project_id = (
             SELECT receipts.project_id
             FROM project_initialization_projects receipts
             WHERE receipts.initialization_request_id =
               creator_initialization_request_id
           ),
           work_item_id = (
             SELECT receipts.work_item_id
             FROM project_initialization_projects receipts
             WHERE receipts.initialization_request_id =
               creator_initialization_request_id
           ),
           packet_id = (
             SELECT receipts.packet_id
             FROM project_initialization_projects receipts
             WHERE receipts.initialization_request_id =
               creator_initialization_request_id
           ),
           updated_at = ?
       WHERE (vault_id, project_label_key) = (
           SELECT vault_id, project_label_key
           FROM project_creation_requests
           WHERE initialization_request_id = ?
         )
         AND project_id IS NULL
         AND creator_initialization_request_id IS NOT NULL
         AND creation_contract_sha256 IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM project_initialization_projects receipts
           JOIN collaboration_projects projects
             ON projects.project_id = receipts.project_id
           JOIN collaboration_work_items work_items
             ON work_items.work_item_id = receipts.work_item_id
            AND work_items.project_id = receipts.project_id
           JOIN collaboration_records packets
             ON packets.id = receipts.packet_id
            AND packets.record_type = 'work-packet'
            AND packets.project_id = receipts.project_id
            AND packets.work_item_id = receipts.work_item_id
           WHERE receipts.initialization_request_id =
             creator_initialization_request_id
         )`,
    )
    .bind(now, initializationId)
    .run();
  return readProjectCreationReservation(db, initializationId);
}

export async function claimProjectCreationReservation(
  db: D1Database,
  input: {
    creationContractSha256: string;
    initializationId: string;
    now: number;
  },
): Promise<ProjectCreationReservation | null> {
  await db
    .prepare(
      `UPDATE project_creation_reservations
       SET creator_initialization_request_id = ?,
         creation_contract_sha256 = ?, updated_at = ?
       WHERE (vault_id, project_label_key) = (
           SELECT vault_id, project_label_key
           FROM project_creation_requests
           WHERE initialization_request_id = ?
         )
         AND project_id IS NULL
         AND (
           creator_initialization_request_id IS NULL
           OR (
             creator_initialization_request_id = ?
             AND (
               creation_contract_sha256 = ?
               OR (
                 creation_contract_sha256 IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM project_initialization_projects own_receipt
                   WHERE own_receipt.initialization_request_id =
                     creator_initialization_request_id
                 )
               )
             )
           )
           OR (
             NOT EXISTS (
               SELECT 1 FROM project_initialization_projects receipts
               WHERE receipts.initialization_request_id =
                 creator_initialization_request_id
             )
             AND EXISTS (
               SELECT 1 FROM project_initialization_requests abandoned
               WHERE abandoned.id = creator_initialization_request_id
                 AND abandoned.status IN ('expired', 'rejected')
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_initialization_approval_claims claims
               WHERE claims.initialization_request_id =
                 creator_initialization_request_id
                 AND claims.expires_at > ?
             )
           )
         )`,
    )
    .bind(
      input.initializationId,
      input.creationContractSha256,
      input.now,
      input.initializationId,
      input.initializationId,
      input.creationContractSha256,
      input.now,
    )
    .run();
  await bindProjectCreationReservation(db, input.initializationId, input.now);
  return readProjectCreationReservation(db, input.initializationId);
}

export async function adoptBoundProjectCreationContract(
  db: D1Database,
  input: {
    creationContractSha256: string;
    creatorInitializationId: string;
    initializationId: string;
    now: number;
  },
): Promise<ProjectCreationReservation | null> {
  await db
    .prepare(
      `UPDATE project_creation_reservations
       SET creation_contract_sha256 = ?, updated_at = ?
       WHERE (vault_id, project_label_key) = (
           SELECT vault_id, project_label_key
           FROM project_creation_requests
           WHERE initialization_request_id = ?
         )
         AND creator_initialization_request_id = ?
         AND creation_contract_sha256 IS NULL
         AND project_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM project_initialization_projects receipts
           WHERE receipts.initialization_request_id = ?
             AND receipts.project_id =
               project_creation_reservations.project_id
             AND receipts.work_item_id =
               project_creation_reservations.work_item_id
             AND receipts.packet_id =
               project_creation_reservations.packet_id
         )`,
    )
    .bind(
      input.creationContractSha256,
      input.now,
      input.initializationId,
      input.creatorInitializationId,
      input.creatorInitializationId,
    )
    .run();
  return readProjectCreationReservation(db, input.initializationId);
}

export async function releaseProjectCreationReservation(
  db: D1Database,
  input: { initializationId: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE project_creation_reservations
       SET creator_initialization_request_id = NULL,
         creation_contract_sha256 = NULL, updated_at = ?
       WHERE (vault_id, project_label_key) = (
           SELECT vault_id, project_label_key
           FROM project_creation_requests
           WHERE initialization_request_id = ?
         )
         AND creator_initialization_request_id = ?
         AND project_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM project_initialization_projects receipts
           WHERE receipts.initialization_request_id = ?
         )`,
    )
    .bind(
      input.now,
      input.initializationId,
      input.initializationId,
      input.initializationId,
    )
    .run();
}

async function projectCreationReservationAllowsApproval(
  db: D1Database,
  input: {
    creationContractSha256: string;
    initializationId: string;
    packetId: string;
    projectId: string;
    workItemId: string;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS allowed
       FROM project_creation_requests requests
       JOIN project_creation_reservations reservations
         ON reservations.vault_id = requests.vault_id
        AND reservations.project_label_key = requests.project_label_key
       WHERE requests.initialization_request_id = ?
         AND reservations.creation_contract_sha256 = ?
         AND reservations.project_id = ?
         AND reservations.work_item_id = ?
         AND reservations.packet_id = ?`,
    )
    .bind(
      input.initializationId,
      input.creationContractSha256,
      input.projectId,
      input.workItemId,
      input.packetId,
    )
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

export async function claimInitializationForApproval(
  db: D1Database,
  token: string,
  now: number,
): Promise<{
  approvalClaimId: string;
  value: StoredProjectInitialization;
} | null> {
  const tokenSha256 = await sha256Hex(token);
  const approvalClaimId = crypto.randomUUID();
  const results = await db.batch<InitializationRow & { id: string }>([
    db
      .prepare(
        `INSERT INTO project_initialization_approval_claims (
          initialization_request_id, claim_id, claimed_at, expires_at
        )
        SELECT requests.id, ?, ?, ?
        FROM project_initialization_requests requests
        WHERE requests.id = COALESCE(
            (
              SELECT id FROM project_initialization_requests
              WHERE token_sha256 = ?
            ),
            (
              SELECT initialization_request_id
              FROM project_initialization_token_aliases
              WHERE token_sha256 = ?
            )
          )
          AND requests.status IN ('pending', 'approving')
          AND requests.expires_at > ?
        ON CONFLICT(initialization_request_id) DO UPDATE SET
          claim_id = excluded.claim_id,
          claimed_at = excluded.claimed_at,
          expires_at = excluded.expires_at
        WHERE project_initialization_approval_claims.expires_at <= ?
        RETURNING initialization_request_id AS id`,
      )
      .bind(
        approvalClaimId,
        now,
        now + APPROVAL_CLAIM_LIFETIME_SECONDS,
        tokenSha256,
        tokenSha256,
        now,
        now,
      ),
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'pending'
         WHERE id = (
           SELECT initialization_request_id
           FROM project_initialization_approval_claims
           WHERE claim_id = ? AND expires_at > ?
         )
           AND status IN ('pending', 'approving')
         RETURNING *`,
      )
      .bind(approvalClaimId, now),
  ]);
  const row = results[1]?.results[0];
  return results[0]?.results[0]?.id === row?.id && row !== undefined
    ? { approvalClaimId, value: fromRow(row) }
    : null;
}

export async function claimInitializationForApprovalById(
  db: D1Database,
  initializationId: string,
  now: number,
): Promise<{
  approvalClaimId: string;
  value: StoredProjectInitialization;
} | null> {
  const approvalClaimId = crypto.randomUUID();
  const results = await db.batch<InitializationRow & { id: string }>([
    db
      .prepare(
        `INSERT INTO project_initialization_approval_claims (
          initialization_request_id, claim_id, claimed_at, expires_at
        )
        SELECT requests.id, ?, ?, ?
        FROM project_initialization_requests requests
        WHERE requests.id = ?
          AND requests.status IN ('pending', 'approving')
          AND requests.expires_at > ?
        ON CONFLICT(initialization_request_id) DO UPDATE SET
          claim_id = excluded.claim_id,
          claimed_at = excluded.claimed_at,
          expires_at = excluded.expires_at
        WHERE project_initialization_approval_claims.expires_at <= ?
        RETURNING initialization_request_id AS id`,
      )
      .bind(
        approvalClaimId,
        now,
        now + APPROVAL_CLAIM_LIFETIME_SECONDS,
        initializationId,
        now,
        now,
      ),
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'pending'
         WHERE id = (
           SELECT initialization_request_id
           FROM project_initialization_approval_claims
           WHERE claim_id = ? AND expires_at > ?
         )
           AND status IN ('pending', 'approving')
         RETURNING *`,
      )
      .bind(approvalClaimId, now),
  ]);
  const row = results[1]?.results[0];
  return results[0]?.results[0]?.id === row?.id && row !== undefined
    ? { approvalClaimId, value: fromRow(row) }
    : null;
}

export async function returnInitializationToPending(
  db: D1Database,
  id: string,
  approvalClaimId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE project_initialization_requests SET status = 'pending'
         WHERE id = ? AND status = 'approving'
           AND EXISTS (
             SELECT 1 FROM project_initialization_approval_claims
             WHERE initialization_request_id = ? AND claim_id = ?
           )`,
      )
      .bind(id, id, approvalClaimId),
    db
      .prepare(
        `DELETE FROM project_initialization_approval_claims
         WHERE initialization_request_id = ? AND claim_id = ?`,
      )
      .bind(id, approvalClaimId),
  ]);
}

export async function rejectInitialization(
  db: D1Database,
  input: { now: number; requestId: string; token: string },
): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'rejected', decided_at = ?
         WHERE id = COALESCE(
             (
               SELECT id FROM project_initialization_requests
               WHERE token_sha256 = ?
             ),
             (
               SELECT initialization_request_id
               FROM project_initialization_token_aliases
               WHERE token_sha256 = ?
             )
           )
           AND status = 'pending' AND expires_at > ?
           AND NOT EXISTS (
             SELECT 1 FROM project_initialization_approval_claims
             WHERE initialization_request_id =
               project_initialization_requests.id
               AND expires_at > ?
           )
         RETURNING id`,
      )
      .bind(
        input.now,
        await sha256Hex(input.token),
        await sha256Hex(input.token),
        input.now,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.initialization_rejected', ?, ?
         WHERE changes() > 0`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now),
  ]);
  return (results[0]?.results.length ?? 0) === 1;
}

export async function approveInitializationWithProjectGrant(
  db: D1Database,
  input: {
    approvalClaimId: string;
    approvedContextPolicy: unknown;
    creationContractSha256?: string;
    initializationId: string;
    knowledgeSpaceVersionId: string;
    now: number;
    packetId: string;
    preparedProjectHandoffId?: string;
    projectId: string;
    requestId: string;
    sourceGrant: ProjectAuthorizationSourceGrant;
    workItemId: string;
  },
): Promise<ActiveProjectAuthorization | null> {
  const value = await readInitializationById(db, input.initializationId);
  if (
    value === null ||
    !sourceGrantMatchesInitialization(input.sourceGrant, value)
  ) {
    return null;
  }
  if (value.status === "approved") {
    return readActiveProjectAuthorization(db, {
      initializationId: value.id,
      now: input.now,
      projectId: input.projectId,
      sourceGrant: input.sourceGrant,
    });
  }
  if (value.status !== "pending") return null;
  const approvedContextPolicy = projectContextPolicySchema.safeParse(
    input.approvedContextPolicy,
  );
  if (!approvedContextPolicy.success) return null;
  const approvedDraft: StoredProjectSetupDraft = {
    ...value.draft,
    contextPolicy: approvedContextPolicy.data,
  };
  const approvedDraftJson = JSON.stringify(approvedDraft);
  const approvedDraftSha256 = await sha256Hex(
    canonicalizeCollaborationJson(approvedDraft),
  );
  const ownerAction =
    value.draft.requestKind === "join" ? value.draft.ownerAction : undefined;
  if (value.draft.requestKind === "join") {
    const packetStillAuthorized = await isSameOrSuccessorPacket(
      db,
      value.draft.target.packetId,
      input.packetId,
    );
    if (
      value.draft.target.projectId !== input.projectId ||
      value.draft.target.workItemId !== input.workItemId ||
      (ownerAction !== undefined &&
        ownerAction.workItemId !== input.workItemId) ||
      !packetStillAuthorized ||
      value.draft.target.knowledgeSpaceVersionId !==
        input.knowledgeSpaceVersionId
    ) {
      return null;
    }
  } else {
    const receipt = await readInitializationProjectReceipt(db, value.id);
    const ownsExactReceipt =
      receipt !== null &&
      receipt.projectId === input.projectId &&
      receipt.workItemId === input.workItemId &&
      receipt.packetId === input.packetId;
    const followsExactReservation =
      input.creationContractSha256 !== undefined &&
      (await projectCreationReservationAllowsApproval(db, {
        creationContractSha256: input.creationContractSha256,
        initializationId: value.id,
        packetId: input.packetId,
        projectId: input.projectId,
        workItemId: input.workItemId,
      }));
    if (!ownsExactReceipt && !followsExactReservation) {
      return null;
    }
  }

  const grantId = crypto.randomUUID();
  const approvalAuditId = crypto.randomUUID();
  const reopenAuditId = crypto.randomUUID();
  const expiresAt = input.now + COLLABORATION_GRANT_LIFETIME_SECONDS;
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE collaboration_work_items
         SET status = 'open'
         WHERE ? = 1
           AND work_item_id = ? AND project_id = ?
           AND active_work_item_version_id = ? AND status = 'closed'
           AND EXISTS (
             SELECT 1
             FROM collaboration_projects projects
             JOIN collaboration_records packet
               ON packet.id = ?
              AND packet.record_type = 'work-packet'
              AND packet.project_id = projects.project_id
              AND packet.work_item_id = collaboration_work_items.work_item_id
             JOIN collaboration_dependencies packet_knowledge_space
               ON packet_knowledge_space.record_id = packet.id
              AND packet_knowledge_space.dependency_id =
                projects.active_knowledge_space_version_id
              AND packet_knowledge_space.dependency_kind = 'record'
             JOIN project_initialization_requests requests
               ON requests.id = ? AND requests.status = 'pending'
             JOIN project_initialization_approval_claims approval_claim
               ON approval_claim.initialization_request_id = requests.id
              AND approval_claim.claim_id = ?
              AND approval_claim.expires_at > ?
             WHERE projects.project_id = ?
               AND projects.status = 'active'
               AND projects.agent_visibility = 'discoverable'
               AND projects.active_knowledge_space_version_id = ?
           )
         RETURNING work_item_id AS id`,
      )
      .bind(
        ownerAction === undefined ? 0 : 1,
        input.workItemId,
        input.projectId,
        ownerAction?.workItemVersionId ?? "",
        input.packetId,
        input.initializationId,
        input.approvalClaimId,
        input.now,
        input.projectId,
        input.knowledgeSpaceVersionId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'collaboration.work_item_reopened', ?, ?
         WHERE ? = 1 AND changes() > 0
         RETURNING id`,
      )
      .bind(
        reopenAuditId,
        input.requestId,
        input.now,
        ownerAction === undefined ? 0 : 1,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_grants (
          id, source_agent_grant_id, oauth_client_id, audience, project_id,
          knowledge_space_version_id, scopes_json, status, issued_at,
          expires_at, activated_at
        )
        SELECT ?, source.id, requests.oauth_client_id, requests.audience,
          projects.project_id, projects.active_knowledge_space_version_id,
          requests.requested_scopes_json, 'active', ?, ?, ?
        FROM project_initialization_requests requests
        JOIN project_initialization_approval_claims approval_claim
          ON approval_claim.initialization_request_id = requests.id
         AND approval_claim.claim_id = ?
         AND approval_claim.expires_at > ?
        JOIN agent_grants source
          ON source.id = requests.bootstrap_agent_grant_id
        JOIN vaults source_vault ON source_vault.id = source.vault_id
        JOIN collaboration_projects projects
          ON projects.project_id = ?
        JOIN collaboration_records knowledge_space
          ON knowledge_space.id = projects.active_knowledge_space_version_id
         AND knowledge_space.record_type = 'knowledge-space-version'
        JOIN collaboration_work_items work_items
          ON work_items.work_item_id = ?
         AND work_items.project_id = projects.project_id
        JOIN collaboration_records packet
          ON packet.id = ?
         AND packet.record_type = 'work-packet'
         AND packet.project_id = projects.project_id
         AND packet.work_item_id = work_items.work_item_id
        JOIN collaboration_dependencies packet_knowledge_space
          ON packet_knowledge_space.record_id = packet.id
         AND packet_knowledge_space.dependency_id =
           projects.active_knowledge_space_version_id
         AND packet_knowledge_space.dependency_kind = 'record'
        WHERE requests.id = ? AND requests.status = 'pending'
          AND requests.bootstrap_agent_grant_id = ?
          AND requests.oauth_client_id = ?
          AND requests.client_name = ?
          AND requests.client_origin = ?
          AND requests.audience = ?
          AND requests.vault_id = ?
          AND source.oauth_client_id = requests.oauth_client_id
          AND source.client_name = requests.client_name
          AND source.client_origin = requests.client_origin
          AND source.audience = requests.audience
          AND source.vault_id = requests.vault_id
          AND source.scopes_json = ?
          AND source.status = 'active'
          AND source_vault.status = 'active'
          AND (
            ? = 0 OR EXISTS (
              SELECT 1
              FROM prepared_project_handoffs handoffs
              WHERE handoffs.id = ?
                AND handoffs.status = 'claiming'
                AND handoffs.initialization_request_id = requests.id
                AND handoffs.agent_grant_id =
                  requests.bootstrap_agent_grant_id
                AND handoffs.vault_id = requests.vault_id
            )
          )
          AND projects.status = 'active'
          AND projects.agent_visibility = 'discoverable'
          AND projects.active_knowledge_space_version_id = ?
          AND work_items.status = 'open'
          AND (
            ? = 0 OR EXISTS (
              SELECT 1 FROM audit_events reopen
              WHERE reopen.id = ?
                AND reopen.event_type = 'collaboration.work_item_reopened'
                AND reopen.request_id = ?
            )
          )
        RETURNING id`,
      )
      .bind(
        grantId,
        input.now,
        expiresAt,
        input.now,
        input.approvalClaimId,
        input.now,
        input.projectId,
        input.workItemId,
        input.packetId,
        input.initializationId,
        input.sourceGrant.id,
        input.sourceGrant.clientId,
        input.sourceGrant.clientName,
        input.sourceGrant.clientOrigin,
        input.sourceGrant.audience,
        input.sourceGrant.vaultId,
        JSON.stringify(input.sourceGrant.scopes),
        input.preparedProjectHandoffId === undefined ? 0 : 1,
        input.preparedProjectHandoffId ?? "",
        input.knowledgeSpaceVersionId,
        ownerAction === undefined ? 0 : 1,
        reopenAuditId,
        input.requestId,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_grant_clients (
          grant_id, source_agent_grant_id, client_name, client_origin,
          created_at
        )
        SELECT grants.id, source.id, source.client_name,
          source.client_origin, ?
        FROM collaboration_grants grants
        JOIN agent_grants source
          ON source.id = grants.source_agent_grant_id
        WHERE grants.id = ? AND grants.status = 'active'
          AND source.id = ? AND source.status = 'active'
          AND source.oauth_client_id = ? AND source.audience = ?
          AND source.vault_id = ?
        RETURNING grant_id AS id`,
      )
      .bind(
        input.now,
        grantId,
        input.sourceGrant.id,
        input.sourceGrant.clientId,
        input.sourceGrant.audience,
        input.sourceGrant.vaultId,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO vault_local_writer_assignments (
          vault_id, oauth_client_id, initialization_request_id,
          assignment_basis, assigned_at, updated_at
        )
        SELECT requests.vault_id, requests.oauth_client_id, requests.id,
          CASE WHEN EXISTS (
            SELECT 1 FROM project_creation_reservations reservations
            WHERE reservations.vault_id = requests.vault_id
              AND reservations.project_id = ?
              AND reservations.creator_initialization_request_id = requests.id
          )
            THEN 'project-creator'
            ELSE 'first-project-agent'
          END,
          ?, ?
        FROM project_initialization_requests requests
        JOIN collaboration_grants grants ON grants.id = ?
        WHERE requests.id = ? AND requests.status = 'pending'
          AND grants.status = 'active'
          AND grants.project_id = ?
          AND grants.oauth_client_id = requests.oauth_client_id
          AND grants.source_agent_grant_id =
            requests.bootstrap_agent_grant_id`,
      )
      .bind(
        input.projectId,
        input.now,
        input.now,
        grantId,
        input.initializationId,
        input.projectId,
      ),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id != ? AND oauth_client_id = ? AND audience = ?
           AND project_id = ? AND status IN ('active', 'pending')
           AND EXISTS (
             SELECT 1 FROM collaboration_grants replacement
             WHERE replacement.id = ? AND replacement.status = 'active'
           )`,
      )
      .bind(
        input.now,
        grantId,
        input.sourceGrant.clientId,
        input.sourceGrant.audience,
        input.projectId,
        grantId,
      ),
    db
      .prepare(
        `UPDATE project_initialization_requests SET status = 'approved',
          decided_at = ?, result_project_id = ?, result_work_item_id = ?,
          result_packet_id = ?, result_collaboration_grant_id = ?,
          draft_json = ?, draft_sha256 = ?
         WHERE id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM collaboration_grants grants
             WHERE grants.id = ? AND grants.status = 'active'
               AND grants.source_agent_grant_id = bootstrap_agent_grant_id
               AND grants.oauth_client_id = oauth_client_id
               AND grants.audience = audience
               AND grants.project_id = ?
               AND grants.knowledge_space_version_id = ?
               AND grants.scopes_json = requested_scopes_json
           )
           AND EXISTS (
             SELECT 1 FROM project_initialization_approval_claims
             WHERE initialization_request_id = ?
               AND claim_id = ? AND expires_at > ?
           )
           AND EXISTS (
             SELECT 1 FROM collaboration_grant_clients clients
             WHERE clients.grant_id = ?
               AND clients.source_agent_grant_id =
                 bootstrap_agent_grant_id
           )
           AND EXISTS (
             SELECT 1 FROM vault_local_writer_assignments writer
             WHERE writer.vault_id =
               project_initialization_requests.vault_id
           )
         RETURNING id`,
      )
      .bind(
        input.now,
        input.projectId,
        input.workItemId,
        input.packetId,
        grantId,
        approvedDraftJson,
        approvedDraftSha256,
        input.initializationId,
        grantId,
        input.projectId,
        input.knowledgeSpaceVersionId,
        input.initializationId,
        input.approvalClaimId,
        input.now,
        grantId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.initialization_approved', ?, ?
         FROM project_initialization_requests
         WHERE id = ? AND status = 'approved'
           AND result_collaboration_grant_id = ?
         RETURNING id`,
      )
      .bind(
        approvalAuditId,
        input.requestId,
        input.now,
        input.initializationId,
        grantId,
      ),
    db
      .prepare(
        `DELETE FROM project_initialization_approval_claims
         WHERE initialization_request_id = ? AND claim_id = ?
           AND EXISTS (
             SELECT 1 FROM project_initialization_requests
             WHERE id = ? AND status = 'approved'
               AND result_collaboration_grant_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
             WHERE id = ?
               AND event_type = 'project.initialization_approved'
               AND request_id = ?
           )
         RETURNING initialization_request_id AS id`,
      )
      .bind(
        input.initializationId,
        input.approvalClaimId,
        input.initializationId,
        grantId,
        approvalAuditId,
        input.requestId,
      ),
    db
      .prepare(
        `INSERT INTO project_initialization_approval_claims (
           initialization_request_id, claim_id, claimed_at, expires_at
         )
         SELECT initialization_request_id, claim_id, claimed_at, expires_at
         FROM project_initialization_approval_claims
         WHERE initialization_request_id = ? AND claim_id = ?`,
      )
      .bind(input.initializationId, input.approvalClaimId),
  ]);
  const reopenedExactlyOnce =
    ownerAction === undefined
      ? (results[0]?.results.length ?? 0) === 0 &&
        (results[1]?.results.length ?? 0) === 0
      : results[0]?.results[0]?.id === input.workItemId &&
        results[1]?.results[0]?.id === reopenAuditId;
  if (
    !reopenedExactlyOnce ||
    results[2]?.results[0]?.id !== grantId ||
    results[3]?.results[0]?.id !== grantId ||
    results[6]?.results[0]?.id !== input.initializationId ||
    results[7]?.results[0]?.id !== approvalAuditId ||
    results[8]?.results[0]?.id !== input.initializationId
  ) {
    return null;
  }
  return readActiveProjectAuthorization(db, {
    initializationId: input.initializationId,
    now: input.now,
    projectId: input.projectId,
    sourceGrant: input.sourceGrant,
  });
}

export async function readInitializationProjectReceipt(
  db: D1Database,
  initializationId: string,
): Promise<{
  packetId: string;
  projectId: string;
  workItemId: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT project_id, work_item_id, packet_id
       FROM project_initialization_projects
       WHERE initialization_request_id = ?`,
    )
    .bind(initializationId)
    .first<{
      packet_id: string;
      project_id: string;
      work_item_id: string;
    }>();
  return row === null
    ? null
    : {
        packetId: row.packet_id,
        projectId: row.project_id,
        workItemId: row.work_item_id,
      };
}

export async function readLatestApprovedProjectScopes(
  db: D1Database,
  bootstrapAgentGrantId: string,
): Promise<CollaborationScope[] | null> {
  const row = await db
    .prepare(
      `SELECT requested_scopes_json
       FROM project_initialization_requests
       WHERE bootstrap_agent_grant_id = ? AND status = 'approved'
         AND result_project_id IS NOT NULL
       ORDER BY decided_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(bootstrapAgentGrantId)
    .first<{ requested_scopes_json: string }>();
  return row === null
    ? null
    : collaborationScopeSchema
        .array()
        .min(1)
        .max(5)
        .parse(JSON.parse(row.requested_scopes_json) as unknown);
}

export type PendingProjectAuthorization = {
  initializationId: string;
  projectId: string;
  requestedScopes: CollaborationScope[];
  sourceAgentGrantId: string;
};

function projectAuthorizationScopesMatch(
  stored: CollaborationScope[],
  requested: CollaborationScope[],
): boolean {
  const key = (scopes: CollaborationScope[]) =>
    JSON.stringify([...scopes].sort());
  if (key(stored) === key(requested)) return true;
  if (!stored.includes("project.lead") || requested.includes("project.lead")) {
    return false;
  }
  return (
    key(stored.filter((scope) => scope !== "project.lead")) === key(requested)
  );
}

export async function readPendingProjectAuthorization(
  db: D1Database,
  input: {
    audience: string;
    oauthClientId: string;
    requestedScopes: CollaborationScope[];
  },
): Promise<PendingProjectAuthorization | "ambiguous" | null> {
  const rows = await db
    .prepare(
      `SELECT requests.id, requests.result_project_id,
        requests.bootstrap_agent_grant_id, requests.requested_scopes_json
       FROM project_initialization_requests requests
       JOIN agent_grants source
         ON source.id = requests.bootstrap_agent_grant_id
       JOIN collaboration_projects projects
         ON projects.project_id = requests.result_project_id
       WHERE requests.oauth_client_id = ?
         AND requests.audience = ?
         AND requests.status = 'approved'
         AND requests.result_collaboration_grant_id = ?
         AND source.oauth_client_id = requests.oauth_client_id
         AND source.audience = requests.audience
         AND source.status = 'active'
         AND projects.status = 'active'
         AND projects.agent_visibility = 'discoverable'
       ORDER BY requests.decided_at DESC, requests.id DESC
       LIMIT 20`,
    )
    .bind(input.oauthClientId, input.audience, PROJECT_AUTHORIZATION_PENDING)
    .all<{
      bootstrap_agent_grant_id: string;
      id: string;
      requested_scopes_json: string;
      result_project_id: string;
    }>();
  const matching = rows.results.filter((row) => {
    const scopes = collaborationScopeSchema
      .array()
      .min(1)
      .max(5)
      .parse(JSON.parse(row.requested_scopes_json) as unknown);
    return projectAuthorizationScopesMatch(scopes, input.requestedScopes);
  });
  if (matching.length === 0) return null;
  if (matching.length > 1) return "ambiguous";
  const row = matching[0];
  if (row === undefined) return null;
  return {
    initializationId: row.id,
    projectId: row.result_project_id,
    requestedScopes: collaborationScopeSchema
      .array()
      .min(1)
      .max(5)
      .parse(JSON.parse(row.requested_scopes_json) as unknown),
    sourceAgentGrantId: row.bootstrap_agent_grant_id,
  };
}

export async function readBoundProjectAuthorization(
  db: D1Database,
  input: {
    audience: string;
    initializationId: string;
    oauthClientId: string;
    requestedScopes: CollaborationScope[];
  },
): Promise<PendingProjectAuthorization | null> {
  const row = await db
    .prepare(
      `SELECT requests.id, requests.result_project_id,
        requests.bootstrap_agent_grant_id, requests.requested_scopes_json
       FROM project_initialization_requests requests
       JOIN agent_grants source
         ON source.id = requests.bootstrap_agent_grant_id
       JOIN collaboration_projects projects
         ON projects.project_id = requests.result_project_id
       WHERE requests.id = ?
         AND requests.oauth_client_id = ?
         AND requests.audience = ?
         AND requests.status = 'approved'
         AND requests.result_collaboration_grant_id = ?
         AND source.oauth_client_id = requests.oauth_client_id
         AND source.audience = requests.audience
         AND source.status = 'active'
         AND projects.status = 'active'
         AND projects.agent_visibility = 'discoverable'`,
    )
    .bind(
      input.initializationId,
      input.oauthClientId,
      input.audience,
      PROJECT_AUTHORIZATION_PENDING,
    )
    .first<{
      bootstrap_agent_grant_id: string;
      id: string;
      requested_scopes_json: string;
      result_project_id: string;
    }>();
  if (row === null) return null;
  const scopes = collaborationScopeSchema
    .array()
    .min(1)
    .max(5)
    .parse(JSON.parse(row.requested_scopes_json) as unknown);
  if (!projectAuthorizationScopesMatch(scopes, input.requestedScopes)) {
    return null;
  }
  return {
    initializationId: row.id,
    projectId: row.result_project_id,
    requestedScopes: scopes,
    sourceAgentGrantId: row.bootstrap_agent_grant_id,
  };
}

export async function completeProjectAuthorization(
  db: D1Database,
  input: {
    collaborationGrantId: string;
    initializationId: string;
  },
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE project_initialization_requests
       SET result_collaboration_grant_id = ?
       WHERE id = ? AND status = 'approved'
         AND result_collaboration_grant_id = ?
         AND EXISTS (
           SELECT 1
           FROM collaboration_grants grants
           JOIN collaboration_projects projects
             ON projects.project_id = grants.project_id
           WHERE grants.id = ?
             AND grants.status = 'active'
             AND projects.status = 'active'
             AND projects.agent_visibility = 'discoverable'
             AND projects.active_knowledge_space_version_id =
               grants.knowledge_space_version_id
         )
       RETURNING id`,
    )
    .bind(
      input.collaborationGrantId,
      input.initializationId,
      PROJECT_AUTHORIZATION_PENDING,
      input.collaborationGrantId,
    )
    .first<{ id: string }>();
  return row?.id === input.initializationId;
}

export async function isSameOrSuccessorPacket(
  db: D1Database,
  priorPacketId: string,
  candidatePacketId: string,
): Promise<boolean> {
  if (priorPacketId === candidatePacketId) return true;
  const row = await db
    .prepare(
      `WITH RECURSIVE successors(packet_id, depth) AS (
         SELECT successor_packet_id, 1
         FROM collaboration_packet_rotations
         WHERE prior_packet_id = ?
         UNION
         SELECT rotations.successor_packet_id, successors.depth + 1
         FROM collaboration_packet_rotations rotations
         JOIN successors
           ON rotations.prior_packet_id = successors.packet_id
         WHERE successors.depth < 100
       )
       SELECT 1 AS present FROM successors
       WHERE packet_id = ? LIMIT 1`,
    )
    .bind(priorPacketId, candidatePacketId)
    .first<{ present: number }>();
  return row?.present === 1;
}

export async function supersedeInitializationForFreshApproval(
  db: D1Database,
  input: {
    blockIfProjectReceipt?: boolean;
    initializationId: string;
    now: number;
    requestId: string;
    token: string;
  },
): Promise<boolean> {
  const tokenSha256 = await sha256Hex(input.token);
  const tombstoneTokenSha256 = await sha256Hex(
    `superseded:${input.initializationId}:${crypto.randomUUID()}`,
  );
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET status = 'expired', decided_at = ?,
           token_sha256 = CASE
             WHEN token_sha256 = ? THEN ? ELSE token_sha256
           END
         WHERE id = ?
           AND status IN ('pending', 'approving', 'approved')
           AND NOT EXISTS (
             SELECT 1 FROM project_initialization_approval_claims
             WHERE initialization_request_id = ?
               AND expires_at > ?
           )
           AND (
             ? = 0 OR NOT EXISTS (
               SELECT 1 FROM project_initialization_projects
               WHERE initialization_request_id = ?
             )
           )
         RETURNING id`,
      )
      .bind(
        input.now,
        tokenSha256,
        tombstoneTokenSha256,
        input.initializationId,
        input.initializationId,
        input.now,
        input.blockIfProjectReceipt === true ? 1 : 0,
        input.initializationId,
      ),
    db
      .prepare(
        `DELETE FROM project_initialization_token_aliases
         WHERE token_sha256 = ?
           AND initialization_request_id = ?
           AND EXISTS (
             SELECT 1 FROM project_initialization_requests
             WHERE id = ? AND status = 'expired'
           )`,
      )
      .bind(tokenSha256, input.initializationId, input.initializationId),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, 'project.initialization_superseded', ?, ?
         FROM project_initialization_requests
         WHERE id = ? AND status = 'expired'`,
      )
      .bind(
        crypto.randomUUID(),
        input.requestId,
        input.now,
        input.initializationId,
      ),
  ]);
  return results[0]?.results[0]?.id === input.initializationId;
}

async function repairApprovedProjectAuthorization(
  db: D1Database,
  input: {
    expectedGrantId: string;
    initializationId: string;
    now: number;
    projectId: string;
    requestId: string;
    sourceGrant: ProjectAuthorizationSourceGrant;
  },
): Promise<ActiveProjectAuthorization | null> {
  const value = await readInitializationById(db, input.initializationId);
  if (
    value === null ||
    value.status !== "approved" ||
    value.resultCollaborationGrantId !== input.expectedGrantId ||
    value.resultProjectId !== input.projectId ||
    value.resultWorkItemId === null ||
    value.resultPacketId === null ||
    value.oauthClientId !== input.sourceGrant.clientId ||
    value.audience !== input.sourceGrant.audience ||
    value.vaultId !== input.sourceGrant.vaultId
  ) {
    return null;
  }
  const prior =
    value.resultCollaborationGrantId === PROJECT_AUTHORIZATION_PENDING
      ? null
      : await db
          .prepare(
            `SELECT grants.source_agent_grant_id, grants.status,
              grants.expires_at, prior_source.oauth_client_id,
              prior_source.client_name, prior_source.client_origin,
              prior_source.audience, prior_source.vault_id,
              prior_source.status AS source_status,
              prior_source.revoked_at AS source_revoked_at,
              source.activated_at AS replacement_activated_at
             FROM collaboration_grants grants
             JOIN agent_grants prior_source
               ON prior_source.id = grants.source_agent_grant_id
             JOIN agent_grants source ON source.id = ?
             WHERE grants.id = ? AND grants.oauth_client_id = ?
               AND grants.audience = ? AND grants.project_id = ?`,
          )
          .bind(
            input.sourceGrant.id,
            value.resultCollaborationGrantId,
            input.sourceGrant.clientId,
            input.sourceGrant.audience,
            input.projectId,
          )
          .first<{
            audience: string;
            client_name: string;
            client_origin: string;
            expires_at: number;
            oauth_client_id: string;
            replacement_activated_at: number | null;
            source_agent_grant_id: string;
            source_revoked_at: number | null;
            source_status: "active" | "pending" | "revoked";
            status: "active" | "pending" | "revoked";
            vault_id: string;
          }>();
  const legacyRepair =
    value.resultCollaborationGrantId === PROJECT_AUTHORIZATION_PENDING &&
    value.bootstrapAgentGrantId === input.sourceGrant.id;
  const expiredGrantRepair =
    prior !== null &&
    prior.source_agent_grant_id === input.sourceGrant.id &&
    prior.status === "active" &&
    prior.expires_at <= input.now;
  const replacementRepair =
    prior !== null &&
    prior.source_agent_grant_id !== input.sourceGrant.id &&
    prior.status === "active" &&
    prior.source_status === "revoked" &&
    prior.source_revoked_at !== null &&
    prior.replacement_activated_at !== null &&
    prior.replacement_activated_at >= prior.source_revoked_at &&
    prior.oauth_client_id === value.oauthClientId &&
    prior.client_name === value.clientName &&
    prior.client_origin === value.clientOrigin &&
    prior.audience === value.audience &&
    prior.vault_id === value.vaultId;
  if (
    value.clientName !== input.sourceGrant.clientName ||
    value.clientOrigin !== input.sourceGrant.clientOrigin ||
    (!legacyRepair && !expiredGrantRepair && !replacementRepair) ||
    !(await sourceGrantCoversApprovedContext(db, input.sourceGrant, value))
  ) {
    return null;
  }
  if (
    value.draft.requestKind === "join" &&
    (value.draft.target.projectId !== value.resultProjectId ||
      value.draft.target.workItemId !== value.resultWorkItemId ||
      !(await isSameOrSuccessorPacket(
        db,
        value.draft.target.packetId,
        value.resultPacketId,
      )))
  ) {
    return null;
  }
  const approvedPacketBinding = await db
    .prepare(
      `SELECT dependencies.dependency_id
       FROM collaboration_dependencies dependencies
       JOIN collaboration_records records
         ON records.id = dependencies.dependency_id
        AND records.record_type = 'knowledge-space-version'
       WHERE dependencies.record_id = ?
         AND dependencies.dependency_kind = 'record'
       LIMIT 2`,
    )
    .bind(value.resultPacketId)
    .all<{ dependency_id: string }>();
  if (approvedPacketBinding.results.length !== 1) return null;
  const expectedKnowledgeSpaceVersionId =
    approvedPacketBinding.results[0]?.dependency_id;
  if (
    expectedKnowledgeSpaceVersionId === undefined ||
    (value.draft.requestKind === "join" &&
      value.draft.target.knowledgeSpaceVersionId !==
        expectedKnowledgeSpaceVersionId)
  ) {
    return null;
  }

  const grantId = crypto.randomUUID();
  const expiresAt = input.now + COLLABORATION_GRANT_LIFETIME_SECONDS;
  const results = await db.batch<{ id: string }>([
    db
      .prepare(
        `INSERT INTO collaboration_grants (
          id, source_agent_grant_id, oauth_client_id, audience, project_id,
          knowledge_space_version_id, scopes_json, status, issued_at,
          expires_at, activated_at
        )
        SELECT ?, source.id, requests.oauth_client_id, requests.audience,
          projects.project_id, projects.active_knowledge_space_version_id,
          requests.requested_scopes_json, 'active', ?, ?, ?
        FROM project_initialization_requests requests
        JOIN agent_grants approved_source
          ON approved_source.id = requests.bootstrap_agent_grant_id
        JOIN agent_grants source ON source.id = ?
        JOIN vaults source_vault ON source_vault.id = source.vault_id
        JOIN collaboration_projects projects
          ON projects.project_id = requests.result_project_id
        JOIN collaboration_records knowledge_space
          ON knowledge_space.id = projects.active_knowledge_space_version_id
         AND knowledge_space.record_type = 'knowledge-space-version'
        JOIN collaboration_work_items work_items
          ON work_items.work_item_id = requests.result_work_item_id
         AND work_items.project_id = projects.project_id
        JOIN collaboration_records packet
          ON packet.id = requests.result_packet_id
         AND packet.record_type = 'work-packet'
         AND packet.project_id = projects.project_id
         AND packet.work_item_id = work_items.work_item_id
        JOIN collaboration_dependencies packet_knowledge_space
          ON packet_knowledge_space.record_id = packet.id
         AND packet_knowledge_space.dependency_id =
           projects.active_knowledge_space_version_id
         AND packet_knowledge_space.dependency_kind = 'record'
        LEFT JOIN collaboration_grants prior_grant
          ON prior_grant.id = requests.result_collaboration_grant_id
        LEFT JOIN agent_grants prior_source
          ON prior_source.id = prior_grant.source_agent_grant_id
        WHERE requests.id = ? AND requests.status = 'approved'
          AND requests.result_collaboration_grant_id = ?
          AND requests.result_project_id = ?
          AND requests.oauth_client_id = ?
          AND requests.audience = ?
          AND requests.vault_id = ?
          AND approved_source.oauth_client_id = requests.oauth_client_id
          AND approved_source.client_name = requests.client_name
          AND approved_source.client_origin = requests.client_origin
          AND approved_source.audience = requests.audience
          AND approved_source.vault_id = requests.vault_id
          AND source.oauth_client_id = requests.oauth_client_id
          AND source.client_name = ?
          AND source.client_origin = ?
          AND source.audience = requests.audience
          AND source.vault_id = requests.vault_id
          AND source.scopes_json = ?
          AND source.status = 'active'
          AND source_vault.status = 'active'
          AND projects.status = 'active'
          AND projects.agent_visibility = 'discoverable'
          AND projects.active_knowledge_space_version_id = ?
          AND (
            (
              requests.result_collaboration_grant_id = ?
              AND approved_source.id = source.id
              AND approved_source.status = 'active'
            )
            OR (
              prior_grant.source_agent_grant_id = source.id
              AND prior_grant.status = 'active'
              AND prior_grant.expires_at <= ?
            )
            OR (
              prior_grant.source_agent_grant_id != source.id
              AND prior_grant.status = 'active'
              AND prior_source.status = 'revoked'
              AND prior_source.revoked_at IS NOT NULL
              AND prior_source.oauth_client_id = requests.oauth_client_id
              AND prior_source.client_name = requests.client_name
              AND prior_source.client_origin = requests.client_origin
              AND prior_source.audience = requests.audience
              AND prior_source.vault_id = requests.vault_id
              AND source.activated_at IS NOT NULL
              AND source.activated_at >= prior_source.revoked_at
            )
          )
        RETURNING id`,
      )
      .bind(
        grantId,
        input.now,
        expiresAt,
        input.now,
        input.sourceGrant.id,
        input.initializationId,
        input.expectedGrantId,
        input.projectId,
        input.sourceGrant.clientId,
        input.sourceGrant.audience,
        input.sourceGrant.vaultId,
        input.sourceGrant.clientName,
        input.sourceGrant.clientOrigin,
        JSON.stringify(input.sourceGrant.scopes),
        expectedKnowledgeSpaceVersionId,
        PROJECT_AUTHORIZATION_PENDING,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_grant_clients (
          grant_id, source_agent_grant_id, client_name, client_origin,
          created_at
        )
        SELECT grants.id, source.id, source.client_name,
          source.client_origin, ?
        FROM collaboration_grants grants
        JOIN agent_grants source
          ON source.id = grants.source_agent_grant_id
        WHERE grants.id = ? AND grants.status = 'active'
          AND source.id = ? AND source.status = 'active'
          AND source.oauth_client_id = ? AND source.audience = ?
          AND source.vault_id = ?
        RETURNING grant_id AS id`,
      )
      .bind(
        input.now,
        grantId,
        input.sourceGrant.id,
        input.sourceGrant.clientId,
        input.sourceGrant.audience,
        input.sourceGrant.vaultId,
      ),
    db
      .prepare(
        `UPDATE collaboration_grants
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id != ? AND oauth_client_id = ? AND audience = ?
           AND project_id = ? AND status IN ('active', 'pending')
           AND EXISTS (
             SELECT 1 FROM collaboration_grants replacement
             WHERE replacement.id = ? AND replacement.status = 'active'
           )`,
      )
      .bind(
        input.now,
        grantId,
        input.sourceGrant.clientId,
        input.sourceGrant.audience,
        input.projectId,
        grantId,
      ),
    db
      .prepare(
        `UPDATE project_initialization_requests
         SET result_collaboration_grant_id = ?
         WHERE id = ? AND status = 'approved'
           AND result_collaboration_grant_id = ?
           AND EXISTS (
             SELECT 1 FROM collaboration_grants grants
             WHERE grants.id = ? AND grants.status = 'active'
               AND grants.source_agent_grant_id = ?
               AND grants.oauth_client_id = oauth_client_id
               AND grants.audience = audience
               AND grants.project_id = result_project_id
               AND grants.scopes_json = requested_scopes_json
           )
         RETURNING id`,
      )
      .bind(
        grantId,
        input.initializationId,
        input.expectedGrantId,
        grantId,
        input.sourceGrant.id,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         SELECT ?, ?, ?, ?
         FROM project_initialization_requests
         WHERE id = ? AND status = 'approved'
           AND result_collaboration_grant_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        replacementRepair
          ? "project.authorization_rebound"
          : "project.authorization_repaired",
        input.requestId,
        input.now,
        input.initializationId,
        grantId,
      ),
  ]);
  if (
    results[0]?.results[0]?.id !== grantId ||
    results[1]?.results[0]?.id !== grantId ||
    results[3]?.results[0]?.id !== input.initializationId
  ) {
    return readActiveProjectAuthorization(db, {
      initializationId: input.initializationId,
      now: input.now,
      projectId: input.projectId,
      sourceGrant: input.sourceGrant,
    });
  }
  return readActiveProjectAuthorization(db, {
    initializationId: input.initializationId,
    now: input.now,
    projectId: input.projectId,
    sourceGrant: input.sourceGrant,
  });
}

export async function resolveApprovedProjectAuthorization(
  db: D1Database,
  input: {
    now: number;
    projectId: string;
    requestId: string;
    sourceGrant: ProjectAuthorizationSourceGrant;
  },
): Promise<ActiveProjectAuthorization | null> {
  const existing = await readActiveProjectAuthorization(db, input);
  if (existing !== null) return existing;

  const candidates = await db
    .prepare(
      `SELECT requests.id, requests.requested_scopes_json,
        requests.result_collaboration_grant_id
       FROM project_initialization_requests requests
       JOIN agent_grants approved_source
         ON approved_source.id = requests.bootstrap_agent_grant_id
       JOIN agent_grants source ON source.id = ?
       JOIN vaults source_vault ON source_vault.id = source.vault_id
       JOIN collaboration_projects projects
         ON projects.project_id = requests.result_project_id
       JOIN collaboration_records packet
         ON packet.id = requests.result_packet_id
        AND packet.record_type = 'work-packet'
        AND packet.project_id = requests.result_project_id
        AND packet.work_item_id = requests.result_work_item_id
       JOIN collaboration_dependencies packet_knowledge_space
         ON packet_knowledge_space.record_id = packet.id
        AND packet_knowledge_space.dependency_id =
          projects.active_knowledge_space_version_id
        AND packet_knowledge_space.dependency_kind = 'record'
       JOIN collaboration_records knowledge_space
         ON knowledge_space.id = projects.active_knowledge_space_version_id
        AND knowledge_space.record_type = 'knowledge-space-version'
       JOIN collaboration_work_items work_items
         ON work_items.work_item_id = requests.result_work_item_id
        AND work_items.project_id = projects.project_id
       LEFT JOIN collaboration_grants prior_grant
         ON prior_grant.id = requests.result_collaboration_grant_id
       LEFT JOIN agent_grants prior_source
         ON prior_source.id = prior_grant.source_agent_grant_id
       WHERE requests.status = 'approved'
         AND requests.result_project_id = ?
         AND requests.oauth_client_id = ?
         AND requests.audience = ?
         AND requests.vault_id = ?
         AND approved_source.oauth_client_id = requests.oauth_client_id
         AND approved_source.client_name = requests.client_name
         AND approved_source.client_origin = requests.client_origin
         AND approved_source.audience = requests.audience
         AND approved_source.vault_id = requests.vault_id
         AND source.oauth_client_id = requests.oauth_client_id
         AND source.client_name = ?
         AND source.client_origin = ?
         AND source.audience = requests.audience
         AND source.vault_id = requests.vault_id
         AND source.scopes_json = ?
         AND source.status = 'active'
         AND source_vault.status = 'active'
         AND projects.status = 'active'
         AND projects.agent_visibility = 'discoverable'
         AND (
           (
             requests.result_collaboration_grant_id = ?
             AND
             approved_source.id = source.id
             AND approved_source.status = 'active'
           )
           OR (
             prior_grant.source_agent_grant_id = source.id
             AND prior_grant.status = 'active'
             AND prior_grant.expires_at <= ?
           )
           OR (
             prior_grant.source_agent_grant_id != source.id
             AND prior_grant.status = 'active'
             AND prior_source.status = 'revoked'
             AND prior_source.revoked_at IS NOT NULL
             AND prior_source.oauth_client_id = requests.oauth_client_id
             AND prior_source.client_name = requests.client_name
             AND prior_source.client_origin = requests.client_origin
             AND prior_source.audience = requests.audience
             AND prior_source.vault_id = requests.vault_id
             AND source.activated_at IS NOT NULL
             AND source.activated_at >= prior_source.revoked_at
           )
         )
       ORDER BY requests.decided_at DESC, requests.id DESC
       LIMIT 20`,
    )
    .bind(
      input.sourceGrant.id,
      input.projectId,
      input.sourceGrant.clientId,
      input.sourceGrant.audience,
      input.sourceGrant.vaultId,
      input.sourceGrant.clientName,
      input.sourceGrant.clientOrigin,
      JSON.stringify(input.sourceGrant.scopes),
      PROJECT_AUTHORIZATION_PENDING,
      input.now,
    )
    .all<{
      id: string;
      requested_scopes_json: string;
      result_collaboration_grant_id: string;
    }>();
  const compatible: {
    expectedGrantId: string;
    initializationId: string;
    scopeKey: string;
  }[] = [];
  for (const candidate of candidates.results) {
    const parsedScopes = collaborationScopeSchema
      .array()
      .min(1)
      .max(5)
      .safeParse(JSON.parse(candidate.requested_scopes_json) as unknown);
    if (!parsedScopes.success) continue;
    const value = await readInitializationById(db, candidate.id);
    if (
      value === null ||
      !(await sourceGrantCoversApprovedContext(db, input.sourceGrant, value))
    ) {
      continue;
    }
    compatible.push({
      expectedGrantId: candidate.result_collaboration_grant_id,
      initializationId: candidate.id,
      scopeKey: JSON.stringify([...parsedScopes.data].sort()),
    });
  }
  const scopeKeys = new Set(compatible.map((candidate) => candidate.scopeKey));
  if (scopeKeys.size !== 1) return null;
  const candidate = compatible[0];
  if (candidate === undefined) return null;

  return repairApprovedProjectAuthorization(db, {
    ...input,
    expectedGrantId: candidate.expectedGrantId,
    initializationId: candidate.initializationId,
  });
}

export function initializationStatus(
  value: StoredProjectInitialization,
  now: number,
  continuity: ProjectInitializationStatusResponse["continuity"] = null,
): ProjectInitializationStatusResponse {
  const status =
    value.status === "approving"
      ? "pending"
      : value.status === "pending" && value.expiresAt <= now
        ? "expired"
        : value.status;
  return projectInitializationStatusResponseSchema.parse({
    continuity,
    documentationPlan: value.draft.documentationPlan,
    expiresAt: value.expiresAt,
    folderBoundary: value.folderPath,
    initializationId: value.id,
    nextAction:
      status === "pending"
        ? value.draft.requestKind === "join"
          ? "Approve this agent's access to the exact existing Project in the owner browser."
          : "Approve the exact new Project request in the owner browser."
        : status === "approved"
          ? "Project access is ready. Continue in this agent to apply any approved documentation moves and resume the Project; no reconnect or reauthorization is required."
          : status === "rejected"
            ? value.draft.requestKind === "join"
              ? "Call open_project again for this exact Project only after the owner asks to revise access."
              : "Revise the bounded draft and call open_project again."
            : value.draft.requestKind === "join"
              ? "Call open_project once for this exact Project to repair the expired request; do not reconnect or create a duplicate."
              : "Call open_project again with the same bounded draft.",
    objective: value.draft.project.objective,
    packetId: value.resultPacketId,
    projectId: value.resultProjectId,
    requestedScopes: value.requestedScopes,
    requestKind: value.draft.requestKind,
    status,
    vaultName: value.vaultName,
    workItemId: value.resultWorkItemId,
  });
}

export function initializationConsentContext(
  value: StoredProjectInitialization,
  token: string,
  vaultPathPrefixes: string[],
): ProjectInitializationConsentContext {
  return {
    client: {
      id: value.oauthClientId,
      name: value.clientName,
      origin: value.clientOrigin,
    },
    contextPolicy: value.draft.contextPolicy,
    documentationPlan: value.draft.documentationPlan,
    expiresAt: value.expiresAt,
    folderBoundary: value.folderPath,
    initializationToken: token,
    objective: value.draft.project.objective,
    ownerAction:
      value.draft.requestKind === "join"
        ? (value.draft.ownerAction ?? null)
        : null,
    projectId:
      value.draft.requestKind === "join" ? value.draft.target.projectId : null,
    projectLabel: value.draft.project.label,
    requestKind: value.draft.requestKind,
    requestedScopes: value.requestedScopes,
    sourceNotePaths: value.draft.sourceNotePaths.map((note) => note.path),
    vault: { id: value.vaultId, name: value.vaultName },
    vaultPathPrefixes,
    workItemTitle: value.draft.workItem.objective,
  };
}

export async function expireInitializations(
  db: D1Database,
  now: number,
): Promise<number> {
  await db
    .prepare(
      `DELETE FROM project_initialization_approval_claims
       WHERE expires_at <= ?`,
    )
    .bind(now)
    .run();
  await db
    .prepare(
      `DELETE FROM project_initialization_token_aliases
       WHERE expires_at <= ?`,
    )
    .bind(now)
    .run();
  const result = await db
    .prepare(
      `UPDATE project_initialization_requests
       SET status = 'expired', decided_at = ?
       WHERE status IN ('pending', 'approving') AND expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM project_initialization_approval_claims
           WHERE initialization_request_id =
             project_initialization_requests.id
             AND expires_at > ?
         )
       RETURNING id`,
    )
    .bind(now, now, now)
    .all<{ id: string }>();
  return result.results.length;
}
