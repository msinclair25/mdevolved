import {
  collaborationNotebookProjectionRequestSchema,
  collaborationNotebookProjectionSchema,
  decisionSchema,
  knowledgeSpaceVersionSchema,
  type CollaborationNotebookProjection,
} from "@mdevolved/contracts";
import { CollaborationProblem } from "./collaboration-service";
import { readCollaborationRecord } from "./collaboration-store";
import { sha256Hex } from "./security";
import { validateMarkdownVaultPath } from "./vault-path";

export type CollaborationNotebookWriter = {
  create(input: {
    content: string;
    path: string;
    vaultId: string;
  }): Promise<
    { contentVersion: string; ok: true } | { code: string; ok: false }
  >;
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function notebookPath(folder: string, recordId: string): string {
  return validateMarkdownVaultPath(`${folder}/Decisions/${recordId}.md`).path;
}

function renderDecision(
  project: { label: string },
  decision: ReturnType<typeof decisionSchema.parse>,
  sourceContentSha256: string,
): string {
  return [
    "---",
    "owd_projection: true",
    `owd_project_id: ${yamlString(decision.projectId)}`,
    `owd_record_id: ${yamlString(decision.decisionId)}`,
    'owd_record_type: "decision"',
    `owd_source_content_sha256: ${yamlString(sourceContentSha256)}`,
    `owd_work_item_id: ${yamlString(decision.workItemId)}`,
    "tags:",
    '  - "owd/project"',
    '  - "owd/decision"',
    "---",
    "",
    `# Decision · ${decision.resolution}`,
    "",
    "> [!info] Derived MDevolved projection",
    `> This immutable note is a human-readable view of Decision \`${decision.decisionId}\`. The structured MDevolved ledger remains authoritative.`,
    "",
    "## Project",
    "",
    project.label,
    "",
    "## Rationale",
    "",
    decision.rationale,
    "",
    "## Inputs",
    "",
    ...(decision.inputRecords.length === 0
      ? ["- None"]
      : decision.inputRecords.map(
          (input) =>
            `- \`${input.recordType}\` · \`${input.recordId}\` · ${input.ownerDisposition} · SHA-256 \`${input.contentSha256}\``,
        )),
    "",
    "## Provenance",
    "",
    `- MDevolved Project: \`${decision.projectId}\``,
    `- MDevolved Work Item: \`${decision.workItemId}\``,
    `- MDevolved Decision: \`${decision.decisionId}\``,
    `- Canonical record SHA-256: \`${sourceContentSha256}\``,
    "",
  ].join("\n");
}

export async function projectDecisionToNotebook(
  db: D1Database,
  storage: R2Bucket,
  writer: CollaborationNotebookWriter,
  input: {
    now: number;
    projectId: string;
    rawRequest: unknown;
    recordId: string;
    requestId: string;
  },
): Promise<CollaborationNotebookProjection> {
  const request = collaborationNotebookProjectionRequestSchema.safeParse(
    input.rawRequest,
  );
  if (!request.success) {
    throw new CollaborationProblem("submission_invalid");
  }
  const existing = await db
    .prepare(
      `SELECT projection_id, project_id, record_id, vault_id, path,
        content_sha256, target_content_version, created_at
       FROM collaboration_notebook_projections
       WHERE project_id = ? AND record_id = ?`,
    )
    .bind(input.projectId, input.recordId)
    .first<{
      content_sha256: string;
      created_at: number;
      path: string;
      project_id: string;
      projection_id: string;
      record_id: string;
      target_content_version: string;
      vault_id: string;
    }>();
  if (existing !== null) {
    return collaborationNotebookProjectionSchema.parse({
      contentSha256: existing.content_sha256,
      createdAt: existing.created_at,
      path: existing.path,
      projectId: existing.project_id,
      projectionId: existing.projection_id,
      recordId: existing.record_id,
      targetContentVersion: existing.target_content_version,
      vaultId: existing.vault_id,
    });
  }

  const project = await db
    .prepare(
      `SELECT label, active_knowledge_space_version_id
       FROM collaboration_projects
       WHERE project_id = ? AND status = 'active'`,
    )
    .bind(input.projectId)
    .first<{
      active_knowledge_space_version_id: string;
      label: string;
    }>();
  const loaded = await readCollaborationRecord(db, storage, input.recordId);
  const state = await db
    .prepare(
      `SELECT disposition FROM collaboration_record_states
       WHERE record_id = ?`,
    )
    .bind(input.recordId)
    .first<{ disposition: string }>();
  if (
    project === null ||
    loaded?.record.recordType !== "decision" ||
    loaded.record.projectId !== input.projectId ||
    state?.disposition !== "accepted"
  ) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  const knowledgeSpace = await readCollaborationRecord(
    db,
    storage,
    project.active_knowledge_space_version_id,
  );
  if (knowledgeSpace?.record.recordType !== "knowledge-space-version") {
    throw new CollaborationProblem("project_reference_invalid");
  }
  const version = knowledgeSpaceVersionSchema.parse(knowledgeSpace.record);
  const member = version.members.find(
    (candidate) => candidate.vaultId === request.data.vaultId,
  );
  const folderIsExcluded =
    member?.exclusions.some(
      (exclusion) =>
        request.data.folder.pathKey === exclusion.pathKey ||
        request.data.folder.pathKey.startsWith(`${exclusion.pathKey}/`),
    ) ?? false;
  if (!folderIsExcluded) {
    throw new CollaborationProblem("projection_origin_loop");
  }

  const decision = decisionSchema.parse(loaded.record);
  const path = notebookPath(request.data.folder.path, decision.decisionId);
  const content = renderDecision(
    project,
    decision,
    loaded.metadata.contentSha256,
  );
  const contentSha256 = await sha256Hex(content);
  const written = await writer.create({
    content,
    path,
    vaultId: request.data.vaultId,
  });
  if (!written.ok) {
    throw new CollaborationProblem("projection_target_changed");
  }
  const projectionId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO collaboration_notebook_projections (
          projection_id, project_id, record_id, vault_id, path, path_key,
          content_sha256, target_content_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        projectionId,
        input.projectId,
        input.recordId,
        request.data.vaultId,
        path,
        validateMarkdownVaultPath(path).pathKey,
        contentSha256,
        written.contentVersion,
        input.now,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (id, event_type, request_id, created_at)
         VALUES (?, 'collaboration.notebook_projected', ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.requestId, input.now),
  ]);
  return collaborationNotebookProjectionSchema.parse({
    contentSha256,
    createdAt: input.now,
    path,
    projectId: input.projectId,
    projectionId,
    recordId: input.recordId,
    targetContentVersion: written.contentVersion,
    vaultId: request.data.vaultId,
  });
}
