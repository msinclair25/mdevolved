import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  projectCreationIdentityMigrationEntry,
} from "./migration-fixture";

describe("0022 Project creation identity upgrade", () => {
  it("maps legacy two-client requests onto one vault-wide reservation", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 16));
    const vaultId = crypto.randomUUID();
    const firstRequestId = crypto.randomUUID();
    const secondRequestId = crypto.randomUUID();
    const draft = JSON.stringify({
      project: {
        label: "  Shared Upgrade Project  ",
        objective: "Converge legacy requests.",
      },
      requestKind: "create",
    });
    await env.DB.prepare(
      `INSERT INTO vaults (
        id, display_name, status, created_at, paired_at
      ) VALUES (?, 'Upgrade vault', 'active', 100, 101)`,
    )
      .bind(vaultId)
      .run();
    for (const [index, requestId] of [
      firstRequestId,
      secondRequestId,
    ].entries()) {
      await env.DB.prepare(
        `INSERT INTO project_initialization_requests (
          id, token_sha256, bootstrap_agent_grant_id, oauth_client_id,
          client_name, client_origin, audience, vault_id, vault_name,
          folder_path, folder_path_key, draft_json, draft_sha256,
          authorization_url, requested_scopes_json,
          url_elicitation_supported, status, created_at, expires_at,
          semantic_key_sha256
        ) VALUES (
          ?, ?, ?, ?, ?, 'https://agent.test', 'https://owd.test/mcp',
          ?, 'Upgrade vault', '', '', ?, ?, 'https://owd.test/initialize',
          '["project.read"]', 1, 'pending', ?, 1000, ?
        )`,
      )
        .bind(
          requestId,
          String(index + 1).repeat(64),
          crypto.randomUUID(),
          crypto.randomUUID(),
          `Legacy client ${index + 1}`,
          vaultId,
          draft,
          String(index + 3).repeat(64),
          100 + index,
          String(index + 5).repeat(64),
        )
        .run();
    }

    await applyMigrations(env.DB, [projectCreationIdentityMigrationEntry]);
    await applyMigrations(env.DB, [projectCreationIdentityMigrationEntry]);

    const reservations = await env.DB.prepare(
      `SELECT vault_id, project_label_key,
        creator_initialization_request_id, project_id
       FROM project_creation_reservations`,
    ).all<{
      creator_initialization_request_id: string | null;
      project_id: string | null;
      project_label_key: string;
      vault_id: string;
    }>();
    const requests = await env.DB.prepare(
      `SELECT initialization_request_id, vault_id, project_label_key
       FROM project_creation_requests
       ORDER BY initialization_request_id`,
    ).all<{
      initialization_request_id: string;
      project_label_key: string;
      vault_id: string;
    }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(reservations.results).toEqual([
      {
        creator_initialization_request_id: null,
        project_id: null,
        project_label_key: "shared upgrade project",
        vault_id: vaultId,
      },
    ]);
    expect(requests.results).toHaveLength(2);
    expect(
      requests.results.every(
        (request) =>
          request.vault_id === vaultId &&
          request.project_label_key === "shared upgrade project",
      ),
    ).toBe(true);
    expect(
      requests.results.map((request) => request.initialization_request_id),
    ).toEqual([firstRequestId, secondRequestId].sort());
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
