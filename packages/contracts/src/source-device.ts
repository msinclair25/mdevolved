import { z } from "./zod";
import { sourceCapabilitySchema, sourceKindSchema } from "./source-descriptor";

export const SOURCE_DEVICE_CAPABILITY = "owd.source-devices-v1" as const;
export const SOURCE_BOUNDARY_POLICY = "mdevolved-markdown-v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const sourceBoundarySchema = z
  .object({
    version: z.literal(1),
    root: z.literal("."),
    pathPolicy: z.literal(SOURCE_BOUNDARY_POLICY),
    sourceKind: sourceKindSchema,
    capabilities: z
      .array(sourceCapabilitySchema)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
    boundarySha256: sha256Schema,
  })
  .strict();

export type SourceBoundary = z.infer<typeof sourceBoundarySchema>;

export const sourceDeviceEnrollmentSchema = z
  .object({
    contractVersion: z.literal(1),
    deviceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(120),
    rootFingerprintSha256: sha256Schema,
    boundary: sourceBoundarySchema,
    credentialSha256: sha256Schema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type SourceDeviceEnrollment = z.infer<
  typeof sourceDeviceEnrollmentSchema
>;

export const sourceDeviceSummarySchema = z
  .object({
    deviceId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(120),
    status: z.enum(["active", "revoked", "expired"]),
    boundary: sourceBoundarySchema,
    enrolledAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    revokedAt: z.number().int().nonnegative().nullable(),
    lastSeenAt: z.number().int().nonnegative().nullable(),
    lastPublishedAt: z.number().int().nonnegative().nullable(),
    lastPublishedStateVectorSha256: sha256Schema.nullable(),
  })
  .strict();

export type SourceDeviceSummary = z.infer<typeof sourceDeviceSummarySchema>;

export const portableSourceDeviceSchema = sourceDeviceSummarySchema
  .extend({
    restoreDisposition: z.literal("quarantined"),
    authorityRestored: z.literal(false),
    credentialRestored: z.literal(false),
    connectionRestored: z.literal(false),
  })
  .strict();

export type PortableSourceDevice = z.infer<typeof portableSourceDeviceSchema>;

export const sourceDeviceCapabilitySchema = z
  .object({
    version: z.literal(1),
    capability: z.literal(SOURCE_DEVICE_CAPABILITY),
    credentialMode: z.literal("client-generated-sha256"),
    maxDevicesPerSource: z.number().int().positive().max(64),
  })
  .strict();

export const sourceDeviceEnrollmentGrantRequestSchema = z
  .object({
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export const sourceDevicePairingExchangeResponseSchema = z
  .object({
    deploymentUrl: z.string().url(),
    vaultId: z.string().uuid(),
    credentialAccepted: z.literal(true),
    sourceDevice: sourceDeviceSummarySchema,
    serverVersion: z.string().min(1).max(64),
    supportedSchemaVersions: z
      .object({
        min: z.number().int().positive(),
        max: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type SourceDevicePairingExchangeResponse = z.infer<
  typeof sourceDevicePairingExchangeResponseSchema
>;

export const sourceDeviceListResponseSchema = z
  .object({ devices: z.array(sourceDeviceSummarySchema).max(64) })
  .strict();
