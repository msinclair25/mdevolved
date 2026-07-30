import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  projectConnectionHardeningMigrationEntry,
} from "./migration-fixture";

describe("0021 Project connection hardening upgrade", () => {
  it("adds leases without mutating an in-flight legacy approval", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 15));
    const vaultId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Upgrade vault', 'active', 100, 101)`,
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
            ?, ?, ?, ?, 'Upgrade client', 'https://agent.test',
            'https://owd.test/mcp', ?, 'Upgrade vault', '', '', '{}', ?,
            'https://owd.test/initialize', '[]', 1, 'approving', 100, 1000, ?
          )`,
      ).bind(
        requestId,
        "a".repeat(64),
        crypto.randomUUID(),
        crypto.randomUUID(),
        vaultId,
        "b".repeat(64),
        "c".repeat(64),
      ),
    ]);

    await applyMigrations(env.DB, [projectConnectionHardeningMigrationEntry]);
    await applyMigrations(env.DB, [projectConnectionHardeningMigrationEntry]);

    const request = await env.DB.prepare(
      `SELECT status FROM project_initialization_requests WHERE id = ?`,
    )
      .bind(requestId)
      .first<{ status: string }>();
    const claimTable = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name = 'project_initialization_approval_claims'`,
    ).first<{ name: string }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(request?.status).toBe("approving");
    expect(claimTable?.name).toBe("project_initialization_approval_claims");
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
