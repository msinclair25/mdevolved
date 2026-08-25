import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalizeCollaborationJson } from "@owd/contracts";
import {
  acceptCompoundingDraft,
  deleteCompoundingDraft,
  ignoreCompoundingDraft,
  listCompoundingDrafts,
  observeCompoundingCheckpoint,
  CompoundingProblem,
  ensureCompoundingCheckpointBinding,
} from "../src/compounding-service";
import { listWorkingPreferences } from "../src/working-profile-service";
import { sha256Hex } from "../src/security";
import { applyMigrations, migrations } from "./migration-fixture";

async function seedProject(): Promise<string> {
  const projectId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const knowledgeVersionId = crypto.randomUUID();
  await env.DB.batch(
    [
      [projectId, "project", null],
      [versionId, "project-version", projectId],
      [knowledgeVersionId, "knowledge-space-version", projectId],
    ].map(([id, recordType, recordProjectId]) =>
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
     ) VALUES (?, ?, ?, 'Compounding fixture', 'M3 test project', 'active', 1)`,
  )
    .bind(projectId, versionId, knowledgeVersionId)
    .run();
  return projectId;
}

async function observeTwice(
  projectId: string,
  signal: unknown,
  prefix: string,
): Promise<void> {
  await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
    acknowledgedAt: 10,
    checkpointId: crypto.randomUUID(),
    learningSignals: [signal],
    pointContentSha256: "a".repeat(64),
    producerClientId: `${prefix}-a`,
    projectId,
  });
  await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
    acknowledgedAt: 20,
    checkpointId: crypto.randomUUID(),
    learningSignals: [signal],
    pointContentSha256: "b".repeat(64),
    producerClientId: `${prefix}-b`,
    projectId,
  });
}

beforeAll(async () => applyMigrations(env.DB, migrations));

describe("M3 compounding service", () => {
  it("requires two distinct points, replays idempotently, and accepts through M2", async () => {
    const projectId = await seedProject();
    const signal = {
      key: "package-manager",
      kind: "preference",
      projectId,
      scope: "project",
      value: "Use pnpm.",
    };
    const first = crypto.randomUUID();
    const correctionsBefore = (
      await listWorkingPreferences(env.DB, projectId)
    ).some((preference) => preference.key === "package-manager")
      ? 0
      : 1;
    const input = {
      acknowledgedAt: 10,
      checkpointId: first,
      learningSignals: [signal],
      pointContentSha256: "a".repeat(64),
      producerClientId: "client-a",
      projectId,
    };
    expect(
      await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, input),
    ).toEqual({ createdDraftIds: [], observed: 1 });
    expect(
      await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, input),
    ).toEqual({ createdDraftIds: [], observed: 0 });
    await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
      ...input,
      acknowledgedAt: 20,
      checkpointId: crypto.randomUUID(),
      pointContentSha256: "b".repeat(64),
      producerClientId: "client-b",
    });
    const drafts = await listCompoundingDrafts(
      env.DB,
      env.VAULT_STORAGE,
      projectId,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.evidence).toHaveLength(2);
    expect(drafts[0]?.correlationNote).toContain("not proof");
    const accepted = await acceptCompoundingDraft(env.DB, env.VAULT_STORAGE, {
      attachProjectSkill: false,
      draftId: drafts[0]!.draftId,
      idempotencyKey: `m3-accept-package-manager-${projectId}`,
      sourceLabel: "Owner",
      sourceUrl: null,
    });
    expect(accepted.effect).toBe("preference-saved");
    expect(await listWorkingPreferences(env.DB, projectId)).toMatchObject([
      { key: "package-manager", value: "Use pnpm." },
    ]);
    const correctionsForFreshAgent = (
      await listWorkingPreferences(env.DB, projectId)
    ).some(
      (preference) =>
        preference.key === "package-manager" &&
        preference.value === "Use pnpm.",
    )
      ? 0
      : 1;
    expect(correctionsForFreshAgent).toBeLessThan(correctionsBefore);
    expect(
      await acceptCompoundingDraft(env.DB, env.VAULT_STORAGE, {
        attachProjectSkill: false,
        draftId: drafts[0]!.draftId,
        idempotencyKey: `m3-accept-package-manager-${projectId}`,
        sourceLabel: "Owner",
        sourceUrl: null,
      }),
    ).toMatchObject({ replayed: true });
  });

  it("marks competing values, keeps scopes separate, and suppresses ignored/deleted fingerprints", async () => {
    const projectId = await seedProject();
    await observeTwice(
      projectId,
      {
        key: "format",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Markdown",
      },
      "project-markdown",
    );
    await observeTwice(
      projectId,
      {
        key: "format",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Plain text",
      },
      "project-plain",
    );
    await observeTwice(
      projectId,
      {
        key: "format",
        kind: "preference",
        projectId: null,
        scope: "personal",
        value: "Markdown",
      },
      "personal-markdown",
    );
    const drafts = await listCompoundingDrafts(
      env.DB,
      env.VAULT_STORAGE,
      projectId,
    );
    expect(
      drafts.filter(
        (draft) =>
          draft.candidate.kind === "preference" &&
          draft.candidate.projectId === projectId,
      ),
    ).toHaveLength(2);
    expect(drafts.filter((draft) => draft.conflict)).toHaveLength(2);
    const projectDraft = drafts.find(
      (draft) =>
        draft.candidate.kind === "preference" &&
        draft.candidate.projectId === projectId &&
        draft.candidate.value === "Markdown",
    );
    if (projectDraft === undefined) throw new Error("Project draft missing");
    await ignoreCompoundingDraft(env.DB, env.VAULT_STORAGE, {
      draftId: projectDraft.draftId,
      idempotencyKey: "m3-ignore-format",
    });
    await observeTwice(
      projectId,
      {
        key: "format",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Markdown",
      },
      "project-markdown-replay",
    );
    expect(
      (
        await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
      ).filter((draft) => draft.fingerprint === projectDraft.fingerprint),
    ).toHaveLength(1);
  });

  it("denies malformed, oversized, credential-bearing, and cross-project signals", async () => {
    const projectId = await seedProject();
    await expect(
      observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
        acknowledgedAt: 1,
        checkpointId: crypto.randomUUID(),
        learningSignals: Array.from({ length: 5 }, () => ({
          key: "too-many",
          kind: "preference",
          projectId: null,
          scope: "personal",
          value: "value",
        })),
        pointContentSha256: "a".repeat(64),
        producerClientId: "client",
        projectId,
      }),
    ).rejects.toBeInstanceOf(CompoundingProblem);
    await expect(
      observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
        acknowledgedAt: 1,
        checkpointId: crypto.randomUUID(),
        learningSignals: [
          {
            key: "token",
            kind: "preference",
            projectId: null,
            scope: "personal",
            value: `ghp_${"A".repeat(40)}`,
          },
        ],
        pointContentSha256: "a".repeat(64),
        producerClientId: "client",
        projectId,
      }),
    ).rejects.toMatchObject({ code: "signal_invalid" });
    await expect(
      observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
        acknowledgedAt: 1,
        checkpointId: crypto.randomUUID(),
        learningSignals: [
          {
            key: "cross-project",
            kind: "preference",
            projectId: crypto.randomUUID(),
            scope: "project",
            value: "Nope",
          },
        ],
        pointContentSha256: "a".repeat(64),
        producerClientId: "client",
        projectId,
      }),
    ).rejects.toMatchObject({ code: "signal_invalid" });
  });

  it("binds learning signals to a checkpoint and rejects replay injection", async () => {
    const checkpointId = crypto.randomUUID();
    await ensureCompoundingCheckpointBinding(env.DB, {
      checkpointId,
      learningSignalsSha256: "a".repeat(64),
      now: 1,
    });
    await expect(
      ensureCompoundingCheckpointBinding(env.DB, {
        checkpointId,
        learningSignalsSha256: "b".repeat(64),
        now: 2,
      }),
    ).rejects.toMatchObject({ code: "signal_invalid" });
  });

  it("creates an inert standard skill on explicit acceptance", async () => {
    const projectId = await seedProject();
    await observeTwice(
      projectId,
      {
        description: "A compact verification method.",
        instruction: "Run the focused checks and preserve the evidence.",
        kind: "skill",
        name: "compact-verification",
        projectId,
        scope: "project",
      },
      "skill",
    );
    const draft = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).find((candidate) => candidate.candidate.kind === "skill");
    if (draft === undefined) throw new Error("Skill draft missing");
    const accepted = await acceptCompoundingDraft(env.DB, env.VAULT_STORAGE, {
      attachProjectSkill: true,
      draftId: draft.draftId,
      idempotencyKey: "m3-accept-skill",
      sourceLabel: "Owner",
      sourceUrl: null,
    });
    expect(accepted.effect).toBe("skill-saved");
  });

  it("keeps exact delete suppression durable", async () => {
    const projectId = await seedProject();
    await observeTwice(
      projectId,
      {
        key: "delete-me",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Never repeat",
      },
      "delete",
    );
    const draft = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).find(
      (candidate) =>
        candidate.candidate.kind === "preference" &&
        candidate.candidate.key === "delete-me",
    );
    if (draft === undefined) throw new Error("Delete draft missing");
    await deleteCompoundingDraft(env.DB, env.VAULT_STORAGE, {
      draftId: draft.draftId,
      idempotencyKey: "m3-delete-draft",
    });
    expect(
      (await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)).find(
        (candidate) => candidate.draftId === draft.draftId,
      )?.status,
    ).toBe("deleted");
  });

  it("serializes concurrent owner dispositions and leaves no live claim", async () => {
    const projectId = await seedProject();
    await observeTwice(
      projectId,
      {
        key: "concurrent-review",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Keep one owner disposition.",
      },
      "concurrent-review",
    );
    const draft = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).find(
      (candidate) =>
        candidate.candidate.kind === "preference" &&
        candidate.candidate.key === "concurrent-review",
    );
    if (draft === undefined) throw new Error("Concurrent draft missing");

    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = new Proxy(env.VAULT_STORAGE, {
      get(target, property) {
        if (property !== "get") {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<R2Bucket["get"]>) => {
          waiting += 1;
          if (waiting === 2) release();
          await barrier;
          return env.VAULT_STORAGE.get(...args);
        };
      },
    });
    const outcomes = await Promise.allSettled([
      ignoreCompoundingDraft(env.DB, storage, {
        draftId: draft.draftId,
        idempotencyKey: "m3-concurrent-ignore",
      }),
      deleteCompoundingDraft(env.DB, storage, {
        draftId: draft.draftId,
        idempotencyKey: "m3-concurrent-delete",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM compounding_draft_action_claims WHERE draft_id = ?",
      )
        .bind(draft.draftId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM compounding_records
             WHERE draft_id = ? AND record_type IN ('draft-ignored', 'draft-deleted')`,
        )
          .bind(draft.draftId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it("never reports a losing draft identity during concurrent creation", async () => {
    const projectId = await seedProject();
    const signal = {
      key: "concurrent-creation",
      kind: "preference" as const,
      projectId,
      scope: "project" as const,
      value: "Return only a durable draft identity.",
    };
    await observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
      acknowledgedAt: 1,
      checkpointId: crypto.randomUUID(),
      learningSignals: [signal],
      pointContentSha256: "c".repeat(64),
      producerClientId: "creation-first",
      projectId,
    });
    const results = await Promise.all(
      [2, 3].map((acknowledgedAt) =>
        observeCompoundingCheckpoint(env.DB, env.VAULT_STORAGE, {
          acknowledgedAt,
          checkpointId: crypto.randomUUID(),
          learningSignals: [signal],
          pointContentSha256: String(acknowledgedAt).repeat(64),
          producerClientId: `creation-${acknowledgedAt}`,
          projectId,
        }),
      ),
    );
    const drafts = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).filter(
      (candidate) =>
        candidate.candidate.kind === "preference" &&
        candidate.candidate.key === "concurrent-creation",
    );
    expect(drafts).toHaveLength(1);
    const durableIds = new Set(drafts.map((draft) => draft.draftId));
    expect(
      results
        .flatMap((result) => result.createdDraftIds)
        .every((draftId) => durableIds.has(draftId)),
    ).toBe(true);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM compounding_records
           WHERE draft_id = ? AND record_type = 'draft-version'`,
        )
          .bind(drafts[0]!.draftId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it("resumes an exact interrupted claim and recovers an expired different-key claim", async () => {
    const projectId = await seedProject();
    await observeTwice(
      projectId,
      {
        key: "claim-recovery",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Recover without database repair.",
      },
      "claim-recovery",
    );
    const draft = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).find(
      (candidate) =>
        candidate.candidate.kind === "preference" &&
        candidate.candidate.key === "claim-recovery",
    );
    if (draft === undefined) throw new Error("Recovery draft missing");
    const exact = {
      draftId: draft.draftId,
      idempotencyKey: "m3-resume-exact-claim",
    };
    await env.DB.prepare(
      `INSERT INTO compounding_draft_action_claims (
        draft_id, idempotency_key_sha256, operation, input_sha256, created_at
      ) VALUES (?, ?, 'ignore', ?, 1)`,
    )
      .bind(
        draft.draftId,
        await sha256Hex(exact.idempotencyKey),
        await sha256Hex(
          canonicalizeCollaborationJson({ ...exact, operation: "ignore" }),
        ),
      )
      .run();
    expect(
      (await ignoreCompoundingDraft(env.DB, env.VAULT_STORAGE, exact)).draft
        .status,
    ).toBe("ignored");

    await observeTwice(
      projectId,
      {
        key: "expired-claim",
        kind: "preference",
        projectId,
        scope: "project",
        value: "Recover an abandoned different-key claim.",
      },
      "expired-claim",
    );
    const expiredDraft = (
      await listCompoundingDrafts(env.DB, env.VAULT_STORAGE, projectId)
    ).find(
      (candidate) =>
        candidate.candidate.kind === "preference" &&
        candidate.candidate.key === "expired-claim",
    );
    if (expiredDraft === undefined) throw new Error("Expired draft missing");
    await env.DB.prepare(
      `INSERT INTO compounding_draft_action_claims (
        draft_id, idempotency_key_sha256, operation, input_sha256, created_at
      ) VALUES (?, ?, 'delete', ?, 1)`,
    )
      .bind(expiredDraft.draftId, "d".repeat(64), "e".repeat(64))
      .run();
    expect(
      (
        await deleteCompoundingDraft(env.DB, env.VAULT_STORAGE, {
          draftId: expiredDraft.draftId,
          idempotencyKey: "m3-recover-expired-claim",
        })
      ).draft.status,
    ).toBe("deleted");
  });
});
