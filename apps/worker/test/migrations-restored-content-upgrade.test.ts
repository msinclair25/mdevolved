import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  restoredContentAuthorizationMigrationEntry,
} from "./migration-fixture";

describe("D1 restored-content authorization upgrade", () => {
  it("keeps every existing grant unapproved for prior restore sources", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 13));
    const vaultId = "10000000-0000-4000-8000-000000000019";
    const grantId = "20000000-0000-4000-8000-000000000019";
    const restoreId = "30000000-0000-4000-8000-000000000019";
    const cleanedRestoreId = "31000000-0000-4000-8000-000000000019";
    const generationId = "70000000-0000-4000-8000-000000000019";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO owners (
          id, webauthn_user_id, credential_id, public_key, counter,
          transports, device_type, backed_up, created_at
        ) VALUES (1, 'restore-owner', 'credential', 'public-key', 0,
          '[]', 'singleDevice', 0, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at
        ) VALUES (?, 'Recovery target', 'active', 100, 101)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO agent_grants (
          id, owner_id, oauth_client_id, client_name, client_origin,
          redirect_uri, audience, vault_id, scopes_json,
          path_prefixes_json, path_key_prefixes_json, status, created_at,
          activated_at
        ) VALUES (?, 1, 'client', 'Agent', 'https://agent.test',
          'https://agent.test/callback', 'https://owd.test/mcp', ?,
          '["vault.read"]', '[]', '[]', 'active', 110, 111)`,
      ).bind(grantId, vaultId),
      env.DB.prepare(
        `INSERT INTO materialization_generations (
          id, vault_id, source_state_vector_sha256, status, note_count,
          total_bytes, manifest_key, manifest_sha256, created_at, completed_at
        ) VALUES (?, ?, ?, 'published', 1, 10, ?, ?, 120, 130)`,
      ).bind(
        generationId,
        vaultId,
        "b".repeat(64),
        `materializations/${generationId}/manifest.json`,
        "c".repeat(64),
      ),
      env.DB.prepare(
        `INSERT INTO materialized_notes (
          generation_id, vault_id, path, path_key, title, r2_key,
          content_sha256, byte_length
        ) VALUES (?, ?, 'Cleaned.md', 'cleaned.md', 'Cleaned', ?, ?, 10)`,
      ).bind(
        generationId,
        vaultId,
        `materializations/${generationId}/notes/cleaned.md`,
        "d".repeat(64),
      ),
      env.DB.prepare(
        `INSERT INTO restore_jobs (
          id, target_vault_id, source_backup_id, source_vault_id,
          source_vault_name, source_generation_id, status,
          expected_note_count, expected_bytes, applied_note_count,
          created_at, updated_at, expires_at, confirmed_at, applied_at
        ) VALUES (?, ?, ?, ?, 'Prior source', ?, 'applied', 1, 10, 1,
          120, 130, 200, 125, 130)`,
      ).bind(
        restoreId,
        vaultId,
        "40000000-0000-4000-8000-000000000019",
        "50000000-0000-4000-8000-000000000019",
        "60000000-0000-4000-8000-000000000019",
      ),
      env.DB.prepare(
        `INSERT INTO restore_entries (
          restore_id, path, path_key, content_sha256, byte_length,
          staging_key, status, applied_at
        ) VALUES (?, 'Restored.md', 'restored.md', ?, 10, ?,
          'applied', 130)`,
      ).bind(restoreId, "a".repeat(64), `restore-upgrade/${restoreId}`),
      env.DB.prepare(
        `INSERT INTO restore_jobs (
          id, target_vault_id, source_backup_id, source_vault_id,
          source_vault_name, source_generation_id, status,
          expected_note_count, expected_bytes, applied_note_count,
          created_at, updated_at, expires_at, confirmed_at, applied_at,
          verified_generation_id
        ) VALUES (?, ?, ?, ?, 'Cleaned prior source', ?, 'applied', 1, 10, 1,
          120, 130, 200, 125, 130, ?)`,
      ).bind(
        cleanedRestoreId,
        vaultId,
        "41000000-0000-4000-8000-000000000019",
        "51000000-0000-4000-8000-000000000019",
        "61000000-0000-4000-8000-000000000019",
        generationId,
      ),
    ]);

    await applyMigrations(env.DB, [restoredContentAuthorizationMigrationEntry]);

    const approvalCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_grant_restore_sources
       WHERE grant_id = ? OR restore_id = ?`,
    )
      .bind(grantId, restoreId)
      .first<{ count: number }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    const lineageCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM restored_note_lineage
       WHERE target_vault_id = ?
         AND (
           (restore_id = ? AND path_key = 'restored.md')
           OR (restore_id = ? AND path_key = 'cleaned.md')
         )`,
    )
      .bind(vaultId, restoreId, cleanedRestoreId)
      .first<{ count: number }>();
    expect(approvalCount?.count).toBe(0);
    expect(lineageCount?.count).toBe(2);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
