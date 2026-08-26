import {
  backupCreateRequestSchema,
  backupListResponseSchema,
  backupRecipientRequestSchema,
  vaultIdSchema,
  type BackupListResponse,
} from "@owd/contracts";
import { z } from "zod";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit } from "./auth-store";
import {
  BackupError,
  createEncryptedBackup,
  listReadyBackups,
  readBackupRecipient,
  readReadyBackup,
  saveBackupRecipient,
} from "./backup-store";
import { requireOwnerSession } from "./owner-session";
import { parseJsonBody, sha256Hex } from "./security";
import { listSourceDevices } from "./source-device-service";
import type { AppBindings } from "./types";

const backupIdSchema = z.string().uuid();

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

async function enforceBackupRateLimit(
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
      "Too many backup requests. Try again later.",
    );
  }
}

function throwBackupProblem(error: unknown): never {
  if (!(error instanceof BackupError)) throw error;
  if (error.code === "backup_recipient_in_use") {
    throw new ApiProblem(
      409,
      error.code,
      "Wait for the active backup to finish, or finish or cancel the active snapshot, before changing the recovery key.",
    );
  }
  if (error.code === "backup_recipient_changed") {
    throw new ApiProblem(
      409,
      error.code,
      "The recovery key changed. Reopen the current key before creating this backup.",
    );
  }
  if (error.code === "backup_recipient_missing") {
    throw new ApiProblem(
      409,
      error.code,
      "Create and safely store a recovery identity before making a backup.",
    );
  }
  if (error.code === "backup_source_invalid") {
    throw new ApiProblem(
      400,
      error.code,
      "The age recovery recipient is invalid.",
    );
  }
  if (error.code === "backup_source_unavailable") {
    throw new ApiProblem(
      409,
      error.code,
      "Refresh the vault library before creating this backup.",
    );
  }
  throw new ApiProblem(
    503,
    "backup_unavailable",
    "The encrypted backup could not be completed. Existing backups are unchanged.",
  );
}

export function registerBackupRoutes(app: Hono<AppBindings>): void {
  app.get("/api/backups/recovery-recipient", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    context.header("Cache-Control", "private, no-store");
    return context.json(await readBackupRecipient(context.env.DB));
  });

  app.put("/api/backups/recovery-recipient", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceBackupRateLimit(context, "backup-recipient", 10);
    const parsed = backupRecipientRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "backup_recipient_invalid",
        "The age recovery recipient is invalid.",
      );
    }
    try {
      const response = await saveBackupRecipient(context.env.DB, {
        now: nowSeconds(),
        recipient: parsed.data.recipient,
        requestId: context.get("requestId"),
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(response);
    } catch (error) {
      return throwBackupProblem(error);
    }
  });

  app.post("/api/vaults/:vaultId/backups", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforceBackupRateLimit(context, "backup-create", 6);
    const request = backupCreateRequestSchema.safeParse(
      await parseJsonBody(context, 4_096),
    );
    if (!request.success) {
      throw new ApiProblem(
        400,
        "backup_request_invalid",
        "The backup request is invalid.",
      );
    }
    const vaultId = parseVaultId(context);
    const now = nowSeconds();
    const [recipient, vault, sourceDevices] = await Promise.all([
      readBackupRecipient(context.env.DB),
      context.env.DB.prepare(
        `SELECT display_name FROM vaults
         WHERE id = ? AND status = 'active'`,
      )
        .bind(vaultId)
        .first<{ display_name: string | null }>(),
      listSourceDevices(context.env.DB, vaultId, now),
    ]);
    if (!recipient.configured) {
      return throwBackupProblem(new BackupError("backup_recipient_missing"));
    }
    if (recipient.fingerprint !== request.data.recipientFingerprint) {
      return throwBackupProblem(new BackupError("backup_recipient_changed"));
    }
    if (vault?.display_name == null) {
      throw new ApiProblem(
        409,
        "backup_source_unavailable",
        "The selected vault is not active.",
      );
    }
    const materialization = await context.env.VAULTS.getByName(
      vaultId,
    ).queueMaterialization(vaultId, context.get("requestId"), nowSeconds());
    if (!materialization.ok) {
      return throwBackupProblem(new BackupError("backup_source_unavailable"));
    }
    if (
      materialization.job.status === "queued" ||
      materialization.job.status === "running"
    ) {
      throw new ApiProblem(
        409,
        "backup_source_refresh_pending",
        "The vault library is refreshing. Retry the backup after it finishes.",
      );
    }
    if (
      materialization.job.status !== "completed" ||
      materialization.job.generation === null
    ) {
      return throwBackupProblem(new BackupError("backup_source_unavailable"));
    }

    try {
      const artifact = await createEncryptedBackup(
        context.env.DB,
        context.env.VAULT_STORAGE,
        {
          expectedRecipientFingerprint: request.data.recipientFingerprint,
          generation: materialization.job.generation,
          now: nowSeconds(),
          requestId: context.get("requestId"),
          sourceDevices: sourceDevices.map((device) => ({
            ...device,
            authorityRestored: false as const,
            connectionRestored: false as const,
            credentialRestored: false as const,
            restoreDisposition: "quarantined" as const,
          })),
          vaultName: vault.display_name,
        },
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(artifact, 201);
    } catch (error) {
      return throwBackupProblem(error);
    }
  });

  app.get("/api/vaults/:vaultId/backups", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response: BackupListResponse = {
      backups: await listReadyBackups(context.env.DB, parseVaultId(context)),
    };
    backupListResponseSchema.parse(response);
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  app.get("/api/backups/:backupId/download", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    await enforceBackupRateLimit(context, "backup-download", 30);
    const parsed = backupIdSchema.safeParse(context.req.param("backupId"));
    if (!parsed.success) {
      throw new ApiProblem(
        404,
        "backup_not_found",
        "The backup was not found.",
      );
    }
    const backup = await readReadyBackup(context.env.DB, parsed.data);
    if (backup === null) {
      throw new ApiProblem(
        404,
        "backup_not_found",
        "The backup was not found.",
      );
    }
    const object = await context.env.VAULT_STORAGE.get(backup.objectKey);
    if (
      object === null ||
      object.size !== backup.ciphertextBytes ||
      object.etag !== backup.objectEtag ||
      object.version !== backup.objectVersion
    ) {
      throw new ApiProblem(
        503,
        "backup_unavailable",
        "The encrypted backup is temporarily unavailable.",
      );
    }

    context.header("Cache-Control", "private, no-store");
    context.header("Content-Type", "application/octet-stream");
    context.header(
      "Content-Disposition",
      `attachment; filename="owd-backup-${backup.backupId}.age"`,
    );
    context.header("X-Content-Type-Options", "nosniff");
    return context.body(object.body);
  });
}
