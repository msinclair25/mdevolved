import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCollaborationProject } from "../src/collaboration-service";
import {
  applyMigrations,
  migrations,
  vaultPrimaryWriterMigrationEntry,
} from "./migration-fixture";

describe("0026 vault primary writer upgrade", () => {
  it("backfills one deterministic vault-wide writer and remains idempotent", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 20));
    const vaultId = crypto.randomUUID();
    const firstRequestId = crypto.randomUUID();
    const secondRequestId = crypto.randomUUID();
    const firstClientId = crypto.randomUUID();
    const secondClientId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
            id, display_name, status, created_at, paired_at
          ) VALUES (?, 'Writer upgrade vault', 'active', 100, 101)`,
      ).bind(vaultId),
      ...[
        {
          clientId: firstClientId,
          draftDigit: "3",
          requestId: firstRequestId,
          tokenDigit: "1",
        },
        {
          clientId: secondClientId,
          draftDigit: "4",
          requestId: secondRequestId,
          tokenDigit: "2",
        },
      ].map(({ clientId, draftDigit, requestId, tokenDigit }) =>
        env.DB.prepare(
          `INSERT INTO project_initialization_requests (
              id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
              client_name, client_origin, audience, vault_id, vault_name,
              folder_path, folder_path_key, draft_json, draft_sha256,
              authorization_url, requested_scopes_json,
              url_elicitation_supported, status, created_at, expires_at,
              semantic_key_sha256
            ) VALUES (
              ?, ?, ?, ?, 'Upgrade agent', 'https://agent.test',
              'https://owd.test/mcp', ?, 'Writer upgrade vault', '', '',
              '{}', ?, 'https://owd.test/initialize', '["project.read"]',
              1, 'pending', 100, 1000, ?
            )`,
        ).bind(
          requestId,
          tokenDigit.repeat(64),
          crypto.randomUUID(),
          clientId,
          vaultId,
          draftDigit.repeat(64),
          String(Number(tokenDigit) + 4).repeat(64),
        ),
      ),
    ]);

    const createProject = async (
      initializationRequestId: string,
      label: string,
      now: number,
    ) =>
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        {
          knowledgeSpace: {
            label: `${label} context`,
            members: [
              {
                exclusions: [],
                pathPrefixes: [{ path: "", pathKey: "" }],
                vaultId,
              },
            ],
          },
          packetExpiresInSeconds: 600,
          project: {
            label,
            objective: `Preserve ${label} during the writer upgrade.`,
          },
          requestedRole: "implementer",
          sourceNotes: [],
          workItem: {
            constraints: ["Keep the role vault-wide."],
            definitionOfDone: ["One primary writer remains."],
            objective: `Upgrade ${label}.`,
            requestedOutput: "A durable writer assignment.",
          },
        },
        now,
        crypto.randomUUID(),
        { initializationRequestId, skipProjectCreationCommit: true },
      );
    const firstProject = await createProject(
      firstRequestId,
      "First upgrade Project",
      110,
    );
    const secondProject = await createProject(
      secondRequestId,
      "Second upgrade Project",
      111,
    );

    await env.DB.batch([
      ...[
        { project: firstProject, requestId: firstRequestId },
        { project: secondProject, requestId: secondRequestId },
      ].map(({ project, requestId }) =>
        env.DB.prepare(
          `UPDATE project_initialization_requests
             SET status = 'approved', decided_at = 200,
               result_project_id = ?, result_work_item_id = ?,
               result_packet_id = ?, result_collaboration_grant_id = ?
             WHERE id = ?`,
        ).bind(
          project.projectId,
          project.workItemId,
          project.packet.packetId,
          crypto.randomUUID(),
          requestId,
        ),
      ),
      ...[
        {
          hashDigit: "6",
          labelKey: "first upgrade project",
          project: firstProject,
          requestId: firstRequestId,
        },
        {
          hashDigit: "7",
          labelKey: "second upgrade project",
          project: secondProject,
          requestId: secondRequestId,
        },
      ].map(({ hashDigit, labelKey, project, requestId }) =>
        env.DB.prepare(
          `INSERT INTO project_creation_reservations (
              vault_id, project_label_key, creator_initialization_request_id,
              creation_contract_sha256, project_id, work_item_id, packet_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 200)`,
        ).bind(
          vaultId,
          labelKey,
          requestId,
          hashDigit.repeat(64),
          project.projectId,
          project.workItemId,
          project.packet.packetId,
        ),
      ),
    ]);

    await applyMigrations(env.DB, [vaultPrimaryWriterMigrationEntry]);
    await applyMigrations(env.DB, [vaultPrimaryWriterMigrationEntry]);

    const assignments = await env.DB.prepare(
      `SELECT vault_id, oauth_client_id, initialization_request_id,
        assignment_basis, assigned_at, updated_at
       FROM vault_local_writer_assignments`,
    ).all<{
      assigned_at: number;
      assignment_basis: string;
      initialization_request_id: string;
      oauth_client_id: string;
      updated_at: number;
      vault_id: string;
    }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(assignments.results).toEqual([
      {
        assigned_at: 200,
        assignment_basis: "project-creator",
        initialization_request_id: firstRequestId,
        oauth_client_id: firstClientId,
        updated_at: 200,
        vault_id: vaultId,
      },
    ]);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
