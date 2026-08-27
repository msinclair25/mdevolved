import type { StoredProjectSetupDraft } from "@mdevolved/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCollaborationProject } from "../src/collaboration-service";
import {
  claimProjectCreationReservation,
  ensureProjectCreationIdentity,
  insertInitializationRequest,
  projectCreationLabelKey,
} from "../src/project-initialization-store";
import {
  applyMigrations,
  migrations,
  projectCreationIdentityMigrationEntry,
} from "./migration-fixture";

describe("0022 Unicode Project creation identity upgrade", () => {
  it("canonicalizes a bound decomposed Unicode legacy identity before a later caller can create", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 16));
    const vaultId = crypto.randomUUID();
    const legacyRequestId = crypto.randomUUID();
    const decomposedLabel = "E\u0301LAN";
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
        label: decomposedLabel,
        objective: "Preserve one Unicode Project identity.",
      },
      requestedRole: "implementer",
      requestedScopes: ["project.read"],
      requestKind: "create",
      sourceNotePaths: [],
      workItem: {
        constraints: ["Never duplicate this Project."],
        definitionOfDone: ["Reuse the bound Project."],
        objective: "Prove the Unicode upgrade path.",
        requestedOutput: "One Project.",
      },
    };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Unicode upgrade vault', 'active', 100, 101)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO project_initialization_requests (
            id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
            client_name, client_origin, audience, vault_id, vault_name,
            folder_path, folder_path_key, draft_json, draft_sha256,
            authorization_url, requested_scopes_json,
            url_elicitation_supported, status, created_at, expires_at,
            semantic_key_sha256
          ) VALUES (
            ?, ?, ?, ?, 'Legacy Unicode client', 'https://agent.test',
            'https://owd.test/mcp', ?, 'Unicode upgrade vault', '', '', ?,
            ?, 'https://owd.test/initialize', '["project.read"]',
            1, 'pending', 100, 1000, ?
          )`,
      ).bind(
        legacyRequestId,
        "1".repeat(64),
        crypto.randomUUID(),
        crypto.randomUUID(),
        vaultId,
        JSON.stringify(draft),
        "2".repeat(64),
        "3".repeat(64),
      ),
    ]);
    const created = await createCollaborationProject(
      env.DB,
      env.VAULT_STORAGE,
      {
        knowledgeSpace: {
          label: "Unicode sources",
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
      },
      110,
      crypto.randomUUID(),
      {
        activationReason: "Seed a bound pre-0022 Unicode Project.",
        initializationRequestId: legacyRequestId,
        skipProjectCreationCommit: true,
      },
    );

    await applyMigrations(env.DB, [projectCreationIdentityMigrationEntry]);
    const legacyIdentity = await env.DB.prepare(
      `SELECT project_label_key
       FROM project_creation_reservations
       WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ project_label_key: string }>();
    const canonicalLabelKey = projectCreationLabelKey(decomposedLabel);
    expect(legacyIdentity?.project_label_key).not.toBe(canonicalLabelKey);

    const laterRequestId = crypto.randomUUID();
    expect(
      await insertInitializationRequest(env.DB, {
        authorizationUrl: "https://owd.test/authorize",
        bootstrapAgentGrantId: crypto.randomUUID(),
        clientName: "Later Unicode client",
        clientOrigin: "https://later-agent.test",
        draft,
        draftSha256: "4".repeat(64),
        folderPath: "",
        folderPathKey: "",
        id: laterRequestId,
        now: 120,
        oauthClientId: crypto.randomUUID(),
        projectCreationIdentity: {
          projectLabelKey: canonicalLabelKey,
        },
        requestId: crypto.randomUUID(),
        resource: "https://owd.test/mcp",
        semanticKeySha256: "5".repeat(64),
        token: "unicode-upgrade-request-token",
        urlElicitationSupported: true,
        vaultId,
        vaultName: "Unicode upgrade vault",
      }),
    ).toBe(true);
    const splitBeforeCanonicalization = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM project_creation_reservations
       WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{ count: number }>();
    expect(splitBeforeCanonicalization?.count).toBe(2);

    const whitespace = [
      "\u0009",
      "\u000a",
      "\u000b",
      "\u000c",
      "\u000d",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];
    const legacyKeyBase = legacyIdentity?.project_label_key;
    if (legacyKeyBase === undefined) {
      throw new Error("Expected the legacy Project identity.");
    }
    const equivalentLegacyKeys = whitespace
      .flatMap((left) =>
        whitespace.map((right) => `${left}${legacyKeyBase}${right}`),
      )
      .slice(0, 64);
    await env.DB.batch(
      equivalentLegacyKeys.map((projectLabelKey, index) =>
        env.DB.prepare(
          `INSERT INTO project_creation_reservations (
              vault_id, project_label_key,
              creator_initialization_request_id,
              creation_contract_sha256, project_id, work_item_id, packet_id,
              created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        ).bind(vaultId, projectLabelKey, 121 + index, 121 + index),
      ),
    );
    let preparedStatementCount = 0;
    let largestBatch = 0;
    const countingDb = {
      batch<T>(statements: D1PreparedStatement[]) {
        largestBatch = Math.max(largestBatch, statements.length);
        return env.DB.batch<T>(statements);
      },
      prepare(query: string) {
        preparedStatementCount += 1;
        return env.DB.prepare(query);
      },
    } as D1Database;
    const reservation = await ensureProjectCreationIdentity(countingDb, {
      initializationId: laterRequestId,
      now: 120,
      projectLabelKey: canonicalLabelKey,
      vaultId,
    });
    expect(reservation).toMatchObject({
      packetId: created.packet.packetId,
      projectId: created.projectId,
      projectLabelKey: canonicalLabelKey,
      workItemId: created.workItemId,
    });
    expect(largestBatch).toBeLessThanOrEqual(3);
    expect(preparedStatementCount).toBeLessThanOrEqual(7);
    const claimed = await claimProjectCreationReservation(env.DB, {
      creationContractSha256: "6".repeat(64),
      initializationId: laterRequestId,
      now: 120,
    });
    expect(claimed?.projectId).toBe(created.projectId);

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM collaboration_projects) AS project_count,
         (SELECT COUNT(*) FROM project_creation_reservations
            WHERE vault_id = ?) AS reservation_count,
         (SELECT COUNT(*) FROM project_creation_requests
            WHERE vault_id = ?) AS mapped_request_count`,
    )
      .bind(vaultId, vaultId)
      .first<{
        mapped_request_count: number;
        project_count: number;
        reservation_count: number;
      }>();
    expect(counts).toEqual({
      mapped_request_count: 2,
      project_count: 1,
      reservation_count: 1,
    });
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
