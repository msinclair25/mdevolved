import { z } from "./zod";
import { workItemBriefSchema, workPacketSchema } from "./collaboration";
import { completionModeSchema } from "./policy-operation";

export const OWD_PROJECT_POLICY_FORMAT = "owd-project-policy-v1" as const;
export const OWD_RUN_FORMAT = "owd-run-v1" as const;
export const OWD_ACTOR_FORMAT = "owd-actor-v1" as const;
export const OWD_EVENT_BUNDLE_FORMAT = "owd-event-bundle-v1" as const;
export const OWD_PROJECT_EXCEPTION_FORMAT = "owd-project-exception-v1" as const;
export const OWD_RUN_CONTEXT_FORMAT = "owd-run-context-v1" as const;
export const OWD_LEAD_OPERATION_CAPABILITIES_FORMAT =
  "owd-lead-operation-capabilities-v1" as const;
export const OWD_ELASTIC_RUN_PLANE_FORMAT = "owd-elastic-run-plane-v1" as const;
export const OWD_ELASTIC_ACCOUNT_FORMAT = "owd-elastic-account-v1" as const;
export const OWD_ACTOR_RECOVERY_FORMAT = "owd-actor-recovery-v1" as const;
export const OWD_RUN_DELTA_FORMAT = "owd-run-delta-v1" as const;
export const OWD_RUN_BUDGET_FORMAT = "owd-run-budget-v1" as const;
export const OWD_BUDGET_ENTRY_FORMAT = "owd-budget-entry-v1" as const;
export const OWD_RUN_OBSERVATION_FORMAT = "owd-run-observation-v1" as const;
export const OWD_ORCA_PROJECTION_FORMAT = "owd-orca-projection-v1" as const;
export const OWD_R3_CAPABILITIES_FORMAT =
  "owd-lead-operation-capabilities-v2" as const;

export const MAX_R2_ACTORS_PER_RUN = 8;
export const MAX_R2_BUNDLES_PER_RUN = 64;
export const MAX_R2_EVENTS_PER_BUNDLE = 16;
export const MAX_R2_BUNDLE_BYTES = 256 * 1024;
export const MAX_R2_RUN_LOGICAL_BYTES = 4 * 1024 * 1024;
export const MAX_R3_ACTIVE_ACTORS = 32;
export const MAX_R3_ACTOR_RECORDS = 64;
export const MAX_R3_REGISTER_BATCH = 16;
export const MAX_R3_BUNDLE_BATCH = 8;
export const MAX_R3_DELTA_PAGE = 100;
export const MAX_R3_METADATA_BYTES = 8 * 1024;
export const MAX_R3_OBSERVATION_BYTES = 4 * 1024;

const idSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.number().int().nonnegative();
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const orcaReference = (max: number) =>
  boundedText(max).refine((value) => !/[?#\p{Cc}]/u.test(value), {
    message:
      "Orca references must not contain query strings or control characters.",
  });
const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) bytes += 1;
    else if (codeUnit < 0x800) bytes += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};
const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const leadOperationScopeSchema = z.enum([
  "run.context.read",
  "run.bundle.submit",
  "run.review.submit",
]);
export type LeadOperationScope = z.infer<typeof leadOperationScopeSchema>;

const authorityFlagsSchema = z
  .object({
    restoredAuthorityAllowed: z.literal(false),
    liveAuthorityIncluded: z.literal(false),
  })
  .strict();

export const projectPolicySchema = z
  .object({
    format: z.literal(OWD_PROJECT_POLICY_FORMAT),
    schemaVersion: z.literal(1),
    policyId: idSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    createdAt: timestampSchema,
    maxActorsPerRun: z.literal(MAX_R2_ACTORS_PER_RUN),
    maxBundlesPerRun: z.literal(MAX_R2_BUNDLES_PER_RUN),
    maxEventsPerBundle: z.literal(MAX_R2_EVENTS_PER_BUNDLE),
    maxBundleBytes: z.literal(MAX_R2_BUNDLE_BYTES),
    maxRunLogicalBytes: z.literal(MAX_R2_RUN_LOGICAL_BYTES),
    independentReviewRequired: z.literal(true),
    protectedPaths: z
      .array(z.enum([".git", ".mdevolvedignore", ".obsidian", ".owdignore"]))
      .min(3)
      .max(4),
    exceptionOnlyActions: z
      .array(
        z.enum([
          "authority-expansion",
          "destructive-action",
          "protected-path-access",
        ]),
      )
      .length(3),
    source: z.literal("project-version-bound-default"),
    liveAuthorityIncluded: z.literal(false),
    restoredAuthorityAllowed: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    const protectedPaths = new Set(value.protectedPaths);
    const currentProtectedPaths = [
      ".git",
      ".mdevolvedignore",
      ".obsidian",
    ] as const;
    const legacyProtectedPaths = [".git", ".owdignore", ".obsidian"] as const;
    if (
      protectedPaths.size !== value.protectedPaths.length ||
      (!currentProtectedPaths.every((path) => protectedPaths.has(path)) &&
        !legacyProtectedPaths.every((path) => protectedPaths.has(path)))
    ) {
      context.addIssue({
        code: "custom",
        message: "Protected paths must be exact and unique.",
        path: ["protectedPaths"],
      });
    }
    if (new Set(value.exceptionOnlyActions).size !== 3) {
      context.addIssue({
        code: "custom",
        message: "Exception-only actions must be unique.",
        path: ["exceptionOnlyActions"],
      });
    }
  });
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

export const runPurposeSchema = z.enum(["research", "coding"]);
export const runStatusSchema = z.enum([
  "active",
  "completed",
  "aborted",
  "restored-inert",
]);
export const runSchema = z
  .object({
    completionMode: z.literal("solo-verified").optional(),
    format: z.literal(OWD_RUN_FORMAT),
    schemaVersion: z.literal(1),
    runId: idSchema,
    projectId: idSchema,
    workItemId: idSchema,
    policyId: idSchema,
    purpose: runPurposeSchema,
    status: runStatusSchema,
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    logicalBytes: z.number().int().nonnegative().max(MAX_R2_RUN_LOGICAL_BYTES),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "completed" && value.completedAt === null) {
      context.addIssue({
        code: "custom",
        message: "Completed runs need a completion time.",
        path: ["completedAt"],
      });
    }
    if (value.status !== "completed" && value.completedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "Only completed runs may have a completion time.",
        path: ["completedAt"],
      });
    }
  });
export type Run = z.infer<typeof runSchema>;

export const actorSchema = z
  .object({
    format: z.literal(OWD_ACTOR_FORMAT),
    schemaVersion: z.literal(1),
    actorId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    workItemId: idSchema,
    claimedIdentity: boundedText(256),
    scopes: z.array(leadOperationScopeSchema).min(1).max(3),
    issuedAt: timestampSchema,
    expiresAt: z.number().int().positive(),
    revokedAt: timestampSchema.nullable(),
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "Actor expiry must be after issue time.",
        path: ["expiresAt"],
      });
    }
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({
        code: "custom",
        message: "Actor scopes must be unique.",
        path: ["scopes"],
      });
    }
  });
export type Actor = z.infer<typeof actorSchema>;

const claimSchema = z
  .object({
    key: boundedText(128),
    valueSha256: hashSchema,
    evidenceSha256: hashSchema.nullable(),
  })
  .strict();

const resultProvisionalEventSchema = z
  .object({
    eventType: z.literal("result.provisional"),
    eventId: idSchema,
    actorId: idSchema,
    runId: idSchema,
    summary: boundedText(8_192),
    claims: z.array(claimSchema).max(MAX_R2_EVENTS_PER_BUNDLE),
  })
  .strict()
  .superRefine((value, context) => {
    if (utf8ByteLength(JSON.stringify(value)) > 512 * 1024)
      context.addIssue({
        code: "custom",
        message: "Delta page exceeds the byte budget.",
        path: ["deltas"],
      });
    if (
      new Set(value.claims.map((claim) => claim.key)).size !==
      value.claims.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Claim keys must be unique.",
        path: ["claims"],
      });
    }
  });

const reviewRequestedEventSchema = z
  .object({
    eventType: z.literal("review.requested"),
    eventId: idSchema,
    actorId: idSchema,
    runId: idSchema,
    targetBundleId: idSchema,
    reviewerActorId: idSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorId === value.reviewerActorId) {
      context.addIssue({
        code: "custom",
        message: "Review requests must route to an independent actor.",
        path: ["reviewerActorId"],
      });
    }
  });

const reviewCompletedEventSchema = z
  .object({
    eventType: z.literal("review.completed"),
    eventId: idSchema,
    actorId: idSchema,
    runId: idSchema,
    targetBundleId: idSchema,
    verdict: z.enum([
      "pass",
      "pass-with-findings",
      "changes-requested",
      "inconclusive",
    ]),
    summary: boundedText(8_192),
    findings: z.array(boundedText(2_048)).max(16),
  })
  .strict();

export const runEventSchema = z.discriminatedUnion("eventType", [
  resultProvisionalEventSchema,
  reviewRequestedEventSchema,
  reviewCompletedEventSchema,
]);
export type RunEvent = z.infer<typeof runEventSchema>;

export const eventBundleSchema = z
  .object({
    format: z.literal(OWD_EVENT_BUNDLE_FORMAT),
    schemaVersion: z.literal(1),
    bundleId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    actorId: idSchema,
    visibility: z.literal("run-shared-unvetted"),
    createdAt: timestampSchema,
    events: z.array(runEventSchema).min(1).max(MAX_R2_EVENTS_PER_BUNDLE),
    requestedActions: z
      .array(
        z.enum([
          "authority-expansion",
          "destructive-action",
          "protected-path-access",
        ]),
      )
      .max(3)
      .default([]),
    normalizedRelativePath: z.string().max(1_024).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const encodedLength = utf8ByteLength(JSON.stringify(value));
    if (encodedLength > MAX_R2_BUNDLE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Event bundle exceeds the byte budget.",
        path: ["events"],
      });
    }
    for (const [index, event] of value.events.entries()) {
      if (event.runId !== value.runId || event.actorId !== value.actorId) {
        context.addIssue({
          code: "custom",
          message: "Event identity must match its containing bundle.",
          path: ["events", index],
        });
      }
    }
    if (
      new Set(value.events.map((event) => event.eventId)).size !==
      value.events.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Event IDs must be unique.",
        path: ["events"],
      });
    }
    if (
      new Set(value.requestedActions).size !== value.requestedActions.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Requested actions must be unique.",
        path: ["requestedActions"],
      });
    }
    const path = value.normalizedRelativePath;
    const protectedPathRequested = value.requestedActions.includes(
      "protected-path-access",
    );
    const firstSegment = path?.split("/")[0];
    if (
      (protectedPathRequested && path === null) ||
      (!protectedPathRequested && path !== null) ||
      (path !== null &&
        (path !== path.normalize("NFC") ||
          /[\p{Cc}\p{Cf}]/u.test(path) ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some(
              (part) => part === "." || part === ".." || part.length === 0,
            ) ||
          ![".git", ".mdevolvedignore", ".owdignore", ".obsidian"].includes(
            firstSegment ?? "",
          )))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Protected paths must be normalized relative paths under an exact protected root.",
        path: ["normalizedRelativePath"],
      });
    }
    const targetIds = value.events.flatMap((event) =>
      "targetBundleId" in event ? [event.targetBundleId] : [],
    );
    if (targetIds.includes(value.bundleId)) {
      context.addIssue({
        code: "custom",
        message: "A bundle cannot review itself.",
        path: ["events"],
      });
    }
  });
export type EventBundle = z.infer<typeof eventBundleSchema>;

export const exceptionKindSchema = z.enum([
  "authority-expansion",
  "destructive-action",
  "protected-path-access",
  "budget-exhausted",
  "evidence-conflict",
  "review-independence",
  "actor-scope",
]);
export const projectExceptionSchema = z
  .object({
    format: z.literal(OWD_PROJECT_EXCEPTION_FORMAT),
    schemaVersion: z.literal(1),
    exceptionId: idSchema,
    projectId: idSchema,
    runId: idSchema.nullable(),
    workItemId: idSchema.nullable(),
    actorId: idSchema.nullable(),
    kind: exceptionKindSchema,
    status: z.enum(["open", "blocking", "resolved"]),
    requestedAction: z
      .enum([
        "authority-expansion",
        "destructive-action",
        "protected-path-access",
      ])
      .nullable(),
    normalizedRelativePath: z.string().max(1_024).nullable(),
    summary: boundedText(8_192),
    evidenceRefs: z.array(hashSchema).max(64),
    createdAt: timestampSchema,
    resolvedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "resolved" && value.resolvedAt === null)
      context.addIssue({
        code: "custom",
        message: "Resolved exceptions need a timestamp.",
        path: ["resolvedAt"],
      });
    if (value.status !== "resolved" && value.resolvedAt !== null)
      context.addIssue({
        code: "custom",
        message: "Open exceptions cannot have a resolution timestamp.",
        path: ["resolvedAt"],
      });
    const path = value.normalizedRelativePath;
    const protectedPathException =
      value.requestedAction === "protected-path-access";
    const firstSegment = path?.split("/")[0];
    if (
      (protectedPathException && path === null) ||
      (!protectedPathException && path !== null) ||
      (path !== null &&
        (path === "" ||
          path !== path.normalize("NFC") ||
          /[\p{Cc}\p{Cf}]/u.test(path) ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some(
              (part) => part === "." || part === ".." || part.length === 0,
            ) ||
          ![".git", ".mdevolvedignore", ".owdignore", ".obsidian"].includes(
            firstSegment ?? "",
          )))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Protected path exceptions require a normalized path under an exact protected root.",
        path: ["normalizedRelativePath"],
      });
    }
  });
export type ProjectException = z.infer<typeof projectExceptionSchema>;

export const runContextSchema = z
  .object({
    format: z.literal(OWD_RUN_CONTEXT_FORMAT),
    schemaVersion: z.literal(1),
    projectId: idSchema,
    run: runSchema,
    policy: projectPolicySchema,
    workPacket: workPacketSchema,
    actors: z.array(actorSchema).max(MAX_R2_ACTORS_PER_RUN),
    acceptedBundles: z.array(eventBundleSchema).max(MAX_R2_BUNDLES_PER_RUN),
    exceptions: z.array(projectExceptionSchema).max(64),
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.run.projectId !== value.projectId ||
      value.policy.projectId !== value.projectId
    )
      context.addIssue({
        code: "custom",
        message: "Context envelope IDs must agree.",
        path: ["projectId"],
      });
    for (const [index, actor] of value.actors.entries())
      if (
        actor.projectId !== value.projectId ||
        actor.runId !== value.run.runId
      )
        context.addIssue({
          code: "custom",
          message: "Actor is outside the context run.",
          path: ["actors", index],
        });
    for (const [index, bundle] of value.acceptedBundles.entries())
      if (
        bundle.projectId !== value.projectId ||
        bundle.runId !== value.run.runId
      )
        context.addIssue({
          code: "custom",
          message: "Bundle is outside the context run.",
          path: ["acceptedBundles", index],
        });
  });
export type RunContext = z.infer<typeof runContextSchema>;

export const mutationEnvelopeSchema = z
  .object({
    projectId: idSchema,
    leaseId: idSchema,
    fencingToken: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

const receiptBaseSchema = z
  .object({
    projectId: idSchema,
    operation: boundedText(64),
    idempotencyKey: idempotencyKeySchema,
    receivedAt: timestampSchema,
    requestSha256: hashSchema,
  })
  .strict();

export const createWorkItemRequestSchema = mutationEnvelopeSchema
  .extend({
    workItemBrief: workItemBriefSchema,
    requestedRole: z
      .object({ authority: z.literal("none"), label: boundedText(64) })
      .strict(),
    packetExpiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60),
    sourceWorkPacketId: idSchema.optional(),
  })
  .strict();
export const createWorkItemReceiptSchema = receiptBaseSchema
  .extend({ operation: z.literal("create_work_item"), workItemId: idSchema })
  .strict();
export const startRunRequestSchema = mutationEnvelopeSchema
  .extend({
    completionMode: completionModeSchema.optional(),
    workItemId: idSchema,
    purpose: runPurposeSchema,
    elastic: z
      .object({ profile: z.literal(OWD_ELASTIC_RUN_PLANE_FORMAT) })
      .strict()
      .optional(),
  })
  .strict();
export const startRunReceiptSchema = receiptBaseSchema
  .extend({ operation: z.literal("start_run"), run: runSchema })
  .strict();
export const registerActorRequestSchema = mutationEnvelopeSchema
  .extend({
    runId: idSchema,
    workItemId: idSchema,
    actorId: idSchema,
    claimedIdentity: boundedText(256),
    scopes: z.array(leadOperationScopeSchema).min(1).max(3),
    lifetimeSeconds: z
      .number()
      .int()
      .positive()
      .max(15 * 60),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length)
      context.addIssue({
        code: "custom",
        message: "Actor scopes must be unique.",
        path: ["scopes"],
      });
  });
export const registerActorReceiptSchema = receiptBaseSchema
  .extend({ operation: z.literal("register_actor"), actor: actorSchema })
  .strict();
export const getRunContextRequestSchema = z
  .object({
    actorId: idSchema.optional(),
    projectId: idSchema,
    runId: idSchema,
    mode: z.enum(["snapshot", "delta"]).optional(),
    cursor: z.string().trim().min(1).max(2_048).optional(),
    limit: z.number().int().positive().max(MAX_R3_DELTA_PAGE).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mode !== "delta" &&
      (value.cursor !== undefined || value.limit !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cursor and limit require delta mode.",
        path: ["mode"],
      });
    }
  });
export const getRunContextReceiptSchema = z
  .object({
    operation: z.literal("get_run_context"),
    context: runContextSchema,
  })
  .strict();
export const submitBundleRequestSchema = mutationEnvelopeSchema
  .extend({ runId: idSchema, bundle: eventBundleSchema })
  .strict()
  .superRefine((value, context) => {
    if (
      value.bundle.projectId !== value.projectId ||
      value.bundle.runId !== value.runId
    )
      context.addIssue({
        code: "custom",
        message: "Bundle IDs must match request IDs.",
        path: ["bundle"],
      });
  });
export const submitBundleReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("submit_bundle"),
    bundleId: idSchema,
    accepted: z.literal(true),
  })
  .strict();
export const completeWorkItemRequestSchema = mutationEnvelopeSchema
  .extend({
    runId: idSchema,
    workItemId: idSchema,
    outcome: boundedText(8_192),
  })
  .strict();
export const completeWorkItemReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("complete_work_item"),
    workItemId: idSchema,
    completed: z.literal(true),
  })
  .strict();
export const listProjectExceptionsRequestSchema = z
  .object({
    projectId: idSchema,
    status: z.enum(["open", "blocking", "resolved"]).optional(),
  })
  .strict();
export const listProjectExceptionsReceiptSchema = z
  .object({
    operation: z.literal("list_project_exceptions"),
    projectId: idSchema,
    exceptions: z.array(projectExceptionSchema).max(256),
  })
  .strict();

const retentionMetadataSchema = z
  .object({
    retentionTier: z.enum(["hot", "warm", "cold", "quarantine"]),
    retainUntil: timestampSchema,
  })
  .strict();

const boundedMetadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine(
    (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_R3_METADATA_BYTES,
    {
      message: "Metadata exceeds the byte budget.",
    },
  );

export const elasticRunProfileSchema = z
  .object({
    profile: z.literal(OWD_ELASTIC_RUN_PLANE_FORMAT),
    maxActiveActors: z.literal(MAX_R3_ACTIVE_ACTORS),
    maxActorRecords: z.literal(MAX_R3_ACTOR_RECORDS),
    maxRegisterBatch: z.literal(MAX_R3_REGISTER_BATCH),
    maxBundleBatch: z.literal(MAX_R3_BUNDLE_BATCH),
    maxDeltaPage: z.literal(MAX_R3_DELTA_PAGE),
    authority: authorityFlagsSchema,
  })
  .strict();
export type ElasticRunProfile = z.infer<typeof elasticRunProfileSchema>;

export const actorRegistrationInputSchema = z
  .object({
    actorId: idSchema,
    claimedIdentity: boundedText(256),
    scopes: z.array(leadOperationScopeSchema).min(1).max(3),
    lifetimeSeconds: z
      .number()
      .int()
      .positive()
      .max(15 * 60),
    metadata: boundedMetadataSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length)
      context.addIssue({
        code: "custom",
        message: "Actor scopes must be unique.",
        path: ["scopes"],
      });
  });

export const registerActorsBatchRequestSchema = mutationEnvelopeSchema
  .extend({
    runId: idSchema,
    workItemId: idSchema,
    actors: z
      .array(actorRegistrationInputSchema)
      .min(1)
      .max(MAX_R3_REGISTER_BATCH),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.actors.map((actor) => actor.actorId)).size !==
      value.actors.length
    )
      context.addIssue({
        code: "custom",
        message: "Actor IDs must be unique in a batch.",
        path: ["actors"],
      });
  });
export const registerActorsBatchReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("register_actors_batch"),
    runId: idSchema,
    actors: z.array(actorSchema).max(MAX_R3_REGISTER_BATCH),
    replayed: z.boolean(),
  })
  .strict();

export const submitBundlesBatchRequestSchema = mutationEnvelopeSchema
  .extend({
    runId: idSchema,
    items: z
      .array(
        z
          .object({
            bundle: eventBundleSchema,
            usage: z
              .object({
                logicalUnits: z.number().int().nonnegative(),
                costMicrounits: z.number().int().nonnegative(),
                reportedBy: boundedText(256),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_R3_BUNDLE_BATCH),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      const bundle = item.bundle;
      if (bundle.projectId !== value.projectId || bundle.runId !== value.runId)
        context.addIssue({
          code: "custom",
          message: "Bundle IDs must match request IDs.",
          path: ["items", index, "bundle"],
        });
      if (ids.has(bundle.bundleId))
        context.addIssue({
          code: "custom",
          message: "Bundle IDs must be unique in a batch.",
          path: ["items", index, "bundle", "bundleId"],
        });
      if (item.usage.logicalUnits === 0 && item.usage.costMicrounits === 0)
        context.addIssue({
          code: "custom",
          message: "Bundle usage must report logical units or cost.",
          path: ["items", index, "usage"],
        });
      ids.add(bundle.bundleId);
    }
  });
export const submitBundlesBatchReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("submit_bundles_batch"),
    runId: idSchema,
    bundleIds: z.array(idSchema).max(MAX_R3_BUNDLE_BATCH),
    replayed: z.boolean(),
  })
  .strict();

export const runDeltaCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/^[A-Za-z0-9._~-]+$/u);
export const getRunDeltaRequestSchema = z
  .object({
    actorId: idSchema.optional(),
    projectId: idSchema,
    runId: idSchema,
    cursor: runDeltaCursorSchema.optional(),
    limit: z.number().int().positive().max(MAX_R3_DELTA_PAGE).optional(),
  })
  .strict();
export const runDeltaSchema = z
  .object({
    format: z.literal(OWD_RUN_DELTA_FORMAT),
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    projectId: idSchema,
    runId: idSchema,
    recordType: z.enum([
      "actor",
      "event-bundle",
      "recovery",
      "budget",
      "observation",
      "orca",
    ]),
    recordId: idSchema,
    contentSha256: hashSchema.nullable(),
    evidenceMetadata: boundedMetadataSchema.optional(),
    occurredAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.metadata.retainUntil < value.occurredAt)
      context.addIssue({
        code: "custom",
        message: "Delta retention cannot precede occurrence.",
        path: ["metadata", "retainUntil"],
      });
  });
export type RunDelta = z.infer<typeof runDeltaSchema>;
export const runDeltaPageSchema = z
  .object({
    format: z.literal(OWD_RUN_DELTA_FORMAT),
    schemaVersion: z.literal(1),
    projectId: idSchema,
    runId: idSchema,
    cursor: runDeltaCursorSchema.nullable(),
    hasMore: z.boolean(),
    deltas: z.array(runDeltaSchema).max(MAX_R3_DELTA_PAGE),
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.deltas.length === MAX_R3_DELTA_PAGE &&
      value.cursor === null &&
      value.hasMore
    )
      context.addIssue({
        code: "custom",
        message: "A non-null cursor is required when more deltas exist.",
        path: ["cursor"],
      });
    for (const [index, delta] of value.deltas.entries()) {
      if (delta.projectId !== value.projectId || delta.runId !== value.runId)
        context.addIssue({
          code: "custom",
          message: "Delta identity is outside the requested Run.",
          path: ["deltas", index],
        });
    }
  });

export const actorRecoverySchema = z
  .object({
    format: z.literal(OWD_ACTOR_RECOVERY_FORMAT),
    schemaVersion: z.literal(1),
    recoveryId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    abandonedActorId: idSchema,
    replacementActorId: idSchema,
    reason: z.enum(["abandoned", "expired"]),
    detectedAt: timestampSchema,
    recoveredAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.abandonedActorId === value.replacementActorId)
      context.addIssue({
        code: "custom",
        message: "Recovery must use a distinct actor.",
        path: ["replacementActorId"],
      });
    if (value.recoveredAt < value.detectedAt)
      context.addIssue({
        code: "custom",
        message: "Recovery cannot precede detection.",
        path: ["recoveredAt"],
      });
    if (value.metadata.retainUntil < value.recoveredAt)
      context.addIssue({
        code: "custom",
        message: "Recovery retention cannot precede recovery.",
        path: ["metadata", "retainUntil"],
      });
  });

export const runBudgetSchema = z
  .object({
    format: z.literal(OWD_RUN_BUDGET_FORMAT),
    schemaVersion: z.literal(1),
    budgetId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    logicalUnitLimit: z.number().int().positive(),
    costMicrounitLimit: z.number().int().nonnegative(),
    logicalUnitsUsed: z.number().int().nonnegative(),
    costMicrounitsUsed: z.number().int().nonnegative(),
    updatedAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.logicalUnitsUsed > value.logicalUnitLimit)
      context.addIssue({
        code: "custom",
        message: "Logical-unit budget is exhausted.",
        path: ["logicalUnitsUsed"],
      });
    if (value.costMicrounitsUsed > value.costMicrounitLimit)
      context.addIssue({
        code: "custom",
        message: "Cost budget is exhausted.",
        path: ["costMicrounitsUsed"],
      });
    if (value.metadata.retainUntil < value.updatedAt)
      context.addIssue({
        code: "custom",
        message: "Budget retention cannot precede its update.",
        path: ["metadata", "retainUntil"],
      });
  });
export const budgetEntrySchema = z
  .object({
    format: z.literal(OWD_BUDGET_ENTRY_FORMAT),
    schemaVersion: z.literal(1),
    entryId: idSchema,
    budgetId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    actorId: idSchema.nullable(),
    logicalUnits: z.number().int().nonnegative(),
    costMicrounits: z.number().int().nonnegative(),
    reportedBy: boundedText(256),
    harnessReported: z.literal(true),
    createdAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.logicalUnits === 0 && value.costMicrounits === 0)
      context.addIssue({
        code: "custom",
        message: "A budget entry must report logical units or cost.",
        path: ["logicalUnits"],
      });
    if (value.metadata.retainUntil < value.createdAt)
      context.addIssue({
        code: "custom",
        message: "Budget-entry retention cannot precede creation.",
        path: ["metadata", "retainUntil"],
      });
  });

export const runObservationSchema = z
  .object({
    format: z.literal(OWD_RUN_OBSERVATION_FORMAT),
    schemaVersion: z.literal(1),
    observationId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    actorCount: z.number().int().nonnegative().max(MAX_R3_ACTOR_RECORDS),
    activeActorCount: z.number().int().nonnegative().max(MAX_R3_ACTIVE_ACTORS),
    acceptedBundleCount: z.number().int().nonnegative(),
    deltaPageCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    p50LatencyMs: z.number().int().nonnegative(),
    p95LatencyMs: z.number().int().nonnegative(),
    ownerActionCount: z.number().int().nonnegative(),
    rawContentIncluded: z.literal(false),
    transcriptsIncluded: z.literal(false),
    hiddenReasoningIncluded: z.literal(false),
    terminalHistoryIncluded: z.literal(false),
    credentialsIncluded: z.literal(false),
    oauthStateIncluded: z.literal(false),
    providerRuntimeIncluded: z.literal(false),
    productionLogsIncluded: z.literal(false),
    measuredAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.p95LatencyMs < value.p50LatencyMs)
      context.addIssue({
        code: "custom",
        message: "p95 latency must be >= p50 latency.",
        path: ["p95LatencyMs"],
      });
    if (value.metadata.retainUntil < value.measuredAt)
      context.addIssue({
        code: "custom",
        message: "Observation retention cannot precede measurement.",
        path: ["metadata", "retainUntil"],
      });
  });

export const orcaProjectionSchema = z
  .object({
    format: z.literal(OWD_ORCA_PROJECTION_FORMAT),
    schemaVersion: z.literal(1),
    projectionId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    actorId: idSchema.nullable(),
    worktreeRef: orcaReference(512).nullable(),
    branchRef: orcaReference(256).nullable(),
    commitSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
      .nullable(),
    pullRequestRef: orcaReference(512).nullable(),
    sessionRef: orcaReference(512).nullable(),
    provider: z.literal("orca"),
    observedAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (utf8ByteLength(JSON.stringify(value)) > MAX_R3_METADATA_BYTES + 2_048)
      context.addIssue({
        code: "custom",
        message: "Orca metadata exceeds the byte budget.",
        path: ["metadata"],
      });
    if (value.metadata.retainUntil < value.observedAt)
      context.addIssue({
        code: "custom",
        message: "Orca retention cannot precede observation.",
        path: ["metadata", "retainUntil"],
      });
  });

export const elasticRunPlaneSchema = z
  .object({
    format: z.literal(OWD_ELASTIC_RUN_PLANE_FORMAT),
    schemaVersion: z.literal(1),
    projectId: idSchema,
    runId: idSchema,
    createdAt: timestampSchema,
    profile: elasticRunProfileSchema,
    retention: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retention.retainUntil < value.createdAt)
      context.addIssue({
        code: "custom",
        message: "Plane retention cannot precede creation.",
        path: ["retention", "retainUntil"],
      });
  });

export const elasticAccountSchema = z
  .object({
    format: z.literal(OWD_ELASTIC_ACCOUNT_FORMAT),
    schemaVersion: z.literal(1),
    accountId: idSchema,
    projectId: idSchema,
    runId: idSchema,
    activeActorCount: z.number().int().nonnegative().max(MAX_R3_ACTIVE_ACTORS),
    actorRecordCount: z.number().int().nonnegative().max(MAX_R3_ACTOR_RECORDS),
    acceptedBundleCount: z.number().int().nonnegative(),
    updatedAt: timestampSchema,
    metadata: retentionMetadataSchema,
    authority: authorityFlagsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.metadata.retainUntil < value.updatedAt)
      context.addIssue({
        code: "custom",
        message: "Account retention cannot precede its update.",
        path: ["metadata", "retainUntil"],
      });
  });

export const startElasticRunReceiptSchema = startRunReceiptSchema
  .extend({
    elastic: z
      .object({
        budget: runBudgetSchema,
        plane: elasticRunPlaneSchema,
      })
      .strict(),
  })
  .strict();

export const recoverActorRequestSchema = mutationEnvelopeSchema
  .extend({
    runId: idSchema,
    workItemId: idSchema,
    abandonedActorId: idSchema,
    reason: z.enum(["abandoned", "expired"]),
    detectedAt: timestampSchema,
    allowedScopes: z.array(leadOperationScopeSchema).min(1).max(3),
    replacement: actorRegistrationInputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedScopes).size !== value.allowedScopes.length)
      context.addIssue({
        code: "custom",
        message: "Allowed scopes must be unique.",
        path: ["allowedScopes"],
      });
    for (const scope of value.replacement.scopes) {
      if (!value.allowedScopes.includes(scope))
        context.addIssue({
          code: "custom",
          message: "Replacement scopes must be a subset of allowed scopes.",
          path: ["replacement", "scopes"],
        });
    }
    if (value.abandonedActorId === value.replacement.actorId)
      context.addIssue({
        code: "custom",
        message: "Recovery must use a distinct actor.",
        path: ["replacement", "actorId"],
      });
  });
export const recoverActorReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("recover_actor"),
    recovery: actorRecoverySchema,
  })
  .strict();
export const getRunDeltaReceiptSchema = z
  .object({ operation: z.literal("get_run_delta"), page: runDeltaPageSchema })
  .strict();
export const submitBudgetEntryRequestSchema = mutationEnvelopeSchema
  .extend({ entry: budgetEntrySchema })
  .strict();
export const submitBudgetEntryReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("submit_budget_entry"),
    entryId: idSchema,
    accepted: z.literal(true),
  })
  .strict();
export const submitObservationRequestSchema = mutationEnvelopeSchema
  .extend({ observation: runObservationSchema })
  .strict();
export const submitObservationReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("submit_observation"),
    observationId: idSchema,
    accepted: z.literal(true),
  })
  .strict();
export const projectOrcaMetadataRequestSchema = mutationEnvelopeSchema
  .extend({ projection: orcaProjectionSchema })
  .strict();
export const projectOrcaMetadataReceiptSchema = receiptBaseSchema
  .extend({
    operation: z.literal("project_orca_metadata"),
    projectionId: idSchema,
    accepted: z.literal(true),
  })
  .strict();

export const leadOperationOverviewSchema = z
  .object({
    format: z.literal("owd-lead-operation-overview-v1"),
    schemaVersion: z.literal(1),
    projects: z
      .array(
        z
          .object({
            projectId: idSchema,
            activeRunCount: z.number().int().nonnegative(),
            activeActorCount: z.number().int().nonnegative(),
            blockingExceptionCount: z.number().int().nonnegative(),
            lastRunActivityAt: timestampSchema.nullable(),
            recentExceptions: z.array(projectExceptionSchema).max(5),
          })
          .strict(),
      )
      .max(256),
    authority: authorityFlagsSchema,
  })
  .strict();
export type LeadOperationOverview = z.infer<typeof leadOperationOverviewSchema>;

export const elasticOperationOverviewSchema = z
  .object({
    format: z.literal("owd-elastic-operation-overview-v1"),
    schemaVersion: z.literal(1),
    runs: z
      .array(
        z
          .object({
            projectId: idSchema,
            runId: idSchema,
            status: runStatusSchema,
            activeActorCount: z.number().int().nonnegative(),
            actorRecordCount: z.number().int().nonnegative(),
            acceptedBundleCount: z.number().int().nonnegative(),
            logicalUnitsUsed: z.number().int().nonnegative(),
            logicalUnitLimit: z.number().int().positive(),
            costMicrounitsUsed: z.number().int().nonnegative(),
            costMicrounitLimit: z.number().int().nonnegative(),
            blockingExceptionCount: z.number().int().nonnegative(),
            ownerActionCount: z.number().int().nonnegative().nullable(),
            p95LatencyMs: z.number().int().nonnegative().nullable(),
            measuredAt: timestampSchema.nullable(),
          })
          .strict(),
      )
      .max(256),
    authority: authorityFlagsSchema,
  })
  .strict();
export type ElasticOperationOverview = z.infer<
  typeof elasticOperationOverviewSchema
>;

export const leadOperationCapabilitiesSchema = z
  .object({
    format: z.literal(OWD_LEAD_OPERATION_CAPABILITIES_FORMAT),
    schemaVersion: z.literal(1),
    mcpTools: z
      .array(
        z.enum([
          "create_work_item",
          "start_run",
          "register_actor",
          "get_run_context",
          "submit_bundle",
          "complete_work_item",
          "list_project_exceptions",
        ]),
      )
      .length(7),
    formats: z
      .array(
        z.enum([
          OWD_PROJECT_POLICY_FORMAT,
          OWD_RUN_FORMAT,
          OWD_ACTOR_FORMAT,
          OWD_EVENT_BUNDLE_FORMAT,
          OWD_PROJECT_EXCEPTION_FORMAT,
          OWD_RUN_CONTEXT_FORMAT,
        ]),
      )
      .length(6),
    mcpProtocolRevision: z.literal("2025-11-25"),
    requiredScope: z.literal("project.lead"),
  })
  .strict();

export const leadOperationRecordSchema = z.discriminatedUnion("format", [
  projectPolicySchema,
  runSchema,
  actorSchema,
  eventBundleSchema,
  projectExceptionSchema,
]);
export type LeadOperationRecord = z.infer<typeof leadOperationRecordSchema>;

export const elasticOperationRecordSchema = z.discriminatedUnion("format", [
  elasticRunPlaneSchema,
  elasticAccountSchema,
  actorRecoverySchema,
  runDeltaSchema,
  runBudgetSchema,
  budgetEntrySchema,
  runObservationSchema,
  orcaProjectionSchema,
]);
export type ElasticOperationRecord = z.infer<
  typeof elasticOperationRecordSchema
>;

export const elasticPortableExportSchema = z
  .object({
    format: z.literal("owd-elastic-record-export-v1"),
    schemaVersion: z.literal(1),
    projectId: idSchema,
    records: z
      .array(
        z
          .object({
            elasticRecordId: idSchema,
            portableObjectId: idSchema,
            recordType: z.enum([
              "plane",
              "account",
              "recovery",
              "delta",
              "budget",
              "budget-entry",
              "observation",
              "orca",
            ]),
            contentSha256: hashSchema,
            byteLength: z
              .number()
              .int()
              .positive()
              .max(4 * 1024 * 1024),
            record: elasticOperationRecordSchema,
          })
          .strict(),
      )
      .max(5_000),
    authority: authorityFlagsSchema,
  })
  .strict();
export type ElasticPortableExport = z.infer<typeof elasticPortableExportSchema>;

export const r3CapabilitiesSchema = z
  .object({
    format: z.literal(OWD_R3_CAPABILITIES_FORMAT),
    schemaVersion: z.literal(2),
    mcpTools: z
      .array(
        z.enum([
          "create_work_item",
          "start_run",
          "register_actor",
          "register_actors_batch",
          "get_run_context",
          "get_run_delta",
          "submit_bundle",
          "submit_bundles_batch",
          "recover_actor",
          "submit_budget_entry",
          "submit_observation",
          "project_orca_metadata",
          "complete_work_item",
          "list_project_exceptions",
        ]),
      )
      .min(7)
      .max(15),
    formats: z
      .array(
        z.enum([
          OWD_PROJECT_POLICY_FORMAT,
          OWD_RUN_FORMAT,
          OWD_ACTOR_FORMAT,
          OWD_EVENT_BUNDLE_FORMAT,
          OWD_PROJECT_EXCEPTION_FORMAT,
          OWD_RUN_CONTEXT_FORMAT,
          OWD_ELASTIC_RUN_PLANE_FORMAT,
          OWD_ELASTIC_ACCOUNT_FORMAT,
          OWD_ACTOR_RECOVERY_FORMAT,
          OWD_RUN_DELTA_FORMAT,
          OWD_RUN_BUDGET_FORMAT,
          OWD_BUDGET_ENTRY_FORMAT,
          OWD_RUN_OBSERVATION_FORMAT,
          OWD_ORCA_PROJECTION_FORMAT,
        ]),
      )
      .min(6)
      .max(14),
    mcpProtocolRevision: z.literal("2025-11-25"),
    requiredScope: z.literal("project.lead"),
    authority: authorityFlagsSchema,
  })
  .strict();
export type R3Capabilities = z.infer<typeof r3CapabilitiesSchema>;

export const projectPolicyJsonSchema = {
  $id: "urn:owd:schema:project-policy:v1",
  ...z.toJSONSchema(projectPolicySchema, { target: "draft-2020-12" }),
};
export const runJsonSchema = {
  $id: "urn:owd:schema:run:v1",
  ...z.toJSONSchema(runSchema, { target: "draft-2020-12" }),
};
export const actorJsonSchema = {
  $id: "urn:owd:schema:actor:v1",
  ...z.toJSONSchema(actorSchema, { target: "draft-2020-12" }),
};
export const eventBundleJsonSchema = {
  $id: "urn:owd:schema:event-bundle:v1",
  ...z.toJSONSchema(eventBundleSchema, { target: "draft-2020-12" }),
};
export const projectExceptionJsonSchema = {
  $id: "urn:owd:schema:project-exception:v1",
  ...z.toJSONSchema(projectExceptionSchema, { target: "draft-2020-12" }),
};
export const runContextJsonSchema = {
  $id: "urn:owd:schema:run-context:v1",
  ...z.toJSONSchema(runContextSchema, { target: "draft-2020-12" }),
};
export type LeadOperationCapabilities = z.infer<
  typeof leadOperationCapabilitiesSchema
>;
