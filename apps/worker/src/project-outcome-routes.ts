import {
  projectOutcomeResponseSchema,
  vaultIdSchema,
} from "@mdevolved/contracts";
import type { Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { requireOwnerSession } from "./owner-session";
import {
  getProjectOutcome,
  ProjectOutcomeProblem,
} from "./project-outcome-service";
import type { AppBindings } from "./types";

function requiredProjectId(value: string | undefined): string {
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

export function registerProjectOutcomeRoutes(app: Hono<AppBindings>): void {
  app.use("/api/project-outcomes", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });

  app.get("/api/project-outcomes", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const projectId = requiredProjectId(context.req.query("projectId"));
    try {
      const outcome = await getProjectOutcome(context.env.DB, projectId);
      return context.json(
        projectOutcomeResponseSchema.parse({ ok: true, outcome }),
      );
    } catch (error) {
      if (error instanceof ProjectOutcomeProblem) {
        throw new ApiProblem(
          404,
          "project_not_found",
          "The Project outcome is not available.",
        );
      }
      throw error;
    }
  });
}
