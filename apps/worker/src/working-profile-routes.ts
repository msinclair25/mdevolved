import {
  agentSkillImportResponseSchema,
  agentSkillListResponseSchema,
  deleteAgentSkillRequestSchema,
  deleteWorkingPreferenceRequestSchema,
  importAgentSkillRequestSchema,
  projectSkillMutationRequestSchema,
  projectSkillAttachmentListResponseSchema,
  projectSkillMutationResponseSchema,
  saveWorkingPreferenceRequestSchema,
  vaultIdSchema,
  workingPreferenceListResponseSchema,
  workingPreferenceMutationResponseSchema,
  workingProfileDeleteResponseSchema,
} from "@mdevolved/contracts";
import type { Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { requireOwnerSession } from "./owner-session";
import { parseJsonBody } from "./security";
import type { AppBindings } from "./types";
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
} from "./working-profile-service";

const MAX_SKILL_IMPORT_JSON_BYTES = 400 * 1_024;

function throwWorkingProfileProblem(error: unknown): never {
  if (!(error instanceof WorkingProfileProblem)) throw error;
  const status =
    error.code === "preference_not_found" || error.code === "skill_not_found"
      ? 404
      : error.code === "skill_package_too_large"
        ? 413
        : error.code === "skill_package_invalid"
          ? 400
          : 409;
  throw new ApiProblem(
    status,
    error.code,
    status === 404
      ? "The working-profile item was not found."
      : status === 413
        ? "The Agent Skills package is too large."
        : status === 400
          ? "The Agent Skills package is invalid or contains unsafe content."
          : error.code === "project_not_active"
            ? "The selected Project is not active."
            : error.code === "idempotency_conflict"
              ? "This idempotency key was already used for a different mutation."
              : error.code === "project_skill_limit_exceeded"
                ? "This Project or skill has reached its attachment limit."
                : "The working-profile mutation conflicts with current state.",
  );
}

function parseProjectId(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  const parsed = vaultIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiProblem(
      400,
      "project_id_invalid",
      "The Project identifier is invalid.",
    );
  }
  return parsed.data;
}

export function registerWorkingProfileRoutes(app: Hono<AppBindings>): void {
  app.use("/api/working-profile/*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });

  app.get("/api/working-profile/preferences", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    try {
      const projectId = parseProjectId(context.req.query("projectId"));
      const preferences = await listWorkingPreferences(
        context.env.DB,
        projectId,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(
        workingPreferenceListResponseSchema.parse({
          ok: true,
          preferences,
          projectId,
        }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.post("/api/working-profile/preferences", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = saveWorkingPreferenceRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "preference_invalid",
        "The preference is invalid.",
      );
    }
    try {
      const preference = await saveWorkingPreference(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(
        workingPreferenceMutationResponseSchema.parse({ ok: true, preference }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.post("/api/working-profile/preferences/delete", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = deleteWorkingPreferenceRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "preference_invalid",
        "The preference deletion is invalid.",
      );
    }
    try {
      const response = await deleteWorkingPreference(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(
        workingProfileDeleteResponseSchema.parse({ ok: true, ...response }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.get("/api/working-profile/skills", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const skills = await listAgentSkills(context.env.DB);
    context.header("Cache-Control", "private, no-store");
    return context.json(
      agentSkillListResponseSchema.parse({ ok: true, skills }),
    );
  });

  app.get("/api/working-profile/skills/attachments", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const projectId = parseProjectId(context.req.query("projectId"));
    if (projectId === null) {
      throw new ApiProblem(
        400,
        "project_id_invalid",
        "The Project identifier is invalid.",
      );
    }
    try {
      const attachments = await listProjectSkillAttachments(
        context.env.DB,
        context.env.VAULT_STORAGE,
        projectId,
      );
      return context.json(
        projectSkillAttachmentListResponseSchema.parse({
          attachments,
          ok: true,
          projectId,
        }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.post("/api/working-profile/skills/import", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = importAgentSkillRequestSchema.safeParse(
      await parseJsonBody(context, MAX_SKILL_IMPORT_JSON_BYTES),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "skill_package_invalid",
        "The Agent Skills package is invalid.",
      );
    }
    try {
      const skill = await importAgentSkill(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(
        agentSkillImportResponseSchema.parse({ ok: true, skill }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.get("/api/working-profile/skills/export", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const parsed = vaultIdSchema.safeParse(context.req.query("skillId"));
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "skill_id_invalid",
        "The skill identifier is invalid.",
      );
    }
    try {
      const response = await exportAgentSkill(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(response);
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  app.post("/api/working-profile/skills/delete", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = deleteAgentSkillRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "skill_delete_invalid",
        "The skill deletion is invalid.",
      );
    }
    try {
      const response = await deleteAgentSkill(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(
        workingProfileDeleteResponseSchema.parse({ ok: true, ...response }),
      );
    } catch (error) {
      return throwWorkingProfileProblem(error);
    }
  });

  for (const [path, attach] of [
    ["/api/working-profile/skills/attach", true],
    ["/api/working-profile/skills/detach", false],
  ] as const) {
    app.post(path, async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const parsed = projectSkillMutationRequestSchema.safeParse(
        await parseJsonBody(context),
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "skill_attachment_invalid",
          "The skill attachment is invalid.",
        );
      }
      try {
        const response = await mutateProjectSkill(
          context.env.DB,
          context.env.VAULT_STORAGE,
          parsed.data,
          attach,
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(
          projectSkillMutationResponseSchema.parse({ ok: true, ...response }),
        );
      } catch (error) {
        return throwWorkingProfileProblem(error);
      }
    });
  }
}
