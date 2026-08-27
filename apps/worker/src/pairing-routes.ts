import {
  pairingExchangeRequestSchema,
  serverCapabilitiesSchema,
  sourceDeviceEnrollmentGrantRequestSchema,
  sourceDeviceListResponseSchema,
  vaultSyncConfirmationRequestSchema,
  vaultSyncConfirmationResponseSchema,
  vaultIdSchema,
  type VaultListResponse,
} from "@owd/contracts";
import {
  SERVER_MAX_SCHEMA_VERSION,
  SERVER_MIN_SCHEMA_VERSION,
  SERVER_VERSION,
} from "@owd/yaos-core";
import type { Context, Hono } from "hono";
import { ApiProblem } from "./api-problem";
import { enforceRateLimit, ownerExists } from "./auth-store";
import { requireOwnerSession } from "./owner-session";
import {
  createPairingGrant,
  confirmVaultSync,
  exchangePairingGrant,
  listVaults,
  markVaultConnected,
  readVaultCredential,
  revokeVault,
} from "./pairing-store";
import {
  SourceDeviceError,
  listSourceDevices,
  revokeSourceDevice,
} from "./source-device-service";
import {
  decodeBase64Url,
  parseJsonBody,
  requestOrigin,
  sha256Hex,
  sha256HexBytes,
} from "./security";
import {
  MINIMUM_PLUGIN_VERSION,
  pluginVersionSupported,
  RECOMMENDED_PLUGIN_VERSION,
} from "./plugin-compatibility";
import { readRuntimeDeploymentConfig } from "./runtime-config";
import { createSocketTicket, verifySocketTicket } from "./socket-ticket";
import type { AppBindings } from "./types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function readBearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/u.exec(value);
  return match?.[1] ?? null;
}

async function enforcePairingRateLimit(
  context: Context<AppBindings>,
  action: string,
  limit: number,
): Promise<void> {
  const clientAddress =
    context.req.header("CF-Connecting-IP") ?? "address-unavailable";
  const allowed = await enforceRateLimit(context.env.DB, {
    action,
    keyHash: await sha256Hex(clientAddress),
    limit,
    now: nowSeconds(),
    windowSeconds: 600,
  });

  if (!allowed) {
    throw new ApiProblem(
      429,
      "rate_limited",
      "Too many pairing attempts. Try again later.",
    );
  }
}

export function registerPairingRoutes(app: Hono<AppBindings>): void {
  app.get("/api/capabilities", async (context) => {
    const claimed = await ownerExists(context.env.DB);
    const response = serverCapabilitiesSchema.parse({
      claimed,
      authMode: claimed ? "claim" : "unclaimed",
      attachments: false,
      snapshots: false,
      socketTicketAuth: true,
      serverVersion: SERVER_VERSION,
      minPluginVersion: MINIMUM_PLUGIN_VERSION,
      recommendedPluginVersion: RECOMMENDED_PLUGIN_VERSION,
      minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
      maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
      migrationRequired: false,
      updateProvider: null,
      updateRepoUrl: null,
      updateRepoBranch: null,
      sourceDescriptors: {
        version: 1,
        kinds: ["folder", "obsidian"],
      },
      sourceDevices: {
        version: 1,
        capability: "owd.source-devices-v1",
        credentialMode: "client-generated-sha256",
        maxDevicesPerSource: 16,
      },
    });

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/pairing/grants", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforcePairingRateLimit(context, "pairing_grant", 20);

    const response = await createPairingGrant(context.env.DB, {
      deploymentUrl: requestOrigin(context).origin,
      maxVaults:
        readRuntimeDeploymentConfig(context.env).mode === "managed"
          ? 2
          : undefined,
      now: nowSeconds(),
      requestId: context.get("requestId"),
    });
    if (response === null) {
      throw new ApiProblem(
        409,
        "managed_vault_limit_reached",
        "This managed trial includes two active or pending vaults. Reconnect an existing vault or revoke one before adding another.",
      );
    }

    context.header("Cache-Control", "no-store");
    return context.json(response, 201);
  });

  app.post("/api/pairing/exchange", async (context) => {
    await enforcePairingRateLimit(context, "pairing_exchange", 20);
    const parsed = pairingExchangeRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "pairing_request_invalid",
        "The pairing request is invalid.",
      );
    }
    if (!pluginVersionSupported(parsed.data.pluginVersion)) {
      throw new ApiProblem(
        409,
        "plugin_update_required",
        `Update MDevolved Sync to ${MINIMUM_PLUGIN_VERSION} or newer, then generate a new pairing link.`,
      );
    }

    let response;
    try {
      response = await exchangePairingGrant(context.env.DB, {
        ...parsed.data,
        deploymentUrl: requestOrigin(context).origin,
        now: nowSeconds(),
        requestId: context.get("requestId"),
      });
    } catch (error) {
      if (error instanceof SourceDeviceError) {
        const status = error.code === "source_device_denied" ? 403 : 409;
        throw new ApiProblem(
          status,
          error.code,
          error.code === "source_device_denied"
            ? "This source device was not approved by the owner."
            : error.code === "idempotency_conflict"
              ? "This device enrollment key was already used with different details."
              : error.code === "source_device_limit"
                ? "This source has reached its retained device-history limit."
                : "The source device does not match the approved source boundary.",
        );
      }
      throw error;
    }
    if (!response) {
      throw new ApiProblem(
        400,
        "pairing_grant_invalid",
        "The pairing link is expired or has already been used.",
      );
    }

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.get("/api/vaults", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const response: VaultListResponse = {
      vaults: await listVaults(context.env.DB),
    };

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.post("/api/vaults/:vaultId/reconnect-grant", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforcePairingRateLimit(context, "vault_reconnect_grant", 20);
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    if (!parsedVaultId.success) {
      throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
    }
    const response = await createPairingGrant(context.env.DB, {
      deploymentUrl: requestOrigin(context).origin,
      now: nowSeconds(),
      requestId: context.get("requestId"),
      vaultId: parsedVaultId.data,
    });
    if (response === null) {
      throw new ApiProblem(
        409,
        "vault_reconnect_unavailable",
        "Only an active vault can be reconnected.",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(response, 201);
  });

  app.post("/api/vaults/:vaultId/device-enrollment-grants", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    await enforcePairingRateLimit(context, "source_device_grant", 20);
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    const parsed = sourceDeviceEnrollmentGrantRequestSchema.safeParse(
      await parseJsonBody(context, 1_024),
    );
    if (!parsedVaultId.success || !parsed.success) {
      throw new ApiProblem(
        400,
        "source_device_grant_invalid",
        "The source device request is invalid.",
      );
    }
    const now = nowSeconds();
    const response = await createPairingGrant(context.env.DB, {
      deploymentUrl: requestOrigin(context).origin,
      now,
      requestId: context.get("requestId"),
      vaultId: parsedVaultId.data,
      deviceEnrollment: true,
      ...(parsed.data.expiresInDays === undefined
        ? {}
        : {
            deviceExpiresAt: now + parsed.data.expiresInDays * 24 * 60 * 60,
          }),
    });
    if (response === null) {
      throw new ApiProblem(
        409,
        "source_device_enrollment_unavailable",
        "Only an active source can approve another device.",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(response, 201);
  });

  app.get("/api/vaults/:vaultId/devices", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    if (!parsedVaultId.success) {
      throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      sourceDeviceListResponseSchema.parse({
        devices: await listSourceDevices(
          context.env.DB,
          parsedVaultId.data,
          nowSeconds(),
        ),
      }),
    );
  });

  app.post("/api/vaults/:vaultId/devices/:deviceId/revoke", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    const parsedDeviceId = vaultIdSchema.safeParse(
      context.req.param("deviceId"),
    );
    if (!parsedVaultId.success || !parsedDeviceId.success) {
      throw new ApiProblem(
        404,
        "source_device_not_found",
        "The source device was not found.",
      );
    }
    const revoked = await revokeSourceDevice(context.env.DB, {
      deviceId: parsedDeviceId.data,
      now: nowSeconds(),
      requestId: context.get("requestId"),
      vaultId: parsedVaultId.data,
    });
    if (!revoked) {
      throw new ApiProblem(
        404,
        "source_device_not_found",
        "The source device was not found.",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.post("/api/vaults/:vaultId/sync-confirmation", async (context) => {
    await enforcePairingRateLimit(context, "vault_sync_confirmation", 120);
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    const credentialToken = readBearerToken(
      context.req.header("Authorization"),
    );
    const parsed = vaultSyncConfirmationRequestSchema.safeParse(
      await parseJsonBody(context, 70_000),
    );
    if (!parsedVaultId.success || !credentialToken || !parsed.success) {
      throw new ApiProblem(
        400,
        "sync_confirmation_invalid",
        "The vault sync confirmation is invalid.",
      );
    }
    if (!pluginVersionSupported(parsed.data.pluginVersion)) {
      throw new ApiProblem(
        409,
        "plugin_update_required",
        `Update MDevolved Sync to ${MINIMUM_PLUGIN_VERSION} or newer before confirming this vault.`,
      );
    }
    const credential = await readVaultCredential(
      context.env.DB,
      parsedVaultId.data,
      await sha256Hex(credentialToken),
    );
    if (credential === null) {
      throw new ApiProblem(
        401,
        "vault_credential_denied",
        "The vault credential is invalid or revoked.",
      );
    }
    let candidate: Uint8Array<ArrayBuffer>;
    try {
      candidate = decodeBase64Url(parsed.data.stateVector);
    } catch {
      throw new ApiProblem(
        400,
        "sync_confirmation_invalid",
        "The vault sync confirmation is invalid.",
      );
    }
    if (candidate.byteLength === 0 || candidate.byteLength > 49_152) {
      throw new ApiProblem(
        400,
        "sync_confirmation_invalid",
        "The vault sync confirmation is invalid.",
      );
    }
    const coordinator = context.env.VAULTS.getByName(parsedVaultId.data);
    if (!(await coordinator.includesStateVector(candidate.buffer))) {
      throw new ApiProblem(
        409,
        "vault_sync_pending",
        "MDevolved is still receiving this Source. Keep the Source sync client running and retry shortly.",
      );
    }
    const currentStateVector = new Uint8Array(
      await coordinator.currentStateVector(),
    );
    const confirmed = await confirmVaultSync(context.env.DB, {
      credential,
      now: nowSeconds(),
      pluginVersion: parsed.data.pluginVersion,
      requestId: context.get("requestId"),
      runtimeProfile: parsed.data.runtimeProfile,
      schemaVersion: parsed.data.schemaVersion,
      stateVectorSha256: await sha256HexBytes(currentStateVector),
      vaultId: parsedVaultId.data,
    });
    if (!confirmed) {
      throw new ApiProblem(
        409,
        "vault_sync_pending",
        "MDevolved could not confirm this vault connection. Reconnect and try again.",
      );
    }
    const libraryBuild = await coordinator.queueMaterialization(
      parsedVaultId.data,
      context.get("requestId"),
      nowSeconds(),
    );
    if (!libraryBuild.ok) {
      throw new ApiProblem(
        libraryBuild.code === "generation_too_large" ||
          libraryBuild.code === "note_too_large"
          ? 413
          : 409,
        libraryBuild.code,
        libraryBuild.code === "note_too_large"
          ? "A Markdown file exceeds MDevolved's 1 MiB library limit. Reduce or exclude it, then retry."
          : libraryBuild.code === "generation_too_large"
            ? "This vault exceeds MDevolved's 32 MiB library limit. Narrow or reduce it, then retry."
            : "MDevolved synced the vault but could not build its library. Open diagnostics before retrying.",
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      vaultSyncConfirmationResponseSchema.parse({
        confirmed: true,
        libraryBuild: libraryBuild.job,
        vaultId: parsedVaultId.data,
      }),
      libraryBuild.job.status === "completed" ? 200 : 202,
    );
  });

  app.post("/api/vaults/:vaultId/revoke", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    if (!parsedVaultId.success) {
      throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
    }

    const revoked = await revokeVault(context.env.DB, {
      now: nowSeconds(),
      requestId: context.get("requestId"),
      vaultId: parsedVaultId.data,
    });
    if (!revoked) {
      throw new ApiProblem(404, "vault_not_found", "The vault was not found.");
    }

    await context.env.VAULTS.getByName(parsedVaultId.data).disconnectAll();
    context.header("Cache-Control", "no-store");
    return context.body(null, 204);
  });

  app.post("/vault/:vaultId/auth/ticket", async (context) => {
    await enforcePairingRateLimit(context, "socket_ticket", 10);
    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    const credentialToken = readBearerToken(
      context.req.header("Authorization"),
    );
    if (!parsedVaultId.success || !credentialToken) {
      throw new ApiProblem(
        401,
        "vault_credential_denied",
        "The vault credential is invalid or revoked.",
      );
    }

    const credential = await readVaultCredential(
      context.env.DB,
      parsedVaultId.data,
      await sha256Hex(credentialToken),
    );
    if (!credential) {
      throw new ApiProblem(
        401,
        "vault_credential_denied",
        "The vault credential is invalid or revoked.",
      );
    }

    context.header("Cache-Control", "no-store");
    return context.json(await createSocketTicket(credential));
  });

  app.get("/vault/sync/:vaultId", async (context) => {
    if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiProblem(
        426,
        "websocket_required",
        "Vault synchronization requires a WebSocket connection.",
      );
    }

    const parsedVaultId = vaultIdSchema.safeParse(context.req.param("vaultId"));
    const url = new URL(context.req.url);
    const ticket = url.searchParams.get("ticket");
    if (!parsedVaultId.success || !ticket) {
      throw new ApiProblem(
        401,
        "vault_ticket_denied",
        "The vault connection ticket is invalid or expired.",
      );
    }

    const credential = await verifySocketTicket(
      context.env.DB,
      ticket,
      parsedVaultId.data,
    );
    if (!credential) {
      throw new ApiProblem(
        401,
        "vault_ticket_denied",
        "The vault connection ticket is invalid or expired.",
      );
    }

    url.searchParams.delete("ticket");
    const headers = new Headers(context.req.raw.headers);
    headers.set("x-partykit-room", parsedVaultId.data);
    const internalRequest = new Request(url, {
      headers,
      method: "GET",
    });
    const response = await context.env.VAULTS.getByName(
      parsedVaultId.data,
    ).fetch(internalRequest);

    if (response.status === 101) {
      await markVaultConnected(
        context.env.DB,
        credential.id,
        parsedVaultId.data,
        nowSeconds(),
      );
    }

    return response;
  });
}
