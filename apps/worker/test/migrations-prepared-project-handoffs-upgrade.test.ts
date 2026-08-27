import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  preparedProjectHandoffsMigrationEntry,
} from "./migration-fixture";

describe("prepared first-Project handoff migration", () => {
  it("upgrades an existing workspace and enforces one active handoff per vault and agent", async () => {
    await applyMigrations(
      env.DB,
      migrations.slice(
        0,
        migrations.indexOf(preparedProjectHandoffsMigrationEntry),
      ),
    );
    const now = Math.floor(Date.now() / 1_000);
    const vaultId = crypto.randomUUID();
    const firstAgentId = crypto.randomUUID();
    const secondAgentId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO owners (
          id, webauthn_user_id, credential_id, public_key, counter,
          transports, device_type, backed_up, created_at
        ) VALUES (
          1, 'migration-owner', 'migration-credential', 'AQID', 0,
          '[]', 'multiDevice', 1, ?
        )`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Existing vault', 'active', ?, ?)`,
      ).bind(vaultId, now, now),
      ...[
        { clientId: "migration-agent-1", id: firstAgentId },
        { clientId: "migration-agent-2", id: secondAgentId },
      ].map(({ clientId, id }) =>
        env.DB.prepare(
          `INSERT INTO agent_grants (
            id, owner_id, oauth_client_id, client_name, client_origin,
            redirect_uri, audience, vault_id, scopes_json, path_prefixes_json,
            path_key_prefixes_json, status, created_at, activated_at
          ) VALUES (?, 1, ?, 'Migration agent', 'https://agent.example',
            'https://agent.example/callback', 'https://owd.test/mcp', ?,
            '["vault.read","project.initialize.request","project.connect.request"]',
            '[]', '[]', 'active', ?, ?)`,
        ).bind(id, clientId, vaultId, now, now),
      ),
    ]);

    await applyMigrations(env.DB, [preparedProjectHandoffsMigrationEntry]);
    const firstHandoffId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO prepared_project_handoffs (
        id, agent_grant_id, vault_id, project_label, project_label_key,
        folder_path, folder_path_key, status, prepared_at
      ) VALUES (?, ?, ?, 'Existing Project', 'existing project',
        '', '', 'prepared', ?)`,
    )
      .bind(firstHandoffId, firstAgentId, vaultId, now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO prepared_project_handoffs (
          id, agent_grant_id, vault_id, project_label, project_label_key,
          folder_path, folder_path_key, status, prepared_at
        ) VALUES (?, ?, ?, 'Conflicting Project', 'conflicting project',
          '', '', 'prepared', ?)`,
      )
        .bind(crypto.randomUUID(), secondAgentId, vaultId, now + 1)
        .run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      `UPDATE prepared_project_handoffs
       SET status = 'revoked', revoked_at = ?
       WHERE id = ?`,
    )
      .bind(now + 1, firstHandoffId)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO prepared_project_handoffs (
          id, agent_grant_id, vault_id, project_label, project_label_key,
          folder_path, folder_path_key, status, prepared_at
        ) VALUES (?, ?, ?, 'Replacement Project', 'replacement project',
          '', '', 'prepared', ?)`,
      )
        .bind(crypto.randomUUID(), secondAgentId, vaultId, now + 2)
        .run(),
    ).resolves.toBeDefined();

    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
