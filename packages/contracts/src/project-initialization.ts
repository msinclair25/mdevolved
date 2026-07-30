import { z } from "./zod";
import {
  collaborationProjectCreateRequestSchema,
  collaborationScopeSchema,
} from "./collaboration";

export const PROJECT_INITIALIZATION_SCOPE = "project.initialize.request";
export const PROJECT_CONNECTION_SCOPE = "project.connect.request";
export const OWD_PROJECT_CONTEXT_FILE = ".owdignore";
export const OWD_PROJECT_CONTEXT_FORMAT = "owd-project-context-v1";
export const OWD_PROJECT_CONTINUITY_FILE = "AGENTS.md";
export const OWD_PROJECT_RESUME_TOOL = "resume_project";
export const projectInitializationScopeSchema = z.literal(
  PROJECT_INITIALIZATION_SCOPE,
);
export const projectConnectionScopeSchema = z.literal(PROJECT_CONNECTION_SCOPE);

const bootstrapTokenSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

const safeFolderSchema = z
  .string()
  .max(1_024)
  .refine((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint === undefined || (codePoint > 0x1f && codePoint !== 0x7f)
      );
    }),
  );

const contextPathSchema = safeFolderSchema.refine((value) => value.length > 0);

const localMarkdownPathSchema = safeFolderSchema
  .refine((value) => value.length > 0)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"))
  .refine((value) => !value.includes("\\"))
  .refine((value) => !value.split(/[\\/]/u).includes(".."))
  .refine((value) => value.toLocaleLowerCase("en-US").endsWith(".md"));

const rootMarkdownPathSchema = localMarkdownPathSchema.refine(
  (value) => !value.includes("/") && !value.includes("\\"),
);

const docsMarkdownPathSchema = localMarkdownPathSchema.refine((value) =>
  value.toLocaleLowerCase("en-US").startsWith("docs/"),
);

const retainedRootControlFiles = new Set([
  "agents.md",
  "changelog.md",
  "code_of_conduct.md",
  "contributing.md",
  "license.md",
  "readme.md",
  "security.md",
  "support.md",
]);

export const projectDocumentationPlanSchema = z
  .object({
    decision: z.enum([
      "no-root-markdown",
      "keep-current-locations",
      "move-approved",
    ]),
    proposedMoves: z
      .array(
        z
          .object({
            from: rootMarkdownPathSchema,
            to: docsMarkdownPathSchema,
          })
          .strict(),
      )
      .max(128),
    retainedRootPaths: z.array(rootMarkdownPathSchema).max(128),
    rootMarkdownPaths: z.array(rootMarkdownPathSchema).max(128),
  })
  .strict()
  .superRefine((plan, context) => {
    const roots = new Set(
      plan.rootMarkdownPaths.map((path) => path.toLocaleLowerCase("en-US")),
    );
    const retained = new Set(
      plan.retainedRootPaths.map((path) => path.toLocaleLowerCase("en-US")),
    );
    const moved = new Set(
      plan.proposedMoves.map((move) => move.from.toLocaleLowerCase("en-US")),
    );
    const destinations = new Set(
      plan.proposedMoves.map((move) => move.to.toLocaleLowerCase("en-US")),
    );
    const unique =
      roots.size === plan.rootMarkdownPaths.length &&
      retained.size === plan.retainedRootPaths.length &&
      moved.size === plan.proposedMoves.length &&
      destinations.size === plan.proposedMoves.length;
    const complete = [...roots].every(
      (path) => retained.has(path) !== moved.has(path),
    );
    const noUnknownPaths =
      [...retained].every((path) => roots.has(path)) &&
      [...moved].every((path) => roots.has(path));
    const decisionMatches =
      (plan.decision === "no-root-markdown" &&
        roots.size === 0 &&
        retained.size === 0 &&
        moved.size === 0) ||
      (plan.decision === "keep-current-locations" &&
        roots.size > 0 &&
        retained.size === roots.size &&
        moved.size === 0) ||
      (plan.decision === "move-approved" && roots.size > 0 && moved.size > 0);
    const controlFilesStayAtRoot = plan.proposedMoves.every(
      (move) =>
        !retainedRootControlFiles.has(move.from.toLocaleLowerCase("en-US")),
    );
    if (
      !unique ||
      !complete ||
      !noUnknownPaths ||
      !decisionMatches ||
      !controlFilesStayAtRoot
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Every root Markdown file must be listed exactly once as retained or moved, and the decision must match.",
      });
    }
  });

export type ProjectDocumentationPlan = z.infer<
  typeof projectDocumentationPlanSchema
>;

export const projectContextPolicySchema = z
  .object({
    excludePaths: z
      .array(contextPathSchema)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    format: z.literal(OWD_PROJECT_CONTEXT_FORMAT),
    includePaths: z
      .array(safeFolderSchema)
      .min(1)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    projectId: z.string().uuid().optional(),
  })
  .strict();

export type ProjectContextPolicy = z.infer<typeof projectContextPolicySchema>;

const requestedProjectScopesSchema = z
  .array(collaborationScopeSchema)
  .min(1)
  .max(4)
  .refine((values) => new Set(values).size === values.length)
  .refine((values) => values.includes("project.read"));

export const projectInitializationDraftSchema = z
  .object({
    contextPolicy: projectContextPolicySchema,
    documentationPlan: projectDocumentationPlanSchema,
    folderBoundary: safeFolderSchema,
    project: collaborationProjectCreateRequestSchema.shape.project,
    workItem: collaborationProjectCreateRequestSchema.shape.workItem,
    requestedRole: collaborationProjectCreateRequestSchema.shape.requestedRole,
    sourceNotePaths: z
      .array(
        z
          .object({
            excerptByteRange: z
              .object({
                endExclusive: z.number().int().positive(),
                start: z.number().int().nonnegative(),
              })
              .strict()
              .nullable(),
            path: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .max(64),
    packetExpiresInSeconds:
      collaborationProjectCreateRequestSchema.shape.packetExpiresInSeconds,
    requestedScopes: requestedProjectScopesSchema,
  })
  .strict();

export type ProjectInitializationDraft = z.infer<
  typeof projectInitializationDraftSchema
>;

export const projectInitializationOwnerActionSchema = z
  .object({
    kind: z.literal("reopen-work-item-and-connect"),
    workItemId: z.string().uuid(),
    workItemVersionId: z.string().uuid(),
  })
  .strict();

export type ProjectInitializationOwnerAction = z.infer<
  typeof projectInitializationOwnerActionSchema
>;

export const storedProjectSetupDraftSchema = z.discriminatedUnion(
  "requestKind",
  [
    projectInitializationDraftSchema
      .extend({ requestKind: z.literal("create") })
      .strict(),
    projectInitializationDraftSchema
      .extend({
        requestKind: z.literal("join"),
        ownerAction: projectInitializationOwnerActionSchema.optional(),
        target: z
          .object({
            knowledgeSpaceVersionId: z.string().uuid(),
            packetId: z.string().uuid(),
            projectId: z.string().uuid(),
            workItemId: z.string().uuid(),
          })
          .strict(),
      })
      .strict(),
  ],
);

export type StoredProjectSetupDraft = z.infer<
  typeof storedProjectSetupDraftSchema
>;

export const projectInitializationRequestSchema = z
  .object({
    clientCapabilities: z.object({ urlElicitation: z.boolean() }).strict(),
    draft: projectInitializationDraftSchema,
    idempotencyKey: bootstrapTokenSchema,
  })
  .strict();

export type ProjectInitializationRequest = z.infer<
  typeof projectInitializationRequestSchema
>;

export const projectInitializationStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);

export const joinableProjectSchema = z
  .object({
    contextPolicy: projectContextPolicySchema,
    createdAt: z.number().int().nonnegative(),
    currentPacket: z
      .object({
        expiresAt: z.number().int().positive(),
        packetId: z.string().uuid(),
        requestedRole: z.string().min(1).max(80),
        workItemId: z.string().uuid(),
        workItemObjective: z.string().min(1).max(2_000),
      })
      .strict(),
    label: z.string().min(1).max(120),
    objective: z.string().min(1).max(2_000),
    projectId: z.string().uuid(),
  })
  .strict();

export type JoinableProject = z.infer<typeof joinableProjectSchema>;

export const joinableProjectListResponseSchema = z
  .object({
    connectedVault: z
      .object({
        entireVault: z.boolean(),
        id: z.string().uuid(),
        name: z.string().min(1).max(120),
        pathPrefixes: z.array(safeFolderSchema).max(64),
      })
      .strict(),
    nextAction: z.string().min(1).max(400),
    newProjectAllowed: z.literal(true),
    projects: z.array(joinableProjectSchema).max(50),
    unavailableProjects: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            nextAction: z.string().min(1).max(400),
            objective: z.string().min(1).max(2_000),
            projectId: z.string().uuid(),
            reason: z.enum([
              "folder-scope-mismatch",
              "integrity-invalid",
              "multi-vault-project",
              "packet-expired",
              "packet-missing",
              "packet-stale",
              "project-context-invalid",
              "source-unavailable",
              "work-item-closed",
            ]),
          })
          .strict(),
      )
      .max(50),
    requiresExplicitChoice: z.boolean(),
    selectionMode: z.enum([
      "choose-existing-project",
      "repair-existing-project",
      "create-new-project",
    ]),
  })
  .strict();

export type JoinableProjectListResponse = z.infer<
  typeof joinableProjectListResponseSchema
>;

export const projectAccessRequestSchema = z
  .object({
    clientCapabilities: z.object({ urlElicitation: z.boolean() }).strict(),
    documentationPlan: projectDocumentationPlanSchema,
    idempotencyKey: bootstrapTokenSchema,
    projectId: z.string().uuid(),
    requestedScopes: requestedProjectScopesSchema,
  })
  .strict();

export type ProjectAccessRequest = z.infer<typeof projectAccessRequestSchema>;

export const projectAccessRequestResponseSchema = z
  .object({
    accessRequestId: z.string().uuid(),
    approvalUrl: z.string().url().max(4_096),
    expiresAt: z.number().int().positive(),
    openMode: z.enum(["url-elicitation", "copy-link"]),
    status: projectInitializationStateSchema,
  })
  .strict();

export type ProjectAccessRequestResponse = z.infer<
  typeof projectAccessRequestResponseSchema
>;

export const projectInitializationRequestResponseSchema = z
  .object({
    authorizationUrl: z.string().url().max(4_096),
    expiresAt: z.number().int().positive(),
    initializationId: z.string().uuid(),
    openMode: z.enum(["url-elicitation", "copy-link"]),
    status: projectInitializationStateSchema,
  })
  .strict();

export type ProjectInitializationRequestResponse = z.infer<
  typeof projectInitializationRequestResponseSchema
>;

export const projectInitializationStatusRequestSchema = z
  .object({ idempotencyKey: bootstrapTokenSchema })
  .strict();

export const projectInitializationStatusResponseSchema = z
  .object({
    continuity: z
      .object({
        contextFileContent: z.string().min(1).max(16_384),
        contextFilePath: z.literal(OWD_PROJECT_CONTEXT_FILE),
        instructionFilePath: z.literal(OWD_PROJECT_CONTINUITY_FILE),
        managedInstructionBlock: z.string().min(1).max(8_192),
        projectId: z.string().uuid(),
        requiredTool: z.literal(OWD_PROJECT_RESUME_TOOL),
        selectorSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict()
      .nullable(),
    documentationPlan: projectDocumentationPlanSchema,
    expiresAt: z.number().int().positive(),
    folderBoundary: safeFolderSchema,
    initializationId: z.string().uuid(),
    nextAction: z.string().min(1).max(240),
    objective: z.string().min(1).max(2_000),
    packetId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    requestedScopes: z.array(collaborationScopeSchema).min(1).max(4),
    requestKind: z.enum(["create", "join"]),
    status: projectInitializationStateSchema,
    vaultName: z.string().min(1).max(120),
    workItemId: z.string().uuid().nullable(),
  })
  .strict();

export type ProjectInitializationStatusResponse = z.infer<
  typeof projectInitializationStatusResponseSchema
>;

export const projectAccessStatusRequestSchema =
  projectInitializationStatusRequestSchema;

export const projectAccessStatusResponseSchema =
  projectInitializationStatusResponseSchema
    .omit({ initializationId: true })
    .extend({
      accessRequestId: z.string().uuid(),
      requestKind: z.literal("join"),
    })
    .strict();

export type ProjectAccessStatusResponse = z.infer<
  typeof projectAccessStatusResponseSchema
>;

export const projectInitializationConsentContextSchema = z
  .object({
    client: z
      .object({
        id: z.string().min(1).max(2_048),
        name: z.string().min(1).max(120),
        origin: z.string().min(1).max(2_048),
      })
      .strict(),
    contextPolicy: projectContextPolicySchema,
    documentationPlan: projectDocumentationPlanSchema,
    expiresAt: z.number().int().positive(),
    folderBoundary: safeFolderSchema,
    initializationToken: bootstrapTokenSchema,
    objective: z.string().min(1).max(2_000),
    ownerAction: projectInitializationOwnerActionSchema
      .nullable()
      .default(null),
    projectId: z.string().uuid().nullable(),
    projectLabel: z.string().min(1).max(120),
    requestKind: z.enum(["create", "join"]),
    requestedScopes: z.array(collaborationScopeSchema).min(1).max(4),
    sourceNotePaths: z.array(z.string().min(1).max(1_024)).max(64),
    vault: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(120),
      })
      .strict(),
    vaultPathPrefixes: z.array(safeFolderSchema).max(64),
    workItemTitle: z.string().min(1).max(160),
  })
  .strict();

export type ProjectInitializationConsentContext = z.infer<
  typeof projectInitializationConsentContextSchema
>;

export const projectInitializationApprovalRequestSchema = z
  .object({
    contextPolicy: projectContextPolicySchema,
    initializationToken: bootstrapTokenSchema,
  })
  .strict();

export const projectInitializationDecisionRequestSchema = z
  .object({ initializationToken: bootstrapTokenSchema })
  .strict();

export const projectInitializationDecisionResponseSchema = z
  .object({
    nextAction: z.string().min(1).max(240),
    projectId: z.string().uuid(),
    status: z.literal("approved"),
  })
  .strict();

export const setupVaultNextStepSchema = z.enum([
  "sync-vault",
  "build-library",
  "create-recovery-point",
  "connect-agent",
  "prepare-project-handoff",
  "approve-project",
  "create-or-select-project",
  "reauthenticate-project",
  "ready",
]);

export type SetupVaultNextStep = z.infer<typeof setupVaultNextStepSchema>;

export const setupVaultReadinessSchema = z
  .object({
    activeAgentCount: z.number().int().nonnegative(),
    activeProjectCount: z.number().int().nonnegative(),
    activeProjectGrantCount: z.number().int().nonnegative(),
    displayName: z.string().min(1).max(120),
    id: z.string().uuid(),
    initialSyncAt: z.number().int().nonnegative().nullable(),
    lastSyncAt: z.number().int().nonnegative().nullable(),
    libraryState: z.enum(["missing", "building", "current", "stale", "failed"]),
    libraryReady: z.boolean(),
    nextStep: setupVaultNextStepSchema,
    pendingProjectRequestCount: z.number().int().nonnegative(),
    pendingProjectRequests: z
      .array(
        z
          .object({
            clientName: z.string().min(1).max(120),
            projectLabel: z.string().min(1).max(120),
            requestKind: z.enum(["connect", "create"]),
            reviewUrl: z
              .string()
              .max(256)
              .regex(/^\/(?:connect|initialize)\?requestId=[0-9a-f-]{36}$/u),
          })
          .strict(),
      )
      .max(50),
    pendingProjectReviewUrl: z
      .string()
      .max(256)
      .regex(/^\/(?:connect|initialize)\?requestId=[0-9a-f-]{36}$/u)
      .nullable(),
    pluginVersion: z.string().min(1).max(64).nullable(),
    preparedProjectHandoff: z
      .object({
        agentGrantId: z.string().uuid(),
        clientName: z.string().min(1).max(120),
        folderBoundary: z.string().max(1_024),
        preparedAt: z.number().int().nonnegative(),
        projectLabel: z.string().min(1).max(120),
      })
      .strict()
      .nullable(),
    syncConfirmed: z.boolean(),
    verifiedSnapshot: z.boolean(),
  })
  .strict();

export type SetupVaultReadiness = z.infer<typeof setupVaultReadinessSchema>;

export const setupReadinessSchema = z
  .object({
    activeAgentCount: z.number().int().nonnegative(),
    activeProjectCount: z.number().int().nonnegative(),
    activeProjectGrantCount: z.number().int().nonnegative(),
    activeVaultCount: z.number().int().nonnegative(),
    libraryReady: z.boolean(),
    nextStep: z.enum(["connect-vault", ...setupVaultNextStepSchema.options]),
    verifiedSnapshot: z.boolean(),
    vaults: z.array(setupVaultReadinessSchema).max(100),
  })
  .strict();

export type SetupReadiness = z.infer<typeof setupReadinessSchema>;
