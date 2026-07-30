import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  migrations,
  onboardingLifecycleMigrationEntry,
} from "./migration-fixture";

describe("0020 onboarding lifecycle upgrade", () => {
  it("backfills the existing owner credential and exact current vault generation", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 14));
    const vaultId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const stateVector = "a".repeat(64);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO owners (
          id, webauthn_user_id, credential_id, public_key, counter,
          transports, device_type, backed_up, created_at,
          last_authenticated_at
        ) VALUES (
          1, 'upgrade-user', 'upgrade-owner-credential', 'AQID', 4,
          '["internal"]', 'multiDevice', 1, 100, 105
        )`,
      ),
      env.DB.prepare(
        `INSERT INTO vaults (
          id, display_name, status, created_at, paired_at, last_connected_at
        ) VALUES (?, 'Upgrade vault', 'active', 100, 110, 120)`,
      ).bind(vaultId),
      env.DB.prepare(
        `INSERT INTO vault_credentials (
          id, vault_id, token_hash, plugin_version, schema_version,
          created_at, last_used_at
        ) VALUES (?, ?, ?, '0.1.4', 3, 110, 120)`,
      ).bind(credentialId, vaultId, "b".repeat(64)),
      env.DB.prepare(
        `INSERT INTO materialization_generations (
          id, vault_id, source_state_vector_sha256, status, note_count,
          total_bytes, manifest_key, manifest_sha256, created_at, completed_at
        ) VALUES (?, ?, ?, 'published', 2, 42, ?, ?, 125, 130)`,
      ).bind(
        generationId,
        vaultId,
        stateVector,
        `materializations/${generationId}/manifest.json`,
        "c".repeat(64),
      ),
      env.DB.prepare(
        `INSERT INTO current_materializations (
          vault_id, generation_id, updated_at
        ) VALUES (?, ?, 130)`,
      ).bind(vaultId, generationId),
    ]);

    await applyMigrations(env.DB, [onboardingLifecycleMigrationEntry]);

    const credential = await env.DB.prepare(
      `SELECT credential_id, owner_id, counter, last_authenticated_at
       FROM owner_credentials WHERE credential_id = ?`,
    )
      .bind("upgrade-owner-credential")
      .first<{
        counter: number;
        credential_id: string;
        last_authenticated_at: number | null;
        owner_id: number;
      }>();
    expect(credential).toEqual({
      counter: 4,
      credential_id: "upgrade-owner-credential",
      last_authenticated_at: 105,
      owner_id: 1,
    });

    const syncState = await env.DB.prepare(
      `SELECT credential_id, plugin_version, schema_version,
        connection_confirmed_at, initial_sync_at, last_sync_at,
        current_state_vector_sha256, library_stale
       FROM vault_sync_states WHERE vault_id = ?`,
    )
      .bind(vaultId)
      .first<{
        connection_confirmed_at: number | null;
        credential_id: string | null;
        current_state_vector_sha256: string | null;
        initial_sync_at: number | null;
        last_sync_at: number | null;
        library_stale: number;
        plugin_version: string | null;
        schema_version: number | null;
      }>();
    expect(syncState).toEqual({
      connection_confirmed_at: 120,
      credential_id: credentialId,
      current_state_vector_sha256: stateVector,
      initial_sync_at: 120,
      last_sync_at: 130,
      library_stale: 0,
      plugin_version: "0.1.4",
      schema_version: 3,
    });

    const requestColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('project_initialization_requests')
       WHERE name = 'semantic_key_sha256'`,
    ).all<{ name: string }>();
    const consentColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('oauth_consent_flows')
       WHERE name = 'project_initialization_request_id'`,
    ).all<{ name: string }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();
    expect(requestColumns.results).toEqual([{ name: "semantic_key_sha256" }]);
    expect(consentColumns.results).toEqual([
      { name: "project_initialization_request_id" },
    ]);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
