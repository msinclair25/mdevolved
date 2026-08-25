import { z } from "./zod";
import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  COMPOUNDING_SNAPSHOT_CAPABILITY,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  collaborationProjectSummarySchema,
  collaborationScopeSchema,
  snapshotIntelligenceManifestSchema,
} from "./collaboration";
import {
  PROJECT_CONNECTION_SCOPE,
  PROJECT_INITIALIZATION_SCOPE,
} from "./project-initialization";
import {
  portableSourceDescriptorSchema,
  sourceDescriptorCapabilitySchema,
  sourceDescriptorInputSchema,
} from "./source-descriptor";

export * from "./vault-path";
export * from "./collaboration";
export * from "./diagnostics";
export * from "./project-initialization";
export * from "./lead-operation";
export * from "./policy-operation";
export * from "./agent-memory";
export * from "./working-profile";
export * from "./compounding";
export * from "./project-outcomes";
export * from "./source-descriptor";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("owd-platform"),
  version: z.string().min(1),
  releaseId: z.string().min(1),
  releaseTag: z.string().min(1).nullable(),
  environment: z.string().min(1),
  requestId: z.string().uuid(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const setupStatusSchema = z.object({
  state: z.enum(["unclaimed", "ready"]),
  claimed: z.boolean(),
  authenticated: z.boolean(),
  claimMode: z.enum(["open", "invitation"]),
  claimAvailable: z.boolean(),
  claimExpiresAt: z.number().int().positive().nullable(),
  trialDays: z.number().int().positive().max(90).nullable(),
  trialEndsAt: z.number().int().positive().nullable(),
  trialExpired: z.boolean(),
  maxVaults: z.number().int().positive().nullable(),
  pairingEnabled: z.literal(true),
  nextAction: z.enum(["claim-owner", "authenticate", "pair-vault"]),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

const base64UrlSchema = z
  .string()
  .min(1)
  .max(65_536)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ownerClaimRequestSchema = z
  .object({
    claimToken: base64UrlSchema.min(43).max(128),
  })
  .strict();

export type OwnerClaimRequest = z.infer<typeof ownerClaimRequestSchema>;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export const vaultIdSchema = z.string().uuid();

export const vaultDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !hasControlCharacters(value));

export const pluginVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);

export const authenticatorTransportSchema = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

export const authenticatorTransportListSchema = z
  .array(authenticatorTransportSchema)
  .max(8);

const credentialDescriptorSchema = z
  .object({
    id: base64UrlSchema,
    type: z.literal("public-key"),
    transports: authenticatorTransportListSchema.optional(),
  })
  .strict();

export const registrationOptionsSchema = z
  .object({
    rp: z
      .object({
        id: z.string().min(1).max(253).optional(),
        name: z.string().min(1).max(100),
      })
      .strict(),
    user: z
      .object({
        id: base64UrlSchema,
        name: z.string().min(1).max(100),
        displayName: z.string().min(1).max(100),
      })
      .strict(),
    challenge: base64UrlSchema,
    pubKeyCredParams: z
      .array(
        z
          .object({
            alg: z.number().int(),
            type: z.literal("public-key"),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    timeout: z.number().int().positive().max(300_000).optional(),
    excludeCredentials: z.array(credentialDescriptorSchema).max(16).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z
          .enum(["cross-platform", "platform"])
          .optional(),
        requireResidentKey: z.boolean().optional(),
        residentKey: z
          .enum(["discouraged", "preferred", "required"])
          .optional(),
        userVerification: z
          .enum(["discouraged", "preferred", "required"])
          .optional(),
      })
      .strict()
      .optional(),
    hints: z
      .array(z.enum(["hybrid", "security-key", "client-device"]))
      .max(3)
      .optional(),
    attestation: z.enum(["direct", "enterprise", "none"]).optional(),
    attestationFormats: z
      .array(
        z.enum([
          "fido-u2f",
          "packed",
          "android-safetynet",
          "android-key",
          "tpm",
          "apple",
          "none",
        ]),
      )
      .max(8)
      .optional(),
    extensions: z
      .object({
        credProps: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RegistrationOptions = z.infer<typeof registrationOptionsSchema>;

export const authenticationOptionsSchema = z
  .object({
    challenge: base64UrlSchema,
    timeout: z.number().int().positive().max(300_000).optional(),
    rpId: z.string().min(1).max(253).optional(),
    allowCredentials: z.array(credentialDescriptorSchema).max(16).optional(),
    userVerification: z
      .enum(["discouraged", "preferred", "required"])
      .optional(),
    hints: z
      .array(z.enum(["hybrid", "security-key", "client-device"]))
      .max(3)
      .optional(),
  })
  .strict();

export type AuthenticationOptions = z.infer<typeof authenticationOptionsSchema>;

const clientExtensionResultsSchema = z
  .object({
    appid: z.boolean().optional(),
    credProps: z
      .object({
        rk: z.boolean().optional(),
      })
      .strict()
      .optional(),
    hmacCreateSecret: z.boolean().optional(),
  })
  .strict();

const credentialEnvelopeSchema = z.object({
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  type: z.literal("public-key"),
  authenticatorAttachment: z
    .enum(["cross-platform", "platform"])
    .nullable()
    .optional(),
  clientExtensionResults: clientExtensionResultsSchema,
});

export const registrationResponseSchema = credentialEnvelopeSchema
  .extend({
    response: z
      .object({
        clientDataJSON: base64UrlSchema,
        attestationObject: base64UrlSchema,
        authenticatorData: base64UrlSchema.optional(),
        transports: authenticatorTransportListSchema.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64UrlSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;

export const authenticationResponseSchema = credentialEnvelopeSchema
  .extend({
    response: z
      .object({
        clientDataJSON: base64UrlSchema,
        authenticatorData: base64UrlSchema,
        signature: base64UrlSchema,
        userHandle: base64UrlSchema.nullable().optional(),
      })
      .strict(),
  })
  .strict();

export type AuthenticationResponse = z.infer<
  typeof authenticationResponseSchema
>;

export const csrfResponseSchema = z.object({
  csrfToken: base64UrlSchema,
});

export type CsrfResponse = z.infer<typeof csrfResponseSchema>;

export const authenticationResultSchema = z.object({
  verified: z.literal(true),
  authenticated: z.literal(true),
  csrfToken: base64UrlSchema,
});

export type AuthenticationResult = z.infer<typeof authenticationResultSchema>;

export const sessionStatusSchema = z.object({
  authenticated: z.boolean(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const pairingGrantResponseSchema = z
  .object({
    vaultId: vaultIdSchema,
    pairingUrl: z.string().regex(/^owd-pair:\/\/connect\?/u),
    obsidianUrl: z.string().regex(/^obsidian:\/\/owd-pair\?/u),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type PairingGrantResponse = z.infer<typeof pairingGrantResponseSchema>;

export const pairingExchangeRequestSchema = z
  .object({
    grant: base64UrlSchema.max(128),
    vaultName: vaultDisplayNameSchema,
    pluginVersion: pluginVersionSchema,
    schemaVersion: z.number().int().min(1).max(3),
    sourceDescriptor: sourceDescriptorInputSchema.optional(),
  })
  .strict();

export type PairingExchangeRequest = z.infer<
  typeof pairingExchangeRequestSchema
>;

export const pairingExchangeResponseSchema = z
  .object({
    deploymentUrl: z.string().url(),
    vaultId: vaultIdSchema,
    credential: base64UrlSchema.max(128),
    serverVersion: z.string().min(1).max(64),
    supportedSchemaVersions: z
      .object({
        min: z.number().int().positive(),
        max: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type PairingExchangeResponse = z.infer<
  typeof pairingExchangeResponseSchema
>;

const vaultRuntimeProfilePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !hasControlCharacters(value))
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"))
  .refine((value) => !value.includes("\\"))
  .refine(
    (value) =>
      !value
        .replace(/\/+$/u, "")
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ),
  )
  .refine((value) => !value.includes("*"))
  .transform((value) => value.replace(/\/+$/u, ""));

const vaultRuntimeProfileFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !hasControlCharacters(value))
  .refine((value) => !value.includes("/") && !value.includes("\\"));

export const obsidianMindRuntimeProfileSchema = z
  .object({
    contentRoots: z
      .array(vaultRuntimeProfilePathSchema)
      .min(1)
      .max(32)
      .refine(
        (values) =>
          new Set(values.map((value) => value.toLocaleLowerCase("en-US")))
            .size === values.length,
      ),
    id: z.literal("obsidian-mind"),
    memoryRoot: vaultRuntimeProfilePathSchema,
    neverExposeFileNames: z
      .array(vaultRuntimeProfileFilenameSchema)
      .max(64)
      .refine(
        (values) =>
          new Set(values.map((value) => value.toLocaleLowerCase("en-US")))
            .size === values.length,
      ),
    version: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  })
  .strict()
  .refine(
    (profile) =>
      !profile.contentRoots.some(
        (root) =>
          root.toLocaleLowerCase("en-US") ===
            profile.memoryRoot.toLocaleLowerCase("en-US") ||
          root
            .toLocaleLowerCase("en-US")
            .startsWith(`${profile.memoryRoot.toLocaleLowerCase("en-US")}/`),
      ),
    {
      message: "The memory root cannot be exposed as ordinary content.",
    },
  );

export type ObsidianMindRuntimeProfile = z.infer<
  typeof obsidianMindRuntimeProfileSchema
>;

export const vaultSummarySchema = z
  .object({
    id: vaultIdSchema,
    displayName: vaultDisplayNameSchema.nullable(),
    status: z.enum(["pending", "active", "revoked"]),
    createdAt: z.number().int().nonnegative(),
    pairedAt: z.number().int().nonnegative().nullable(),
    lastConnectedAt: z.number().int().nonnegative().nullable(),
    runtimeProfile: obsidianMindRuntimeProfileSchema.nullable().optional(),
  })
  .strict();

export type VaultSummary = z.infer<typeof vaultSummarySchema>;

export const vaultListResponseSchema = z
  .object({
    vaults: z.array(vaultSummarySchema),
  })
  .strict();

export type VaultListResponse = z.infer<typeof vaultListResponseSchema>;

export const agentPathPrefixSchema = z
  .string()
  .max(1_024)
  .refine((value) => !hasControlCharacters(value));

export const agentVaultScopesSchema = z.union([
  z.tuple([z.literal("vault.read")]),
  z.tuple([z.literal("vault.read"), z.literal(PROJECT_INITIALIZATION_SCOPE)]),
  z.tuple([z.literal("vault.read"), z.literal(PROJECT_CONNECTION_SCOPE)]),
  z.tuple([
    z.literal("vault.read"),
    z.literal(PROJECT_INITIALIZATION_SCOPE),
    z.literal(PROJECT_CONNECTION_SCOPE),
  ]),
]);

export type AgentVaultScopes = z.infer<typeof agentVaultScopesSchema>;

const preparedProjectLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !hasControlCharacters(value));

const preparedProjectFolderSchema = z
  .string()
  .trim()
  .max(1_024)
  .refine((value) => !hasControlCharacters(value));

export const preparedProjectHandoffSchema = z
  .object({
    folderBoundary: preparedProjectFolderSchema,
    id: z.string().uuid(),
    preparedAt: z.number().int().nonnegative(),
    projectLabel: preparedProjectLabelSchema,
  })
  .strict();

export type PreparedProjectHandoff = z.infer<
  typeof preparedProjectHandoffSchema
>;

export const prepareProjectHandoffRequestSchema = z
  .object({
    folderBoundary: preparedProjectFolderSchema,
    projectLabel: preparedProjectLabelSchema,
  })
  .strict();

export type PrepareProjectHandoffRequest = z.infer<
  typeof prepareProjectHandoffRequestSchema
>;

export const prepareProjectHandoffResponseSchema = z
  .object({
    handoff: preparedProjectHandoffSchema,
  })
  .strict();

export type PrepareProjectHandoffResponse = z.infer<
  typeof prepareProjectHandoffResponseSchema
>;

export const restoredSourceSchema = z
  .object({
    appliedAt: z.number().int().nonnegative(),
    noteCount: z.number().int().nonnegative(),
    restoreId: z.string().uuid(),
    sourceVaultId: z.string().uuid(),
    sourceVaultName: vaultDisplayNameSchema,
    targetVaultId: vaultIdSchema,
  })
  .strict();

export type RestoredSource = z.infer<typeof restoredSourceSchema>;

const agentConsentClientSchema = z
  .object({
    id: z.string().min(1).max(2_048),
    name: z.string().min(1).max(120),
    origin: z.string().min(1).max(2_048),
    redirectUri: z.string().url().max(2_048),
    verified: z.literal(false),
  })
  .strict();

const agentConsentBase = z.object({
  flowToken: base64UrlSchema.max(128),
  client: agentConsentClientSchema,
  resource: z.string().url().max(2_048),
  expiresAt: z.number().int().positive(),
});

export const agentConsentContextSchema = z.discriminatedUnion(
  "authorizationKind",
  [
    agentConsentBase
      .extend({
        authorizationKind: z.literal("vault"),
        restoredSources: z.array(restoredSourceSchema).max(1_000),
        scopes: agentVaultScopesSchema,
        vaults: z.array(vaultSummarySchema).max(100),
      })
      .strict(),
    agentConsentBase
      .extend({
        authorizationKind: z.literal("collaboration"),
        projects: z.array(collaborationProjectSummarySchema).max(100),
        scopes: z
          .array(collaborationScopeSchema)
          .min(1)
          .max(5)
          .refine((values) => new Set(values).size === values.length),
      })
      .strict(),
  ],
);

export type AgentConsentContext = z.infer<typeof agentConsentContextSchema>;

export const agentConsentDecisionRequestSchema = z.discriminatedUnion(
  "authorizationKind",
  [
    z
      .object({
        authorizationKind: z.literal("vault"),
        flowToken: base64UrlSchema.max(128),
        approvedRestoreIds: z
          .array(z.string().uuid())
          .max(64)
          .refine((values) => new Set(values).size === values.length)
          .default([]),
        vaultId: vaultIdSchema,
        pathPrefixes: z.array(agentPathPrefixSchema).max(32),
      })
      .strict(),
    z
      .object({
        authorizationKind: z.literal("collaboration"),
        flowToken: base64UrlSchema.max(128),
        projectId: z.string().uuid(),
      })
      .strict(),
  ],
);

export type AgentConsentDecisionRequest = z.infer<
  typeof agentConsentDecisionRequestSchema
>;

export const agentConsentDenyRequestSchema = z
  .object({
    flowToken: base64UrlSchema.max(128),
  })
  .strict();

export const oauthRedirectResponseSchema = z
  .object({
    redirectTo: z.string().url().max(4_096),
  })
  .strict();

export type OAuthRedirectResponse = z.infer<typeof oauthRedirectResponseSchema>;

export const vaultLocalWriterRoleSchema = z.enum([
  "primary-writer",
  "read-only-collaborator",
  "unassigned",
]);

export const vaultLocalWriterAssignmentBasisSchema = z.enum([
  "project-creator",
  "first-project-agent",
  "owner-transfer",
]);

export const agentConnectionSchema = z
  .object({
    id: z.string().uuid(),
    clientId: z.string().min(1).max(2_048),
    clientName: z.string().min(1).max(120),
    clientOrigin: z.string().min(1).max(2_048),
    vaultId: vaultIdSchema,
    vaultName: vaultDisplayNameSchema,
    scopes: agentVaultScopesSchema,
    pathPrefixes: z.array(agentPathPrefixSchema).max(32),
    approvedRestoredSources: z.array(restoredSourceSchema).max(64),
    status: z.enum(["active", "revoked"]),
    createdAt: z.number().int().nonnegative(),
    activatedAt: z.number().int().nonnegative().nullable(),
    revokedAt: z.number().int().nonnegative().nullable(),
    lastUsedAt: z.number().int().nonnegative().nullable(),
    preparedProjectHandoff: preparedProjectHandoffSchema.nullable(),
    writerAssignmentBasis: vaultLocalWriterAssignmentBasisSchema.nullable(),
    writerAssignedAt: z.number().int().nonnegative().nullable(),
    writerEligible: z.boolean(),
    writerRole: vaultLocalWriterRoleSchema,
    writerUpdatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type AgentConnection = z.infer<typeof agentConnectionSchema>;

export const agentConnectionListResponseSchema = z
  .object({
    connections: z.array(agentConnectionSchema).max(1_000),
    mcpUrl: z.string().url().max(2_048),
  })
  .strict();

export type AgentConnectionListResponse = z.infer<
  typeof agentConnectionListResponseSchema
>;

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const MAX_MARKDOWN_NOTE_CHARACTERS = 1024 * 1024;

export const markdownNoteContentSchema = z
  .string()
  .max(MAX_MARKDOWN_NOTE_CHARACTERS);

export const markdownVaultPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !hasControlCharacters(value));

export const liveMarkdownNoteSchema = z
  .object({
    path: markdownVaultPathSchema,
    content: markdownNoteContentSchema,
    contentVersion: sha256HexSchema,
    modifiedAt: z.number().finite().nullable(),
  })
  .strict();

export type LiveMarkdownNote = z.infer<typeof liveMarkdownNoteSchema>;

/**
 * A null expected version is create-only. A SHA-256 version is update-only.
 * This prevents an ambiguous upsert from overwriting or reviving a note.
 */
export const markdownNoteWriteRequestSchema = z
  .object({
    path: markdownVaultPathSchema,
    content: markdownNoteContentSchema,
    expectedVersion: sha256HexSchema.nullable(),
  })
  .strict();

export type MarkdownNoteWriteRequest = z.infer<
  typeof markdownNoteWriteRequestSchema
>;

export const markdownNoteWriteResponseSchema = z
  .object({
    durable: z.literal(true),
    note: liveMarkdownNoteSchema,
    operation: z.enum(["created", "updated"]),
    projectionScheduled: z.literal(true),
  })
  .strict();

export type MarkdownNoteWriteResponse = z.infer<
  typeof markdownNoteWriteResponseSchema
>;

export const materializationGenerationSchema = z
  .object({
    generationId: z.string().uuid(),
    vaultId: vaultIdSchema,
    sourceStateVectorSha256: sha256HexSchema,
    noteCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MaterializationGeneration = z.infer<
  typeof materializationGenerationSchema
>;

export const currentMaterializationResponseSchema = z
  .object({
    generation: materializationGenerationSchema.nullable(),
  })
  .strict();

export type CurrentMaterializationResponse = z.infer<
  typeof currentMaterializationResponseSchema
>;

export const materializationJobSchema = z
  .object({
    failureCode: z.string().min(1).max(128).nullable(),
    generation: materializationGenerationSchema.nullable(),
    jobId: z.string().uuid(),
    processedNoteCount: z.number().int().nonnegative(),
    status: z.enum(["queued", "running", "completed", "failed"]),
    totalNoteCount: z.number().int().nonnegative(),
    vaultId: vaultIdSchema,
  })
  .strict();

export type MaterializationJob = z.infer<typeof materializationJobSchema>;

export const vaultSyncConfirmationRequestSchema = z
  .object({
    pluginVersion: pluginVersionSchema,
    runtimeProfile: obsidianMindRuntimeProfileSchema.optional(),
    schemaVersion: z.number().int().min(1).max(3),
    stateVector: base64UrlSchema.max(65_536),
  })
  .strict();

export type VaultSyncConfirmationRequest = z.infer<
  typeof vaultSyncConfirmationRequestSchema
>;

export const vaultSyncConfirmationResponseSchema = z
  .object({
    confirmed: z.literal(true),
    libraryBuild: materializationJobSchema,
    vaultId: vaultIdSchema,
  })
  .strict();

export type VaultSyncConfirmationResponse = z.infer<
  typeof vaultSyncConfirmationResponseSchema
>;

export const materializedNoteSummarySchema = z
  .object({
    path: z.string().min(1).max(1_024),
    title: z.string().max(255),
    contentSha256: sha256HexSchema,
    byteLength: z.number().int().nonnegative(),
    modifiedAt: z.number().finite().nullable(),
  })
  .strict();

export type MaterializedNoteSummary = z.infer<
  typeof materializedNoteSummarySchema
>;

export const materializedNotesResponseSchema = z
  .object({
    generation: materializationGenerationSchema,
    notes: z.array(materializedNoteSummarySchema).max(100),
    nextCursor: base64UrlSchema.max(2_048).nullable(),
  })
  .strict();

export type MaterializedNotesResponse = z.infer<
  typeof materializedNotesResponseSchema
>;

export const materializedSearchResultSchema = materializedNoteSummarySchema
  .extend({
    snippet: z.string().max(4_096),
  })
  .strict();

export type MaterializedSearchResult = z.infer<
  typeof materializedSearchResultSchema
>;

export const materializedSearchResponseSchema = z
  .object({
    generation: materializationGenerationSchema,
    results: z.array(materializedSearchResultSchema).max(50),
  })
  .strict();

export type MaterializedSearchResponse = z.infer<
  typeof materializedSearchResponseSchema
>;

export const OWD_BACKUP_MAGIC = "OWD-BACKUP-V1\n";
export const OWD_BACKUP_FORMAT = "owd-backup-v1" as const;
export const MAX_BACKUP_NOTES = 2_000;
export const MAX_BACKUP_TOTAL_BYTES = 32 * 1024 * 1024;

export const ageX25519RecipientSchema = z
  .string()
  .length(62)
  .regex(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u);

export const backupRecipientRequestSchema = z
  .object({ recipient: ageX25519RecipientSchema })
  .strict();

export const backupCreateRequestSchema = z
  .object({ recipientFingerprint: sha256HexSchema })
  .strict();

export const backupRecipientStatusSchema = z
  .object({
    configured: z.boolean(),
    fingerprint: sha256HexSchema.nullable(),
    recipient: ageX25519RecipientSchema.nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type BackupRecipientStatus = z.infer<typeof backupRecipientStatusSchema>;

export const backupArchiveNoteSchema = z
  .object({
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024),
    contentSha256: sha256HexSchema,
    modifiedAt: z.number().finite().nullable(),
    path: markdownVaultPathSchema,
  })
  .strict();

export type BackupArchiveNote = z.infer<typeof backupArchiveNoteSchema>;

export const backupArchiveManifestSchema = z
  .object({
    backupId: z.string().uuid(),
    createdAt: z.number().int().nonnegative(),
    excludedSections: z.tuple([
      z.literal("oauth"),
      z.literal("sessions"),
      z.literal("pairing-codes"),
      z.literal("agent-grants"),
      z.literal("pending-agent-proposals"),
      z.literal("unknown-obsidian-plugin-data"),
    ]),
    format: z.literal(OWD_BACKUP_FORMAT),
    generation: materializationGenerationSchema,
    includedSections: z.tuple([z.literal("notes")]),
    notes: z.array(backupArchiveNoteSchema).max(MAX_BACKUP_NOTES),
    reservedSections: z.tuple([
      z.literal("attachments"),
      z.literal("obsidian-allowlist"),
      z.literal("accepted-memory"),
      z.literal("skills"),
      z.literal("provenance"),
      z.literal("policy"),
    ]),
    vaultName: vaultDisplayNameSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.notes.length !== manifest.generation.noteCount) {
      context.addIssue({
        code: "custom",
        message: "Backup note count does not match its generation.",
        path: ["notes"],
      });
    }
    const totalBytes = manifest.notes.reduce(
      (total, note) => total + note.byteLength,
      0,
    );
    if (totalBytes !== manifest.generation.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "Backup byte count does not match its generation.",
        path: ["notes"],
      });
    }
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Backup exceeds the maximum materialized generation size.",
        path: ["notes"],
      });
    }
  });

export type BackupArchiveManifest = z.infer<typeof backupArchiveManifestSchema>;

export const backupArtifactSchema = z
  .object({
    backupId: z.string().uuid(),
    ciphertextBytes: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    format: z.literal(OWD_BACKUP_FORMAT),
    generationId: z.string().uuid(),
    noteCount: z.number().int().nonnegative(),
    recipientFingerprint: sha256HexSchema,
    vaultId: vaultIdSchema,
    verifiedAt: z.number().int().nonnegative(),
  })
  .strict();

export type BackupArtifact = z.infer<typeof backupArtifactSchema>;

export const backupListResponseSchema = z
  .object({ backups: z.array(backupArtifactSchema).max(100) })
  .strict();

export type BackupListResponse = z.infer<typeof backupListResponseSchema>;

export const OWD_SNAPSHOT_FORMAT = "owd-snapshot-v2" as const;
export const OWD_SNAPSHOT_EXPORT_MAGIC = "OWD-SNAPSHOT-EXPORT-V2\n";
export const MAX_SNAPSHOT_VAULTS = 20;
export const MAX_SNAPSHOT_ITEMS = 5_000;
export const MAX_SNAPSHOT_LOGICAL_BYTES = 128 * 1024 * 1024;
export const MAX_SNAPSHOT_ENCRYPTED_PART_BYTES = 40 * 1024 * 1024;

export const snapshotSectionSchema = z.enum([
  "notes",
  "attachments",
  "obsidian-allowlist",
]);

export type SnapshotSection = z.infer<typeof snapshotSectionSchema>;

export const snapshotRequiredCapabilitySchema = z.string().min(1).max(120);

export const BASE_SNAPSHOT_REQUIRED_CAPABILITIES = [
  "owd.snapshot.notes-v1",
  "owd.snapshot.explicit-target-mapping-v1",
  "owd.snapshot.age-x25519-objects-v1",
] as const;

export const SUPPORTED_SNAPSHOT_REQUIRED_CAPABILITIES = [
  ...BASE_SNAPSHOT_REQUIRED_CAPABILITIES,
  APPROVED_INTELLIGENCE_CAPABILITY,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  COMPOUNDING_SNAPSHOT_CAPABILITY,
] as const;

export const snapshotObjectManifestSchema = z
  .object({
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
    contentSha256: sha256HexSchema,
    portableObjectId: z.string().uuid(),
    section: snapshotSectionSchema,
  })
  .strict();

export type SnapshotObjectManifest = z.infer<
  typeof snapshotObjectManifestSchema
>;

export const snapshotEntryManifestSchema = z
  .object({
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
    contentSha256: sha256HexSchema,
    modifiedAt: z.number().finite().nullable(),
    path: z.string().min(1).max(1_024),
    portableObjectId: z.string().uuid(),
    section: snapshotSectionSchema,
  })
  .strict();

export type SnapshotEntryManifest = z.infer<typeof snapshotEntryManifestSchema>;

export const snapshotSourceGenerationSchema = z
  .object({
    completedAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    generationId: z.string().uuid(),
    noteCount: z.number().int().nonnegative(),
    sourceStateVectorSha256: sha256HexSchema,
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

export const snapshotVaultManifestSchema = z
  .object({
    entries: z.array(snapshotEntryManifestSchema).max(MAX_SNAPSHOT_ITEMS),
    snapshotVaultId: z.string().uuid(),
    sourceVaultId: z.string().uuid().nullable().optional(),
    sourceGeneration: snapshotSourceGenerationSchema.nullable(),
    sourceDescriptor: portableSourceDescriptorSchema.optional(),
    vaultName: vaultDisplayNameSchema,
  })
  .strict();

export type SnapshotVaultManifest = z.infer<typeof snapshotVaultManifestSchema>;

export const snapshotManifestSchema = z
  .object({
    captureCompletedAt: z.number().int().nonnegative(),
    captureStartedAt: z.number().int().nonnegative(),
    excludedSecuritySections: z.tuple([
      z.literal("oauth"),
      z.literal("sessions"),
      z.literal("passkeys"),
      z.literal("pairing-secrets"),
      z.literal("agent-grants"),
      z.literal("pending-agent-proposals"),
      z.literal("harness-context"),
      z.literal("unknown-obsidian-plugin-data"),
    ]),
    format: z.literal(OWD_SNAPSHOT_FORMAT),
    includedSections: z.array(snapshotSectionSchema).min(1).max(3),
    intelligence: snapshotIntelligenceManifestSchema.optional(),
    logicalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SNAPSHOT_LOGICAL_BYTES),
    objects: z.array(snapshotObjectManifestSchema).max(MAX_SNAPSHOT_ITEMS),
    optionalCapabilities: z.array(z.string().min(1).max(120)).max(32),
    recipientFingerprint: sha256HexSchema,
    requiredCapabilities: z
      .array(snapshotRequiredCapabilitySchema)
      .min(1)
      .max(32),
    reservedSections: z.tuple([
      z.literal("accepted-handoffs"),
      z.literal("durable-knowledge"),
      z.literal("skills"),
      z.literal("evaluations"),
      z.literal("provenance"),
      z.literal("policy"),
    ]),
    scope: z.enum(["all-active", "selected", "imported"]),
    snapshotId: z.string().uuid(),
    unavailableSections: z.array(snapshotSectionSchema).max(3),
    vaults: z
      .array(snapshotVaultManifestSchema)
      .min(1)
      .max(MAX_SNAPSHOT_VAULTS),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.captureCompletedAt < manifest.captureStartedAt) {
      context.addIssue({
        code: "custom",
        message: "Snapshot capture completion precedes its start.",
        path: ["captureCompletedAt"],
      });
    }

    const included = new Set(manifest.includedSections);
    if (included.size !== manifest.includedSections.length) {
      context.addIssue({
        code: "custom",
        message: "Snapshot sections must be unique.",
        path: ["includedSections"],
      });
    }
    if (manifest.unavailableSections.some((section) => included.has(section))) {
      context.addIssue({
        code: "custom",
        message: "A snapshot section cannot be both included and unavailable.",
        path: ["unavailableSections"],
      });
    }

    const objects = new Map(
      manifest.objects.map((object) => [object.portableObjectId, object]),
    );
    if (objects.size !== manifest.objects.length) {
      context.addIssue({
        code: "custom",
        message: "Snapshot object identities must be unique.",
        path: ["objects"],
      });
    }

    let itemCount = 0;
    let logicalBytes = 0;
    const referencedObjectIds = new Set<string>();
    const vaultIds = new Set<string>();
    for (const [vaultIndex, vault] of manifest.vaults.entries()) {
      if (vaultIds.has(vault.snapshotVaultId)) {
        context.addIssue({
          code: "custom",
          message: "Snapshot vault identities must be unique.",
          path: ["vaults", vaultIndex, "snapshotVaultId"],
        });
      }
      vaultIds.add(vault.snapshotVaultId);
      const paths = new Set<string>();
      for (const [entryIndex, entry] of vault.entries.entries()) {
        itemCount += 1;
        logicalBytes += entry.byteLength;
        referencedObjectIds.add(entry.portableObjectId);
        const pathIdentity = `${entry.section}:${entry.path.normalize("NFC").toLocaleLowerCase("en-US")}`;
        if (paths.has(pathIdentity)) {
          context.addIssue({
            code: "custom",
            message: "Snapshot paths must be unique within a vault section.",
            path: ["vaults", vaultIndex, "entries", entryIndex, "path"],
          });
        }
        paths.add(pathIdentity);
        const object = objects.get(entry.portableObjectId);
        if (
          object === undefined ||
          object.byteLength !== entry.byteLength ||
          object.contentSha256 !== entry.contentSha256 ||
          object.section !== entry.section
        ) {
          context.addIssue({
            code: "custom",
            message: "Snapshot entry does not match its content object.",
            path: [
              "vaults",
              vaultIndex,
              "entries",
              entryIndex,
              "portableObjectId",
            ],
          });
        }
      }
      if (
        vault.sourceGeneration !== null &&
        (vault.sourceGeneration.noteCount !==
          vault.entries.filter((entry) => entry.section === "notes").length ||
          vault.sourceGeneration.totalBytes !==
            vault.entries
              .filter((entry) => entry.section === "notes")
              .reduce((total, entry) => total + entry.byteLength, 0))
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Snapshot vault entries do not match their source generation.",
          path: ["vaults", vaultIndex, "entries"],
        });
      }
    }
    if (itemCount > MAX_SNAPSHOT_ITEMS) {
      context.addIssue({
        code: "custom",
        message: "Snapshot contains too many items.",
        path: ["vaults"],
      });
    }
    if (referencedObjectIds.size !== objects.size) {
      context.addIssue({
        code: "custom",
        message: "Every snapshot content object must be referenced.",
        path: ["objects"],
      });
    }
    if (logicalBytes !== manifest.logicalBytes) {
      context.addIssue({
        code: "custom",
        message: "Snapshot logical byte count does not match its entries.",
        path: ["logicalBytes"],
      });
    }

    const intelligenceCapabilities = manifest.requiredCapabilities.filter(
      (capability) =>
        capability === APPROVED_INTELLIGENCE_CAPABILITY ||
        capability === QUARANTINED_INTELLIGENCE_CAPABILITY ||
        capability === WORKING_PROFILE_SNAPSHOT_CAPABILITY ||
        capability === COMPOUNDING_SNAPSHOT_CAPABILITY,
    );
    if (manifest.intelligence === undefined) {
      if (intelligenceCapabilities.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "A legacy snapshot without intelligence cannot require intelligence capabilities.",
          path: ["requiredCapabilities"],
        });
      }
    } else if (
      manifest.intelligence.requiredCapabilities.length !==
        intelligenceCapabilities.length ||
      manifest.intelligence.requiredCapabilities.some(
        (capability, index) => capability !== intelligenceCapabilities[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Snapshot intelligence capabilities must match the encrypted extension.",
        path: ["intelligence", "requiredCapabilities"],
      });
    }
  });

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const snapshotVaultSummarySchema = z
  .object({
    generationId: z.string().uuid().nullable(),
    itemCount: z.number().int().nonnegative(),
    logicalBytes: z.number().int().nonnegative(),
    snapshotVaultId: z.string().uuid(),
    sourceVaultId: vaultIdSchema.nullable(),
    vaultName: vaultDisplayNameSchema,
  })
  .strict();

export const snapshotIntelligenceSectionSummarySchema = z
  .object({
    evidenceObjectCount: z.number().int().nonnegative(),
    logicalBytes: z.number().int().nonnegative(),
    newlyStoredBytes: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
  })
  .strict();

export const snapshotIntelligenceSummarySchema = z
  .object({
    approved: snapshotIntelligenceSectionSummarySchema.nullable(),
    selection: z.enum(["none", "approved", "approved-and-unvetted"]),
    unvetted: snapshotIntelligenceSectionSummarySchema.nullable(),
  })
  .strict();

export type SnapshotIntelligenceSummary = z.infer<
  typeof snapshotIntelligenceSummarySchema
>;

export const snapshotSummarySchema = z
  .object({
    archivedAt: z.number().int().nonnegative().nullable(),
    captureCompletedAt: z.number().int().nonnegative().nullable(),
    captureStartedAt: z.number().int().nonnegative(),
    changedItemCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    failureCode: z.string().min(1).max(128).nullable(),
    format: z.literal(OWD_SNAPSHOT_FORMAT),
    includedSections: z.array(snapshotSectionSchema).min(1).max(3),
    intelligence: snapshotIntelligenceSummarySchema,
    integrityStatus: z.enum(["pending", "verified", "degraded"]),
    itemCount: z.number().int().nonnegative(),
    logicalBytes: z.number().int().nonnegative(),
    newlyStoredBytes: z.number().int().nonnegative(),
    pinned: z.boolean(),
    processedObjectCount: z.number().int().nonnegative(),
    recipientFingerprint: sha256HexSchema,
    encryption: z.literal("age-x25519"),
    scope: z.enum(["all-active", "selected", "imported"]),
    snapshotId: z.string().uuid(),
    status: z.enum(["creating", "importing", "ready", "failed"]),
    totalObjectCount: z.number().int().nonnegative(),
    unavailableSections: z.array(snapshotSectionSchema).max(3),
    vaults: z.array(snapshotVaultSummarySchema).max(MAX_SNAPSHOT_VAULTS),
    verifiedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const snapshotListResponseSchema = z
  .object({ snapshots: z.array(snapshotSummarySchema).max(100) })
  .strict();

export const snapshotCreateRequestSchema = z
  .object({
    intelligenceSelection: z
      .enum(["none", "approved", "approved-and-unvetted"])
      .default("approved"),
    vaultIds: z
      .array(vaultIdSchema)
      .min(1)
      .max(MAX_SNAPSHOT_VAULTS)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
  })
  .strict();

export const snapshotPinRequestSchema = z
  .object({ pinned: z.boolean() })
  .strict();

export const snapshotArchiveRequestSchema = z
  .object({ archived: z.boolean() })
  .strict();

export const snapshotEstimateSchema = z
  .object({
    currentRetainedCiphertextBytes: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
    intelligence: snapshotIntelligenceSummarySchema,
    logicalBytes: z.number().int().nonnegative(),
    projectedNewPlaintextBytes: z.number().int().nonnegative(),
    reusableObjectCount: z.number().int().nonnegative(),
    scope: z.enum(["all-active", "selected"]),
    vaultCount: z.number().int().positive(),
  })
  .strict();

export type SnapshotEstimate = z.infer<typeof snapshotEstimateSchema>;

export const snapshotRetentionPolicySchema = z
  .object({
    currentRetainedCiphertextBytes: z.number().int().nonnegative(),
    enabled: z.boolean(),
    keepReadyCount: z.number().int().min(2).max(100),
    maxRetainedCiphertextBytes: z.number().int().nonnegative().nullable(),
    protectedSnapshotCount: z.number().int().nonnegative(),
    readySnapshotCount: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type SnapshotRetentionPolicy = z.infer<
  typeof snapshotRetentionPolicySchema
>;

export const snapshotRetentionPolicyRequestSchema = z
  .object({
    enabled: z.boolean(),
    keepReadyCount: z.number().int().min(2).max(100),
    maxRetainedCiphertextBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const snapshotRetentionRunSchema = z
  .object({
    deletedSnapshotCount: z.number().int().nonnegative(),
    pendingObjectCount: z.number().int().nonnegative(),
    policy: snapshotRetentionPolicySchema,
  })
  .strict();

export const snapshotRepairResponseSchema = z
  .object({
    nextPortableObjectId: z.string().uuid().nullable(),
    summary: snapshotSummarySchema,
  })
  .strict();

export const snapshotExportPartSchema = z
  .object({
    ciphertextBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_SNAPSHOT_ENCRYPTED_PART_BYTES),
    portableObjectId: z.string().uuid(),
    role: z.enum(["manifest", "content"]),
  })
  .strict();

export const snapshotExportIndexSchema = z
  .object({
    format: z.literal(OWD_SNAPSHOT_FORMAT),
    intelligenceSelection: z
      .enum(["none", "approved", "approved-and-unvetted"])
      .optional(),
    optionalCapabilities: z.array(z.string().min(1).max(120)).max(32),
    parts: z
      .array(snapshotExportPartSchema)
      .min(1)
      .max(MAX_SNAPSHOT_ITEMS + 2 * MAX_SNAPSHOT_ITEMS + 1),
    requiredCapabilities: z
      .array(snapshotRequiredCapabilitySchema)
      .min(1)
      .max(32),
    snapshotId: z.string().uuid(),
  })
  .strict()
  .superRefine((index, context) => {
    if (index.parts[0]?.role !== "manifest") {
      context.addIssue({
        code: "custom",
        message: "The portable snapshot manifest must be first.",
        path: ["parts", 0],
      });
    }
    if (index.parts.filter((part) => part.role === "manifest").length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A portable snapshot requires exactly one manifest.",
        path: ["parts"],
      });
    }
    if (
      new Set(index.parts.map((part) => part.portableObjectId)).size !==
      index.parts.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Portable snapshot part identities must be unique.",
        path: ["parts"],
      });
    }
  });

export type SnapshotExportIndex = z.infer<typeof snapshotExportIndexSchema>;

export function unsupportedSnapshotRequiredCapabilities(
  values: readonly string[],
): string[] {
  const supported = new Set<string>(SUPPORTED_SNAPSHOT_REQUIRED_CAPABILITIES);
  return values.filter((value) => !supported.has(value));
}

export const restoreCreateRequestSchema = z
  .object({ manifest: backupArchiveManifestSchema })
  .strict();

export const restoreNoteUploadRequestSchema = z
  .object({
    content: markdownNoteContentSchema,
    path: markdownVaultPathSchema,
  })
  .strict();

export const restoreConfirmationRequestSchema = z
  .object({ vaultName: vaultDisplayNameSchema })
  .strict();

export const restoreJobSchema = z
  .object({
    addedCount: z.number().int().nonnegative().nullable(),
    appliedNoteCount: z.number().int().nonnegative(),
    changedCount: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    expectedBytes: z.number().int().nonnegative(),
    expectedNoteCount: z.number().int().nonnegative(),
    materializationJobId: z.string().uuid().nullable(),
    restoreId: z.string().uuid(),
    sourceBackupId: z.string().uuid(),
    sourceVaultId: vaultIdSchema,
    sourceVaultName: vaultDisplayNameSchema,
    status: z.enum(["staging", "preview", "applying", "applied", "failed"]),
    targetVaultId: vaultIdSchema,
    unchangedCount: z.number().int().nonnegative().nullable(),
    updatedAt: z.number().int().nonnegative(),
    uploadedBytes: z.number().int().nonnegative(),
    uploadedNoteCount: z.number().int().nonnegative(),
    verifiedGenerationId: z.string().uuid().nullable(),
  })
  .strict();

export type RestoreJob = z.infer<typeof restoreJobSchema>;

export const restoreApplyResponseSchema = z
  .object({
    complete: z.boolean(),
    job: restoreJobSchema,
  })
  .strict();

export const restoreMarkdownNoteRequestSchema = z
  .object({
    content: markdownNoteContentSchema,
    contentSha256: sha256HexSchema,
    expectedTargetContentSha256: sha256HexSchema.nullable(),
    modifiedAt: z.number().finite().nullable(),
    path: markdownVaultPathSchema,
  })
  .strict();

export type RestoreMarkdownNoteRequest = z.infer<
  typeof restoreMarkdownNoteRequestSchema
>;

export const noteCursorSchema = base64UrlSchema.max(2_048);

export const materializedSearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacters(value));

export const materializedNotesRequestSchema = z
  .object({
    cursor: noteCursorSchema.nullable().default(null),
  })
  .strict();

export const materializedSearchRequestSchema = z
  .object({
    query: materializedSearchQuerySchema,
  })
  .strict();

export const materializedNoteReadRequestSchema = z
  .object({
    path: markdownVaultPathSchema,
  })
  .strict();

export const socketTicketResponseSchema = z
  .object({
    ticket: z.string().min(1).max(2_048),
    expiresAt: z.number().int().positive(),
    ttlMs: z.number().int().positive().max(86_400_000),
  })
  .strict();

export type SocketTicketResponse = z.infer<typeof socketTicketResponseSchema>;

export const serverCapabilitiesSchema = z
  .object({
    claimed: z.boolean(),
    authMode: z.enum(["claim", "unclaimed"]),
    attachments: z.boolean(),
    snapshots: z.boolean(),
    socketTicketAuth: z.literal(true),
    serverVersion: z.string().min(1).max(64),
    minPluginVersion: z.string().nullable(),
    recommendedPluginVersion: z.string().nullable(),
    minSchemaVersion: z.number().int().positive(),
    maxSchemaVersion: z.number().int().positive(),
    migrationRequired: z.boolean(),
    updateProvider: z.enum(["github", "gitlab", "unknown"]).nullable(),
    updateRepoUrl: z.string().url().nullable(),
    updateRepoBranch: z.string().min(1).max(255).nullable(),
    sourceDescriptors: sourceDescriptorCapabilitySchema.optional(),
  })
  .strict();

export type ServerCapabilities = z.infer<typeof serverCapabilitiesSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().uuid(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
