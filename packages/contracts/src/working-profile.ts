import { z } from "./zod";

const portableIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const idempotencyKeySchema = z.string().trim().min(1).max(200);
const preferenceKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const sourceLabelSchema = z.string().trim().min(1).max(120);
const sourceUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"));

export const workingPreferenceSchema = z
  .object({
    key: preferenceKeySchema,
    preferenceId: portableIdSchema,
    projectId: portableIdSchema.nullable(),
    sourceLabel: sourceLabelSchema,
    sourceUrl: sourceUrlSchema.nullable(),
    updatedAt: z.number().int().nonnegative(),
    value: z.string().min(1).max(512),
    versionRecordId: portableIdSchema,
  })
  .strict();

export const saveWorkingPreferenceRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    key: preferenceKeySchema,
    preferenceId: portableIdSchema.optional(),
    projectId: portableIdSchema.nullable().default(null),
    sourceLabel: sourceLabelSchema,
    sourceUrl: sourceUrlSchema.nullable().default(null),
    value: z.string().min(1).max(512),
  })
  .strict();

export const deleteWorkingPreferenceRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    preferenceId: portableIdSchema,
  })
  .strict();

export const workingPreferenceListResponseSchema = z
  .object({
    ok: z.literal(true),
    preferences: z.array(workingPreferenceSchema).max(256),
    projectId: portableIdSchema.nullable(),
  })
  .strict();

export const workingPreferenceMutationResponseSchema = z
  .object({ ok: z.literal(true), preference: workingPreferenceSchema })
  .strict();

export const workingProfileDeleteResponseSchema = z
  .object({
    deleted: z.literal(true),
    ok: z.literal(true),
    recordId: portableIdSchema,
  })
  .strict();

export const agentSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const agentSkillPackageFileSchema = z
  .object({
    contentBase64: z
      .string()
      .min(1)
      .max(87_384)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
      ),
    path: z.string().min(1).max(1_024),
  })
  .strict();

export const importAgentSkillRequestSchema = z
  .object({
    files: z.array(agentSkillPackageFileSchema).min(1).max(32),
    idempotencyKey: idempotencyKeySchema,
    skillId: portableIdSchema.optional(),
  })
  .strict();

export const agentSkillSummarySchema = z
  .object({
    description: z.string().min(1).max(1_024),
    name: agentSkillNameSchema,
    skillId: portableIdSchema,
    updatedAt: z.number().int().nonnegative(),
    versionRecordId: portableIdSchema,
  })
  .strict();

export const agentSkillListResponseSchema = z
  .object({
    ok: z.literal(true),
    skills: z.array(agentSkillSummarySchema).max(256),
  })
  .strict();

export const agentSkillImportResponseSchema = z
  .object({ ok: z.literal(true), skill: agentSkillSummarySchema })
  .strict();

export const agentSkillExportResponseSchema = z
  .object({
    executes: z.literal(false),
    files: z.array(agentSkillPackageFileSchema).min(1).max(32),
    grantsAuthority: z.literal(false),
    ok: z.literal(true),
    packageSha256: sha256Schema,
    skill: agentSkillSummarySchema,
  })
  .strict();

export const deleteAgentSkillRequestSchema = z
  .object({ idempotencyKey: idempotencyKeySchema, skillId: portableIdSchema })
  .strict();

export const projectSkillMutationRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    projectId: portableIdSchema,
    skillId: portableIdSchema,
  })
  .strict();

export const projectSkillAttachmentSchema = z
  .object({
    attachedAt: z.number().int().nonnegative(),
    projectId: portableIdSchema,
    skill: agentSkillSummarySchema,
  })
  .strict();

export const projectSkillAttachmentListResponseSchema = z
  .object({
    attachments: z.array(projectSkillAttachmentSchema).max(32),
    ok: z.literal(true),
    projectId: portableIdSchema,
  })
  .strict();

export const projectSkillMutationResponseSchema = z
  .object({
    attached: z.boolean(),
    ok: z.literal(true),
    projectId: portableIdSchema,
    recordId: portableIdSchema,
    skillId: portableIdSchema,
    versionRecordId: portableIdSchema,
  })
  .strict();

const workingProfileBodyBaseSchema = z.object({
  recordId: portableIdSchema,
});

const preferenceVersionBodySchema = workingProfileBodyBaseSchema
  .extend({
    key: preferenceKeySchema,
    preferenceId: portableIdSchema,
    projectId: portableIdSchema.nullable(),
    sourceLabel: sourceLabelSchema,
    sourceUrl: sourceUrlSchema.nullable(),
    type: z.literal("preference-version"),
    value: z.string().min(1).max(512),
  })
  .strict();

const preferenceDeletedBodySchema = workingProfileBodyBaseSchema
  .extend({
    preferenceId: portableIdSchema,
    projectId: portableIdSchema.nullable(),
    type: z.literal("preference-deleted"),
  })
  .strict();

const skillVersionBodySchema = workingProfileBodyBaseSchema
  .extend({
    description: z.string().min(1).max(1_024),
    files: z.array(agentSkillPackageFileSchema).min(1).max(32),
    name: agentSkillNameSchema,
    skillId: portableIdSchema,
    type: z.literal("skill-version"),
  })
  .strict();

const skillDeletedBodySchema = workingProfileBodyBaseSchema
  .extend({
    skillId: portableIdSchema,
    type: z.literal("skill-deleted"),
  })
  .strict();

const skillAttachmentBodySchema = workingProfileBodyBaseSchema
  .extend({
    projectId: portableIdSchema,
    skillId: portableIdSchema,
    skillVersionRecordId: portableIdSchema,
    type: z.enum(["skill-attached", "skill-detached"]),
  })
  .strict();

export const workingProfileRecordBodySchema = z.discriminatedUnion("type", [
  preferenceVersionBodySchema,
  preferenceDeletedBodySchema,
  skillVersionBodySchema,
  skillDeletedBodySchema,
  skillAttachmentBodySchema,
]);

export const workingProfileRecordTypeSchema = z.enum([
  "preference-version",
  "preference-deleted",
  "skill-version",
  "skill-deleted",
  "skill-attached",
  "skill-detached",
]);

export type WorkingProfileRecordBody = z.infer<
  typeof workingProfileRecordBodySchema
>;
export type WorkingProfileRecordType = z.infer<
  typeof workingProfileRecordTypeSchema
>;

export type AgentSkillPackageFile = z.infer<typeof agentSkillPackageFileSchema>;
export type AgentSkillSummary = z.infer<typeof agentSkillSummarySchema>;
export type DeleteAgentSkillRequest = z.infer<
  typeof deleteAgentSkillRequestSchema
>;
export type DeleteWorkingPreferenceRequest = z.infer<
  typeof deleteWorkingPreferenceRequestSchema
>;
export type ImportAgentSkillRequest = z.infer<
  typeof importAgentSkillRequestSchema
>;
export type ProjectSkillMutationRequest = z.infer<
  typeof projectSkillMutationRequestSchema
>;
export type SaveWorkingPreferenceRequest = z.infer<
  typeof saveWorkingPreferenceRequestSchema
>;
export type WorkingPreference = z.infer<typeof workingPreferenceSchema>;
