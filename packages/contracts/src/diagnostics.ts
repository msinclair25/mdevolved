import { z } from "./zod";

const unixSecondsSchema = z.number().int().nonnegative();
const portableIdSchema = z.string().uuid();

export const ownerDiagnosticVaultSchema = z
  .object({
    activeAgentCount: z.number().int().nonnegative(),
    activeProjectCount: z.number().int().nonnegative(),
    connectionConfirmedAt: unixSecondsSchema.nullable(),
    id: portableIdSchema,
    initialSyncAt: unixSecondsSchema.nullable(),
    lastErrorCode: z.string().min(1).max(120).nullable(),
    lastSyncAt: unixSecondsSchema.nullable(),
    libraryState: z.enum([
      "not-synced",
      "building",
      "current",
      "stale",
      "failed",
      "revoked",
    ]),
    pendingProjectRequestCount: z.number().int().nonnegative(),
    pluginVersion: z.string().min(1).max(64).nullable(),
    schemaVersion: z.number().int().positive().nullable(),
    status: z.enum(["pending", "active", "revoked"]),
  })
  .strict();

export const ownerDiagnosticProjectSchema = z
  .object({
    activeGrantCount: z.number().int().nonnegative(),
    createdAt: unixSecondsSchema,
    currentPacketExpiresAt: unixSecondsSchema.nullable(),
    duplicateGroupSize: z.number().int().positive(),
    id: portableIdSchema,
    lastActivityAt: unixSecondsSchema,
    pendingAuthorizationCount: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
    sourceVaultIds: z.array(portableIdSchema).max(16),
    state: z.enum([
      "archived",
      "authorization-required",
      "disconnected",
      "packet-expired",
      "packet-missing",
      "ready",
    ]),
    status: z.enum(["active", "archived"]),
    workItemCount: z.number().int().nonnegative(),
  })
  .strict();

export const ownerDiagnosticsResponseSchema = z
  .object({
    format: z.literal("owd-owner-diagnostics-v1"),
    generatedAt: unixSecondsSchema,
    projects: z.array(ownerDiagnosticProjectSchema).max(100),
    requestId: portableIdSchema,
    service: z
      .object({
        deploymentMode: z.enum(["community", "managed"]),
        environment: z.string().min(1).max(120),
        releaseId: z.string().min(1).max(256),
        releaseTag: z.string().min(1).max(256).nullable(),
        version: z.string().min(1).max(120),
      })
      .strict(),
    totals: z
      .object({
        activeAgentCount: z.number().int().nonnegative(),
        activeProjectCount: z.number().int().nonnegative(),
        activeVaultCount: z.number().int().nonnegative(),
        duplicateProjectCount: z.number().int().nonnegative(),
        pendingProjectRequestCount: z.number().int().nonnegative(),
      })
      .strict(),
    trial: z
      .object({
        endsAt: unixSecondsSchema.nullable(),
        expired: z.boolean(),
        maxVaults: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    vaults: z.array(ownerDiagnosticVaultSchema).max(100),
  })
  .strict();

export type OwnerDiagnosticsResponse = z.infer<
  typeof ownerDiagnosticsResponseSchema
>;
