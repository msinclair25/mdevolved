import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  autonomousCompletionModeMigrationEntry,
} from "./migration-fixture";

describe("D1 autonomous completion mode migration", () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE project_runs (run_id TEXT PRIMARY KEY NOT NULL) STRICT",
      ),
      env.DB.prepare(
        "CREATE TABLE project_policy_bindings (binding_id TEXT PRIMARY KEY NOT NULL) STRICT",
      ),
    ]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO project_runs (run_id) VALUES ('legacy-run')"),
      env.DB.prepare(
        "INSERT INTO project_policy_bindings (binding_id) VALUES ('legacy-binding')",
      ),
    ]);
    await applyMigrations(env.DB, [autonomousCompletionModeMigrationEntry]);
  });

  it("maps old Runs and bindings to the reviewed no-solo default", async () => {
    expect(
      await env.DB.prepare(
        `SELECT completion_mode FROM project_runs WHERE run_id = 'legacy-run'`,
      ).first(),
    ).toEqual({ completion_mode: "orchestrated-reviewed" });
    expect(
      await env.DB.prepare(
        `SELECT solo_verified_allowed FROM project_policy_bindings
         WHERE binding_id = 'legacy-binding'`,
      ).first(),
    ).toEqual({ solo_verified_allowed: 0 });
  });

  it("rejects unsupported completion modes and non-boolean consent", async () => {
    await expect(
      env.DB.prepare(
        `UPDATE project_runs SET completion_mode = 'unreviewed'
         WHERE run_id = 'legacy-run'`,
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE project_policy_bindings SET solo_verified_allowed = 2
         WHERE binding_id = 'legacy-binding'`,
      ).run(),
    ).rejects.toThrow();
  });
});
