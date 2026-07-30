import {
  MAX_SUBMISSION_BYTES,
  collaborationConnectionListResponseSchema,
  collaborationParticipantClaimsResponseSchema,
  collaborationNotebookProjectionSchema,
  collaborationProjectAgentVisibilityRequestSchema,
  collaborationProjectArchiveRequestSchema,
  collaborationRestoreConfirmRequestSchema,
  collaborationRestoreCreateRequestSchema,
  collaborationRestoreItemRequestSchema,
  collaborationSubmissionImportSchema,
  collaborationTimelinePageRequestSchema,
  collaborationTimelinePageResponseSchema,
  collaborationWorkItemReopenRequestSchema,
  portableWorkPacketBundleSchema,
} from "@owd/contracts";
import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { projectDecisionToNotebook } from "./collaboration-projection";
import {
  MAX_COLLABORATION_RESTORE_MANIFEST_BYTES,
  applyCollaborationRestore,
  createCollaborationRestore,
  stageCollaborationRestoreItem,
} from "./collaboration-restore";
import {
  CollaborationProblem,
  applyOwnerRecordAction,
  buildPortableWorkPacket,
  createCollaborationProject,
  createContinuationWorkPacket,
  createOwnerDecision,
  getCollaborationDashboard,
  readArtifactBody,
  submitCollaborationRecord,
} from "./collaboration-service";
import {
  listCollaborationConnections,
  readCollaborationParticipantClaims,
  readCollaborationTimelinePage,
  revokeAllCollaborationGrants,
  revokeCollaborationGrant,
  setCollaborationProjectAgentVisibility,
  setCollaborationProjectArchived,
  setCollaborationWorkItemReopened,
} from "./collaboration-store";
import { requireOwnerSession } from "./owner-session";
import { parseJsonBody } from "./security";
import type { AppBindings } from "./types";

const idSchema = z.string().uuid();
const MAX_COLLABORATION_IMPORT_REQUEST_BYTES =
  MAX_SUBMISSION_BYTES + 256 * 1024;
const MAX_COLLABORATION_RESTORE_ITEM_REQUEST_BYTES =
  Math.ceil((MAX_SUBMISSION_BYTES * 4) / 3) + 2_048;
const MAX_COLLABORATION_RESTORE_MANIFEST_REQUEST_BYTES =
  MAX_COLLABORATION_RESTORE_MANIFEST_BYTES + 2_048;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function idParameter(
  context: Context<AppBindings>,
  name: string,
  code: string,
): string {
  const parsed = idSchema.safeParse(context.req.param(name));
  if (!parsed.success) {
    throw new ApiProblem(404, code, "The collaboration record was not found.");
  }
  return parsed.data;
}

export function throwCollaborationProblem(error: unknown): never {
  if (!(error instanceof CollaborationProblem)) throw error;
  if (
    error.code === "record_not_visible" ||
    error.code === "artifact_not_visible" ||
    error.code === "project_reference_invalid"
  ) {
    throw new ApiProblem(
      404,
      error.code,
      "The collaboration record was not found.",
    );
  }
  if (
    error.code === "submission_too_large" ||
    error.code === "content_policy_denied"
  ) {
    throw new ApiProblem(
      413,
      error.code,
      "The collaboration submission exceeds a bounded contract limit.",
    );
  }
  if (
    error.code === "collaboration_grant_revoked" ||
    error.code === "collaboration_scope_required" ||
    error.code === "authorization_context_invalid" ||
    error.code === "owner_authority_required"
  ) {
    throw new ApiProblem(
      403,
      error.code,
      "This request is not authorized for the collaboration operation.",
    );
  }
  throw new ApiProblem(
    409,
    error.code,
    "The collaboration operation conflicts with the current durable state.",
  );
}

export function registerCollaborationRoutes(app: Hono<AppBindings>): void {
  app.get("/api/collaboration/dashboard", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response = await getCollaborationDashboard(
      context.env.DB,
      context.env.VAULT_STORAGE,
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  app.post("/api/collaboration/timeline", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const request = collaborationTimelinePageRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(
        400,
        "collaboration_cursor_invalid",
        "The collaboration timeline cursor is invalid.",
      );
    }
    try {
      const response = collaborationTimelinePageResponseSchema.parse(
        await readCollaborationTimelinePage(context.env.DB, request.data),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(response);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "collaboration_cursor_invalid"
      ) {
        throw new ApiProblem(
          400,
          "collaboration_cursor_invalid",
          "The collaboration timeline cursor is invalid.",
        );
      }
      throw error;
    }
  });

  app.post(
    "/api/collaboration/participants/:grantId/claims",
    async (context) => {
      await requireOwnerSession(context, { csrf: false });
      const labels = await readCollaborationParticipantClaims(
        context.env.DB,
        context.env.VAULT_STORAGE,
        idParameter(context, "grantId", "collaboration_grant_not_found"),
      );
      if (labels === null) {
        throw new ApiProblem(
          404,
          "collaboration_grant_not_found",
          "The collaboration participant was not found.",
        );
      }
      const response = collaborationParticipantClaimsResponseSchema.parse({
        claimedIdentityLabels: labels,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(response);
    },
  );

  app.get("/api/collaboration/connections", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response = collaborationConnectionListResponseSchema.parse({
      connections: await listCollaborationConnections(context.env.DB),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  app.post("/api/collaboration/connections/revoke-all", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await revokeAllCollaborationGrants(context.env.DB, nowSeconds());
    return context.body(null, 204);
  });

  app.post(
    "/api/collaboration/connections/:grantId/revoke",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const grantId = idParameter(
        context,
        "grantId",
        "collaboration_grant_revoked",
      );
      if (
        !(await revokeCollaborationGrant(context.env.DB, {
          grantId,
          now: nowSeconds(),
        }))
      ) {
        throw new ApiProblem(
          404,
          "collaboration_grant_revoked",
          "The Project connection was not found.",
        );
      }
      return context.body(null, 204);
    },
  );

  app.post("/api/collaboration/projects", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    try {
      const created = await createCollaborationProject(
        context.env.DB,
        context.env.VAULT_STORAGE,
        await parseJsonBody(context),
        nowSeconds(),
        context.get("requestId"),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(created, 201);
    } catch (error) {
      return throwCollaborationProblem(error);
    }
  });

  app.post(
    "/api/collaboration/projects/:projectId/packets",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      try {
        const packet = await createContinuationWorkPacket(
          context.env.DB,
          context.env.VAULT_STORAGE,
          idParameter(context, "projectId", "project_reference_invalid"),
          await parseJsonBody(context),
          nowSeconds(),
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(packet, 201);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/agent-visibility",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const request =
        collaborationProjectAgentVisibilityRequestSchema.safeParse(
          await parseJsonBody(context, 4_096),
        );
      if (!request.success) {
        throw new ApiProblem(
          400,
          "project_visibility_invalid",
          "Choose whether agents may discover this exact Project.",
        );
      }
      const projectId = idParameter(
        context,
        "projectId",
        "project_reference_invalid",
      );
      if (
        !(await setCollaborationProjectAgentVisibility(context.env.DB, {
          now: nowSeconds(),
          projectId,
          reason: request.data.reason,
          requestId: context.get("requestId"),
          visibility: request.data.visibility,
        }))
      ) {
        throw new ApiProblem(
          404,
          "project_reference_invalid",
          "The selected Project was not found.",
        );
      }
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/archive",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const request = collaborationProjectArchiveRequestSchema.safeParse(
        await parseJsonBody(context, 4_096),
      );
      if (!request.success) {
        throw new ApiProblem(
          400,
          "project_archive_invalid",
          "Confirm whether this exact Project should be archived.",
        );
      }
      const projectId = idParameter(
        context,
        "projectId",
        "project_reference_invalid",
      );
      if (
        !(await setCollaborationProjectArchived(context.env.DB, {
          archived: request.data.archived,
          now: nowSeconds(),
          projectId,
          reason: request.data.reason,
          requestId: context.get("requestId"),
        }))
      ) {
        throw new ApiProblem(
          404,
          "project_reference_invalid",
          "The selected Project was not found.",
        );
      }
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/work-items/:workItemId/reopen",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const request = collaborationWorkItemReopenRequestSchema.safeParse(
        await parseJsonBody(context, 4_096),
      );
      if (!request.success) {
        throw new ApiProblem(
          400,
          "work_item_reopen_invalid",
          "Confirm why this exact Work Item should be reopened.",
        );
      }
      const projectId = idParameter(
        context,
        "projectId",
        "project_reference_invalid",
      );
      const workItemId = idParameter(
        context,
        "workItemId",
        "project_reference_invalid",
      );
      if (
        !(await setCollaborationWorkItemReopened(context.env.DB, {
          now: nowSeconds(),
          projectId,
          reason: request.data.reason,
          requestId: context.get("requestId"),
          workItemId,
        }))
      ) {
        throw new ApiProblem(
          409,
          "work_item_reopen_invalid",
          "This Work Item is not a closed Work Item on the active Project.",
        );
      }
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/records/:recordId/actions",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      try {
        const event = await applyOwnerRecordAction(
          context.env.DB,
          context.env.VAULT_STORAGE,
          idParameter(context, "projectId", "project_reference_invalid"),
          await parseJsonBody(context),
          nowSeconds(),
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(event, 201);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/decisions",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      try {
        const decision = await createOwnerDecision(
          context.env.DB,
          context.env.VAULT_STORAGE,
          idParameter(context, "projectId", "project_reference_invalid"),
          await parseJsonBody(context),
          nowSeconds(),
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(decision, 201);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );

  app.post("/api/collaboration/submissions/import", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = collaborationSubmissionImportSchema.safeParse(
      await parseJsonBody(context, MAX_COLLABORATION_IMPORT_REQUEST_BYTES),
    );
    if (
      !parsed.success ||
      parsed.data.submission.authorizationContext.mode !== "owner-import"
    ) {
      throw new ApiProblem(
        400,
        "submission_invalid",
        "Choose one valid owner-import submission envelope.",
      );
    }
    try {
      const receipt = await submitCollaborationRecord(
        context.env.DB,
        context.env.VAULT_STORAGE,
        {
          artifactBody: parsed.data.artifactBody,
          now: nowSeconds(),
          rawSubmission: parsed.data.submission,
        },
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(receipt, 201);
    } catch (error) {
      return throwCollaborationProblem(error);
    }
  });

  app.get(
    "/api/collaboration/work-packets/:packetId/portable",
    async (context) => {
      await requireOwnerSession(context, { csrf: false });
      try {
        const bundle = portableWorkPacketBundleSchema.parse(
          await buildPortableWorkPacket(
            context.env.DB,
            context.env.VAULT_STORAGE,
            idParameter(context, "packetId", "project_reference_invalid"),
          ),
        );
        context.header("Cache-Control", "private, no-store");
        context.header(
          "Content-Disposition",
          `attachment; filename="owd-work-packet-${bundle.packetId}.json"`,
        );
        return context.json(bundle);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );

  app.get(
    "/api/collaboration/artifacts/:artifactId/content",
    async (context) => {
      await requireOwnerSession(context, { csrf: false });
      const result = await readArtifactBody(
        context.env.DB,
        context.env.VAULT_STORAGE,
        idParameter(context, "artifactId", "record_not_visible"),
      );
      if (result === null) {
        throw new ApiProblem(
          404,
          "record_not_visible",
          "The collaboration record was not found.",
        );
      }
      context.header("Cache-Control", "private, no-store");
      context.header(
        "Content-Type",
        result.artifact.content.kind === "stored-object"
          ? result.artifact.content.mediaType
          : "application/octet-stream",
      );
      return context.body(new Uint8Array(result.body).buffer);
    },
  );

  app.post(
    "/api/collaboration/projects/:projectId/records/:recordId/project",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      try {
        const projection = collaborationNotebookProjectionSchema.parse(
          await projectDecisionToNotebook(
            context.env.DB,
            context.env.VAULT_STORAGE,
            {
              async create(input) {
                const result = await context.env.VAULTS.getByName(
                  input.vaultId,
                ).writeMarkdownNote(
                  input.vaultId,
                  {
                    content: input.content,
                    expectedVersion: null,
                    path: input.path,
                  },
                  Date.now(),
                );
                return result.ok
                  ? { contentVersion: result.note.contentVersion, ok: true }
                  : { code: result.code, ok: false };
              },
            },
            {
              now: nowSeconds(),
              projectId: idParameter(
                context,
                "projectId",
                "project_reference_invalid",
              ),
              rawRequest: await parseJsonBody(context),
              recordId: idParameter(context, "recordId", "record_not_visible"),
              requestId: context.get("requestId"),
            },
          ),
        );
        context.executionCtx.waitUntil(
          context.env.VAULTS.getByName(projection.vaultId).queueMaterialization(
            projection.vaultId,
            context.get("requestId"),
            nowSeconds(),
          ),
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(projection, 201);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );

  app.post("/api/collaboration/restores", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const body = await parseJsonBody(
      context,
      MAX_COLLABORATION_RESTORE_MANIFEST_REQUEST_BYTES,
    );
    if (!collaborationRestoreCreateRequestSchema.safeParse(body).success) {
      throw new ApiProblem(
        400,
        "snapshot_selection_invalid",
        "Choose an Approved or Approved-and-Unvetted intelligence manifest.",
      );
    }
    try {
      const job = await createCollaborationRestore(
        context.env.DB,
        body,
        nowSeconds(),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(job, 201);
    } catch (error) {
      return throwCollaborationProblem(error);
    }
  });

  app.post("/api/collaboration/restores/:restoreId/items", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const body = await parseJsonBody(
      context,
      MAX_COLLABORATION_RESTORE_ITEM_REQUEST_BYTES,
    );
    if (!collaborationRestoreItemRequestSchema.safeParse(body).success) {
      throw new ApiProblem(
        400,
        "submission_invalid",
        "The staged intelligence object is invalid.",
      );
    }
    try {
      const job = await stageCollaborationRestoreItem(
        context.env.DB,
        context.env.VAULT_STORAGE,
        idParameter(context, "restoreId", "project_reference_invalid"),
        body,
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(job);
    } catch (error) {
      return throwCollaborationProblem(error);
    }
  });

  app.post(
    "/api/collaboration/restores/:restoreId/confirm",
    async (context) => {
      await requireOwnerSession(context, { csrf: true });
      const parsed = collaborationRestoreConfirmRequestSchema.safeParse(
        await parseJsonBody(context),
      );
      if (!parsed.success) {
        throw new ApiProblem(
          400,
          "restore_authority_forbidden",
          "Type the exact restore confirmation before applying portable intelligence.",
        );
      }
      try {
        const result = await applyCollaborationRestore(
          context.env.DB,
          context.env.VAULT_STORAGE,
          idParameter(context, "restoreId", "project_reference_invalid"),
          nowSeconds(),
        );
        context.header("Cache-Control", "private, no-store");
        return context.json(result);
      } catch (error) {
        return throwCollaborationProblem(error);
      }
    },
  );
}
