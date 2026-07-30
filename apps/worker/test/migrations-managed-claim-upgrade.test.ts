import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  invitedOwnerClaimMigrationEntry,
  migrations,
} from "./migration-fixture";

describe("D1 invited-owner upgrade", () => {
  it("adds the optional managed claim gate without changing a Community owner", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 12));
    await env.DB.prepare(
      `INSERT INTO owners (
        id, webauthn_user_id, credential_id, public_key, counter,
        transports, device_type, backed_up, created_at
      ) VALUES (1, 'existing-owner', 'credential', 'public-key', 0,
                '[]', 'singleDevice', 0, 100)`,
    ).run();

    await applyMigrations(env.DB, [invitedOwnerClaimMigrationEntry]);

    const owner = await env.DB.prepare(
      "SELECT webauthn_user_id FROM owners WHERE id = 1",
    ).first<{ webauthn_user_id: string }>();
    const configurationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM owner_claim_configuration",
    ).first<{ count: number }>();
    const foreignKeyFailures = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all<Record<string, unknown>>();

    expect(owner?.webauthn_user_id).toBe("existing-owner");
    expect(configurationCount?.count).toBe(0);
    expect(foreignKeyFailures.results).toEqual([]);
  });
});
