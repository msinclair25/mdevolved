import {
  restoreApplyResponseSchema,
  restoreConfirmationRequestSchema,
  restoreCreateRequestSchema,
  restoreNoteUploadRequestSchema,
  vaultIdSchema,
} from "@owd/contracts";
import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit } from "./auth-store";
import { requireOwnerSession } from "./owner-session";
import {
  RestoreError,
  applyRestoreBatch,
  completeRestorePreview,
  confirmRestore,
  createRestoreJob,
  readRestoreJob,
  readUsableRestoreMaterialization,
  stageRestoreNote,
} from "./restore-store";
import { parseJsonBody, sha256Hex } from "./security";
import type { AppBindings } from "./types";

const restoreIdSchema = z.string().uuid();
const MAX_RESTORE_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_RESTORE_NOTE_REQUEST_BYTES = 6 * 1024 * 1024;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function parseVaultId(context: Context<AppBindings>): string {
  const parsed = vaultIdSchema.safeParse(context.req.param("vaultId"));
  if (!parsed.success) {
    throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
  }
  return parsed.data;
}

function parseRestoreId(context: Context<AppBindings>): string {
  const parsed = restoreIdSchema.safeParse(context.req.param("restoreId"));
  if (!parsed.success) {
    throw new ApiProblem(
      404,
      "restore_not_found",
      "The restore job was not found.",
    );
  }
  return parsed.data;
}

async function enforceRestoreRateLimit(
  context: Context<AppBindings>,
  action: string,
  limit: number,
): Promise<void> {
  const address =
    context.req.header("CF-Connecting-IP") ?? "address-unavailable";
  const allowed = await enforceRateLimit(context.env.DB, {
    action,
    keyHash: await sha256Hex(address),
    limit,
    now: nowSeconds(),
    windowSeconds: 600,
  });
  if (!allowed) {
    throw new ApiProblem(
      429,
      "rate_limited",
      "Too many restore requests. Try again later.",
    );
  }
}

function throwRestoreProblem(error: unknown): never {
  if (!(error instanceof RestoreError)) throw error;
  if (error.code === "restore_not_found") {
    throw new ApiProblem(404, error.code, "The restore job was not found.");
  }
  if (
    error.code === "restore_archive_invalid" ||
    error.code === "restore_incomplete"
  ) {
    throw new ApiProblem(
      400,
      error.code,
      "The decrypted archive is incomplete or does not match its manifest.",
    );
  }
  if (error.code === "restore_target_mismatch") {
    throw new ApiProblem(
      409,
      error.code,
      "The target vault name or active vault does not match.",
    );
  }
  if (error.code === "restore_target_changed") {
    throw new ApiProblem(
      409,
      error.code,
      "The target vault changed after preview. Start a new preview before applying.",
    );
  }
  if (error.code === "restore_state_invalid") {
    throw new ApiProblem(
      409,
      error.code,
      "The restore job is not ready for that operation.",
    );
  }
  throw new ApiProblem(
    503,
    "restore_unavailable",
    "The staged restore could not continue. It can be retried safely.",
  );
}

export function registerRestoreRoutes(app: Hono<AppBindings>): void {
  app.post("/api/vaults/:vaultId/restores", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceRestoreRateLimit(context, "restore-create", 6);
    const parsed = restoreCreateRequestSchema.safeParse(
      await parseJsonBody(context, MAX_RESTORE_MANIFEST_BYTES),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "restore_archive_invalid",
        "The decrypted backup manifest is invalid.",
      );
    }
    try {
      const job = await createRestoreJob(context.env.DB, {
        manifest: parsed.data.manifest,
        now: nowSeconds(),
        requestId: context.get("requestId"),
        targetVaultId: parseVaultId(context),
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(job, 201);
    } catch (error) {
      return throwRestoreProblem(error);
    }
  });

  app.get("/api/restores/:restoreId", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const job = await readRestoreJob(context.env.DB, parseRestoreId(context));
    if (job === null) {
      throw new ApiProblem(
        404,
        "restore_not_found",
        "The restore job was not found.",
      );
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(job);
  });

  app.put("/api/restores/:restoreId/note", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceRestoreRateLimit(context, "restore-stage-note", 2_500);
    const parsed = restoreNoteUploadRequestSchema.safeParse(
      await parseJsonBody(context, MAX_RESTORE_NOTE_REQUEST_BYTES),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "restore_archive_invalid",
        "The staged note does not match the restore manifest.",
      );
    }
    try {
      const job = await stageRestoreNote(
        context.env.DB,
        context.env.VAULT_STORAGE,
        {
          ...parsed.data,
          now: nowSeconds(),
          restoreId: parseRestoreId(context),
        },
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(job);
    } catch (error) {
      return throwRestoreProblem(error);
    }
  });

  app.post("/api/restores/:restoreId/complete", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceRestoreRateLimit(context, "restore-preview", 12);
    const restoreId = parseRestoreId(context);
    const existing = await readRestoreJob(context.env.DB, restoreId);
    if (existing === null) {
      throw new ApiProblem(
        404,
        "restore_not_found",
        "The restore job was not found.",
      );
    }
    if (existing.status === "preview") return context.json(existing);
    if (existing.status !== "staging") {
      return throwRestoreProblem(new RestoreError("restore_state_invalid"));
    }
    let materialization = await readUsableRestoreMaterialization(
      context.env.DB,
      existing,
    );
    if (materialization === null) {
      const queued = await context.env.VAULTS.getByName(
        existing.targetVaultId,
      ).queueMaterialization(
        existing.targetVaultId,
        context.get("requestId"),
        nowSeconds(),
      );
      if (!queued.ok) {
        return throwRestoreProblem(new RestoreError("restore_unavailable"));
      }
      materialization = queued.job;
      if (
        materialization.status === "queued" ||
        materialization.status === "running"
      ) {
        await context.env.DB.prepare(
          `UPDATE restore_jobs SET materialization_job_id = ?, updated_at = ?
           WHERE id = ? AND status = 'staging'
             AND materialization_job_id IS NULL`,
        )
          .bind(materialization.jobId, nowSeconds(), restoreId)
          .run();
      }
    }
    if (
      materialization.status === "queued" ||
      materialization.status === "running"
    ) {
      const pending = await readRestoreJob(context.env.DB, restoreId);
      if (pending === null) {
        return throwRestoreProblem(new RestoreError("restore_not_found"));
      }
      context.header("Cache-Control", "private, no-store");
      return context.json(pending, 202);
    }
    if (
      materialization.status !== "completed" ||
      materialization.generation === null
    ) {
      return throwRestoreProblem(new RestoreError("restore_unavailable"));
    }
    try {
      const preview = await completeRestorePreview(context.env.DB, {
        generationId: materialization.generation.generationId,
        now: nowSeconds(),
        restoreId,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(preview);
    } catch (error) {
      return throwRestoreProblem(error);
    }
  });

  app.post("/api/restores/:restoreId/confirm", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceRestoreRateLimit(context, "restore-confirm", 12);
    const parsed = restoreConfirmationRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "restore_target_mismatch",
        "Type the exact target vault name to confirm this restore.",
      );
    }
    try {
      const job = await confirmRestore(context.env.DB, {
        now: nowSeconds(),
        requestId: context.get("requestId"),
        restoreId: parseRestoreId(context),
        vaultName: parsed.data.vaultName,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(job);
    } catch (error) {
      return throwRestoreProblem(error);
    }
  });

  app.post("/api/restores/:restoreId/apply", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceRestoreRateLimit(context, "restore-apply", 240);
    try {
      const result = await applyRestoreBatch(
        context.env.DB,
        context.env.VAULT_STORAGE,
        context.env.VAULTS,
        {
          now: nowSeconds(),
          requestId: context.get("requestId"),
          restoreId: parseRestoreId(context),
        },
      );
      restoreApplyResponseSchema.parse(result);
      context.header("Cache-Control", "private, no-store");
      return context.json(result);
    } catch (error) {
      return throwRestoreProblem(error);
    }
  });
}
