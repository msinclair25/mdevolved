import {
  materializedNoteReadRequestSchema,
  markdownNoteWriteRequestSchema,
  vaultIdSchema,
  type MarkdownNoteWriteResponse,
} from "@owd/contracts";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit } from "./auth-store";
import { MAX_MATERIALIZED_NOTE_BYTES } from "./materialization-snapshot";
import { requireOwnerSession } from "./owner-session";
import { parseJsonBody, sha256Hex } from "./security";
import type { AppBindings } from "./types";
import type { VaultContentFailureCode } from "./vault-content";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

const encoder = new TextEncoder();
// JSON escaping can expand one valid content byte to six ASCII bytes (for
// example, a control character encoded as `\u0000`). The canonical note limit
// is still enforced on decoded UTF-8 immediately after parsing.
const MAX_NOTE_WRITE_REQUEST_BYTES = MAX_MATERIALIZED_NOTE_BYTES * 6 + 4_096;

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

function parsePath(rawPath: string): string {
  try {
    return validateMarkdownVaultPath(rawPath).path;
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new ApiProblem(404, "note_not_found", "The note was not found.");
    }
    throw error;
  }
}

async function enforceContentRateLimit(
  context: Context<AppBindings>,
  action: string,
  vaultId: string,
  limit: number,
): Promise<void> {
  const address =
    context.req.header("CF-Connecting-IP") ?? "address-unavailable";
  const allowed = await enforceRateLimit(context.env.DB, {
    action,
    keyHash: await sha256Hex(`${address}:${vaultId}`),
    limit,
    now: nowSeconds(),
    windowSeconds: 600,
  });
  if (!allowed) {
    throw new ApiProblem(
      429,
      "rate_limited",
      "Too many live note requests. Try again later.",
    );
  }
}

function throwContentProblem(code: VaultContentFailureCode): never {
  switch (code) {
    case "vault_not_active":
      throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
    case "note_not_found":
      throw new ApiProblem(404, code, "The live note was not found.");
    case "vault_path_invalid":
      throw new ApiProblem(
        400,
        code,
        "Use a valid vault-relative Markdown path outside .obsidian.",
      );
    case "note_stale":
      throw new ApiProblem(
        409,
        code,
        "This note changed after the editor loaded. Reload the live note before saving.",
      );
    case "note_exists":
      throw new ApiProblem(
        409,
        code,
        "A live note already exists at that path. No content was overwritten.",
      );
    case "note_tombstoned":
      throw new ApiProblem(
        409,
        code,
        "That path has a deletion record. Create the note at a different path.",
      );
    case "snapshot_schema_unsupported":
      throw new ApiProblem(
        426,
        code,
        "Update OWD Sync and reconnect this vault before editing from the web.",
      );
    case "note_too_large":
    case "generation_too_large":
      throw new ApiProblem(
        413,
        code,
        "This write is larger than the current live-editing safety limit.",
      );
    case "snapshot_invalid":
    case "vault_path_collision":
      throw new ApiProblem(
        409,
        code,
        "The vault contains a sync or path conflict that must be resolved before web editing.",
      );
    case "vault_busy":
      throw new ApiProblem(
        503,
        code,
        "The live vault is changing quickly. Try this request again.",
      );
    case "vault_persistence_unavailable":
      throw new ApiProblem(
        503,
        code,
        "The write was not acknowledged because durable storage could not be confirmed. Reload before retrying.",
      );
  }
}

function scheduleProjectionAndAudit(
  context: Context<AppBindings>,
  vaultId: string,
  operation: "created" | "updated",
): void {
  const requestId = context.get("requestId");
  const now = nowSeconds();
  const audit = context.env.DB.prepare(
    `INSERT INTO audit_events (id, event_type, request_id, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      operation === "created" ? "vault.note_created" : "vault.note_updated",
      requestId,
      now,
    )
    .run();
  const projection = context.env.VAULTS.getByName(vaultId).queueMaterialization(
    vaultId,
    requestId,
    now,
  );

  context.executionCtx.waitUntil(
    Promise.allSettled([audit, projection] as const).then((results) => {
      const projectionResult = results[1];
      if (
        results[0]?.status === "rejected" ||
        projectionResult?.status === "rejected" ||
        (projectionResult?.status === "fulfilled" && !projectionResult.value.ok)
      ) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "vault.note_projection_or_audit_failed",
            operation,
            requestId,
            vaultId,
          }),
        );
      }
    }),
  );
}

export function registerContentRoutes(app: Hono<AppBindings>): void {
  app.post("/api/vaults/:vaultId/live-note", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const vaultId = parseVaultId(context);
    await enforceContentRateLimit(context, "live-note-read", vaultId, 240);
    const request = materializedNoteReadRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(404, "note_not_found", "The note was not found.");
    }
    const result = await context.env.VAULTS.getByName(vaultId).readMarkdownNote(
      vaultId,
      parsePath(request.data.path),
    );
    if (!result.ok) throwContentProblem(result.code);

    context.header("Cache-Control", "private, no-store");
    return context.json(result.note);
  });

  app.put("/api/vaults/:vaultId/live-note", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const vaultId = parseVaultId(context);
    await enforceContentRateLimit(context, "live-note-write", vaultId, 120);
    const parsed = markdownNoteWriteRequestSchema.safeParse(
      await parseJsonBody(context, MAX_NOTE_WRITE_REQUEST_BYTES),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "note_write_invalid",
        "The note path, content, or expected version is invalid.",
      );
    }
    if (
      encoder.encode(parsed.data.content).byteLength >
      MAX_MATERIALIZED_NOTE_BYTES
    ) {
      throw new ApiProblem(
        413,
        "note_too_large",
        "This note is larger than the current live-editing safety limit.",
      );
    }

    const result = await context.env.VAULTS.getByName(
      vaultId,
    ).writeMarkdownNote(vaultId, parsed.data, Date.now());
    if (!result.ok) throwContentProblem(result.code);

    scheduleProjectionAndAudit(context, vaultId, result.operation);
    const response: MarkdownNoteWriteResponse = {
      durable: true,
      note: result.note,
      operation: result.operation,
      projectionScheduled: true,
    };
    context.header("Cache-Control", "private, no-store");
    return context.json(response, result.operation === "created" ? 201 : 200);
  });
}
