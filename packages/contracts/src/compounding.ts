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
const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const learningSignalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preference"),
      key: preferenceKeySchema,
      projectId: portableIdSchema.nullable().default(null),
      scope: z.enum(["personal", "project"]),
      value: z.string().trim().min(1).max(512),
    })
    .strict()
    .superRefine((signal, refinement) => {
      if (
        (signal.scope === "project" && signal.projectId === null) ||
        (signal.scope === "personal" && signal.projectId !== null)
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Learning-signal scope and project identity must agree.",
          path: ["scope"],
        });
      }
    }),
  z
    .object({
      description: z.string().trim().min(1).max(1_024),
      instruction: z.string().trim().min(1).max(8_192),
      kind: z.literal("skill"),
      name: skillNameSchema,
      projectId: portableIdSchema.nullable().default(null),
      scope: z.enum(["personal", "project"]),
    })
    .strict()
    .superRefine((signal, refinement) => {
      if (
        (signal.scope === "project" && signal.projectId === null) ||
        (signal.scope === "personal" && signal.projectId !== null)
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Learning-signal scope and project identity must agree.",
          path: ["scope"],
        });
      }
    }),
]);

export const learningSignalsSchema = z.array(learningSignalSchema).max(4);

export const compoundingEvidenceSchema = z
  .object({
    acknowledgedAt: z.number().int().nonnegative(),
    continuityPointId: portableIdSchema,
    contentSha256: sha256Schema,
    producerClientId: z.string().trim().min(1).max(200),
  })
  .strict();

export const compoundingCandidateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      key: preferenceKeySchema,
      kind: z.literal("preference"),
      projectId: portableIdSchema.nullable(),
      scope: z.enum(["personal", "project"]),
      value: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      description: z.string().trim().min(1).max(1_024),
      instruction: z.string().trim().min(1).max(8_192),
      kind: z.literal("skill"),
      name: skillNameSchema,
      projectId: portableIdSchema.nullable(),
      scope: z.enum(["personal", "project"]),
    })
    .strict(),
]);

export const compoundingDraftSchema = z
  .object({
    candidate: compoundingCandidateSchema,
    conflict: z.boolean(),
    correlationNote: z.literal("Suggestion only; correlation is not proof."),
    draftId: portableIdSchema,
    evidence: z.array(compoundingEvidenceSchema).min(2).max(16),
    fingerprint: sha256Schema,
    firstObservedAt: z.number().int().nonnegative(),
    lastObservedAt: z.number().int().nonnegative(),
    observationCount: z.number().int().positive().max(256),
    projectId: portableIdSchema.nullable(),
    scope: z.enum(["personal", "project"]),
    status: z.enum(["pending", "accepted", "ignored", "deleted"]),
  })
  .strict();

export const compoundingRecordBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      correlationNote: z.literal("Suggestion only; correlation is not proof."),
      fingerprint: sha256Schema,
      learningSignal: learningSignalSchema,
      observationId: portableIdSchema,
      point: compoundingEvidenceSchema,
      recordId: portableIdSchema,
      type: z.literal("checkpoint-observation"),
    })
    .strict(),
  z
    .object({
      draft: compoundingDraftSchema,
      recordId: portableIdSchema,
      type: z.enum([
        "draft-version",
        "draft-accepted",
        "draft-ignored",
        "draft-deleted",
      ]),
    })
    .strict(),
]);

export const compoundingDraftListResponseSchema = z
  .object({
    drafts: z.array(compoundingDraftSchema).max(128),
    ok: z.literal(true),
  })
  .strict();

export const compoundingDraftActionRequestSchema = z
  .object({
    attachProjectSkill: z.boolean().default(false),
    draftId: portableIdSchema,
    idempotencyKey: idempotencyKeySchema,
    editedCandidate: compoundingCandidateSchema.optional(),
    sourceLabel: z.string().trim().min(1).max(120).default("Owner"),
    sourceUrl: z.string().url().max(2_048).nullable().default(null),
  })
  .strict();

export const compoundingDraftDispositionRequestSchema = z
  .object({ draftId: portableIdSchema, idempotencyKey: idempotencyKeySchema })
  .strict();

export const compoundingDraftActionResponseSchema = z
  .object({
    draft: compoundingDraftSchema,
    effect: z.enum(["preference-saved", "skill-saved", "none"]),
    ok: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();

export const compoundingObservationResultSchema = z
  .object({
    createdDraftIds: z.array(portableIdSchema).max(4),
    observed: z.number().int().nonnegative().max(4),
  })
  .strict();

export type LearningSignal = z.infer<typeof learningSignalSchema>;
export type LearningSignals = z.infer<typeof learningSignalsSchema>;
export type CompoundingCandidate = z.infer<typeof compoundingCandidateSchema>;
export type CompoundingDraft = z.infer<typeof compoundingDraftSchema>;
export type CompoundingEvidence = z.infer<typeof compoundingEvidenceSchema>;
export type CompoundingRecordBody = z.infer<typeof compoundingRecordBodySchema>;
export type CompoundingDraftActionRequest = z.infer<
  typeof compoundingDraftActionRequestSchema
>;
export type CompoundingDraftDispositionRequest = z.infer<
  typeof compoundingDraftDispositionRequestSchema
>;
