import { z } from "./zod";

/** The only source kinds that can be persisted by the Community data plane. */
export const sourceKindSchema = z.enum(["folder", "obsidian"]);

export const sourceCapabilitySchema = z.enum([
  "markdown",
  "attachments",
  "editor-integration",
  "watch",
]);

const sourceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      ![...value].some((char) => {
        const codePoint = char.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
  );

const sourceClientVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u);

const sourceCapabilitiesSchema = z
  .array(sourceCapabilitySchema)
  .min(1)
  .max(4)
  .refine((values) => new Set(values).size === values.length);

/** The optional client-supplied portion of a v1 pairing descriptor. */
export const sourceDescriptorInputSchema = z
  .object({
    sourceKind: sourceKindSchema,
    label: sourceLabelSchema,
    capabilities: sourceCapabilitiesSchema,
    clientVersion: sourceClientVersionSchema,
    syncSchemaVersion: z.number().int().positive().max(32),
  })
  .strict();

export type SourceDescriptorInput = z.infer<typeof sourceDescriptorInputSchema>;

export const sourceDescriptorProvenanceSchema = z
  .object({
    pairedAt: z.number().int().nonnegative(),
    descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

/** Durable server-owned descriptor; provenance contains no provider IDs. */
export const sourceDescriptorSchema = sourceDescriptorInputSchema
  .extend({
    descriptorVersion: z.literal(1),
    provenance: sourceDescriptorProvenanceSchema,
  })
  .strict();

export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;

/** Portable metadata is explicitly inert after import or restore. */
export const portableSourceDescriptorSchema = sourceDescriptorSchema
  .extend({
    restoreDisposition: z.literal("quarantined"),
    authorityRestored: z.literal(false),
  })
  .strict();

export type PortableSourceDescriptor = z.infer<
  typeof portableSourceDescriptorSchema
>;

export const sourceDescriptorCapabilitySchema = z
  .object({
    version: z.literal(1),
    kinds: z.array(sourceKindSchema).min(1).max(2),
  })
  .strict();

export type SourceDescriptorCapability = z.infer<
  typeof sourceDescriptorCapabilitySchema
>;
