import {
  materializedNoteReadRequestSchema,
  materializedNotesRequestSchema,
  materializedSearchRequestSchema,
  materializationJobSchema,
  noteCursorSchema,
  vaultIdSchema,
  type CurrentMaterializationResponse,
  type MaterializedNotesResponse,
  type MaterializedSearchResponse,
} from "@owd/contracts";
import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit } from "./auth-store";
import {
  listMaterializedNotes,
  readCurrentMaterialization,
  readMaterializedNote,
  searchMaterializedNotes,
} from "./materialization-store";
import { readMaterializationJob } from "./materialization-job";
import { buildMaterializedFtsQuery } from "./materialization-query";
import { requireOwnerSession } from "./owner-session";
import {
  decodeBase64Url,
  encodeBase64Url,
  parseJsonBody,
  sha256Hex,
} from "./security";
import type { AppBindings } from "./types";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const LIST_LIMIT = 100;
const SEARCH_LIMIT = 50;
const jobIdSchema = z.string().uuid();

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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

async function enforceMaterializationRateLimit(
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
      "Too many vault requests. Try again later.",
    );
  }
}

function decodeCursor(raw: string | null): string | null {
  if (raw === null) return null;
  const parsed = noteCursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiProblem(400, "cursor_invalid", "The note cursor is invalid.");
  }
  try {
    const decoded = decoder.decode(decodeBase64Url(parsed.data));
    if (decoded.length === 0 || decoded.length > 1_024) throw new Error();
    return decoded;
  } catch {
    throw new ApiProblem(400, "cursor_invalid", "The note cursor is invalid.");
  }
}

function encodeCursor(value: string | null): string | null {
  return value === null ? null : encodeBase64Url(encoder.encode(value));
}

async function requireCurrentGeneration(
  context: Context<AppBindings>,
  vaultId: string,
) {
  const generation = await readCurrentMaterialization(context.env.DB, vaultId);
  if (generation === null) {
    throw new ApiProblem(
      404,
      "materialization_not_found",
      "MDevolved has not published this active vault's searchable library yet.",
    );
  }
  return generation;
}

export function registerMaterializationRoutes(app: Hono<AppBindings>): void {
  app.post("/api/vaults/:vaultId/materializations", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceMaterializationRateLimit(context, "materialize", 30);
    const vaultId = parseVaultId(context);
    const result = await context.env.VAULTS.getByName(
      vaultId,
    ).queueMaterialization(vaultId, context.get("requestId"), nowSeconds());

    if (!result.ok) {
      if (
        result.code === "generation_too_large" ||
        result.code === "note_too_large"
      ) {
        throw new ApiProblem(
          413,
          result.code,
          "This vault library is larger than the current safety limit.",
        );
      }
      if (
        result.code === "vault_path_invalid" ||
        result.code === "vault_path_collision" ||
        result.code === "snapshot_invalid" ||
        result.code === "snapshot_schema_unsupported"
      ) {
        throw new ApiProblem(
          409,
          result.code,
          "The vault contains a path or sync record that cannot be materialized safely.",
        );
      }
      throw new ApiProblem(
        503,
        "materialization_unavailable",
        "The searchable library could not be completed. The previous library is unchanged.",
      );
    }

    context.header("Cache-Control", "no-store");
    return context.json(
      materializationJobSchema.parse(result.job),
      result.job.status === "completed" ? 200 : 202,
    );
  });

  app.get("/api/vaults/:vaultId/materializations/:jobId", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const vaultId = parseVaultId(context);
    const jobId = jobIdSchema.safeParse(context.req.param("jobId"));
    if (!jobId.success) {
      throw new ApiProblem(
        404,
        "materialization_job_not_found",
        "The library build was not found.",
      );
    }
    const job = await readMaterializationJob(
      context.env.DB,
      vaultId,
      jobId.data,
    );
    if (job === null) {
      throw new ApiProblem(
        404,
        "materialization_job_not_found",
        "The library build was not found.",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(materializationJobSchema.parse(job));
  });

  app.get("/api/vaults/:vaultId/materialization", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response: CurrentMaterializationResponse = {
      generation: await readCurrentMaterialization(
        context.env.DB,
        parseVaultId(context),
      ),
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/vaults/:vaultId/notes", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const request = materializedNotesRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(
        400,
        "cursor_invalid",
        "The note cursor is invalid.",
      );
    }
    const vaultId = parseVaultId(context);
    const generation = await requireCurrentGeneration(context, vaultId);
    const page = await listMaterializedNotes(
      context.env.DB,
      generation.generationId,
      vaultId,
      decodeCursor(request.data.cursor),
      LIST_LIMIT,
    );
    const response: MaterializedNotesResponse = {
      generation,
      nextCursor: encodeCursor(page.nextPathKey),
      notes: page.notes,
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/vaults/:vaultId/search", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    await enforceMaterializationRateLimit(context, "search", 120);
    const request = materializedSearchRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(
        400,
        "search_invalid",
        "Enter a valid search query.",
      );
    }
    const vaultId = parseVaultId(context);
    const generation = await requireCurrentGeneration(context, vaultId);
    const response: MaterializedSearchResponse = {
      generation,
      results: await searchMaterializedNotes(
        context.env.DB,
        generation.generationId,
        vaultId,
        buildMaterializedFtsQuery(request.data.query),
        SEARCH_LIMIT,
      ),
    };
    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/vaults/:vaultId/note", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const request = materializedNoteReadRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(404, "note_not_found", "The note was not found.");
    }
    const vaultId = parseVaultId(context);
    const generation = await requireCurrentGeneration(context, vaultId);
    let pathKey: string;
    try {
      pathKey = validateMarkdownVaultPath(request.data.path).pathKey;
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new ApiProblem(404, "note_not_found", "The note was not found.");
      }
      throw error;
    }
    const note = await readMaterializedNote(
      context.env.DB,
      generation.generationId,
      vaultId,
      pathKey,
    );
    if (note === null) {
      throw new ApiProblem(404, "note_not_found", "The note was not found.");
    }
    const object = await context.env.VAULT_STORAGE.get(note.r2_key);
    if (
      object === null ||
      object.size !== note.byte_length ||
      object.checksums.sha256 === undefined ||
      bytesToHex(object.checksums.sha256) !== note.content_sha256
    ) {
      throw new ApiProblem(
        503,
        "materialization_unavailable",
        "The note mirror is temporarily unavailable.",
      );
    }

    context.header("Cache-Control", "private, no-store");
    context.header("Content-Type", "text/markdown; charset=utf-8");
    context.header("Content-Disposition", 'inline; filename="note.md"');
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-OWD-Generation", generation.generationId);
    return context.body(object.body);
  });
}
