import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { commitFirstOwner, createSessionMaterial } from "../src/auth-store";
import { runCollaborationGarbageCollection } from "../src/collaboration-retention";
import {
  deleteAgentSkill,
  deleteWorkingPreference,
  exportAgentSkill,
  importAgentSkill,
  listAgentSkills,
  listProjectSkillAttachments,
  listWorkingPreferences,
  mutateProjectSkill,
  saveWorkingPreference,
  WorkingProfileProblem,
} from "../src/working-profile-service";
import {
  putImmutableWorkingProfileBody,
  WorkingProfileStoreProblem,
} from "../src/working-profile-store";
import { applyMigrations, migrations } from "./migration-fixture";

const ORIGIN = "https://owd.test";

function base64(value: string): string {
  return bytesBase64(new TextEncoder().encode(value));
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pkcs8PrivateKeyFixture(): Uint8Array {
  return Uint8Array.from([
    0x30,
    0x32,
    0x02,
    0x01,
    0x00,
    0x30,
    0x0b,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x04,
    0x20,
    ...new Uint8Array(32).fill(0x42),
  ]);
}

function skillFiles(
  frontmatter = "name: safe-skill\ndescription: A safe portable skill",
) {
  return [
    {
      contentBase64: base64(`---\n${frontmatter}\n---\n\nUse the checklist.`),
      path: "SKILL.md",
    },
    { contentBase64: base64("echo inert"), path: "scripts/check.sh" },
    { contentBase64: "AAEC/w==", path: "assets/example.bin" },
  ];
}

function failNextBatch(): D1Database {
  let failed = false;
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!failed) {
            failed = true;
            throw new Error("synthetic commit failure");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedProject(projectId = crypto.randomUUID()): Promise<string> {
  const versionId = crypto.randomUUID();
  const knowledgeVersionId = crypto.randomUUID();
  const values = [
    [projectId, "project", null],
    [versionId, "project-version", projectId],
    [knowledgeVersionId, "knowledge-space-version", projectId],
  ] as const;
  await env.DB.batch(
    values.map(([id, recordType, recordProjectId]) =>
      env.DB.prepare(
        `INSERT INTO collaboration_records (
             id, record_type, schema_version, project_id, portable_object_id,
             body_object_key, content_sha256, byte_length, received_at
           ) VALUES (?, ?, 1, ?, ?, ?, ?, 2, 1)`,
      ).bind(
        id,
        recordType,
        recordProjectId,
        crypto.randomUUID(),
        `test/${id}.json`,
        "a".repeat(64),
      ),
    ),
  );
  await env.DB.prepare(
    `INSERT INTO collaboration_projects (
         project_id, active_project_version_id, active_knowledge_space_version_id,
         label, objective, status, created_at
       ) VALUES (?, ?, ?, 'Synthetic Project', 'Test working profiles', 'active', 1)`,
  )
    .bind(projectId, versionId, knowledgeVersionId)
    .run();
  return projectId;
}

async function seedSyntheticAttachment(
  projectId: string,
  skillId: string,
  versionRecordId: string,
  index: number,
  slots = { projectSlot: index, skillSlot: 0 },
): Promise<void> {
  const attachedRecordId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO working_profile_records (
           record_id, record_type, portable_object_id, project_id, skill_id,
           dependencies_json, body_object_key, content_sha256, byte_length,
           created_at, restore_state, restored_authority_allowed
         ) VALUES (?, 'skill-attached', ?, ?, ?, ?, ?, ?, 2, ?, 'live', 0)`,
    ).bind(
      attachedRecordId,
      crypto.randomUUID(),
      projectId,
      skillId,
      JSON.stringify([versionRecordId]),
      `test/${attachedRecordId}.json`,
      "c".repeat(64),
      index + 1,
    ),
    env.DB.prepare(
      `INSERT INTO project_skill_attachments (
           project_id, skill_id, skill_version_record_id, project_slot,
           skill_slot, attached_record_id, record_restore_state, attached_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`,
    ).bind(
      projectId,
      skillId,
      versionRecordId,
      slots.projectSlot,
      slots.skillSlot,
      attachedRecordId,
      index + 1,
    ),
  ]);
}

async function seedSyntheticSkillAttachment(
  projectId: string,
  index: number,
): Promise<void> {
  const skillId = crypto.randomUUID();
  const versionRecordId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO working_profile_records (
           record_id, record_type, portable_object_id, skill_id,
           dependencies_json, body_object_key, content_sha256, byte_length,
           created_at, restore_state, restored_authority_allowed
         ) VALUES (?, 'skill-version', ?, ?, '[]', ?, ?, 2, ?, 'live', 0)`,
    ).bind(
      versionRecordId,
      crypto.randomUUID(),
      skillId,
      `test/${versionRecordId}.json`,
      "b".repeat(64),
      index + 1,
    ),
    env.DB.prepare(
      `INSERT INTO agent_skills (
           skill_id, name, description, current_version_record_id,
           record_restore_state, status, updated_at
         ) VALUES (?, ?, 'Synthetic boundedness fixture', ?, 'live', 'active', ?)`,
    ).bind(skillId, `synthetic-${index}`, versionRecordId, index + 1),
  ]);
  await seedSyntheticAttachment(projectId, skillId, versionRecordId, index);
}

async function resetDatabase(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM working_profile_mutation_receipts;
    DELETE FROM collaboration_gc_objects;
    DELETE FROM project_skill_attachments;
    DELETE FROM working_preferences;
    DELETE FROM agent_skills;
    DELETE FROM working_profile_records;
    DELETE FROM collaboration_projects;
    DELETE FROM collaboration_records;
    DELETE FROM sessions;
    DELETE FROM auth_challenges;
    DELETE FROM auth_rate_limits;
    DELETE FROM audit_events;
    DELETE FROM owners;
  `);
}

async function seedPreferenceCapacity(count: number): Promise<void> {
  for (let start = 0; start < count; start += 32) {
    const statements: D1PreparedStatement[] = [];
    for (let index = start; index < Math.min(start + 32, count); index += 1) {
      const preferenceId = crypto.randomUUID();
      const recordId = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          `INSERT INTO working_profile_records (
             record_id, record_type, portable_object_id, preference_id,
             dependencies_json, body_object_key, content_sha256, byte_length,
             created_at
           ) VALUES (?, 'preference-version', ?, ?, '[]', ?, ?, 2, ?)`,
        ).bind(
          recordId,
          crypto.randomUUID(),
          preferenceId,
          `capacity/preference-${index}.json`,
          "a".repeat(64),
          index + 1,
        ),
        env.DB.prepare(
          `INSERT INTO working_preferences (
             preference_id, project_id, preference_key, current_record_id,
             record_restore_state, status, value, source_label, source_url,
             updated_at
           ) VALUES (?, NULL, ?, ?, 'live', 'active', ?, 'Synthetic', NULL, ?)`,
        ).bind(
          preferenceId,
          `capacity-${index}`,
          recordId,
          `value-${index}`,
          index + 1,
        ),
      );
    }
    await env.DB.batch(statements);
  }
}

async function seedSkillCapacity(count: number): Promise<void> {
  for (let start = 0; start < count; start += 32) {
    const statements: D1PreparedStatement[] = [];
    for (let index = start; index < Math.min(start + 32, count); index += 1) {
      const skillId = crypto.randomUUID();
      const recordId = crypto.randomUUID();
      statements.push(
        env.DB.prepare(
          `INSERT INTO working_profile_records (
             record_id, record_type, portable_object_id, skill_id,
             dependencies_json, body_object_key, content_sha256, byte_length,
             created_at
           ) VALUES (?, 'skill-version', ?, ?, '[]', ?, ?, 2, ?)`,
        ).bind(
          recordId,
          crypto.randomUUID(),
          skillId,
          `capacity/skill-${index}.json`,
          "b".repeat(64),
          index + 1,
        ),
        env.DB.prepare(
          `INSERT INTO agent_skills (
             skill_id, name, description, current_version_record_id,
             record_restore_state, status, updated_at
           ) VALUES (?, ?, 'Synthetic capacity fixture', ?, 'live', 'active', ?)`,
        ).bind(skillId, `capacity-skill-${index}`, recordId, index + 1),
      );
    }
    await env.DB.batch(statements);
  }
}

beforeAll(async () => applyMigrations(env.DB, migrations));
beforeEach(resetDatabase);

describe("working-profile service", () => {
  it("enforces the 256-item durable cap instead of silently truncating lists", async () => {
    await seedPreferenceCapacity(256);
    expect(await listWorkingPreferences(env.DB, null)).toHaveLength(256);
    await expect(
      saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
        idempotencyKey: "preference-capacity-overflow",
        key: "capacity-overflow",
        projectId: null,
        sourceLabel: "Owner",
        sourceUrl: null,
        value: "Rejected at the durable cap.",
      }),
    ).rejects.toMatchObject({ code: "preference_conflict" });

    await seedSkillCapacity(256);
    expect(await listAgentSkills(env.DB)).toHaveLength(256);
    await expect(
      importAgentSkill(env.DB, env.VAULT_STORAGE, {
        files: skillFiles(
          "name: capacity-overflow\ndescription: Rejected at the durable cap",
        ),
        idempotencyKey: "skill-capacity-overflow",
      }),
    ).rejects.toMatchObject({ code: "skill_package_too_large" });
  });

  it("queues every failed preference and skill publication for reference-safe cleanup", async () => {
    await expect(
      saveWorkingPreference(failNextBatch(), env.VAULT_STORAGE, {
        idempotencyKey: "failed-preference-save",
        key: "failed-save",
        projectId: null,
        sourceLabel: "Synthetic failure",
        sourceUrl: null,
        value: "Never committed.",
      }),
    ).rejects.toThrow("synthetic commit failure");
    const preference = await saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "preference-before-failed-delete",
      key: "failed-delete",
      projectId: null,
      sourceLabel: "Synthetic failure",
      sourceUrl: null,
      value: "Delete me.",
    });
    await expect(
      deleteWorkingPreference(failNextBatch(), env.VAULT_STORAGE, {
        idempotencyKey: "failed-preference-delete",
        preferenceId: preference.preferenceId,
      }),
    ).rejects.toThrow("synthetic commit failure");
    await expect(
      importAgentSkill(failNextBatch(), env.VAULT_STORAGE, {
        files: skillFiles(
          "name: failed-import\ndescription: Never committed skill",
        ),
        idempotencyKey: "failed-skill-import",
      }),
    ).rejects.toThrow("synthetic commit failure");
    const skill = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(
        "name: skill-before-delete\ndescription: Delete failure fixture",
      ),
      idempotencyKey: "skill-before-failed-delete",
    });
    await expect(
      deleteAgentSkill(failNextBatch(), env.VAULT_STORAGE, {
        idempotencyKey: "failed-skill-delete",
        skillId: skill.skillId,
      }),
    ).rejects.toThrow("synthetic commit failure");

    const queued = await env.DB.prepare(
      `SELECT object_key FROM collaboration_gc_objects
       WHERE object_key LIKE 'working-profile/%' ORDER BY object_key`,
    ).all<{ object_key: string }>();
    expect(queued.results).toHaveLength(4);
    for (const row of queued.results) {
      expect(await env.VAULT_STORAGE.head(row.object_key)).not.toBeNull();
    }
    await runCollaborationGarbageCollection(
      env.DB,
      env.VAULT_STORAGE,
      Math.floor(Date.now() / 1_000) + 61,
    );
    for (const row of queued.results) {
      expect(await env.VAULT_STORAGE.head(row.object_key)).toBeNull();
    }
  });

  it("never deletes a queued body once a working-profile record references it", async () => {
    const preference = await saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "referenced-profile-body",
      key: "reference-safe",
      projectId: null,
      sourceLabel: "Reference safety",
      sourceUrl: null,
      value: "Keep this body.",
    });
    const row = await env.DB.prepare(
      `SELECT body_object_key FROM working_profile_records
       WHERE record_id = ?`,
    )
      .bind(preference.versionRecordId)
      .first<{ body_object_key: string }>();
    if (row === null) throw new Error("Working-profile body missing.");
    await env.DB.prepare(
      `INSERT INTO collaboration_gc_objects (object_key, queued_at)
       VALUES (?, 1)`,
    )
      .bind(row.body_object_key)
      .run();
    await runCollaborationGarbageCollection(
      env.DB,
      env.VAULT_STORAGE,
      Math.floor(Date.now() / 1_000) + 61,
    );
    expect(await env.VAULT_STORAGE.head(row.body_object_key)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM collaboration_gc_objects WHERE object_key = ?",
      )
        .bind(row.body_object_key)
        .first(),
    ).toBeNull();
  });

  it("applies Project precedence and versioned edit/delete with stable replay", async () => {
    const projectId = await seedProject();
    const personal = await saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "personal-save",
      key: "package-manager",
      projectId: null,
      sourceLabel: "Owner",
      sourceUrl: null,
      value: "Use npm.",
    });
    const project = await saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "project-save",
      key: "package-manager",
      projectId,
      sourceLabel: "Owner",
      sourceUrl: "https://example.test/preference",
      value: "Use pnpm.",
    });

    expect(await listWorkingPreferences(env.DB, projectId)).toMatchObject([
      { preferenceId: project.preferenceId, value: "Use pnpm." },
    ]);
    expect(await listWorkingPreferences(env.DB, null)).toMatchObject([
      { preferenceId: personal.preferenceId, value: "Use npm." },
    ]);
    const otherProjectId = await seedProject();
    expect(await listWorkingPreferences(env.DB, otherProjectId)).toMatchObject([
      { preferenceId: personal.preferenceId, value: "Use npm." },
    ]);

    const editedInput = {
      idempotencyKey: "project-edit",
      key: "package-manager",
      preferenceId: project.preferenceId,
      projectId,
      sourceLabel: "Owner",
      sourceUrl: null,
      value: "Use pnpm with the lockfile.",
    };
    const edited = await saveWorkingPreference(
      env.DB,
      env.VAULT_STORAGE,
      editedInput,
    );
    expect(
      await saveWorkingPreference(env.DB, env.VAULT_STORAGE, editedInput),
    ).toEqual(edited);
    await expect(
      saveWorkingPreference(env.DB, env.VAULT_STORAGE, {
        ...editedInput,
        value: "Conflict",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await deleteWorkingPreference(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "project-delete",
      preferenceId: project.preferenceId,
    });
    expect(await listWorkingPreferences(env.DB, projectId)).toMatchObject([
      { preferenceId: personal.preferenceId, value: "Use npm." },
    ]);
  });

  it("round-trips inert scripts/assets and enforces hostile package boundaries", async () => {
    const imported = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(),
      idempotencyKey: "skill-import",
    });
    const exported = await exportAgentSkill(
      env.DB,
      env.VAULT_STORAGE,
      imported.skillId,
    );
    expect(exported.files).toEqual(skillFiles());
    expect(exported).toMatchObject({
      executes: false,
      grantsAuthority: false,
      skill: { name: "safe-skill" },
    });

    const hostile = [
      [{ contentBase64: base64("x"), path: "../SKILL.md" }],
      [{ contentBase64: base64("x"), path: "/SKILL.md" }],
      [{ contentBase64: base64("x"), path: "folder\\SKILL.md" }],
      [{ contentBase64: base64("x"), path: "folder\u0000/SKILL.md" }],
      [...skillFiles(), { contentBase64: base64("x"), path: "skill.md" }],
      [
        ...skillFiles(),
        { contentBase64: base64("x"), path: "nested/SKILL.md" },
      ],
      skillFiles("name: duplicate\nname: again\ndescription: bad"),
      skillFiles("name: alias\ndescription: &value bad\ncopy: *value"),
      skillFiles("name: malformed\ndescription: [unterminated"),
      skillFiles("name: custom-tag\ndescription: !unsafe value"),
      [{ contentBase64: "/v4=", path: "SKILL.md" }],
      [
        ...skillFiles(),
        {
          contentBase64: bytesBase64(new Uint8Array(64 * 1_024 + 1)),
          path: "assets/oversized.bin",
        },
      ],
      [
        ...skillFiles(),
        ...Array.from({ length: 4 }, (_, index) => ({
          contentBase64: bytesBase64(new Uint8Array(64 * 1_024)),
          path: `assets/bulk-${index}.bin`,
        })),
      ],
      [
        ...skillFiles(),
        {
          contentBase64: base64(
            ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
          ),
          path: "assets/readme.txt",
        },
      ],
      [...skillFiles(), { contentBase64: base64("secret"), path: ".env" }],
    ];
    for (const [index, files] of hostile.entries()) {
      await expect(
        importAgentSkill(env.DB, env.VAULT_STORAGE, {
          files,
          idempotencyKey: `hostile-${index}`,
        }),
      ).rejects.toBeInstanceOf(WorkingProfileProblem);
    }

    const credentialTokens = [
      `ghp_${"Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx5Yz7"}`,
      `github_pat_${"Ab3_Cd5Ef7Gh9Jk2Lm4Np6Qr8St1"}`,
      `xoxb-${"123456789012-AbCdEfGhIjKlMnOpQrStUv"}`,
      `AIza${"Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx5Yz"}`,
      `sk-${"Ab3Cd5Ef7Gh9Jk2Lm4Np6Qr8St1Uv3Wx"}`,
      `eyJ${"Ab3Cd5Ef7Gh9"}.${"Jk2Lm4Np6Qr8St"}.${"Uv3Wx5Yz7Ab9Cd"}`,
    ];
    for (const [index, token] of credentialTokens.entries()) {
      await expect(
        importAgentSkill(env.DB, env.VAULT_STORAGE, {
          files: [
            ...skillFiles(
              `name: credential-${index}\ndescription: Synthetic hostile credential fixture`,
            ),
            {
              contentBase64: base64(`unlabeled ${token}`),
              path: `references/credential-${index}.txt`,
            },
          ],
          idempotencyKey: `credential-${index}`,
        }),
      ).rejects.toMatchObject({ code: "skill_package_invalid" });
    }
    await expect(
      importAgentSkill(env.DB, env.VAULT_STORAGE, {
        files: [
          ...skillFiles(
            "name: binary-credential\ndescription: Binary credential fixture",
          ),
          {
            contentBase64: bytesBase64(
              Uint8Array.from([
                0xff,
                ...new TextEncoder().encode(credentialTokens[0] ?? ""),
              ]),
            ),
            path: "assets/credential.bin",
          },
        ],
        idempotencyKey: "binary-credential",
      }),
    ).rejects.toMatchObject({ code: "skill_package_invalid" });
    await expect(
      importAgentSkill(env.DB, env.VAULT_STORAGE, {
        files: [
          ...skillFiles(
            "name: neutral-binary-key\ndescription: Neutral binary key fixture",
          ),
          {
            contentBase64: bytesBase64(pkcs8PrivateKeyFixture()),
            path: "assets/data.bin",
          },
        ],
        idempotencyKey: "neutral-binary-key",
      }),
    ).rejects.toMatchObject({ code: "skill_package_invalid" });

    const placeholders = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: [
        ...skillFiles(
          "name: placeholder-safe\ndescription: Safe documentation placeholders",
        ),
        {
          contentBase64: base64(
            `Use sk-${"x".repeat(32)}, ghp_${"EXAMPLE".repeat(6)}, and xoxb-REDACTED-placeholder in documentation.`,
          ),
          path: "references/placeholders.md",
        },
      ],
      idempotencyKey: "placeholder-safe",
    });
    expect(placeholders.name).toBe("placeholder-safe");
  });

  it("pins exact versions and makes detach/delete effective immediately", async () => {
    const projectId = await seedProject();
    const skill = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(),
      idempotencyKey: "attach-import",
    });
    const attached = await mutateProjectSkill(
      env.DB,
      env.VAULT_STORAGE,
      { idempotencyKey: "attach", projectId, skillId: skill.skillId },
      true,
    );
    expect(attached.versionRecordId).toBe(skill.versionRecordId);
    await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(
        "name: safe-skill\ndescription: A newer portable skill version",
      ),
      idempotencyKey: "attached-version-edit",
      skillId: skill.skillId,
    });
    expect(
      await listProjectSkillAttachments(env.DB, env.VAULT_STORAGE, projectId),
    ).toMatchObject([
      {
        skill: {
          description: "A safe portable skill",
          versionRecordId: skill.versionRecordId,
        },
      },
    ]);
    await mutateProjectSkill(
      env.DB,
      env.VAULT_STORAGE,
      { idempotencyKey: "detach", projectId, skillId: skill.skillId },
      false,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM project_skill_attachments",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });

    await mutateProjectSkill(
      env.DB,
      env.VAULT_STORAGE,
      { idempotencyKey: "reattach", projectId, skillId: skill.skillId },
      true,
    );
    await deleteAgentSkill(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "skill-delete",
      skillId: skill.skillId,
    });
    expect(await listAgentSkills(env.DB)).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM project_skill_attachments",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("fails closed when pinned R2 evidence has conflicting skill identity", async () => {
    const projectId = await seedProject();
    const skill = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(),
      idempotencyKey: "identity-import",
    });
    await mutateProjectSkill(
      env.DB,
      env.VAULT_STORAGE,
      { idempotencyKey: "identity-attach", projectId, skillId: skill.skillId },
      true,
    );
    const mismatched = await putImmutableWorkingProfileBody(
      env.VAULT_STORAGE,
      JSON.stringify({
        description: "Conflicting synthetic evidence",
        files: skillFiles(),
        name: "conflicting-evidence",
        recordId: crypto.randomUUID(),
        skillId: skill.skillId,
        type: "skill-version",
      }),
      crypto.randomUUID(),
    );
    await env.DB.prepare(
      `UPDATE working_profile_records
       SET body_object_key = ?, content_sha256 = ?, byte_length = ?
       WHERE record_id = ?`,
    )
      .bind(
        mismatched.bodyObjectKey,
        mismatched.contentSha256,
        mismatched.byteLength,
        skill.versionRecordId,
      )
      .run();

    await expect(
      exportAgentSkill(env.DB, env.VAULT_STORAGE, skill.skillId),
    ).rejects.toMatchObject({ code: "skill_package_invalid" });
    await expect(
      listProjectSkillAttachments(env.DB, env.VAULT_STORAGE, projectId),
    ).rejects.toMatchObject({ code: "skill_package_invalid" });
  });

  it("resolves overlapping attachment slot races without raw D1 errors", async () => {
    const projectId = await seedProject();
    const [firstSkill, secondSkill] = await Promise.all([
      importAgentSkill(env.DB, env.VAULT_STORAGE, {
        files: skillFiles(
          "name: overlap-first\ndescription: First overlap fixture",
        ),
        idempotencyKey: "overlap-first-import",
      }),
      importAgentSkill(env.DB, env.VAULT_STORAGE, {
        files: skillFiles(
          "name: overlap-second\ndescription: Second overlap fixture",
        ),
        idempotencyKey: "overlap-second-import",
      }),
    ]);
    await Promise.all([
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "overlap-first-attach",
          projectId,
          skillId: firstSkill.skillId,
        },
        true,
      ),
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "overlap-second-attach",
          projectId,
          skillId: secondSkill.skillId,
        },
        true,
      ),
    ]);
    const slots = await env.DB.prepare(
      `SELECT project_slot FROM project_skill_attachments
       WHERE project_id = ? ORDER BY project_slot`,
    )
      .bind(projectId)
      .all<{ project_slot: number }>();
    expect(slots.results.map((row) => row.project_slot)).toEqual([0, 1]);

    const duplicateProjectId = await seedProject();
    const duplicateResults = await Promise.allSettled([
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "overlap-duplicate-a",
          projectId: duplicateProjectId,
          skillId: firstSkill.skillId,
        },
        true,
      ),
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "overlap-duplicate-b",
          projectId: duplicateProjectId,
          skillId: firstSkill.skillId,
        },
        true,
      ),
    ]);
    expect(
      duplicateResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = duplicateResults.find(
      (result) => result.status === "rejected",
    );
    expect(rejected).toMatchObject({
      reason: { code: "skill_already_attached" },
      status: "rejected",
    });
    const queuedOrphans = await env.DB.prepare(
      `SELECT object_key FROM collaboration_gc_objects
       WHERE object_key LIKE 'working-profile/%'`,
    ).all<{ object_key: string }>();
    expect(queuedOrphans.results.length).toBeGreaterThan(0);
    const orphanKey = queuedOrphans.results[0]?.object_key;
    expect(
      orphanKey === undefined ? null : await env.VAULT_STORAGE.head(orphanKey),
    ).not.toBeNull();
    await runCollaborationGarbageCollection(
      env.DB,
      env.VAULT_STORAGE,
      Math.floor(Date.now() / 1_000) + 61,
    );
    expect(
      orphanKey === undefined ? null : await env.VAULT_STORAGE.head(orphanKey),
    ).toBeNull();
    const duplicateCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM project_skill_attachments
       WHERE project_id = ? AND skill_id = ?`,
    )
      .bind(duplicateProjectId, firstSkill.skillId)
      .first<{ count: number }>();
    expect(duplicateCount).toEqual({ count: 1 });
  });

  it("detects immutable R2 collisions while leaving unreferenced bodies inert", async () => {
    const portableId = crypto.randomUUID();
    await putImmutableWorkingProfileBody(
      env.VAULT_STORAGE,
      '{"safe":true}',
      portableId,
    );
    await expect(
      putImmutableWorkingProfileBody(
        env.VAULT_STORAGE,
        '{"safe":false}',
        portableId,
      ),
    ).rejects.toBeInstanceOf(WorkingProfileStoreProblem);
    const referenced = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM working_profile_records WHERE portable_object_id = ?",
    )
      .bind(portableId)
      .first<{ count: number }>();
    expect(referenced?.count).toBe(0);
    const object = await env.VAULT_STORAGE.head(
      `working-profile/${portableId}.json`,
    );
    expect(object?.httpMetadata?.cacheControl).toBe("private, no-store");
  });

  it("fails explicitly before R2 fan-out when attachment bounds are exceeded", async () => {
    const overfullProjectId = await seedProject();
    for (let index = 0; index < 32; index += 1) {
      await seedSyntheticSkillAttachment(overfullProjectId, index);
    }

    const candidate = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(
        "name: bounded-candidate\ndescription: Candidate for a bounded Project",
      ),
      idempotencyKey: "bounded-candidate",
    });
    await expect(
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "bounded-attach",
          projectId: overfullProjectId,
          skillId: candidate.skillId,
        },
        true,
      ),
    ).rejects.toMatchObject({ code: "project_skill_limit_exceeded" });

    const shared = await importAgentSkill(env.DB, env.VAULT_STORAGE, {
      files: skillFiles(
        "name: bounded-shared\ndescription: Shared deletion bound fixture",
      ),
      idempotencyKey: "bounded-shared",
    });
    for (let index = 0; index < 31; index += 1) {
      const projectId = await seedProject();
      await seedSyntheticAttachment(
        projectId,
        shared.skillId,
        shared.versionRecordId,
        index,
        { projectSlot: 0, skillSlot: index },
      );
    }
    const overflowProjectId = await seedProject();
    await expect(
      mutateProjectSkill(
        env.DB,
        env.VAULT_STORAGE,
        {
          idempotencyKey: "bounded-shared-overflow",
          projectId: overflowProjectId,
          skillId: shared.skillId,
        },
        true,
      ),
    ).rejects.toMatchObject({ code: "project_skill_limit_exceeded" });
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM working_profile_records WHERE skill_id = ?",
    )
      .bind(shared.skillId)
      .first<{ count: number }>();
    await deleteAgentSkill(env.DB, env.VAULT_STORAGE, {
      idempotencyKey: "bounded-delete",
      skillId: shared.skillId,
    });
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM working_profile_records WHERE skill_id = ?",
    )
      .bind(shared.skillId)
      .first<{ count: number }>();
    expect((after?.count ?? 0) - (before?.count ?? 0)).toBe(32);
    expect(
      (await listAgentSkills(env.DB)).map((skill) => skill.skillId),
    ).not.toContain(shared.skillId);
  });
});

describe("working-profile routes", () => {
  it("requires owner authentication and rejects oversized JSON before parsing", async () => {
    const unauthenticated = await worker.fetch(
      new Request(`${ORIGIN}/api/working-profile/preferences`),
      env,
      createExecutionContext(),
    );
    expect(unauthenticated.status).toBe(401);

    const now = Math.floor(Date.now() / 1_000);
    const session = await createSessionMaterial(now);
    await commitFirstOwner(
      env.DB,
      {
        backedUp: true,
        counter: 0,
        credentialId: "working-profile-passkey",
        deviceType: "multiDevice",
        publicKey: new Uint8Array([1, 2, 3]),
        transports: ["internal"],
        webauthnUserId: "working-profile-owner",
      },
      session,
      crypto.randomUUID(),
      now,
    );
    const csrfDenied = await worker.fetch(
      new Request(`${ORIGIN}/api/working-profile/preferences`, {
        body: JSON.stringify({
          idempotencyKey: "csrf-denied",
          key: "test",
          projectId: null,
          sourceLabel: "Owner",
          sourceUrl: null,
          value: "Denied",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-owd_session=${session.token}`,
          Origin: ORIGIN,
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(csrfDenied.status).toBe(403);

    const saved = await worker.fetch(
      new Request(`${ORIGIN}/api/working-profile/preferences`, {
        body: JSON.stringify({
          idempotencyKey: "route-save",
          key: "response-style",
          projectId: null,
          sourceLabel: "Owner",
          sourceUrl: null,
          value: "Be concise.",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`,
          Origin: ORIGIN,
          "X-OWD-CSRF": session.csrfToken,
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(saved.status).toBe(200);
    const listed = await worker.fetch(
      new Request(`${ORIGIN}/api/working-profile/preferences`, {
        headers: {
          Cookie: `__Host-owd_session=${session.token}`,
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      ok: true,
      preferences: [{ key: "response-style", value: "Be concise." }],
    });

    const oversized = await worker.fetch(
      new Request(`${ORIGIN}/api/working-profile/skills/import`, {
        body: JSON.stringify({ padding: "x".repeat(401 * 1_024) }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-owd_session=${session.token}; __Host-owd_csrf=${session.csrfToken}`,
          Origin: ORIGIN,
          "X-OWD-CSRF": session.csrfToken,
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
  });
});
