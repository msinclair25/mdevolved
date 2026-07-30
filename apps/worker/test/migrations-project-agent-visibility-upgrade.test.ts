import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  applyProjectAgentVisibilityMigration,
  migrations,
} from "./migration-fixture";

describe("0025 Project agent visibility upgrade", () => {
  it("keeps existing Projects discoverable until the owner hides them", async () => {
    await applyMigrations(env.DB, migrations.slice(0, 19));
    const projectId = crypto.randomUUID();
    const projectVersionId = crypto.randomUUID();
    const knowledgeSpaceVersionId = crypto.randomUUID();
    for (const [id, recordType] of [
      [projectId, "project"],
      [projectVersionId, "project-version"],
      [knowledgeSpaceVersionId, "knowledge-space-version"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO collaboration_records (
          id, record_type, schema_version, portable_object_id,
          body_object_key, content_sha256, byte_length, received_at
        ) VALUES (?, ?, 1, ?, ?, ?, 2, 100)`,
      )
        .bind(id, recordType, `portable-${id}`, `records/${id}`, "0".repeat(64))
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO collaboration_projects (
        project_id, active_project_version_id,
        active_knowledge_space_version_id, label, objective, created_at
      ) VALUES (?, ?, ?, 'Legacy Project', 'Keep private when asked.', 100)`,
    )
      .bind(projectId, projectVersionId, knowledgeSpaceVersionId)
      .run();

    await applyProjectAgentVisibilityMigration(env.DB);
    await applyProjectAgentVisibilityMigration(env.DB);

    expect(
      await env.DB.prepare(
        `SELECT agent_visibility FROM collaboration_projects
         WHERE project_id = ?`,
      )
        .bind(projectId)
        .first(),
    ).toEqual({ agent_visibility: "discoverable" });
    await env.DB.prepare(
      `UPDATE collaboration_projects
       SET agent_visibility = 'owner-only'
       WHERE project_id = ?`,
    )
      .bind(projectId)
      .run();
    expect(
      await env.DB.prepare(
        `SELECT agent_visibility FROM collaboration_projects
         WHERE project_id = ?`,
      )
        .bind(projectId)
        .first(),
    ).toEqual({ agent_visibility: "owner-only" });
    await expect(
      env.DB.prepare(
        `UPDATE collaboration_projects
         SET agent_visibility = 'internal'
         WHERE project_id = ?`,
      )
        .bind(projectId)
        .run(),
    ).rejects.toThrow();
  });
});
