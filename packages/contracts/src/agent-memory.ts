import { z } from "./zod";
import { MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS } from "./collaboration";
import {
  agentSkillPackageFileSchema,
  agentSkillSummarySchema,
  workingPreferenceSchema,
} from "./working-profile";
import { learningSignalsSchema } from "./compounding";

const portableIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedTextSchema = z.string().trim().min(1).max(4_096);
const boundedItemSchema = z.string().trim().min(1).max(1_024);
const boundedItemsSchema = z.array(boundedItemSchema).max(32);
const checkpointDetailSchema = z.string().trim().min(1).max(1_000);

export const agentMemoryWorkingProfileSchema = z
  .object({
    preferences: z.array(workingPreferenceSchema).max(256),
    skills: z.array(agentSkillSummarySchema).max(256),
  })
  .strict();

export const agentMemoryContextModeSchema = z.enum([
  "focused",
  "independent",
  "synthesis",
]);

export const agentMemoryCapabilityProfileSchema = z
  .object({
    format: z.literal("owd-agent-memory-capabilities-v2"),
    mcpProtocolRevision: z.literal("2025-11-25"),
    mcpTools: z.tuple([
      z.literal("owd_resume"),
      z.literal("owd_find"),
      z.literal("owd_checkpoint"),
      z.literal("owd_get_skill"),
    ]),
    portableRecovery: z
      .object({
        maxTotalObjectsWhenProfilePresent: z.literal(
          MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS,
        ),
        maxWorkingProfileRecordsPerRestore: z.literal(
          MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS,
        ),
        restoresAuthority: z.literal(false),
      })
      .strict(),
    requiredScope: z.literal("project.read"),
    resumeContextVersions: z.tuple([z.literal(1), z.literal(2)]),
    schemaVersion: z.literal(2),
    workingProfileSchemaVersion: z.literal(1),
  })
  .strict();

export const owdResumeRequestSchema = z
  .object({
    acceptedContextVersions: z
      .array(z.union([z.literal(1), z.literal(2)]))
      .min(1)
      .max(2)
      .default([1]),
    contextMode: agentMemoryContextModeSchema.default("focused"),
    projectId: portableIdSchema,
    task: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const agentMemoryCitationSchema = z
  .object({
    citationId: portableIdSchema,
    contentSha256: sha256Schema,
    excerptByteRange: z
      .object({
        endExclusive: z.number().int().positive(),
        start: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    generationId: portableIdSchema.nullable(),
    label: z.string().trim().min(1).max(1_024),
    path: z.string().min(1).max(1_024).nullable(),
    sourceType: z.enum([
      "project-source",
      "continuity-point",
      "shared-result",
      "materialized-note",
    ]),
    vaultId: portableIdSchema.nullable(),
  })
  .strict();

export const agentMemorySharedResultSchema = z
  .object({
    completed: boundedItemsSchema,
    contentSha256: sha256Schema,
    durableRecordId: portableIdSchema,
    provenance: z
      .object({
        producerLabel: z.string().trim().min(1).max(120),
        receivedAt: z.number().int().nonnegative(),
        verification: z.literal("authorization-bound-client"),
      })
      .strict(),
    provisionalDecisionNotes: boundedItemsSchema,
    risks: boundedItemsSchema,
    summary: boundedTextSchema,
    suggestedNextActions: boundedItemsSchema,
    unresolvedQuestions: boundedItemsSchema,
  })
  .strict();

export const agentMemoryContextSchema = z
  .object({
    brief: z
      .object({
        constraints: boundedItemsSchema,
        definitionOfDone: boundedItemsSchema,
        objective: boundedTextSchema,
        requestedOutput: boundedTextSchema,
      })
      .strict(),
    citations: z.array(agentMemoryCitationSchema).max(32),
    contextMode: agentMemoryContextModeSchema,
    currentState: z
      .object({
        acknowledgedAt: z.number().int().nonnegative(),
        blockers: boundedItemsSchema,
        completedWork: boundedItemsSchema,
        decisions: z
          .array(
            z
              .object({
                contentSha256: sha256Schema,
                rationale: boundedTextSchema,
                resolution: z.enum([
                  "accepted",
                  "rejected",
                  "mixed",
                  "deferred",
                ]),
              })
              .strict(),
          )
          .max(32),
        knownRejectedApproaches: boundedItemsSchema,
        nextAction: boundedItemSchema,
        openWork: boundedItemsSchema,
        provisionalDecisionNotes: boundedItemsSchema,
        risks: boundedItemsSchema,
      })
      .strict()
      .nullable(),
    localVaultAccess: z
      .object({
        basis: z.enum([
          "first-project-agent",
          "owner-transfer",
          "project-creator",
          "unassigned",
        ]),
        enforcement: z.literal("advisory"),
        handoffRule: z.literal("same-client-resume-only"),
        humanOwnerRetainsAuthority: z.literal(true),
        localWriteDefault: z.enum([
          "owner-requested-bounded-task-only",
          "read-only",
        ]),
        role: z.enum(["primary-writer", "read-only-collaborator"]),
        scope: z.literal("vault"),
        warning: z.string().min(1).max(4_096),
      })
      .strict(),
    omittedSections: z
      .object({
        continuityOperationalConclusions: z.boolean(),
        peerRecordBodies: z.boolean(),
        provisionalResults: z.boolean(),
      })
      .strict(),
    project: z
      .object({
        objective: boundedTextSchema,
        projectId: portableIdSchema,
      })
      .strict(),
    results: z.array(agentMemorySharedResultSchema).max(8),
    task: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (
      context.contextMode === "independent" &&
      (context.currentState !== null || context.results.length !== 0)
    ) {
      refinement.addIssue({
        code: "custom",
        message:
          "Independent context cannot contain continuity state or peer results.",
        path: ["contextMode"],
      });
    }
    if (context.contextMode === "focused" && context.results.length !== 0) {
      refinement.addIssue({
        code: "custom",
        message: "Focused context cannot contain peer result bodies.",
        path: ["results"],
      });
    }
    if (context.contextMode === "synthesis" && context.currentState !== null) {
      refinement.addIssue({
        code: "custom",
        message:
          "Synthesis context cannot contain unattributed continuity conclusions.",
        path: ["currentState"],
      });
    }
  });

export const owdResumeResponseSchema = z
  .object({
    checkpointBase: sha256Schema,
    context: agentMemoryContextSchema,
    contextMode: agentMemoryContextModeSchema,
    contextSha256: sha256Schema,
    contextVersion: z.literal(1),
    markdown: z
      .string()
      .min(1)
      .max(64 * 1_024),
    ok: z.literal(true),
    truncated: z.boolean(),
  })
  .strict();

export const owdResumeResponseV2Schema = z
  .object({
    checkpointBase: sha256Schema,
    context: agentMemoryContextSchema,
    contextMode: agentMemoryContextModeSchema,
    contextSha256: sha256Schema,
    contextVersion: z.literal(2),
    markdown: z
      .string()
      .min(1)
      .max(64 * 1_024),
    ok: z.literal(true),
    truncated: z.boolean(),
    workingProfile: agentMemoryWorkingProfileSchema,
  })
  .strict();

export const owdResumeCompatibleResponseSchema = z.union([
  owdResumeResponseSchema,
  owdResumeResponseV2Schema,
]);

export const owdFindRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(20).default(10),
    projectId: portableIdSchema,
    question: z.string().trim().min(1).max(500),
  })
  .strict();

export const owdGetSkillRequestSchema = z
  .object({
    projectId: portableIdSchema,
    skillId: portableIdSchema,
    versionRecordId: portableIdSchema,
  })
  .strict();

export const owdGetSkillResponseSchema = z
  .object({
    executes: z.literal(false),
    files: z.array(agentSkillPackageFileSchema).min(1).max(32),
    grantsAuthority: z.literal(false),
    markdown: z
      .string()
      .min(1)
      .max(384 * 1_024),
    ok: z.literal(true),
    packageSha256: sha256Schema,
    projectId: portableIdSchema,
    skill: agentSkillSummarySchema,
  })
  .strict();

export const owdFindResponseSchema = z
  .object({
    answer: z
      .string()
      .min(1)
      .max(16 * 1_024),
    citations: z.array(agentMemoryCitationSchema).max(20),
    coverage: z
      .object({
        ceiling: z.number().int().min(1).max(20),
        returned: z.number().int().nonnegative().max(20),
        searchedCurrentProjectBrief: z.literal(true),
        searchedExactCurrentLibrary: z.boolean(),
        searchedRecentProjectMemory: z.literal(true),
        recentProjectMemoryCeiling: z.number().int().min(1).max(20),
        truncated: z.boolean(),
      })
      .strict(),
    markdown: z
      .string()
      .min(1)
      .max(64 * 1_024),
    matches: z
      .array(
        z
          .object({
            citationId: portableIdSchema,
            excerpt: z.string().max(4_096),
            title: z.string().max(1_024),
          })
          .strict(),
      )
      .max(20),
    ok: z.literal(true),
    projectId: portableIdSchema,
    question: z.string().trim().min(1).max(500),
  })
  .strict();

const durableReferencesSchema = z
  .object({
    acceptedDecisionIds: z.array(portableIdSchema).max(32).optional(),
    artifactIds: z.array(portableIdSchema).max(32).optional(),
    citationIds: z.array(portableIdSchema).max(32).optional(),
  })
  .strict()
  .superRefine((references, refinement) => {
    for (const field of [
      "acceptedDecisionIds",
      "artifactIds",
      "citationIds",
    ] as const) {
      const values = references[field];
      if (values !== undefined && new Set(values).size !== values.length) {
        refinement.addIssue({
          code: "custom",
          message: "Durable references must be unique.",
          path: [field],
        });
      }
    }
  });

export const owdCheckpointRequestSchema = z
  .object({
    blockers: boundedItemsSchema.default([]),
    checkpointBase: sha256Schema,
    contextMode: agentMemoryContextModeSchema.default("focused"),
    decisions: z.array(checkpointDetailSchema).max(31).default([]),
    durableReferences: durableReferencesSchema.optional(),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/u),
    learningSignals: learningSignalsSchema.default([]),
    nextAction: boundedItemSchema,
    outcome: boundedItemSchema,
    projectId: portableIdSchema,
    remainingWork: boundedItemsSchema.default([]),
    risks: boundedItemsSchema.default([]),
    usefulFailures: boundedItemsSchema.default([]),
    verificationEvidence: z.array(checkpointDetailSchema).max(31).default([]),
  })
  .strict()
  .superRefine((request, refinement) => {
    if (
      1 + request.decisions.length + request.verificationEvidence.length >
      32
    ) {
      refinement.addIssue({
        code: "custom",
        message:
          "Outcome, decisions, and verification evidence exceed the checkpoint state budget.",
        path: ["outcome"],
      });
    }
  });

export const owdCheckpointResponseSchema = z
  .object({
    checkpoint: z
      .object({
        acknowledgedAt: z.number().int().nonnegative(),
        contentSha256: sha256Schema,
        continuityPointId: portableIdSchema,
        previousContinuityPointId: portableIdSchema.nullable(),
        projectId: portableIdSchema,
      })
      .strict(),
    markdown: z
      .string()
      .min(1)
      .max(16 * 1_024),
    nextAction: boundedItemSchema,
    ok: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();

export type AgentMemoryContextMode = z.infer<
  typeof agentMemoryContextModeSchema
>;
export type AgentMemoryContext = z.infer<typeof agentMemoryContextSchema>;
export type OwdResumeRequest = z.infer<typeof owdResumeRequestSchema>;
export type OwdResumeResponse = z.infer<
  typeof owdResumeCompatibleResponseSchema
>;
export type OwdFindRequest = z.infer<typeof owdFindRequestSchema>;
export type OwdFindResponse = z.infer<typeof owdFindResponseSchema>;
export type OwdGetSkillRequest = z.infer<typeof owdGetSkillRequestSchema>;
export type OwdGetSkillResponse = z.infer<typeof owdGetSkillResponseSchema>;
export type OwdCheckpointRequest = z.infer<typeof owdCheckpointRequestSchema>;
export type OwdCheckpointResponse = z.infer<typeof owdCheckpointResponseSchema>;
