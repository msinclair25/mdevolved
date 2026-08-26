import {
  MAX_SNAPSHOT_VAULTS,
  snapshotArchiveRequestSchema,
  snapshotCreateRequestSchema,
  snapshotEstimateSchema,
  snapshotListResponseSchema,
  snapshotPinRequestSchema,
  snapshotRepairResponseSchema,
  snapshotRetentionPolicyRequestSchema,
  snapshotRetentionPolicySchema,
  snapshotRetentionRunSchema,
  snapshotSummarySchema,
  type VaultSummary,
} from "@owd/contracts";
import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit } from "./auth-store";
import { readUsableMaterialization } from "./materialization-store";
import { requireOwnerSession } from "./owner-session";
import { readVaultSourceDescriptor } from "./pairing-store";
import { listSourceDevices } from "./source-device-service";
import { parseJsonBody, sha256Hex } from "./security";
import {
  enforceSnapshotRetention,
  readSnapshotRetentionPolicy,
  runSnapshotGarbageCollection,
  updateSnapshotRetentionPolicy,
} from "./snapshot-retention";
import {
  SnapshotError,
  buildPortableSnapshotExport,
  cancelWorkspaceSnapshot,
  continueWorkspaceSnapshot,
  createPortableSnapshotStream,
  estimateWorkspaceSnapshot,
  listWorkspaceSnapshots,
  readWorkspaceSnapshot,
  repairWorkspaceSnapshot,
  setWorkspaceSnapshotArchived,
  setWorkspaceSnapshotPinned,
  startWorkspaceSnapshot,
  type SnapshotCaptureSource,
} from "./snapshot-store";
import type { AppBindings } from "./types";

const snapshotIdSchema = z.string().uuid();
const repairCursorSchema = z.string().uuid();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function parseSnapshotId(context: Context<AppBindings>): string {
  const parsed = snapshotIdSchema.safeParse(context.req.param("snapshotId"));
  if (!parsed.success) {
    throw new ApiProblem(
      404,
      "snapshot_not_found",
      "The snapshot was not found.",
    );
  }
  return parsed.data;
}

async function enforceSnapshotRateLimit(
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
      "Too many snapshot requests. Try again later.",
    );
  }
}

function throwSnapshotProblem(error: unknown): never {
  if (!(error instanceof SnapshotError)) throw error;
  if (error.code === "snapshot_not_found") {
    throw new ApiProblem(404, error.code, "The snapshot was not found.");
  }
  if (error.code === "snapshot_recipient_missing") {
    throw new ApiProblem(
      409,
      error.code,
      "Activate and verify a recovery key before creating or repairing snapshots.",
    );
  }
  if (error.code === "snapshot_recipient_changed") {
    throw new ApiProblem(
      409,
      error.code,
      "The recovery key changed, so this capture was safely stopped. Start a new snapshot with the active key.",
    );
  }
  if (error.code === "snapshot_in_progress") {
    throw new ApiProblem(
      409,
      error.code,
      "Another snapshot or import is already in progress. Continue it before starting another.",
    );
  }
  if (error.code === "snapshot_too_large") {
    throw new ApiProblem(
      413,
      error.code,
      "The selected workspace exceeds the current bounded snapshot limit.",
    );
  }
  if (error.code === "snapshot_source_refresh_pending") {
    throw new ApiProblem(
      409,
      error.code,
      "The selected vault libraries are refreshing. Retry the snapshot after they finish.",
    );
  }
  if (
    error.code === "snapshot_source_unavailable" ||
    error.code === "snapshot_repair_unavailable"
  ) {
    throw new ApiProblem(
      409,
      error.code,
      error.code === "snapshot_repair_unavailable"
        ? "A ciphertext object is damaged and its canonical repair source is unavailable."
        : "Every selected vault must have a complete, verified library generation.",
    );
  }
  if (
    error.code === "snapshot_invalid" ||
    error.code === "snapshot_state_invalid"
  ) {
    throw new ApiProblem(
      409,
      error.code,
      "The snapshot is not ready for that operation.",
    );
  }
  throw new ApiProblem(
    503,
    "snapshot_unavailable",
    "The snapshot operation could not continue. The last ready recovery point is unchanged.",
  );
}

async function resolveCaptureVaults(
  context: Context<AppBindings>,
  requestedVaultIds: string[] | undefined,
): Promise<VaultSummary[]> {
  const result = await context.env.DB.prepare(
    `SELECT id, display_name, status, created_at, paired_at, last_connected_at
     FROM vaults WHERE status = 'active' ORDER BY created_at, id`,
  ).all<{
    created_at: number;
    display_name: string | null;
    id: string;
    last_connected_at: number | null;
    paired_at: number | null;
    status: "active";
  }>();
  const active = result.results.map((row): VaultSummary => ({
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    lastConnectedAt: row.last_connected_at,
    pairedAt: row.paired_at,
    status: row.status,
  }));
  if (active.length === 0) {
    throw new SnapshotError("snapshot_source_unavailable");
  }
  if (requestedVaultIds === undefined) {
    if (active.length > MAX_SNAPSHOT_VAULTS) {
      throw new SnapshotError("snapshot_too_large");
    }
    return active;
  }
  const byId = new Map(active.map((vault) => [vault.id, vault]));
  const selected = requestedVaultIds.map((vaultId) => byId.get(vaultId));
  if (selected.some((vault) => vault === undefined)) {
    throw new SnapshotError("snapshot_source_unavailable");
  }
  return selected.filter((vault): vault is VaultSummary => vault !== undefined);
}

async function currentCaptureSources(
  context: Context<AppBindings>,
  vaults: VaultSummary[],
): Promise<SnapshotCaptureSource[]> {
  const sources: SnapshotCaptureSource[] = [];
  for (const vault of vaults) {
    const generation = await readUsableMaterialization(
      context.env.DB,
      vault.id,
    );
    if (generation === null || vault.displayName === null) {
      throw new SnapshotError("snapshot_source_unavailable");
    }
    const devices = await listSourceDevices(
      context.env.DB,
      vault.id,
      Math.floor(Date.now() / 1_000),
    );
    sources.push({
      generation,
      sourceDescriptor:
        (await readVaultSourceDescriptor(context.env.DB, vault.id)) ??
        undefined,
      sourceDevices: devices.map((device) => ({
        ...device,
        authorityRestored: false as const,
        connectionRestored: false as const,
        credentialRestored: false as const,
        restoreDisposition: "quarantined" as const,
      })),
      vaultName: vault.displayName,
    });
  }
  return sources;
}

async function freshCaptureSources(
  context: Context<AppBindings>,
  vaults: VaultSummary[],
  now: number,
): Promise<SnapshotCaptureSource[]> {
  const results = await Promise.all(
    vaults.map(async (vault) => {
      const materialization = await context.env.VAULTS.getByName(
        vault.id,
      ).queueMaterialization(vault.id, context.get("requestId"), now);
      if (!materialization.ok || vault.displayName === null) {
        throw new SnapshotError("snapshot_source_unavailable");
      }
      return { job: materialization.job, vault };
    }),
  );
  if (
    results.some(
      ({ job }) => job.status === "queued" || job.status === "running",
    )
  ) {
    throw new SnapshotError("snapshot_source_refresh_pending");
  }
  return await Promise.all(
    results.map(async ({ job, vault }) => {
      if (job.status !== "completed" || job.generation === null) {
        throw new SnapshotError("snapshot_source_unavailable");
      }
      return {
        generation: job.generation,
        sourceDescriptor:
          (await readVaultSourceDescriptor(context.env.DB, vault.id)) ??
          undefined,
        sourceDevices: (
          await listSourceDevices(context.env.DB, vault.id, now)
        ).map((device) => ({
          ...device,
          authorityRestored: false as const,
          connectionRestored: false as const,
          credentialRestored: false as const,
          restoreDisposition: "quarantined" as const,
        })),
        vaultName: vault.displayName as string,
      };
    }),
  );
}

export function registerSnapshotRoutes(app: Hono<AppBindings>): void {
  app.get("/api/snapshots", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response = snapshotListResponseSchema.parse({
      snapshots: await listWorkspaceSnapshots(context.env.DB),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  app.post("/api/snapshots/estimate", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-estimate", 30);
    const parsed = snapshotCreateRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "snapshot_scope_invalid",
        "Choose one or more active vaults, or use the all-active default.",
      );
    }
    try {
      const vaults = await resolveCaptureVaults(context, parsed.data.vaultIds);
      const estimate = await estimateWorkspaceSnapshot(
        context.env.DB,
        await currentCaptureSources(context, vaults),
        parsed.data.vaultIds === undefined ? "all-active" : "selected",
        parsed.data.intelligenceSelection,
      );
      snapshotEstimateSchema.parse(estimate);
      context.header("Cache-Control", "private, no-store");
      return context.json(estimate);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.get("/api/snapshots/retention", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const policy = snapshotRetentionPolicySchema.parse(
      await readSnapshotRetentionPolicy(context.env.DB),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(policy);
  });

  app.put("/api/snapshots/retention", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-retention-update", 12);
    const parsed = snapshotRetentionPolicyRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "snapshot_retention_invalid",
        "Choose a valid retention count and optional encrypted-storage limit.",
      );
    }
    const policy = snapshotRetentionPolicySchema.parse(
      await updateSnapshotRetentionPolicy(context.env.DB, {
        ...parsed.data,
        now: nowSeconds(),
        requestId: context.get("requestId"),
      }),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json(policy);
  });

  app.post("/api/snapshots/retention/run", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-retention-run", 12);
    const now = nowSeconds();
    const deletedSnapshotCount = await enforceSnapshotRetention(
      context.env.DB,
      { now, requestId: context.get("requestId") },
    );
    const pendingObjectCount = await runSnapshotGarbageCollection(
      context.env.DB,
      context.env.VAULT_STORAGE,
      { now },
    );
    const result = snapshotRetentionRunSchema.parse({
      deletedSnapshotCount,
      pendingObjectCount,
      policy: await readSnapshotRetentionPolicy(context.env.DB),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(result);
  });

  app.post("/api/snapshots", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-create", 8);
    const parsed = snapshotCreateRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "snapshot_scope_invalid",
        "Choose one or more active vaults, or use the all-active default.",
      );
    }
    const captureStartedAt = nowSeconds();
    try {
      const vaults = await resolveCaptureVaults(context, parsed.data.vaultIds);
      const snapshot = await startWorkspaceSnapshot(context.env.DB, {
        captureStartedAt,
        intelligenceSelection: parsed.data.intelligenceSelection,
        now: nowSeconds(),
        requestId: context.get("requestId"),
        scope: parsed.data.vaultIds === undefined ? "all-active" : "selected",
        sources: await freshCaptureSources(context, vaults, captureStartedAt),
      });
      snapshotSummarySchema.parse(snapshot);
      context.header("Cache-Control", "private, no-store");
      return context.json(snapshot, 201);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.get("/api/snapshots/:snapshotId", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const snapshot = await readWorkspaceSnapshot(
      context.env.DB,
      parseSnapshotId(context),
    );
    if (snapshot === null) {
      return throwSnapshotProblem(new SnapshotError("snapshot_not_found"));
    }
    snapshotSummarySchema.parse(snapshot);
    context.header("Cache-Control", "private, no-store");
    return context.json(snapshot);
  });

  app.post("/api/snapshots/:snapshotId/continue", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-continue", 300);
    try {
      const snapshot = await continueWorkspaceSnapshot(
        context.env.DB,
        context.env.VAULT_STORAGE,
        {
          now: nowSeconds(),
          requestId: context.get("requestId"),
          snapshotId: parseSnapshotId(context),
        },
      );
      if (snapshot.status === "ready") {
        const now = nowSeconds();
        await enforceSnapshotRetention(context.env.DB, {
          now,
          requestId: context.get("requestId"),
        });
        await runSnapshotGarbageCollection(
          context.env.DB,
          context.env.VAULT_STORAGE,
          { now },
        );
      }
      snapshotSummarySchema.parse(snapshot);
      context.header("Cache-Control", "private, no-store");
      return context.json(snapshot);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.post("/api/snapshots/:snapshotId/cancel", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-cancel", 30);
    try {
      const snapshot = snapshotSummarySchema.parse(
        await cancelWorkspaceSnapshot(context.env.DB, {
          now: nowSeconds(),
          requestId: context.get("requestId"),
          snapshotId: parseSnapshotId(context),
        }),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(snapshot);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.put("/api/snapshots/:snapshotId/pin", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-pin", 30);
    const parsed = snapshotPinRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "snapshot_pin_invalid",
        "Choose whether this snapshot should be protected.",
      );
    }
    try {
      const snapshot = await setWorkspaceSnapshotPinned(context.env.DB, {
        now: nowSeconds(),
        pinned: parsed.data.pinned,
        requestId: context.get("requestId"),
        snapshotId: parseSnapshotId(context),
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(snapshot);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.put("/api/snapshots/:snapshotId/archive", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-archive", 30);
    const parsed = snapshotArchiveRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "snapshot_archive_invalid",
        "Choose whether this snapshot should appear in archived history.",
      );
    }
    try {
      const snapshot = await setWorkspaceSnapshotArchived(context.env.DB, {
        archived: parsed.data.archived,
        now: nowSeconds(),
        requestId: context.get("requestId"),
        snapshotId: parseSnapshotId(context),
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(snapshot);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.post("/api/snapshots/:snapshotId/repair", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceSnapshotRateLimit(context, "snapshot-repair", 300);
    const rawCursor = context.req.query("after") ?? null;
    const cursor =
      rawCursor === null ? null : repairCursorSchema.safeParse(rawCursor);
    if (cursor !== null && !cursor.success) {
      throw new ApiProblem(
        400,
        "snapshot_cursor_invalid",
        "The snapshot repair cursor is invalid.",
      );
    }
    try {
      const now = nowSeconds();
      const result = snapshotRepairResponseSchema.parse(
        await repairWorkspaceSnapshot(
          context.env.DB,
          context.env.VAULT_STORAGE,
          {
            afterPortableObjectId: cursor?.data ?? null,
            now,
            snapshotId: parseSnapshotId(context),
          },
        ),
      );
      await runSnapshotGarbageCollection(
        context.env.DB,
        context.env.VAULT_STORAGE,
        { now },
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(result);
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });

  app.get("/api/snapshots/:snapshotId/download", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    await enforceSnapshotRateLimit(context, "snapshot-download", 30);
    try {
      const snapshotId = parseSnapshotId(context);
      const portable = await buildPortableSnapshotExport(
        context.env.DB,
        snapshotId,
      );
      context.header("Cache-Control", "private, no-store");
      context.header("Content-Type", "application/octet-stream");
      context.header("Content-Length", String(portable.totalBytes));
      context.header(
        "Content-Disposition",
        `attachment; filename="owd-snapshot-${snapshotId}.owdsnapshot"`,
      );
      context.header("X-Content-Type-Options", "nosniff");
      return context.body(
        createPortableSnapshotStream(
          context.env.VAULT_STORAGE,
          portable.prefix,
          portable.parts,
        ),
      );
    } catch (error) {
      return throwSnapshotProblem(error);
    }
  });
}
