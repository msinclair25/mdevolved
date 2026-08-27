import { z } from "./zod";

export const OWD_POLICY_BINDING_FORMAT = "owd-policy-binding-v1" as const;
export const OWD_POLICY_DECISION_FORMAT = "owd-policy-decision-v1" as const;
export const OWD_OPERATIONAL_SCHEDULE_FORMAT =
  "owd-operational-schedule-v1" as const;
export const OWD_OPERATIONAL_EVIDENCE_FORMAT =
  "owd-operational-evidence-v1" as const;
export const OWD_CONTINUITY_RECEIPT_FORMAT =
  "owd-continuity-receipt-v1" as const;
export const OWD_R4_CAPABILITIES_FORMAT =
  "owd-lead-operation-capabilities-v3" as const;
export const OWD_MD8_CAPABILITIES_FORMAT =
  "owd-lead-operation-capabilities-v4" as const;
export const OWD_RESEARCH_COMPLETION_GATE =
  "owd-research-completion-gate-v1" as const;
export const OWD_CODING_COMPLETION_GATE =
  "owd-coding-completion-gate-v1" as const;
export const OWD_COMPLETION_POLICY_FORMAT = "owd-completion-policy-v1" as const;

export const MAX_POLICY_EVIDENCE_REFS = 64;
export const MAX_OPERATIONAL_RECORD_BYTES = 1024 * 1024;
export const MAX_OPERATIONAL_EXPORT_RECORDS = 512;
export const MAX_OPERATIONAL_EXPORT_REFERENCES = 1_024;
export const MAX_OPERATIONAL_EXPORT_BYTES = 32 * 1024 * 1024;

const idSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.number().int().nonnegative();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const authoritySchema = z
  .object({
    liveAuthorityIncluded: z.literal(false),
    restoredAuthorityAllowed: z.literal(false),
  })
  .strict();

export const completionModeSchema = z.enum([
  "orchestrated-reviewed",
  "solo-verified",
]);
export type CompletionMode = z.infer<typeof completionModeSchema>;

export const completionPolicySchema = z
  .object({
    allowedModes: z.array(completionModeSchema).min(1).max(2),
    defaultMode: z.literal("orchestrated-reviewed"),
    format: z.literal(OWD_COMPLETION_POLICY_FORMAT),
    schemaVersion: z.literal(1),
    soloVerifiedOwnerConsent: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const modes = new Set(value.allowedModes);
    if (
      modes.size !== value.allowedModes.length ||
      !modes.has("orchestrated-reviewed") ||
      modes.has("solo-verified") !== value.soloVerifiedOwnerConsent
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Completion modes must be unique, retain reviewed completion, and match explicit solo consent.",
        path: ["allowedModes"],
      });
    }
  });
export type CompletionPolicy = z.infer<typeof completionPolicySchema>;

export const policyExceptionActionSchema = z.enum([
  "authority-expansion",
  "policy-editing",
  "self-approval",
  "destructive-action",
  "protected-path-access",
  "conflicting-evidence",
  "budget-exhaustion",
  "integrity-failure",
  "unsupported-upgrade",
  "unsupported-rollback",
]);
export type PolicyExceptionAction = z.infer<typeof policyExceptionActionSchema>;

const POLICY_EXCEPTION_ACTIONS = [
  "authority-expansion",
  "policy-editing",
  "self-approval",
  "destructive-action",
  "protected-path-access",
  "conflicting-evidence",
  "budget-exhaustion",
  "integrity-failure",
  "unsupported-upgrade",
  "unsupported-rollback",
] as const;

export const policyBindingSchema = z
  .object({
    activatedAt: timestampSchema,
    authority: authoritySchema,
    bindingId: idSchema,
    checkpointIntervalSeconds: z.number().int().min(300).max(86_400),
    completionPolicy: completionPolicySchema.optional(),
    drillIntervalSeconds: z
      .number()
      .int()
      .min(3_600)
      .max(30 * 24 * 60 * 60),
    exceptionOnlyActions: z
      .array(policyExceptionActionSchema)
      .length(POLICY_EXCEPTION_ACTIONS.length),
    format: z.literal(OWD_POLICY_BINDING_FORMAT),
    gateProfiles: z
      .object({
        coding: z.literal(OWD_CODING_COMPLETION_GATE),
        research: z.literal(OWD_RESEARCH_COMPLETION_GATE),
      })
      .strict(),
    ownerAuthored: z.literal(true),
    ownerAuthorization: z.literal("owner-session"),
    ownerPolicyInput: z
      .object({
        contentSha256: hashSchema,
        recordId: idSchema,
        recordType: z.literal("project-version"),
      })
      .strict(),
    policyId: idSchema,
    policySha256: hashSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerPolicyInput.recordId !== value.projectVersionId) {
      context.addIssue({
        code: "custom",
        message: "The owner policy input must be the exact Project version.",
        path: ["ownerPolicyInput", "recordId"],
      });
    }
    if (
      new Set(value.exceptionOnlyActions).size !==
        POLICY_EXCEPTION_ACTIONS.length ||
      POLICY_EXCEPTION_ACTIONS.some(
        (action) => !value.exceptionOnlyActions.includes(action),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Every fixed exception-only action must appear exactly once.",
        path: ["exceptionOnlyActions"],
      });
    }
  });
export type PolicyBinding = z.infer<typeof policyBindingSchema>;

export const policyGateCheckKeySchema = z.enum([
  "owner-authored-policy",
  "run-identity",
  "purpose-evidence",
  "independent-review",
  "continuity-point",
  "no-blocking-exception",
  "no-evidence-conflict",
  "budget-within-policy",
  "integrity-valid",
  "no-owner-only-action",
]);
export type PolicyGateCheckKey = z.infer<typeof policyGateCheckKeySchema>;

const GATE_CHECK_KEYS = [
  "owner-authored-policy",
  "run-identity",
  "purpose-evidence",
  "independent-review",
  "continuity-point",
  "no-blocking-exception",
  "no-evidence-conflict",
  "budget-within-policy",
  "integrity-valid",
  "no-owner-only-action",
] as const;

export const policyEvidenceRefSchema = z
  .object({
    contentSha256: hashSchema,
    id: idSchema,
    kind: z.enum([
      "accepted-content",
      "event-bundle",
      "independent-review",
      "continuity-point",
      "budget-version",
      "policy-binding",
    ]),
  })
  .strict();
export type PolicyEvidenceRef = z.infer<typeof policyEvidenceRefSchema>;

const policyGateCheckSchema = z
  .object({
    evidenceRefs: z.array(idSchema).max(MAX_POLICY_EVIDENCE_REFS),
    key: policyGateCheckKeySchema,
    passed: z.boolean(),
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    acceptedBundleCount: z.number().int().nonnegative(),
    authority: authoritySchema,
    checks: z.array(policyGateCheckSchema).length(GATE_CHECK_KEYS.length),
    completionMode: z.literal("solo-verified").optional(),
    continuityPointId: idSchema.nullable(),
    decisionId: idSchema,
    evaluatedAt: timestampSchema,
    evaluator: z.literal("authorization-bound-lead"),
    evidenceFingerprint: hashSchema,
    evidenceRefs: z
      .array(policyEvidenceRefSchema)
      .max(MAX_POLICY_EVIDENCE_REFS),
    exceptionReason: policyExceptionActionSchema.nullable(),
    format: z.literal(OWD_POLICY_DECISION_FORMAT),
    gateProfile: z.enum([
      OWD_RESEARCH_COMPLETION_GATE,
      OWD_CODING_COMPLETION_GATE,
    ]),
    outcome: z.enum(["allow", "exception"]),
    policyBindingId: idSchema,
    policyId: idSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    purpose: z.enum(["research", "coding"]),
    requestedOwnerActions: z.array(policyExceptionActionSchema).max(10),
    runId: idSchema,
    schemaVersion: z.literal(1),
    workItemId: idSchema,
    workPacketId: idSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.checks.map((check) => check.key);
    if (
      new Set(keys).size !== GATE_CHECK_KEYS.length ||
      GATE_CHECK_KEYS.some((key) => !keys.includes(key))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A PolicyDecision must contain every deterministic check once.",
        path: ["checks"],
      });
    }
    const allPassed = value.checks.every((check) => check.passed);
    if (
      (value.outcome === "allow" &&
        (!allPassed ||
          value.exceptionReason !== null ||
          value.requestedOwnerActions.length > 0)) ||
      (value.outcome === "exception" &&
        (allPassed || value.exceptionReason === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "The decision outcome must match its deterministic checks.",
        path: ["outcome"],
      });
    }
    const independentReview = value.checks.find(
      (check) => check.key === "independent-review",
    );
    if (
      value.completionMode === "solo-verified" &&
      (independentReview?.passed !== true ||
        independentReview.evidenceRefs.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Solo completion satisfies the review requirement without claiming review evidence.",
        path: ["checks"],
      });
    }
    if (
      (value.purpose === "research" &&
        value.gateProfile !== OWD_RESEARCH_COMPLETION_GATE) ||
      (value.purpose === "coding" &&
        value.gateProfile !== OWD_CODING_COMPLETION_GATE)
    ) {
      context.addIssue({
        code: "custom",
        message: "The gate profile must match the Run purpose.",
        path: ["gateProfile"],
      });
    }
    const evidenceKeys = value.evidenceRefs.map(
      (evidence) => `${evidence.kind}:${evidence.id}`,
    );
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Policy evidence references must be unique.",
        path: ["evidenceRefs"],
      });
    }
  });
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const operationalScheduleSchema = z
  .object({
    authority: authoritySchema
      .extend({ schedulerAuthorityIncluded: z.literal(false) })
      .strict(),
    checkpointIntervalSeconds: z.number().int().min(300).max(86_400),
    createdAt: timestampSchema,
    drillIntervalSeconds: z
      .number()
      .int()
      .min(3_600)
      .max(30 * 24 * 60 * 60),
    format: z.literal(OWD_OPERATIONAL_SCHEDULE_FORMAT),
    nextCheckpointAt: timestampSchema,
    nextDrillAt: timestampSchema,
    policyBindingId: idSchema,
    projectId: idSchema,
    scheduleId: idSchema,
    schemaVersion: z.literal(1),
    status: z.enum(["active", "paused", "restored-inert"]),
  })
  .strict();
export type OperationalSchedule = z.infer<typeof operationalScheduleSchema>;

const operationalEvidenceDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      dueAt: timestampSchema,
      kind: z.literal("continuity-point-request"),
      scheduleWindow: timestampSchema,
    })
    .strict(),
  z
    .object({
      dueAt: timestampSchema,
      freshCommunityRequired: z.literal(true),
      kind: z.literal("continuity-drill-request"),
      leadReplacementRequired: z.literal(true),
      scheduleWindow: timestampSchema,
      sourceContinuityPointId: idSchema,
      sourceWorkItemId: idSchema,
      sourceWorkPacketId: idSchema,
    })
    .strict(),
  z
    .object({
      coverage: z.enum(["complete", "partial"]),
      inspectedBodyCount: z.number().int().nonnegative().max(512),
      inspectedRecordCount: z.number().int().nonnegative().max(512),
      kind: z.literal("integrity-scan"),
      mismatchedCount: z.number().int().nonnegative().max(512),
      missingCount: z.number().int().nonnegative().max(512),
    })
    .strict(),
  z
    .object({
      forwardOnly: z.literal(true),
      fromMigration: z.literal("0032"),
      kind: z.literal("upgrade-readiness"),
      toMigration: z.literal("0033"),
      triggerFree: z.literal(true),
    })
    .strict(),
  z
    .object({
      automaticRollback: z.literal(false),
      destructiveDownMigration: z.literal(false),
      kind: z.literal("rollback-readiness"),
      mode: z.literal("application-only"),
      priorWorkerCompatible: z.literal(true),
    })
    .strict(),
  z
    .object({
      communityIndependent: z.literal(true),
      controlPlaneRequired: z.literal(false),
      deploymentMode: z.enum(["community", "managed-cell"]),
      executionEngineExternal: z.literal(true),
      kind: z.literal("managed-cell-health"),
    })
    .strict(),
]);

export const operationalEvidenceSchema = z
  .object({
    authority: authoritySchema,
    detail: operationalEvidenceDetailSchema,
    evidenceId: idSchema,
    format: z.literal(OWD_OPERATIONAL_EVIDENCE_FORMAT),
    occurredAt: timestampSchema,
    projectId: idSchema,
    retainUntil: timestampSchema,
    retentionTier: z.enum(["hot", "warm", "cold", "quarantine"]),
    runId: idSchema.nullable(),
    scheduleId: idSchema.nullable(),
    schemaVersion: z.literal(1),
    status: z.enum(["requested", "ok", "degraded", "blocked"]),
    summary: boundedText(2_048),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retainUntil < value.occurredAt) {
      context.addIssue({
        code: "custom",
        message: "Operational evidence cannot expire before it occurs.",
        path: ["retainUntil"],
      });
    }
    const request =
      value.detail.kind === "continuity-point-request" ||
      value.detail.kind === "continuity-drill-request";
    if (
      (request && value.status !== "requested") ||
      (!request && value.status === "requested")
    ) {
      context.addIssue({
        code: "custom",
        message: "Only scheduled requests may use requested status.",
        path: ["status"],
      });
    }
  });
export type OperationalEvidence = z.infer<typeof operationalEvidenceSchema>;

export const continuityReceiptSchema = z
  .object({
    authority: authoritySchema
      .extend({
        actorAuthorityIncluded: z.literal(false),
        credentialAuthorityIncluded: z.literal(false),
        grantAuthorityIncluded: z.literal(false),
        leaseAuthorityIncluded: z.literal(false),
        oauthAuthorityIncluded: z.literal(false),
        policyAuthorityIncluded: z.literal(false),
        schedulerAuthorityIncluded: z.literal(false),
      })
      .strict(),
    cleanup: z
      .object({
        completed: z.literal(true),
        remainingAuthorityCount: z.literal(0),
        temporaryObjectsRemoved: z.number().int().nonnegative(),
      })
      .strict(),
    disposable: z.literal(true),
    drillId: idSchema,
    emittedAt: timestampSchema,
    format: z.literal(OWD_CONTINUITY_RECEIPT_FORMAT),
    freshCommunityInstall: z.literal(true),
    leadReplaced: z.literal(true),
    metrics: z
      .object({
        continuityAgeSeconds: z.number().int().nonnegative(),
        recoveryChecksPassed: z.number().int().nonnegative(),
        recoveryChecksTotal: z.number().int().positive(),
        recoveryQualityBps: z.number().int().min(0).max(10_000),
        rpoSeconds: z.number().int().nonnegative(),
        rtoSeconds: z.number().int().nonnegative(),
        runtimeIndependent: z.boolean(),
      })
      .strict(),
    outcome: z.enum(["pass", "fail"]),
    projectId: idSchema,
    receiptId: idSchema,
    redaction: z
      .object({
        credentialsIncluded: z.literal(false),
        customerDataIncluded: z.literal(false),
        filenamesIncluded: z.literal(false),
        hiddenReasoningIncluded: z.literal(false),
        hostnamesIncluded: z.literal(false),
        oauthStateIncluded: z.literal(false),
        productionLogsIncluded: z.literal(false),
        providerRuntimeIncluded: z.literal(false),
        rawBodiesIncluded: z.literal(false),
        terminalHistoryIncluded: z.literal(false),
        transcriptsIncluded: z.literal(false),
      })
      .strict(),
    restoredContinuityPointId: idSchema,
    schemaVersion: z.literal(1),
    sourceTimes: z
      .object({
        latestAcknowledgedPointAt: timestampSchema,
        receiptEmittedAt: timestampSchema,
        replacementProductiveAt: timestampSchema,
        restoredPointAcknowledgedAt: timestampSchema,
        simulatedLeadLossAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const times = value.sourceTimes;
    const expectedRpo = Math.max(
      0,
      times.simulatedLeadLossAt - times.latestAcknowledgedPointAt,
    );
    const expectedRto =
      times.replacementProductiveAt - times.simulatedLeadLossAt;
    const expectedAge =
      times.receiptEmittedAt - times.restoredPointAcknowledgedAt;
    const expectedQuality = Math.floor(
      (10_000 * value.metrics.recoveryChecksPassed) /
        value.metrics.recoveryChecksTotal,
    );
    if (
      times.latestAcknowledgedPointAt !== times.restoredPointAcknowledgedAt ||
      times.latestAcknowledgedPointAt > times.simulatedLeadLossAt ||
      expectedRto < 0 ||
      expectedAge < 0 ||
      times.replacementProductiveAt > times.receiptEmittedAt ||
      value.emittedAt !== times.receiptEmittedAt ||
      value.metrics.rpoSeconds !== expectedRpo ||
      value.metrics.rtoSeconds !== expectedRto ||
      value.metrics.continuityAgeSeconds !== expectedAge ||
      value.metrics.recoveryQualityBps !== expectedQuality ||
      value.metrics.recoveryChecksPassed > value.metrics.recoveryChecksTotal
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Continuity metrics must match their exact source times and checks.",
        path: ["metrics"],
      });
    }
    if (
      value.metrics.runtimeIndependent !==
      (value.outcome === "pass" &&
        value.metrics.recoveryChecksPassed ===
          value.metrics.recoveryChecksTotal)
    ) {
      context.addIssue({
        code: "custom",
        message: "Runtime independence requires a complete passing recovery.",
        path: ["metrics", "runtimeIndependent"],
      });
    }
  });
export type ContinuityReceipt = z.infer<typeof continuityReceiptSchema>;

export const policyOperationalRecordSchema = z.discriminatedUnion("format", [
  policyBindingSchema,
  policyDecisionSchema,
  operationalScheduleSchema,
  operationalEvidenceSchema,
  continuityReceiptSchema,
]);
export type PolicyOperationalRecord = z.infer<
  typeof policyOperationalRecordSchema
>;

export const activatePolicyBindingRequestSchema = z
  .object({
    checkpointIntervalSeconds: z.number().int().min(300).max(86_400),
    completionMode: completionModeSchema.optional(),
    drillIntervalSeconds: z
      .number()
      .int()
      .min(3_600)
      .max(30 * 24 * 60 * 60),
    projectId: idSchema,
  })
  .strict();

export const evaluateRunPolicyRequestSchema = z
  .object({
    fencingToken: z.number().int().positive(),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/u),
    leaseId: idSchema,
    normalizedRelativePath: z.string().max(1_024).nullable().default(null),
    projectId: idSchema,
    requestedOwnerActions: z
      .array(policyExceptionActionSchema)
      .max(10)
      .default([]),
    runId: idSchema,
    workItemId: idSchema,
  })
  .strict();

export const evaluateRunPolicyReceiptSchema = z
  .object({
    decision: policyDecisionSchema,
    idempotencyKey: z.string().min(16).max(128),
    operation: z.literal("evaluate_run_policy"),
    projectId: idSchema,
    receivedAt: timestampSchema,
    requestSha256: hashSchema,
  })
  .strict();

export const getPolicyOperationsRequestSchema = z
  .object({ projectId: idSchema })
  .strict();
export const getPolicyOperationsReceiptSchema = z
  .object({
    binding: policyBindingSchema.nullable(),
    decisions: z.array(policyDecisionSchema).max(64),
    operation: z.literal("get_policy_operations"),
    pendingRequests: z.array(operationalEvidenceSchema).max(64),
    projectId: idSchema,
    schedule: operationalScheduleSchema.nullable(),
  })
  .strict();

export const completeContinuityDrillRequestSchema = z
  .object({
    fencingToken: z.number().int().positive(),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/u),
    leaseId: idSchema,
    projectId: idSchema,
    receipt: continuityReceiptSchema,
    requestId: idSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.receipt.projectId !== value.projectId ||
      value.receipt.drillId !== value.requestId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The continuity receipt must name the exact Project and scheduled drill request.",
        path: ["receipt"],
      });
    }
  });

export const completeContinuityDrillReceiptSchema = z
  .object({
    idempotencyKey: z.string().min(16).max(128),
    operation: z.literal("complete_continuity_drill"),
    projectId: idSchema,
    receivedAt: timestampSchema,
    receipt: continuityReceiptSchema,
    requestId: idSchema,
    requestSha256: hashSchema,
  })
  .strict();

export const operationalOverviewSchema = z
  .object({
    authority: authoritySchema,
    format: z.literal("owd-operational-overview-v1"),
    projects: z
      .array(
        z
          .object({
            continuityAgeSeconds: z.number().int().nonnegative().nullable(),
            integrityStatus: z.enum(["ok", "degraded", "unknown"]),
            latestDecision: z
              .object({
                decisionId: idSchema,
                evaluatedAt: timestampSchema,
                outcome: z.enum(["allow", "exception"]),
                purpose: z.enum(["research", "coding"]),
                runId: idSchema,
              })
              .strict()
              .nullable(),
            latestReceipt: z
              .object({
                continuityAgeSeconds: z.number().int().nonnegative(),
                emittedAt: timestampSchema,
                receiptId: idSchema,
                recoveryQualityBps: z.number().int().min(0).max(10_000),
                rpoSeconds: z.number().int().nonnegative(),
                rtoSeconds: z.number().int().nonnegative(),
                runtimeIndependent: z.boolean(),
              })
              .strict()
              .nullable(),
            pendingRequestCount: z.number().int().nonnegative(),
            policyBinding: z
              .object({ bindingId: idSchema, activatedAt: timestampSchema })
              .strict()
              .nullable(),
            projectId: idSchema,
          })
          .strict(),
      )
      .max(256),
    schemaVersion: z.literal(1),
  })
  .strict();
export type OperationalOverview = z.infer<typeof operationalOverviewSchema>;

export const operationalPortableExportSchema = z
  .object({
    authority: authoritySchema,
    format: z.literal("owd-operational-record-export-v1"),
    projectId: idSchema,
    records: z
      .array(
        z
          .object({
            byteLength: z
              .number()
              .int()
              .positive()
              .max(MAX_OPERATIONAL_RECORD_BYTES),
            contentSha256: hashSchema,
            dependencies: z
              .array(
                z
                  .object({
                    contentSha256: hashSchema.nullable(),
                    dependencyId: idSchema,
                    dependencyKind: z.enum([
                      "record",
                      "evidence",
                      "operational",
                    ]),
                  })
                  .strict(),
              )
              .max(256),
            operationalRecordId: idSchema,
            portableObjectId: idSchema,
            record: policyOperationalRecordSchema,
          })
          .strict(),
      )
      .max(MAX_OPERATIONAL_EXPORT_RECORDS),
    referencedBodies: z
      .array(
        z
          .object({
            bodyBase64Url: z
              .string()
              .min(1)
              .max(Math.ceil((MAX_OPERATIONAL_RECORD_BYTES * 4) / 3))
              .regex(/^[A-Za-z0-9_-]+$/u),
            byteLength: z
              .number()
              .int()
              .positive()
              .max(MAX_OPERATIONAL_RECORD_BYTES),
            contentSha256: hashSchema,
            dependencyId: idSchema,
            dependencyKind: z.enum(["record", "evidence"]),
          })
          .strict(),
      )
      .max(MAX_OPERATIONAL_EXPORT_REFERENCES),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const recordIds = new Set(
      value.records.map((record) => record.operationalRecordId),
    );
    if (recordIds.size !== value.records.length) {
      context.addIssue({
        code: "custom",
        message: "Operational export record identities must be unique.",
        path: ["records"],
      });
    }
    const bodies = new Map(
      value.referencedBodies.map((body) => [
        `${body.dependencyKind}:${body.dependencyId}`,
        body,
      ]),
    );
    if (bodies.size !== value.referencedBodies.length) {
      context.addIssue({
        code: "custom",
        message: "Operational export referenced bodies must be unique.",
        path: ["referencedBodies"],
      });
    }
    const referenced = new Set<string>();
    for (const [recordIndex, record] of value.records.entries()) {
      const dependencyKeys = new Set<string>();
      for (const [
        dependencyIndex,
        dependency,
      ] of record.dependencies.entries()) {
        const key = `${dependency.dependencyKind}:${dependency.dependencyId}`;
        if (dependencyKeys.has(key)) {
          context.addIssue({
            code: "custom",
            message: "Operational export dependencies must be unique.",
            path: ["records", recordIndex, "dependencies", dependencyIndex],
          });
        }
        dependencyKeys.add(key);
        if (dependency.dependencyKind !== "operational") {
          referenced.add(key);
          const body = bodies.get(key);
          if (
            body === undefined ||
            (dependency.contentSha256 !== null &&
              dependency.contentSha256 !== body.contentSha256)
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Every non-operational dependency requires its exact referenced body.",
              path: ["records", recordIndex, "dependencies", dependencyIndex],
            });
          }
        } else if (!recordIds.has(dependency.dependencyId)) {
          context.addIssue({
            code: "custom",
            message:
              "Every operational dependency must be closed inside the export.",
            path: ["records", recordIndex, "dependencies", dependencyIndex],
          });
        }
      }
    }
    for (const [key] of bodies) {
      if (!referenced.has(key)) {
        context.addIssue({
          code: "custom",
          message: "An exported referenced body must be dependency-reachable.",
          path: ["referencedBodies"],
        });
      }
    }
    const logicalBytes = [
      ...value.records.map((record) => record.byteLength),
      ...value.referencedBodies.map((body) => body.byteLength),
    ].reduce((total, byteLength) => total + byteLength, 0);
    if (logicalBytes > MAX_OPERATIONAL_EXPORT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "The operational export exceeds its bounded logical size.",
        path: ["referencedBodies"],
      });
    }
  });
export type OperationalPortableExport = z.infer<
  typeof operationalPortableExportSchema
>;

export const r4CapabilitiesSchema = z
  .object({
    authority: authoritySchema,
    format: z.literal(OWD_R4_CAPABILITIES_FORMAT),
    formats: z
      .array(
        z.enum([
          OWD_POLICY_BINDING_FORMAT,
          OWD_POLICY_DECISION_FORMAT,
          OWD_OPERATIONAL_SCHEDULE_FORMAT,
          OWD_OPERATIONAL_EVIDENCE_FORMAT,
          OWD_CONTINUITY_RECEIPT_FORMAT,
        ]),
      )
      .length(5),
    mcpProtocolRevision: z.literal("2025-11-25"),
    mcpTools: z
      .array(
        z.enum([
          "evaluate_run_policy",
          "get_policy_operations",
          "complete_continuity_drill",
        ]),
      )
      .length(3),
    requiredScope: z.literal("project.lead"),
    schemaVersion: z.literal(3),
  })
  .strict();

export const md8CapabilitiesSchema = z
  .object({
    authority: authoritySchema,
    completionModes: z.array(completionModeSchema).length(2),
    completionPolicyFormat: z.literal(OWD_COMPLETION_POLICY_FORMAT),
    connectionModes: z
      .array(z.enum(["direct-mcp", "lead-mediated-mcp", "portable-handoff"]))
      .length(3),
    format: z.literal(OWD_MD8_CAPABILITIES_FORMAT),
    legacyDefaultMode: z.literal("orchestrated-reviewed"),
    mcpProtocolRevision: z.literal("2025-11-25"),
    requiredScope: z.literal("project.lead"),
    schemaVersion: z.literal(4),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.completionModes).size !== 2 ||
      !value.completionModes.includes("orchestrated-reviewed") ||
      !value.completionModes.includes("solo-verified") ||
      new Set(value.connectionModes).size !== 3
    ) {
      context.addIssue({
        code: "custom",
        message: "MD8 capabilities must advertise each bounded mode once.",
        path: ["completionModes"],
      });
    }
  });

export const policyBindingJsonSchema = {
  $id: "urn:owd:schema:policy-binding:v1",
  ...z.toJSONSchema(policyBindingSchema, { target: "draft-2020-12" }),
};
export const policyDecisionJsonSchema = {
  $id: "urn:owd:schema:policy-decision:v1",
  ...z.toJSONSchema(policyDecisionSchema, { target: "draft-2020-12" }),
};
export const continuityReceiptJsonSchema = {
  $id: "urn:owd:schema:continuity-receipt:v1",
  ...z.toJSONSchema(continuityReceiptSchema, { target: "draft-2020-12" }),
};
