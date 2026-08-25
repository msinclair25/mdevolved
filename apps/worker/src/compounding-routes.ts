import {
  compoundingDraftActionRequestSchema,
  compoundingDraftDispositionRequestSchema,
  compoundingDraftListResponseSchema,
  compoundingDraftActionResponseSchema,
  vaultIdSchema,
} from "@owd/contracts";
import type { Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { requireOwnerSession } from "./owner-session";
import { parseJsonBody } from "./security";
import type { AppBindings } from "./types";
import {
  acceptCompoundingDraft,
  CompoundingProblem,
  deleteCompoundingDraft,
  editAndAcceptCompoundingDraft,
  ignoreCompoundingDraft,
  listCompoundingDrafts,
} from "./compounding-service";

const MAX_COMPOUNDING_REQUEST_BYTES = 32 * 1_024;

function projectIdFromQuery(value: string | undefined): string | null {
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

function throwCompoundingProblem(error: unknown): never {
  if (!(error instanceof CompoundingProblem)) throw error;
  const status =
    error.code === "draft_not_found" || error.code === "project_not_active"
      ? 404
      : error.code === "signal_invalid" ||
          error.code === "signal_limit_exceeded"
        ? 400
        : 409;
  const message =
    error.code === "draft_not_found"
      ? "The compounding draft was not found."
      : error.code === "project_not_active"
        ? "The selected Project is not active."
        : error.code === "idempotency_conflict"
          ? "This idempotency key was already used for a different mutation."
          : error.code === "candidate_conflict"
            ? "The edited candidate must keep the draft's kind and scope."
            : error.code === "draft_not_pending"
              ? "This compounding draft has already been reviewed."
              : "The compounding request is invalid.";
  throw new ApiProblem(status, error.code, message);
}

async function ensureDraftVisible(
  db: D1Database,
  storage: R2Bucket,
  draftId: string,
  projectId: string | null,
): Promise<void> {
  const visible = await listCompoundingDrafts(db, storage, projectId);
  if (!visible.some((draft) => draft.draftId === draftId)) {
    throw new ApiProblem(
      404,
      "draft_not_found",
      "The compounding draft was not found.",
    );
  }
}

export function registerCompoundingRoutes(app: Hono<AppBindings>): void {
  app.use("/api/compounding/*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });

  app.get("/api/compounding/drafts", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    try {
      const projectId = projectIdFromQuery(context.req.query("projectId"));
      const drafts = await listCompoundingDrafts(
        context.env.DB,
        context.env.VAULT_STORAGE,
        projectId,
      );
      return context.json(
        compoundingDraftListResponseSchema.parse({ drafts, ok: true }),
      );
    } catch (error) {
      return throwCompoundingProblem(error);
    }
  });

  app.post("/api/compounding/drafts/accept", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = compoundingDraftActionRequestSchema.safeParse(
      await parseJsonBody(context, MAX_COMPOUNDING_REQUEST_BYTES),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "compounding_request_invalid",
        "The compounding draft action is invalid.",
      );
    }
    try {
      const projectId = projectIdFromQuery(context.req.query("projectId"));
      await ensureDraftVisible(
        context.env.DB,
        context.env.VAULT_STORAGE,
        parsed.data.draftId,
        projectId,
      );
      const response =
        parsed.data.editedCandidate === undefined
          ? await acceptCompoundingDraft(
              context.env.DB,
              context.env.VAULT_STORAGE,
              parsed.data,
            )
          : await editAndAcceptCompoundingDraft(
              context.env.DB,
              context.env.VAULT_STORAGE,
              parsed.data as typeof parsed.data & {
                editedCandidate: NonNullable<
                  typeof parsed.data.editedCandidate
                >;
              },
            );
      return context.json(compoundingDraftActionResponseSchema.parse(response));
    } catch (error) {
      return throwCompoundingProblem(error);
    }
  });

  for (const [operation, action] of [
    ["ignore", ignoreCompoundingDraft],
    ["delete", deleteCompoundingDraft],
  ] as const) {
    app.post(`/api/compounding/drafts/${operation}`, async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const parsed = compoundingDraftDispositionRequestSchema.safeParse(
        await parseJsonBody(context, MAX_COMPOUNDING_REQUEST_BYTES),
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "compounding_request_invalid",
          "The compounding draft action is invalid.",
        );
      }
      try {
        const projectId = projectIdFromQuery(context.req.query("projectId"));
        await ensureDraftVisible(
          context.env.DB,
          context.env.VAULT_STORAGE,
          parsed.data.draftId,
          projectId,
        );
        const response = await action(
          context.env.DB,
          context.env.VAULT_STORAGE,
          parsed.data,
        );
        return context.json(
          compoundingDraftActionResponseSchema.parse(response),
        );
      } catch (error) {
        return throwCompoundingProblem(error);
      }
    });
  }
}
