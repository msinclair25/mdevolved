import type { StoredProjectSetupDraft } from "@owd/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCollaborationProject } from "../src/collaboration-service";
import { projectCreationLabelKey } from "../src/project-initialization-store";
import {
  applyMigrations,
  migrations,
  projectCreationCommitMigrationEntry,
} from "./migration-fixture";

describe("0023 Project creation commit upgrade", () => {
  it("backfills the exact bound legacy Project identity and remains idempotent", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 17));
    const vaultId = crypto.randomUUID();
    const unrelatedVaultId = crypto.randomUUID();
    const initializationId = crypto.randomUUID();
    const draft: StoredProjectSetupDraft = {
      contextPolicy: {
        excludePaths: [],
        format: "owd-project-context-v1",
        includePaths: [""],
      },
      documentationPlan: {
        decision: "no-root-markdown",
        proposedMoves: [],
        retainedRootPaths: [],
        rootMarkdownPaths: [],
      },
      folderBoundary: "",
      packetExpiresInSeconds: 600,
      project: {
        label: "E\u0301lan Legacy Project",
        objective: "Preserve one exact Project during the 0023 upgrade.",
      },
      requestedRole: "implementer",
      requestedScopes: ["project.read"],
      requestKind: "create",
      sourceNotePaths: [],
      workItem: {
        constraints: ["Do not create a duplicate."],
        definitionOfDone: ["Retain one durable Project identity."],
        objective: "Upgrade the bound Project.",
        requestedOutput: "One Project.",
      },
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, '0023 upgrade vault', 'active', 100, 101)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Unrelated upgrade vault', 'active', 100, 101)`,
      ).bind(unrelatedVaultId),
      env.DB.prepare(
        `INSERT INTO project_initialization_requests (
          id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
          client_name, client_origin, audience, vault_id, vault_name,
          folder_path, folder_path_key, draft_json, draft_sha256,
          authorization_url, requested_scopes_json,
          url_elicitation_supported, status, created_at, expires_at,
          semantic_key_sha256
        ) VALUES (
          ?, ?, ?, ?, 'Legacy creator', 'https://agent.test',
          'https://owd.test/mcp', ?, '0023 upgrade vault', '', '', ?, ?,
          'https://owd.test/initialize', '["project.read"]',
          1, 'pending', 100, 1000, ?
        )`,
      ).bind(
        initializationId,
        "1".repeat(64),
        crypto.randomUUID(),
        crypto.randomUUID(),
        vaultId,
        JSON.stringify(draft),
        "2".repeat(64),
        "3".repeat(64),
      ),
    ]);
    const request = {
      knowledgeSpace: {
        label: "Bound legacy context",
        members: [
          {
            exclusions: [],
            pathPrefixes: [{ path: "", pathKey: "" }],
            vaultId,
          },
        ],
      },
      packetExpiresInSeconds: 600,
      project: draft.project,
      requestedRole: draft.requestedRole,
      sourceNotes: [],
      workItem: draft.workItem,
    };
    const created = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      request,
      110,
      crypto.randomUUID(),
      {
        initializationRequestId: initializationId,
        skipProjectCreationCommit: true,
      },
    );
    const legacyOwnerRequest = {
      ...request,
      project: {
        label: "O\u0308wner Legacy Project",
        objective: "Preserve an owner-created Project without a reservation.",
      },
    };
    await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      legacyOwnerRequest,
      111,
      crypto.randomUUID(),
      { skipProjectCreationCommit: true },
    );
    const labelKey = projectCreationLabelKey(draft.project.label);
    const legacyLabelKey = draft.project.label.trim().toLowerCase();
    expect(legacyLabelKey).not.toBe(labelKey);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO project_creation_reservations (
            vault_id, project_label_key, creator_initialization_request_id,
            creation_contract_sha256, project_id, work_item_id, packet_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 110)`,
      ).bind(
        vaultId,
        legacyLabelKey,
        initializationId,
        "4".repeat(64),
        created.projectId,
        created.workItemId,
        created.packet.packetId,
      ),
      env.DB.prepare(
        `INSERT INTO project_creation_requests (
            initialization_request_id, vault_id, project_label_key, created_at
          ) VALUES (?, ?, ?, 100)`,
      ).bind(initializationId, vaultId, legacyLabelKey),
    ]);

    await applyMigrations(env.DB, [projectCreationCommitMigrationEntry]);
    await applyMigrations(env.DB, [projectCreationCommitMigrationEntry]);

    const commits = await env.DB.prepare(
      `SELECT vault_id, project_label_key, creation_payload_sha256,
        project_id, work_item_id, packet_id
       FROM project_creation_commits`,
    ).all<{
      creation_payload_sha256: string | null;
      packet_id: string;
      project_id: string;
      project_label_key: string;
      vault_id: string;
      work_item_id: string;
    }>();
    expect(commits.results).toEqual([
      {
        creation_payload_sha256: null,
        packet_id: created.packet.packetId,
        project_id: created.projectId,
        project_label_key: legacyLabelKey,
        vault_id: vaultId,
        work_item_id: created.workItemId,
      },
    ]);
    const disjointRequest = {
      ...legacyOwnerRequest,
      knowledgeSpace: {
        ...legacyOwnerRequest.knowledgeSpace,
        members: legacyOwnerRequest.knowledgeSpace.members.map((member) => ({
          ...member,
          vaultId: unrelatedVaultId,
        })),
      },
      project: {
        ...legacyOwnerRequest.project,
        label: "\u00d6wner Legacy Project",
      },
    };
    const disjoint = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      disjointRequest,
      119,
      crypto.randomUUID(),
    );
    expect(disjoint.projectId).not.toBe(created.projectId);
    await expect(
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        {
          ...request,
          project: {
            ...request.project,
            label: "\u00c9lan Legacy Project",
          },
        },
        120,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "project_identity_conflict" });
    await expect(
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        {
          ...legacyOwnerRequest,
          project: {
            ...legacyOwnerRequest.project,
            label: "\u00d6wner Legacy Project",
          },
        },
        121,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "project_identity_conflict" });

    const partialRequest = {
      ...request,
      knowledgeSpace: {
        ...request.knowledgeSpace,
        members: [
          request.knowledgeSpace.members[0]!,
          {
            ...request.knowledgeSpace.members[0]!,
            vaultId: unrelatedVaultId,
          },
        ],
      },
      project: {
        label: "Partial Legacy Fence",
        objective: "Prove every member vault retains one identity fence.",
      },
    };
    const partial = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      partialRequest,
      122,
      crypto.randomUUID(),
      { skipProjectCreationCommit: true },
    );
    await env.DB.prepare(
      `INSERT INTO project_creation_commits (
        vault_id, project_label_key, creation_payload_sha256,
        project_id, work_item_id, packet_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        vaultId,
        projectCreationLabelKey(partialRequest.project.label),
        "5".repeat(64),
        partial.projectId,
        partial.workItemId,
        partial.packet.packetId,
        122,
      )
      .run();
    await expect(
      createCollaborationProject(
        env.DB,
        env.VAULT_STORAGE,
        {
          ...partialRequest,
          knowledgeSpace: {
            ...partialRequest.knowledgeSpace,
            members: [partialRequest.knowledgeSpace.members[1]!],
          },
        },
        123,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "project_identity_conflict" });

    const pollutedProjects = Array.from({ length: 257 }, (_, index) => {
      const projectId = crypto.randomUUID();
      return {
        createdAt: 200 + index,
        label: `Unrelated polluted Project ${index}`,
        objectKey: `collaboration/test-pollution-${projectId}.json`,
        portableObjectId: crypto.randomUUID(),
        projectId,
      };
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO collaboration_records (
          id, record_type, schema_version, portable_object_id,
          body_object_key, content_sha256, byte_length, received_at
        )
        SELECT
          json_extract(item.value, '$.projectId'), 'project', 1,
          json_extract(item.value, '$.portableObjectId'),
          json_extract(item.value, '$.objectKey'), ?,
          0, json_extract(item.value, '$.createdAt')
        FROM json_each(?) AS item`,
      ).bind("6".repeat(64), JSON.stringify(pollutedProjects)),
      env.DB.prepare(
        `INSERT INTO collaboration_projects (
          project_id, active_project_version_id,
          active_knowledge_space_version_id, label, objective,
          status, created_at
        )
        SELECT
          json_extract(item.value, '$.projectId'),
          json_extract(item.value, '$.projectId'),
          json_extract(item.value, '$.projectId'),
          json_extract(item.value, '$.label'),
          'Legacy pollution unrelated to the requested label.',
          'active', json_extract(item.value, '$.createdAt')
        FROM json_each(?) AS item`,
      ).bind(JSON.stringify(pollutedProjects)),
    ]);
    const afterPollution = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        ...request,
        project: {
          label: "Clean Project After Pollution",
          objective: "Creation must paginate beyond unrelated legacy state.",
        },
      },
      500,
      crypto.randomUUID(),
    );
    expect(afterPollution.projectId).not.toBe(created.projectId);
    const projectCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM collaboration_projects",
    ).first<{ count: number }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    expect(projectCount?.count).toBe(262);
    expect(foreignKeyFailures.results).toEqual([]);
  }, 30_000);
});
