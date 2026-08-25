import { z } from "./zod";

/**
 * A deliberately small, owner-only Project health receipt. These values are
 * local projections, not a success score and not a claim about the quality of
 * agent work.
 */
export const projectOutcomeReadinessSchema = z.enum([
  "not_started",
  "building",
  "ready",
]);

export const projectOutcomeAttentionSchema = z.enum([
  "checkpoint_again",
  "review_suggestions",
  "none",
]);

export const projectOutcomeSchema = z
  .object({
    checkpointedByMultipleClients: z.boolean(),
    latestCheckpointAt: z.number().int().nonnegative().nullable(),
    acceptedMemoryCount: z.number().int().nonnegative().max(10_000),
    pendingSuggestionCount: z.number().int().nonnegative().max(10_000),
    readiness: projectOutcomeReadinessSchema,
    attention: projectOutcomeAttentionSchema,
  })
  .strict();

export type ProjectOutcome = z.infer<typeof projectOutcomeSchema>;

export const projectOutcomeResponseSchema = z
  .object({
    ok: z.literal(true),
    outcome: projectOutcomeSchema,
  })
  .strict();

export type ProjectOutcomeResponse = z.infer<
  typeof projectOutcomeResponseSchema
>;
