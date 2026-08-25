import { z } from "./zod";
import { workingProfileRecordTypeSchema } from "./working-profile";

export const OWD_WORK_PACKET_FORMAT = "owd-work-packet-v1" as const;
export const OWD_COLLABORATION_SUBMISSION_FORMAT =
  "owd-collaboration-submission-v1" as const;
export const OWD_COLLABORATION_LEDGER_FORMAT =
  "owd-collaboration-ledger-v1" as const;
export const OWD_COLLABORATION_CAPABILITIES_FORMAT =
  "owd-collaboration-capabilities-v1" as const;
export const OWD_SNAPSHOT_INTELLIGENCE_FORMAT =
  "owd-snapshot-intelligence-v1" as const;
export const OWD_CONTINUITY_POINT_FORMAT = "owd-continuity-point-v1" as const;
export const OWD_LEAD_CONTINUITY_CAPABILITIES_FORMAT =
  "owd-lead-continuity-capabilities-v1" as const;
export const OWD_PORTABLE_CONTINUITY_BUNDLE_FORMAT =
  "owd-portable-continuity-bundle-v1" as const;

export const APPROVED_INTELLIGENCE_CAPABILITY =
  "owd.snapshot.approved-intelligence-v1" as const;
export const QUARANTINED_INTELLIGENCE_CAPABILITY =
  "owd.snapshot.quarantined-intelligence-v1" as const;
export const WORKING_PROFILE_SNAPSHOT_CAPABILITY =
  "owd.snapshot.working-profile-v1" as const;
export const COMPOUNDING_SNAPSHOT_CAPABILITY =
  "owd.snapshot.compounding-v1" as const;
export const MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS = 14;

export const snapshotIntelligenceRequiredCapabilitySchema = z.enum([
  APPROVED_INTELLIGENCE_CAPABILITY,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  WORKING_PROFILE_SNAPSHOT_CAPABILITY,
  COMPOUNDING_SNAPSHOT_CAPABILITY,
]);

export const MAX_KNOWLEDGE_SPACE_VAULTS = 20;
export const MAX_KNOWLEDGE_SPACE_PREFIXES_PER_VAULT = 32;
export const MAX_PACKET_CITATIONS = 64;
export const MAX_PACKET_INCLUDED_RECORDS = 64;
export const MAX_PACKET_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_SUBMISSION_BYTES = 1024 * 1024;
export const MAX_ATTEMPT_ARTIFACTS = 16;
export const MAX_INTELLIGENCE_RECORDS = 5_000;
export const MAX_INTELLIGENCE_EVIDENCE_OBJECTS = 5_000;
export const MAX_INTELLIGENCE_LOGICAL_BYTES = 128 * 1024 * 1024;
export const MAX_CONTINUITY_REFERENCES = 64;
export const MAX_CONTINUITY_STATE_ITEMS = 64;
export const MIN_PROJECT_LEAD_LEASE_SECONDS = 60;
export const MAX_PROJECT_LEAD_LEASE_SECONDS = 15 * 60;

const portableIdSchema = z.string().uuid();
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const unixSecondsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

function canonicalStringSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value === value.trim(), {
      message: "Portable strings must not contain leading or trailing space.",
    });
}

const shortLabelSchema = canonicalStringSchema(120);
const roleLabelSchema = canonicalStringSchema(64);
const proseSchema = canonicalStringSchema(32_768);
const boundedListItemSchema = canonicalStringSchema(4_096);

function hasControlOrFormatCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

function normalizedPathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function safeRelativePath(value: string, allowRoot: boolean): boolean {
  if (allowRoot && value === "") return true;
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    hasControlOrFormatCharacter(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment, index) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !(index === 0 && segment.toLocaleLowerCase("en-US") === ".obsidian"),
  );
}

const safeMarkdownPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => safeRelativePath(value, false))
  .refine((value) => value.toLocaleLowerCase("en-US").endsWith(".md"));

export const collaborationPathPrefixSchema = z
  .object({
    path: z
      .string()
      .max(1_024)
      .refine((value) => safeRelativePath(value, true)),
    pathKey: z.string().max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pathKey !== normalizedPathKey(value.path)) {
      context.addIssue({
        code: "custom",
        message: "The path key must be the normalized case-folded path.",
        path: ["pathKey"],
      });
    }
  });

export const collaborationRecordTypeSchema = z.enum([
  "knowledge-space",
  "knowledge-space-version",
  "project",
  "project-version",
  "work-item",
  "work-item-version",
  "participant-ref",
  "work-packet",
  "attempt",
  "artifact",
  "handoff",
  "review",
  "decision",
  "owner-event",
  "provenance-edge",
]);

export type CollaborationRecordType = z.infer<
  typeof collaborationRecordTypeSchema
>;

export const collaborationScopeSchema = z.enum([
  "project.read",
  "project.lead",
  "collaboration.submit",
  "review.submit",
  "proposal.status",
]);

export type CollaborationScope = z.infer<typeof collaborationScopeSchema>;

export const collaborationGrantSchema = z
  .object({
    audience: z.string().url().max(2_048),
    expiresAt: unixSecondsSchema,
    grantId: portableIdSchema,
    issuedAt: unixSecondsSchema,
    knowledgeSpaceVersionId: portableIdSchema,
    oauthClientId: z.string().min(1).max(2_048),
    projectId: portableIdSchema,
    revokedAt: unixSecondsSchema.nullable(),
    scopes: z.array(collaborationScopeSchema).min(1).max(5),
    status: z.enum(["active", "revoked"]),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.expiresAt <= grant.issuedAt) {
      context.addIssue({
        code: "custom",
        message: "A collaboration grant must expire after it is issued.",
        path: ["expiresAt"],
      });
    }
    if (new Set(grant.scopes).size !== grant.scopes.length) {
      context.addIssue({
        code: "custom",
        message: "Collaboration grant scopes must be unique.",
        path: ["scopes"],
      });
    }
    if (
      (grant.status === "active" && grant.revokedAt !== null) ||
      (grant.status === "revoked" && grant.revokedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Grant status and revocation time disagree.",
        path: ["revokedAt"],
      });
    }
  });

export const knowledgeSpaceSchema = z
  .object({
    createdAt: unixSecondsSchema,
    initialLabel: shortLabelSchema,
    knowledgeSpaceId: portableIdSchema,
    recordType: z.literal("knowledge-space"),
    schemaVersion: z.literal(1),
  })
  .strict();

export const knowledgeSpaceMemberSchema = z
  .object({
    exclusions: z
      .array(collaborationPathPrefixSchema)
      .max(MAX_KNOWLEDGE_SPACE_PREFIXES_PER_VAULT),
    pathPrefixes: z
      .array(collaborationPathPrefixSchema)
      .min(1)
      .max(MAX_KNOWLEDGE_SPACE_PREFIXES_PER_VAULT),
    vaultId: portableIdSchema,
  })
  .strict()
  .superRefine((member, context) => {
    const included = new Set(
      member.pathPrefixes.map((prefix) => prefix.pathKey),
    );
    if (included.size !== member.pathPrefixes.length) {
      context.addIssue({
        code: "custom",
        message: "Knowledge Space path prefixes must be unique.",
        path: ["pathPrefixes"],
      });
    }
    const excluded = new Set(member.exclusions.map((prefix) => prefix.pathKey));
    if (excluded.size !== member.exclusions.length) {
      context.addIssue({
        code: "custom",
        message: "Knowledge Space exclusions must be unique.",
        path: ["exclusions"],
      });
    }
    for (const [index, exclusion] of member.exclusions.entries()) {
      const covered = member.pathPrefixes.some(
        (prefix) =>
          prefix.pathKey === "" ||
          exclusion.pathKey === prefix.pathKey ||
          exclusion.pathKey.startsWith(`${prefix.pathKey}/`),
      );
      if (!covered) {
        context.addIssue({
          code: "custom",
          message: "Every exclusion must be inside an included path prefix.",
          path: ["exclusions", index],
        });
      }
    }
  });

export const knowledgeSpaceVersionSchema = z
  .object({
    createdAt: unixSecondsSchema,
    knowledgeSpaceId: portableIdSchema,
    knowledgeSpaceVersionId: portableIdSchema,
    members: z
      .array(knowledgeSpaceMemberSchema)
      .min(1)
      .max(MAX_KNOWLEDGE_SPACE_VAULTS),
    previousVersionId: portableIdSchema.nullable(),
    recordType: z.literal("knowledge-space-version"),
    schemaVersion: z.literal(1),
    selectorSha256: sha256HexSchema,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((version, context) => {
    const vaultIds = version.members.map((member) => member.vaultId);
    if (new Set(vaultIds).size !== vaultIds.length) {
      context.addIssue({
        code: "custom",
        message: "A Knowledge Space version may name each vault only once.",
        path: ["members"],
      });
    }
    if (version.version === 1 && version.previousVersionId !== null) {
      context.addIssue({
        code: "custom",
        message: "The first Knowledge Space version has no predecessor.",
        path: ["previousVersionId"],
      });
    }
    if (version.version > 1 && version.previousVersionId === null) {
      context.addIssue({
        code: "custom",
        message:
          "Later Knowledge Space versions must identify their predecessor.",
        path: ["previousVersionId"],
      });
    }
    if (version.previousVersionId === version.knowledgeSpaceVersionId) {
      context.addIssue({
        code: "custom",
        message: "A Knowledge Space version cannot be its own predecessor.",
        path: ["previousVersionId"],
      });
    }
  });

export const projectSchema = z
  .object({
    createdAt: unixSecondsSchema,
    initialLabel: shortLabelSchema,
    projectId: portableIdSchema,
    recordType: z.literal("project"),
    schemaVersion: z.literal(1),
  })
  .strict();

export const projectVersionSchema = z
  .object({
    createdAt: unixSecondsSchema,
    knowledgeSpaceVersionId: portableIdSchema,
    objective: proseSchema,
    packetPolicy: z
      .object({
        maxCitationCount: z.number().int().positive().max(MAX_PACKET_CITATIONS),
        maxEvidenceBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_PACKET_EVIDENCE_BYTES),
        maxSharedRecordCount: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_PACKET_INCLUDED_RECORDS),
      })
      .strict(),
    previousVersionId: portableIdSchema.nullable(),
    projectId: portableIdSchema,
    projectVersionId: portableIdSchema,
    recordType: z.literal("project-version"),
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((version, context) => {
    if (
      (version.version === 1 && version.previousVersionId !== null) ||
      (version.version > 1 && version.previousVersionId === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the first Project version may omit its predecessor.",
        path: ["previousVersionId"],
      });
    }
    if (version.previousVersionId === version.projectVersionId) {
      context.addIssue({
        code: "custom",
        message: "A Project version cannot be its own predecessor.",
        path: ["previousVersionId"],
      });
    }
  });

export const workItemSchema = z
  .object({
    createdAt: unixSecondsSchema,
    projectId: portableIdSchema,
    recordType: z.literal("work-item"),
    schemaVersion: z.literal(1),
    workItemId: portableIdSchema,
  })
  .strict();

export const workItemBriefSchema = z
  .object({
    constraints: z.array(boundedListItemSchema).max(32),
    definitionOfDone: z.array(boundedListItemSchema).min(1).max(32),
    objective: proseSchema,
    requestedOutput: proseSchema,
  })
  .strict();

export const workItemVersionSchema = z
  .object({
    brief: workItemBriefSchema,
    createdAt: unixSecondsSchema,
    previousVersionId: portableIdSchema.nullable(),
    projectId: portableIdSchema,
    recordType: z.literal("work-item-version"),
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
    workItemId: portableIdSchema,
    workItemVersionId: portableIdSchema,
  })
  .strict()
  .superRefine((version, context) => {
    if (
      (version.version === 1 && version.previousVersionId !== null) ||
      (version.version > 1 && version.previousVersionId === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the first Work Item version may omit its predecessor.",
        path: ["previousVersionId"],
      });
    }
    if (version.previousVersionId === version.workItemVersionId) {
      context.addIssue({
        code: "custom",
        message: "A Work Item version cannot be its own predecessor.",
        path: ["previousVersionId"],
      });
    }
  });

const claimedSoftwareIdentitySchema = z
  .object({
    assertedBy: z.enum(["client", "owner"]),
    name: shortLabelSchema,
    version: canonicalStringSchema(120).nullable(),
    verification: z.literal("claimed"),
  })
  .strict();

export const projectLeadIdentitySchema = z
  .object({
    claimedHarness: claimedSoftwareIdentitySchema.nullable(),
    claimedModel: claimedSoftwareIdentitySchema.nullable(),
    displayName: shortLabelSchema,
  })
  .strict();

export type ProjectLeadIdentity = z.infer<typeof projectLeadIdentitySchema>;

export const participantRefSchema = z
  .object({
    claimedHarness: claimedSoftwareIdentitySchema.nullable(),
    claimedModel: claimedSoftwareIdentitySchema.nullable(),
    observedAt: unixSecondsSchema,
    oauthClient: z
      .object({
        clientId: z.string().min(1).max(2_048),
        displayName: shortLabelSchema,
        origin: z.string().url().max(2_048),
        verification: z.literal("authorization-bound-client"),
      })
      .strict(),
    participantRefId: portableIdSchema,
    recordType: z.literal("participant-ref"),
    schemaVersion: z.literal(1),
  })
  .strict();

export const canonicalIntegritySchema = z
  .object({
    algorithm: z.literal("sha-256-jcs-rfc8785"),
    digest: sha256HexSchema,
    scope: z.literal("object-with-integrity-digest-omitted"),
  })
  .strict();

export const portableContentObjectSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(MAX_SUBMISSION_BYTES),
    contentSha256: sha256HexSchema,
    mediaType: z.enum(["text/markdown", "application/json"]),
    portableObjectId: portableIdSchema,
  })
  .strict();

export const collaborationRecordRefSchema = z
  .object({
    contentSha256: sha256HexSchema,
    recordId: portableIdSchema,
    recordType: collaborationRecordTypeSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

export const packetEvidenceObjectSchema = portableContentObjectSchema
  .omit({ portableObjectId: true })
  .extend({ evidenceObjectId: portableIdSchema })
  .strict();

export const packetSourceCitationSchema = z
  .object({
    citationId: portableIdSchema,
    evidenceObjectId: portableIdSchema,
    excerptByteRange: z
      .object({
        endExclusive: z.number().int().positive(),
        start: z.number().int().nonnegative(),
      })
      .strict(),
    generationId: portableIdSchema,
    path: safeMarkdownPathSchema,
    sourceByteLength: z.number().int().nonnegative().max(MAX_SUBMISSION_BYTES),
    sourceContentSha256: sha256HexSchema,
    stateLayer: z.literal("materialized-library"),
    vaultId: portableIdSchema,
  })
  .strict()
  .superRefine((citation, context) => {
    if (
      citation.excerptByteRange.endExclusive <=
        citation.excerptByteRange.start ||
      citation.excerptByteRange.endExclusive > citation.sourceByteLength
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The cited byte range must be non-empty and inside the source.",
        path: ["excerptByteRange"],
      });
    }
  });

const packetIncludedRecordSchema = collaborationRecordRefSchema
  .extend({
    includedAs: z.enum([
      "accepted-decision",
      "shared-handoff",
      "shared-review",
    ]),
    selectionReason: canonicalStringSchema(1_024),
    visibilityAtAssembly: z.enum(["shared", "accepted"]),
  })
  .strict()
  .superRefine((record, context) => {
    const expected = {
      "accepted-decision": {
        recordType: "decision",
        visibility: "accepted",
      },
      "shared-handoff": { recordType: "handoff", visibility: "shared" },
      "shared-review": { recordType: "review", visibility: "shared" },
    } as const;
    const selected = expected[record.includedAs];
    if (
      record.recordType !== selected.recordType ||
      record.visibilityAtAssembly !== selected.visibility
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Included record type and visibility must match its packet classification.",
        path: ["includedAs"],
      });
    }
  });

export const workPacketSchema = z
  .object({
    brief: workItemBriefSchema,
    createdAt: unixSecondsSchema,
    evidenceObjects: z
      .array(packetEvidenceObjectSchema)
      .max(MAX_PACKET_CITATIONS),
    excluded: z.array(canonicalStringSchema(1_024)).max(64),
    expiresAt: unixSecondsSchema,
    format: z.literal(OWD_WORK_PACKET_FORMAT),
    includedRecords: z
      .array(packetIncludedRecordSchema)
      .max(MAX_PACKET_INCLUDED_RECORDS),
    integrity: canonicalIntegritySchema,
    knowledgeSpaceVersionId: portableIdSchema,
    outputContract: z
      .object({
        acceptedMediaTypes: z
          .array(z.enum(["text/markdown", "application/json"]))
          .min(1)
          .max(2),
        acceptedRecordTypes: z
          .array(z.enum(["attempt", "artifact", "handoff", "review"]))
          .min(1)
          .max(4),
        maxSubmissionBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_SUBMISSION_BYTES),
        submissionFormat: z.literal(OWD_COLLABORATION_SUBMISSION_FORMAT),
      })
      .strict(),
    packetId: portableIdSchema,
    projectId: portableIdSchema,
    projectVersionId: portableIdSchema,
    recordType: z.literal("work-packet"),
    requestedRole: z
      .object({ authority: z.literal("none"), label: roleLabelSchema })
      .strict(),
    schemaVersion: z.literal(1),
    sourceCitations: z
      .array(packetSourceCitationSchema)
      .max(MAX_PACKET_CITATIONS),
    truncationNotices: z.array(canonicalStringSchema(1_024)).max(64),
    workItemId: portableIdSchema,
    workItemVersionId: portableIdSchema,
  })
  .strict()
  .superRefine((packet, context) => {
    if (packet.expiresAt <= packet.createdAt) {
      context.addIssue({
        code: "custom",
        message: "A Work Packet must expire after it is created.",
        path: ["expiresAt"],
      });
    }
    const evidence = new Map(
      packet.evidenceObjects.map((object) => [object.evidenceObjectId, object]),
    );
    if (evidence.size !== packet.evidenceObjects.length) {
      context.addIssue({
        code: "custom",
        message: "Packet evidence object identities must be unique.",
        path: ["evidenceObjects"],
      });
    }
    const citationIds = packet.sourceCitations.map(
      (citation) => citation.citationId,
    );
    if (new Set(citationIds).size !== citationIds.length) {
      context.addIssue({
        code: "custom",
        message: "Packet citation identities must be unique.",
        path: ["sourceCitations"],
      });
    }
    const usedEvidence = new Set<string>();
    for (const [index, citation] of packet.sourceCitations.entries()) {
      const object = evidence.get(citation.evidenceObjectId);
      usedEvidence.add(citation.evidenceObjectId);
      if (
        object === undefined ||
        object.byteLength !==
          citation.excerptByteRange.endExclusive -
            citation.excerptByteRange.start
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A citation must resolve to an exact retained evidence object.",
          path: ["sourceCitations", index, "evidenceObjectId"],
        });
      }
    }
    if (usedEvidence.size !== evidence.size) {
      context.addIssue({
        code: "custom",
        message: "Every packet evidence object must be cited.",
        path: ["evidenceObjects"],
      });
    }
    const evidenceBytes = packet.evidenceObjects.reduce(
      (total, object) => total + object.byteLength,
      0,
    );
    if (evidenceBytes > MAX_PACKET_EVIDENCE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "The retained packet evidence exceeds the contract budget.",
        path: ["evidenceObjects"],
      });
    }
    const recordIds = packet.includedRecords.map((record) => record.recordId);
    if (new Set(recordIds).size !== recordIds.length) {
      context.addIssue({
        code: "custom",
        message: "Included collaboration records must be unique.",
        path: ["includedRecords"],
      });
    }
    for (const field of [
      "acceptedMediaTypes",
      "acceptedRecordTypes",
    ] as const) {
      if (
        new Set(packet.outputContract[field]).size !==
        packet.outputContract[field].length
      ) {
        context.addIssue({
          code: "custom",
          message: "Work Packet output contract values must be unique.",
          path: ["outputContract", field],
        });
      }
    }
  });

export const attemptSchema = z
  .object({
    attemptId: portableIdSchema,
    claimedCompletedAt: unixSecondsSchema.nullable(),
    claimedStartedAt: unixSecondsSchema.nullable(),
    grantId: portableIdSchema.nullable(),
    participantRefId: portableIdSchema,
    projectId: portableIdSchema,
    recordType: z.literal("attempt"),
    requestedRole: z
      .object({ authority: z.literal("none"), label: roleLabelSchema })
      .strict(),
    schemaVersion: z.literal(1),
    supersedesRecordId: portableIdSchema.nullable(),
    workItemId: portableIdSchema,
    workPacketId: portableIdSchema,
  })
  .strict()
  .superRefine((attempt, context) => {
    if (
      attempt.claimedStartedAt !== null &&
      attempt.claimedCompletedAt !== null &&
      attempt.claimedCompletedAt < attempt.claimedStartedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Claimed completion cannot precede claimed start.",
        path: ["claimedCompletedAt"],
      });
    }
  });

function isPrivateOrReservedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const first = octets[0] ?? 256;
  const second = octets[1] ?? 256;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isSafeExternalHttpsUri(value: string): boolean {
  const authorityMatch = /^https:\/\/([^/?#]+)(?:[/?#]|$)/iu.exec(value);
  const authority = authorityMatch?.[1];
  if (authority === undefined || authority.includes("@")) return false;
  let hostname: string;
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0) return false;
    hostname = authority.slice(1, closingBracket);
    const remainder = authority.slice(closingBracket + 1);
    if (remainder !== "" && !/^:\d{1,5}$/u.test(remainder)) return false;
  } else {
    const [host, port, ...extra] = authority.split(":");
    if (
      host === undefined ||
      extra.length > 0 ||
      (port !== undefined && !/^\d{1,5}$/u.test(port))
    ) {
      return false;
    }
    hostname = host;
  }
  hostname = hostname.toLocaleLowerCase("en-US");
  if (
    hostname === "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (/^[0-9.]+$/u.test(hostname) && hostname.split(".").length !== 4) ||
    /^0x[0-9a-f]+$/u.test(hostname) ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:") ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/u.test(hostname) ||
    isPrivateOrReservedIpv4(hostname)
  ) {
    return false;
  }
  return true;
}

const httpsExternalReferenceSchema = z
  .object({
    expectedSha256: sha256HexSchema.nullable(),
    kind: z.literal("external-reference"),
    retrievalPolicy: z.literal("never-server-fetch"),
    uri: z.string().url().max(4_096).refine(isSafeExternalHttpsUri, {
      message:
        "External references must use public HTTPS without embedded credentials.",
    }),
    version: canonicalStringSchema(255).nullable(),
  })
  .strict();

const storedArtifactContentSchema = portableContentObjectSchema
  .extend({ kind: z.literal("stored-object") })
  .strict();

export const artifactSchema = z
  .object({
    artifactId: portableIdSchema,
    attemptId: portableIdSchema,
    content: z.discriminatedUnion("kind", [
      storedArtifactContentSchema,
      httpsExternalReferenceSchema,
    ]),
    label: shortLabelSchema,
    projectId: portableIdSchema,
    recordType: z.literal("artifact"),
    schemaVersion: z.literal(1),
    supersedesRecordId: portableIdSchema.nullable(),
    workItemId: portableIdSchema,
    workPacketId: portableIdSchema,
  })
  .strict();

export const handoffSchema = z
  .object({
    artifactIds: z.array(portableIdSchema).max(MAX_ATTEMPT_ARTIFACTS),
    attemptId: portableIdSchema,
    completed: z.array(boundedListItemSchema).max(32),
    evidenceCitationIds: z.array(portableIdSchema).max(MAX_PACKET_CITATIONS),
    handoffId: portableIdSchema,
    projectId: portableIdSchema,
    recordType: z.literal("handoff"),
    risks: z.array(boundedListItemSchema).max(32),
    schemaVersion: z.literal(1),
    suggestedNextActions: z.array(boundedListItemSchema).max(32),
    summary: proseSchema,
    supersedesRecordId: portableIdSchema.nullable(),
    unresolvedQuestions: z.array(boundedListItemSchema).max(32),
    workItemId: portableIdSchema,
    workPacketId: portableIdSchema,
  })
  .strict()
  .superRefine((handoff, context) => {
    for (const field of ["artifactIds", "evidenceCitationIds"] as const) {
      if (new Set(handoff[field]).size !== handoff[field].length) {
        context.addIssue({
          code: "custom",
          message: "Handoff references must be unique.",
          path: [field],
        });
      }
    }
  });

const reviewFindingSchema = z
  .object({
    artifactIds: z.array(portableIdSchema).max(MAX_ATTEMPT_ARTIFACTS),
    evidenceCitationIds: z.array(portableIdSchema).max(MAX_PACKET_CITATIONS),
    findingId: portableIdSchema,
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    summary: proseSchema,
  })
  .strict();

export const reviewSchema = z
  .object({
    artifactIds: z.array(portableIdSchema).min(1).max(MAX_ATTEMPT_ARTIFACTS),
    attemptId: portableIdSchema,
    findings: z.array(reviewFindingSchema).max(64),
    projectId: portableIdSchema,
    recordType: z.literal("review"),
    reviewId: portableIdSchema,
    schemaVersion: z.literal(1),
    supersedesRecordId: portableIdSchema.nullable(),
    verdict: z.enum([
      "pass",
      "pass-with-findings",
      "changes-requested",
      "inconclusive",
    ]),
    verdictAuthority: z.literal("producer-claim"),
    workItemId: portableIdSchema,
    workPacketId: portableIdSchema,
  })
  .strict()
  .superRefine((review, context) => {
    const artifactIds = new Set(review.artifactIds);
    if (artifactIds.size !== review.artifactIds.length) {
      context.addIssue({
        code: "custom",
        message: "Review Artifact references must be unique.",
        path: ["artifactIds"],
      });
    }
    const findingIds = review.findings.map((finding) => finding.findingId);
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "Review finding identities must be unique.",
        path: ["findings"],
      });
    }
    for (const [findingIndex, finding] of review.findings.entries()) {
      if (new Set(finding.artifactIds).size !== finding.artifactIds.length) {
        context.addIssue({
          code: "custom",
          message: "Finding Artifact references must be unique.",
          path: ["findings", findingIndex, "artifactIds"],
        });
      }
      if (
        new Set(finding.evidenceCitationIds).size !==
        finding.evidenceCitationIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Finding citation references must be unique.",
          path: ["findings", findingIndex, "evidenceCitationIds"],
        });
      }
      for (const [artifactIndex, artifactId] of finding.artifactIds.entries()) {
        if (!artifactIds.has(artifactId)) {
          context.addIssue({
            code: "custom",
            message:
              "A finding can only reference an Artifact declared by its Review.",
            path: ["findings", findingIndex, "artifactIds", artifactIndex],
          });
        }
      }
    }
  });

export const decisionSchema = z
  .object({
    createdAt: unixSecondsSchema,
    decisionId: portableIdSchema,
    inputRecords: z
      .array(
        collaborationRecordRefSchema
          .extend({ ownerDisposition: z.enum(["accepted", "rejected"]) })
          .strict(),
      )
      .max(64),
    ownerAuthored: z.literal(true),
    projectId: portableIdSchema,
    rationale: proseSchema,
    recordType: z.literal("decision"),
    resolution: z.enum(["accepted", "rejected", "mixed", "deferred"]),
    schemaVersion: z.literal(1),
    supersedesDecisionId: portableIdSchema.nullable(),
    workItemId: portableIdSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    const inputIds = decision.inputRecords.map((input) => input.recordId);
    if (new Set(inputIds).size !== inputIds.length) {
      context.addIssue({
        code: "custom",
        message: "A Decision may identify each input record only once.",
        path: ["inputRecords"],
      });
    }
    if (decision.supersedesDecisionId === decision.decisionId) {
      context.addIssue({
        code: "custom",
        message: "A Decision cannot supersede itself.",
        path: ["supersedesDecisionId"],
      });
    }
  });

const continuityStateListSchema = z
  .array(boundedListItemSchema)
  .max(MAX_CONTINUITY_STATE_ITEMS);

const continuityDecisionSchema = z
  .object({
    decision: decisionSchema,
    recordSha256: sha256HexSchema,
  })
  .strict();

const continuityArtifactSchema = z
  .object({
    artifact: artifactSchema,
    disposition: z.enum([
      "pending",
      "accepted",
      "rejected",
      "quarantined",
      "superseded",
    ]),
    recordSha256: sha256HexSchema,
    visibility: z.enum(["private", "shared", "owner-only"]),
  })
  .strict();

const continuityEvidenceSchema = z
  .object({
    citation: packetSourceCitationSchema,
    evidence: packetEvidenceObjectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.citation.evidenceObjectId !== value.evidence.evidenceObjectId ||
      value.evidence.byteLength !==
        value.citation.excerptByteRange.endExclusive -
          value.citation.excerptByteRange.start
    ) {
      context.addIssue({
        code: "custom",
        message: "Continuity evidence must match its exact packet citation.",
        path: ["evidence"],
      });
    }
  });

export const continuityPointSchema = z
  .object({
    acceptedDecisions: z
      .array(continuityDecisionSchema)
      .max(MAX_CONTINUITY_REFERENCES),
    artifacts: z.array(continuityArtifactSchema).max(MAX_CONTINUITY_REFERENCES),
    authority: z
      .object({
        liveAuthorityIncluded: z.literal(false),
        restoredAuthorityAllowed: z.literal(false),
      })
      .strict(),
    blockers: continuityStateListSchema,
    citedEvidence: z
      .array(continuityEvidenceSchema)
      .max(MAX_CONTINUITY_REFERENCES),
    completedWork: continuityStateListSchema,
    continuityPointId: portableIdSchema,
    context: z
      .object({
        createdAt: unixSecondsSchema,
        expiresAt: unixSecondsSchema,
        knowledgeSpaceVersionId: portableIdSchema,
        workPacketId: portableIdSchema,
        workPacketSha256: sha256HexSchema,
      })
      .strict(),
    format: z.literal(OWD_CONTINUITY_POINT_FORMAT),
    integrity: canonicalIntegritySchema,
    knownRejectedApproaches: continuityStateListSchema,
    nextAction: boundedListItemSchema,
    objective: z
      .object({
        project: proseSchema,
        workItem: workItemBriefSchema,
      })
      .strict(),
    openWork: continuityStateListSchema,
    previousContinuityPointId: portableIdSchema.nullable(),
    project: z
      .object({
        projectId: portableIdSchema,
        projectVersionId: portableIdSchema,
        projectVersionSha256: sha256HexSchema,
      })
      .strict(),
    provenance: z
      .object({
        acknowledgedAt: unixSecondsSchema,
        leadFencingToken: z.number().int().positive(),
        leadIdentity: projectLeadIdentitySchema,
        producerVerification: z.literal("authorization-bound-client"),
      })
      .strict(),
    recordType: z.literal("continuity-point"),
    risks: continuityStateListSchema,
    schemaVersion: z.literal(1),
    workItem: z
      .object({
        status: z.enum(["open", "closed", "quarantined"]),
        workItemId: portableIdSchema,
        workItemVersionId: portableIdSchema,
        workItemVersionSha256: sha256HexSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((point, context) => {
    if (point.previousContinuityPointId === point.continuityPointId) {
      context.addIssue({
        code: "custom",
        message: "A Continuity Point cannot be its own predecessor.",
        path: ["previousContinuityPointId"],
      });
    }
    if (point.context.expiresAt <= point.context.createdAt) {
      context.addIssue({
        code: "custom",
        message: "The checkpoint context must preserve a valid packet window.",
        path: ["context", "expiresAt"],
      });
    }
    const uniqueIds = (
      values: string[],
      path: "acceptedDecisions" | "artifacts" | "citedEvidence",
    ) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Continuity references must be unique.",
          path: [path],
        });
      }
    };
    uniqueIds(
      point.acceptedDecisions.map((value) => value.decision.decisionId),
      "acceptedDecisions",
    );
    uniqueIds(
      point.artifacts.map((value) => value.artifact.artifactId),
      "artifacts",
    );
    uniqueIds(
      point.citedEvidence.map((value) => value.citation.citationId),
      "citedEvidence",
    );
    for (const [index, value] of point.acceptedDecisions.entries()) {
      if (
        value.decision.projectId !== point.project.projectId ||
        value.decision.workItemId !== point.workItem.workItemId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A Continuity Point cannot include a cross-Project Decision.",
          path: ["acceptedDecisions", index],
        });
      }
    }
    for (const [index, value] of point.artifacts.entries()) {
      if (
        value.artifact.projectId !== point.project.projectId ||
        value.artifact.workItemId !== point.workItem.workItemId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A Continuity Point cannot include a cross-Project Artifact.",
          path: ["artifacts", index],
        });
      }
    }
  });

const continuityIdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const projectLeadClaimRequestSchema = z
  .object({
    idempotencyKey: continuityIdempotencyKeySchema,
    leadIdentity: projectLeadIdentitySchema,
    leaseExpiresInSeconds: z
      .number()
      .int()
      .min(MIN_PROJECT_LEAD_LEASE_SECONDS)
      .max(MAX_PROJECT_LEAD_LEASE_SECONDS),
    projectId: portableIdSchema,
  })
  .strict();

export const projectLeadRenewRequestSchema = z
  .object({
    fencingToken: z.number().int().positive(),
    leaseExpiresInSeconds: z
      .number()
      .int()
      .min(MIN_PROJECT_LEAD_LEASE_SECONDS)
      .max(MAX_PROJECT_LEAD_LEASE_SECONDS),
    leaseId: portableIdSchema,
    projectId: portableIdSchema,
  })
  .strict();

export const projectLeadLeaseSchema = z
  .object({
    claimedAt: unixSecondsSchema,
    expiresAt: unixSecondsSchema,
    fencingToken: z.number().int().positive(),
    leadIdentity: projectLeadIdentitySchema,
    leaseId: portableIdSchema,
    projectId: portableIdSchema,
    renewedAt: unixSecondsSchema,
    revokedAt: unixSecondsSchema.nullable(),
    status: z.enum(["active", "expired", "revoked"]),
  })
  .strict();

export const projectCheckpointRequestSchema = z
  .object({
    acceptedDecisionIds: z
      .array(portableIdSchema)
      .max(MAX_CONTINUITY_REFERENCES),
    artifactIds: z.array(portableIdSchema).max(MAX_CONTINUITY_REFERENCES),
    blockers: continuityStateListSchema,
    citationIds: z.array(portableIdSchema).max(MAX_CONTINUITY_REFERENCES),
    completedWork: continuityStateListSchema,
    fencingToken: z.number().int().positive(),
    idempotencyKey: continuityIdempotencyKeySchema,
    knownRejectedApproaches: continuityStateListSchema,
    leaseId: portableIdSchema,
    nextAction: boundedListItemSchema,
    openWork: continuityStateListSchema,
    packetId: portableIdSchema,
    previousContinuityPointId: portableIdSchema.nullable(),
    projectId: portableIdSchema,
    risks: continuityStateListSchema,
    workItemId: portableIdSchema,
  })
  .strict()
  .superRefine((request, context) => {
    for (const field of [
      "acceptedDecisionIds",
      "artifactIds",
      "citationIds",
    ] as const) {
      if (new Set(request[field]).size !== request[field].length) {
        context.addIssue({
          code: "custom",
          message: "Checkpoint references must be unique.",
          path: [field],
        });
      }
    }
  });

export const continuityCheckpointReceiptSchema = z
  .object({
    acknowledgedAt: unixSecondsSchema,
    contentSha256: sha256HexSchema,
    continuityPointId: portableIdSchema,
    idempotencyKeySha256: sha256HexSchema,
    previousContinuityPointId: portableIdSchema.nullable(),
    projectId: portableIdSchema,
  })
  .strict();

const ownerEventBase = z.object({
  createdAt: unixSecondsSchema,
  eventId: portableIdSchema,
  ownerAuthenticated: z.literal(true),
  projectId: portableIdSchema,
  recordType: z.literal("owner-event"),
  schemaVersion: z.literal(1),
});

const ownerRecordEventSchema = ownerEventBase
  .extend({
    eventType: z.enum([
      "record.shared",
      "record.accepted",
      "record.rejected",
      "record.quarantined",
    ]),
    reason: canonicalStringSchema(4_096),
    target: collaborationRecordRefSchema,
  })
  .strict();

const ownerSupersessionEventSchema = ownerEventBase
  .extend({
    eventType: z.literal("record.superseded"),
    reason: canonicalStringSchema(4_096),
    replacement: collaborationRecordRefSchema,
    target: collaborationRecordRefSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (event.target.recordType !== event.replacement.recordType) {
      context.addIssue({
        code: "custom",
        message: "A supersession replacement must have the same record type.",
        path: ["replacement", "recordType"],
      });
    }
    if (event.target.recordId === event.replacement.recordId) {
      context.addIssue({
        code: "custom",
        message: "A record cannot supersede itself.",
        path: ["replacement", "recordId"],
      });
    }
  });

const ownerWorkItemEventSchema = ownerEventBase
  .extend({
    eventType: z.enum(["work-item.closed", "work-item.reopened"]),
    reason: canonicalStringSchema(4_096),
    workItemId: portableIdSchema,
  })
  .strict();

const ownerProjectEventSchema = ownerEventBase
  .extend({
    eventType: z.enum(["project.archived", "project.reactivated"]),
    reason: canonicalStringSchema(4_096),
  })
  .strict();

const ownerProjectVersionEventSchema = ownerEventBase
  .extend({
    eventType: z.literal("project.version-activated"),
    projectVersionId: portableIdSchema,
    reason: canonicalStringSchema(4_096),
  })
  .strict();

export const ownerEventSchema = z.discriminatedUnion("eventType", [
  ownerRecordEventSchema,
  ownerSupersessionEventSchema,
  ownerWorkItemEventSchema,
  ownerProjectEventSchema,
  ownerProjectVersionEventSchema,
]);

const provenanceClassByRecordType: Record<
  CollaborationRecordType,
  "activity" | "agent" | "entity"
> = {
  "knowledge-space": "entity",
  "knowledge-space-version": "entity",
  project: "entity",
  "project-version": "entity",
  "work-item": "entity",
  "work-item-version": "entity",
  "participant-ref": "agent",
  "work-packet": "entity",
  attempt: "activity",
  artifact: "entity",
  handoff: "entity",
  review: "activity",
  decision: "entity",
  "owner-event": "entity",
  "provenance-edge": "entity",
};

export const provenanceNodeSchema = z
  .object({
    id: portableIdSchema,
    provClass: z.enum(["entity", "activity", "agent"]),
    recordType: collaborationRecordTypeSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (node.provClass !== provenanceClassByRecordType[node.recordType]) {
      context.addIssue({
        code: "custom",
        message:
          "The PROV class must match the collaboration record's semantic class.",
        path: ["provClass"],
      });
    }
  });

export const provenanceRelationSchema = z.enum([
  "used",
  "was-generated-by",
  "was-derived-from",
  "was-revision-of",
  "was-informed-by",
  "was-attributed-to",
  "was-associated-with",
]);

export const provenanceEdgeSchema = z
  .object({
    createdAt: unixSecondsSchema,
    edgeId: portableIdSchema,
    object: provenanceNodeSchema,
    projectId: portableIdSchema,
    recordType: z.literal("provenance-edge"),
    relation: provenanceRelationSchema,
    schemaVersion: z.literal(1),
    subject: provenanceNodeSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    const expected: Record<
      z.infer<typeof provenanceRelationSchema>,
      [
        z.infer<typeof provenanceNodeSchema>["provClass"],
        z.infer<typeof provenanceNodeSchema>["provClass"],
      ]
    > = {
      used: ["activity", "entity"],
      "was-generated-by": ["entity", "activity"],
      "was-derived-from": ["entity", "entity"],
      "was-revision-of": ["entity", "entity"],
      "was-informed-by": ["activity", "activity"],
      "was-attributed-to": ["entity", "agent"],
      "was-associated-with": ["activity", "agent"],
    };
    const [subjectClass, objectClass] = expected[edge.relation];
    if (
      edge.subject.provClass !== subjectClass ||
      edge.object.provClass !== objectClass
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The provenance edge direction does not match W3C PROV semantics.",
        path: ["relation"],
      });
    }
  });

export const agentSubmissionRecordSchema = z.discriminatedUnion("recordType", [
  attemptSchema,
  artifactSchema,
  handoffSchema,
  reviewSchema,
]);

const authorizedSubmissionContextSchema = z
  .object({
    grantId: portableIdSchema,
    mode: z.literal("authorized-client"),
    oauthClientId: z.string().min(1).max(2_048),
  })
  .strict();

const ownerImportSubmissionContextSchema = z
  .object({
    grantId: z.null(),
    mode: z.literal("owner-import"),
    oauthClientId: z.string().min(1).max(2_048).nullable(),
  })
  .strict();

export const collaborationSubmissionSchema = z
  .object({
    authorizationContext: z.discriminatedUnion("mode", [
      authorizedSubmissionContextSchema,
      ownerImportSubmissionContextSchema,
    ]),
    format: z.literal(OWD_COLLABORATION_SUBMISSION_FORMAT),
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/u),
    integrity: canonicalIntegritySchema,
    participantRef: participantRefSchema,
    projectId: portableIdSchema,
    record: agentSubmissionRecordSchema,
    schemaVersion: z.literal(1),
    submissionId: portableIdSchema,
    workItemId: portableIdSchema,
    workPacketId: portableIdSchema,
  })
  .strict()
  .superRefine((submission, context) => {
    if (
      submission.record.projectId !== submission.projectId ||
      submission.record.workItemId !== submission.workItemId ||
      submission.record.workPacketId !== submission.workPacketId
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The submitted record must match the envelope Project, Work Item, and Work Packet.",
        path: ["record"],
      });
    }
    if (
      submission.record.recordType === "attempt" &&
      submission.record.participantRefId !==
        submission.participantRef.participantRefId
    ) {
      context.addIssue({
        code: "custom",
        message: "The Attempt must reference the envelope participant.",
        path: ["record", "participantRefId"],
      });
    }
    if (
      submission.authorizationContext.mode === "authorized-client" &&
      (submission.authorizationContext.oauthClientId !==
        submission.participantRef.oauthClient.clientId ||
        (submission.record.recordType === "attempt" &&
          submission.record.grantId !==
            submission.authorizationContext.grantId))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The claimed producer must match the authorization-bound client and grant.",
        path: ["authorizationContext"],
      });
    }
    if (
      submission.authorizationContext.mode === "owner-import" &&
      submission.record.recordType === "attempt" &&
      submission.record.grantId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A portable owner import cannot claim live grant authority.",
        path: ["record", "grantId"],
      });
    }
  });

export const collaborationSubmissionReceiptSchema = z
  .object({
    idempotencyKeySha256: sha256HexSchema,
    receivedAt: unixSecondsSchema,
    recordId: portableIdSchema,
    recordType: z.enum(["attempt", "artifact", "handoff", "review"]),
    submissionId: portableIdSchema,
    submissionSha256: sha256HexSchema,
  })
  .strict();

export type CollaborationSubmissionReceipt = z.infer<
  typeof collaborationSubmissionReceiptSchema
>;

export function collaborationRecordId(
  record: { recordType: CollaborationRecordType } & Record<string, unknown>,
): string {
  const fieldByType: Record<CollaborationRecordType, string> = {
    "knowledge-space": "knowledgeSpaceId",
    "knowledge-space-version": "knowledgeSpaceVersionId",
    project: "projectId",
    "project-version": "projectVersionId",
    "work-item": "workItemId",
    "work-item-version": "workItemVersionId",
    "participant-ref": "participantRefId",
    "work-packet": "packetId",
    attempt: "attemptId",
    artifact: "artifactId",
    handoff: "handoffId",
    review: "reviewId",
    decision: "decisionId",
    "owner-event": "eventId",
    "provenance-edge": "edgeId",
  };
  const value = record[fieldByType[record.recordType]];
  return typeof value === "string" ? value : "";
}

export const collaborationDurableRecordSchema = z.discriminatedUnion(
  "recordType",
  [
    knowledgeSpaceSchema,
    knowledgeSpaceVersionSchema,
    projectSchema,
    projectVersionSchema,
    workItemSchema,
    workItemVersionSchema,
    participantRefSchema,
    workPacketSchema,
    attemptSchema,
    artifactSchema,
    handoffSchema,
    reviewSchema,
    decisionSchema,
  ],
);

export const collaborationLedgerSchema = z
  .object({
    format: z.literal(OWD_COLLABORATION_LEDGER_FORMAT),
    ownerEvents: z.array(ownerEventSchema).max(MAX_INTELLIGENCE_RECORDS),
    provenanceEdges: z
      .array(provenanceEdgeSchema)
      .max(MAX_INTELLIGENCE_RECORDS),
    records: z
      .array(collaborationDurableRecordSchema)
      .max(MAX_INTELLIGENCE_RECORDS),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((ledger, context) => {
    const durableIds = new Set<string>();
    const records = new Map<
      string,
      {
        projectId?: string;
        recordType: CollaborationRecordType;
        value: unknown;
      }
    >();
    const registerDurableId = (id: string, path: (string | number)[]) => {
      if (durableIds.has(id)) {
        context.addIssue({
          code: "custom",
          message:
            "Portable record, event, and edge identities must be globally unique.",
          path,
        });
      }
      durableIds.add(id);
    };
    for (const [index, value] of ledger.records.entries()) {
      const id = collaborationRecordId(value as never);
      registerDurableId(id, ["records", index]);
      const projectIdValue =
        "projectId" in value && typeof value.projectId === "string"
          ? value.projectId
          : undefined;
      records.set(id, {
        projectId: projectIdValue,
        recordType: value.recordType,
        value,
      });
    }
    for (const [index, event] of ledger.ownerEvents.entries()) {
      registerDurableId(event.eventId, ["ownerEvents", index, "eventId"]);
    }
    for (const [index, edge] of ledger.provenanceEdges.entries()) {
      registerDurableId(edge.edgeId, ["provenanceEdges", index, "edgeId"]);
    }
    const versionOrdinals = new Set<string>();
    for (const [index, value] of ledger.records.entries()) {
      let ordinal: string | undefined;
      switch (value.recordType) {
        case "knowledge-space-version":
          ordinal = `${value.recordType}:${value.knowledgeSpaceId}:${value.version}`;
          break;
        case "project-version":
          ordinal = `${value.recordType}:${value.projectId}:${value.version}`;
          break;
        case "work-item-version":
          ordinal = `${value.recordType}:${value.workItemId}:${value.version}`;
          break;
        default:
          break;
      }
      if (ordinal !== undefined) {
        if (versionOrdinals.has(ordinal)) {
          context.addIssue({
            code: "custom",
            message:
              "A stable record may have only one immutable version at each ordinal.",
            path: ["records", index, "version"],
          });
        }
        versionOrdinals.add(ordinal);
      }
    }

    const requireRecord = (
      id: string,
      type: CollaborationRecordType,
      path: (string | number)[],
    ):
      | {
          projectId?: string;
          recordType: CollaborationRecordType;
          value: unknown;
        }
      | undefined => {
      const found = records.get(id);
      if (found === undefined || found.recordType !== type) {
        context.addIssue({
          code: "custom",
          message: `Missing ${type} dependency.`,
          path,
        });
        return undefined;
      }
      return found;
    };

    for (const [index, value] of ledger.records.entries()) {
      switch (value.recordType) {
        case "knowledge-space-version": {
          requireRecord(value.knowledgeSpaceId, "knowledge-space", [
            "records",
            index,
            "knowledgeSpaceId",
          ]);
          if (value.previousVersionId !== null) {
            const previous = requireRecord(
              value.previousVersionId,
              "knowledge-space-version",
              ["records", index, "previousVersionId"],
            );
            if (previous !== undefined) {
              const previousValue = previous.value as z.infer<
                typeof knowledgeSpaceVersionSchema
              >;
              if (
                previousValue.knowledgeSpaceId !== value.knowledgeSpaceId ||
                previousValue.version + 1 !== value.version
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "A Knowledge Space predecessor must be the immediately prior version of the same Knowledge Space.",
                  path: ["records", index, "previousVersionId"],
                });
              }
            }
          }
          break;
        }
        case "project-version": {
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          requireRecord(
            value.knowledgeSpaceVersionId,
            "knowledge-space-version",
            ["records", index, "knowledgeSpaceVersionId"],
          );
          if (value.previousVersionId !== null) {
            const previous = requireRecord(
              value.previousVersionId,
              "project-version",
              ["records", index, "previousVersionId"],
            );
            if (previous !== undefined) {
              const previousValue = previous.value as z.infer<
                typeof projectVersionSchema
              >;
              if (
                previousValue.projectId !== value.projectId ||
                previousValue.version + 1 !== value.version
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "A Project predecessor must be the immediately prior version of the same Project.",
                  path: ["records", index, "previousVersionId"],
                });
              }
            }
          }
          break;
        }
        case "work-item":
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          break;
        case "work-item-version": {
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          if (
            requireRecord(value.workItemId, "work-item", [
              "records",
              index,
              "workItemId",
            ])?.projectId !== value.projectId
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A Work Item version must belong to the same Project as its Work Item.",
              path: ["records", index, "workItemId"],
            });
          }
          if (value.previousVersionId !== null) {
            const previous = requireRecord(
              value.previousVersionId,
              "work-item-version",
              ["records", index, "previousVersionId"],
            );
            if (previous !== undefined) {
              const previousValue = previous.value as z.infer<
                typeof workItemVersionSchema
              >;
              if (
                previousValue.projectId !== value.projectId ||
                previousValue.workItemId !== value.workItemId ||
                previousValue.version + 1 !== value.version
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "A Work Item predecessor must be the immediately prior version of the same Work Item.",
                  path: ["records", index, "previousVersionId"],
                });
              }
            }
          }
          break;
        }
        case "work-packet": {
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          const projectVersion = requireRecord(
            value.projectVersionId,
            "project-version",
            ["records", index, "projectVersionId"],
          );
          const workItem = requireRecord(value.workItemId, "work-item", [
            "records",
            index,
            "workItemId",
          ]);
          const workItemVersion = requireRecord(
            value.workItemVersionId,
            "work-item-version",
            ["records", index, "workItemVersionId"],
          );
          for (const [field, dependency] of [
            ["projectVersionId", projectVersion],
            ["workItemId", workItem],
            ["workItemVersionId", workItemVersion],
          ] as const) {
            if (dependency?.projectId !== value.projectId) {
              context.addIssue({
                code: "custom",
                message:
                  "Every Work Packet dependency must belong to its Project.",
                path: ["records", index, field],
              });
            }
          }
          requireRecord(
            value.knowledgeSpaceVersionId,
            "knowledge-space-version",
            ["records", index, "knowledgeSpaceVersionId"],
          );
          if (projectVersion !== undefined) {
            const projectVersionValue = projectVersion.value as z.infer<
              typeof projectVersionSchema
            >;
            if (
              projectVersionValue.knowledgeSpaceVersionId !==
              value.knowledgeSpaceVersionId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A Work Packet must use its Project version's exact Knowledge Space version.",
                path: ["records", index, "knowledgeSpaceVersionId"],
              });
            }
            const evidenceBytes = value.evidenceObjects.reduce(
              (total, evidence) => total + evidence.byteLength,
              0,
            );
            if (
              value.sourceCitations.length >
                projectVersionValue.packetPolicy.maxCitationCount ||
              evidenceBytes >
                projectVersionValue.packetPolicy.maxEvidenceBytes ||
              value.includedRecords.length >
                projectVersionValue.packetPolicy.maxSharedRecordCount
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A Work Packet must remain inside its Project version's packet policy.",
                path: ["records", index],
              });
            }
          }
          if (workItemVersion !== undefined) {
            const workItemVersionValue = workItemVersion.value as z.infer<
              typeof workItemVersionSchema
            >;
            if (workItemVersionValue.workItemId !== value.workItemId) {
              context.addIssue({
                code: "custom",
                message:
                  "A Work Packet must reference a version of its exact Work Item.",
                path: ["records", index, "workItemVersionId"],
              });
            }
          }
          for (const [
            includedIndex,
            included,
          ] of value.includedRecords.entries()) {
            const found = requireRecord(
              included.recordId,
              included.recordType,
              ["records", index, "includedRecords", includedIndex],
            );
            if (
              found?.projectId !== undefined &&
              found.projectId !== value.projectId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A Work Packet cannot include a record from another Project.",
                path: ["records", index, "includedRecords", includedIndex],
              });
            }
          }
          break;
        }
        case "attempt": {
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          const workItem = requireRecord(value.workItemId, "work-item", [
            "records",
            index,
            "workItemId",
          ]);
          const packet = requireRecord(value.workPacketId, "work-packet", [
            "records",
            index,
            "workPacketId",
          ]);
          if (workItem?.projectId !== value.projectId) {
            context.addIssue({
              code: "custom",
              message:
                "An Attempt and its Work Item must belong to the same Project.",
              path: ["records", index, "workItemId"],
            });
          }
          if (packet?.projectId !== value.projectId) {
            context.addIssue({
              code: "custom",
              message:
                "An Attempt and its Work Packet must belong to the same Project.",
              path: ["records", index, "workPacketId"],
            });
          } else {
            const packetValue = packet.value as z.infer<
              typeof workPacketSchema
            >;
            if (
              packetValue.workItemId !== value.workItemId ||
              packetValue.requestedRole.label !== value.requestedRole.label
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "An Attempt must use its Work Packet's exact Work Item and requested role.",
                path: ["records", index, "workPacketId"],
              });
            }
          }
          requireRecord(value.participantRefId, "participant-ref", [
            "records",
            index,
            "participantRefId",
          ]);
          break;
        }
        case "artifact":
        case "handoff":
        case "review": {
          const attempt = requireRecord(value.attemptId, "attempt", [
            "records",
            index,
            "attemptId",
          ]);
          const packet = requireRecord(value.workPacketId, "work-packet", [
            "records",
            index,
            "workPacketId",
          ]);
          if (attempt?.projectId !== value.projectId) {
            context.addIssue({
              code: "custom",
              message:
                "An output record and its Attempt must belong to the same Project.",
              path: ["records", index, "attemptId"],
            });
          }
          if (packet?.projectId !== value.projectId) {
            context.addIssue({
              code: "custom",
              message:
                "An output record and its Work Packet must belong to the same Project.",
              path: ["records", index, "workPacketId"],
            });
          }
          if (attempt !== undefined) {
            const attemptValue = attempt.value as z.infer<typeof attemptSchema>;
            if (
              attemptValue.workItemId !== value.workItemId ||
              attemptValue.workPacketId !== value.workPacketId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "An output record must use its parent Attempt's exact Work Item and Work Packet.",
                path: ["records", index, "attemptId"],
              });
            }
          }
          let packetCitationIds = new Set<string>();
          if (packet !== undefined) {
            const packetValue = packet.value as z.infer<
              typeof workPacketSchema
            >;
            if (packetValue.workItemId !== value.workItemId) {
              context.addIssue({
                code: "custom",
                message:
                  "An output record must use its Work Packet's exact Work Item.",
                path: ["records", index, "workItemId"],
              });
            }
            packetCitationIds = new Set(
              packetValue.sourceCitations.map(
                (citation) => citation.citationId,
              ),
            );
          }
          const artifactIds =
            value.recordType === "artifact" ? [] : value.artifactIds;
          for (const [artifactIndex, artifactId] of artifactIds.entries()) {
            const artifact = requireRecord(artifactId, "artifact", [
              "records",
              index,
              "artifactIds",
              artifactIndex,
            ]);
            if (artifact?.projectId !== value.projectId) {
              context.addIssue({
                code: "custom",
                message:
                  "Referenced Artifacts must belong to the same Project.",
                path: ["records", index, "artifactIds", artifactIndex],
              });
            }
            if (
              artifact !== undefined &&
              (artifact.value as z.infer<typeof artifactSchema>).workItemId !==
                value.workItemId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Referenced Artifacts must belong to the same Work Item.",
                path: ["records", index, "artifactIds", artifactIndex],
              });
            }
            if (
              value.recordType === "handoff" &&
              artifact !== undefined &&
              (artifact.value as z.infer<typeof artifactSchema>).attemptId !==
                value.attemptId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A Handoff can only deliver Artifacts produced by its Attempt.",
                path: ["records", index, "artifactIds", artifactIndex],
              });
            }
          }
          const evidenceCitationIds =
            value.recordType === "handoff"
              ? value.evidenceCitationIds
              : value.recordType === "review"
                ? value.findings.flatMap(
                    (finding) => finding.evidenceCitationIds,
                  )
                : [];
          for (const [
            citationIndex,
            citationId,
          ] of evidenceCitationIds.entries()) {
            if (!packetCitationIds.has(citationId)) {
              context.addIssue({
                code: "custom",
                message:
                  "Output evidence citations must resolve inside the exact Work Packet.",
                path: ["records", index, "evidenceCitationIds", citationIndex],
              });
            }
          }
          break;
        }
        case "decision": {
          requireRecord(value.projectId, "project", [
            "records",
            index,
            "projectId",
          ]);
          if (
            requireRecord(value.workItemId, "work-item", [
              "records",
              index,
              "workItemId",
            ])?.projectId !== value.projectId
          ) {
            context.addIssue({
              code: "custom",
              message: "A Decision's Work Item must belong to its Project.",
              path: ["records", index, "workItemId"],
            });
          }
          for (const [inputIndex, input] of value.inputRecords.entries()) {
            const found = requireRecord(input.recordId, input.recordType, [
              "records",
              index,
              "inputRecords",
              inputIndex,
            ]);
            if (
              found?.projectId !== undefined &&
              found.projectId !== value.projectId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A Decision cannot consume a record from another Project.",
                path: ["records", index, "inputRecords", inputIndex],
              });
            }
          }
          break;
        }
        case "knowledge-space":
        case "project":
        case "participant-ref":
          break;
      }
    }

    for (const [index, event] of ledger.ownerEvents.entries()) {
      requireRecord(event.projectId, "project", [
        "ownerEvents",
        index,
        "projectId",
      ]);
      if (event.eventType.startsWith("record.")) {
        const target = "target" in event ? event.target : undefined;
        if (target !== undefined) {
          const found = requireRecord(target.recordId, target.recordType, [
            "ownerEvents",
            index,
            "target",
          ]);
          if (
            found?.projectId !== undefined &&
            found.projectId !== event.projectId
          ) {
            context.addIssue({
              code: "custom",
              message: "An OwnerEvent cannot target another Project's record.",
              path: ["ownerEvents", index, "target"],
            });
          }
        }
        if (event.eventType === "record.superseded") {
          const replacement = requireRecord(
            event.replacement.recordId,
            event.replacement.recordType,
            ["ownerEvents", index, "replacement"],
          );
          if (
            replacement?.projectId !== undefined &&
            replacement.projectId !== event.projectId
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A supersession replacement must belong to the OwnerEvent's Project.",
              path: ["ownerEvents", index, "replacement"],
            });
          }
        }
      } else if (
        event.eventType === "work-item.closed" ||
        event.eventType === "work-item.reopened"
      ) {
        if (
          requireRecord(event.workItemId, "work-item", [
            "ownerEvents",
            index,
            "workItemId",
          ])?.projectId !== event.projectId
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A Work Item lifecycle event must belong to the OwnerEvent's Project.",
            path: ["ownerEvents", index, "workItemId"],
          });
        }
      } else if (event.eventType === "project.version-activated") {
        if (
          requireRecord(event.projectVersionId, "project-version", [
            "ownerEvents",
            index,
            "projectVersionId",
          ])?.projectId !== event.projectId
        ) {
          context.addIssue({
            code: "custom",
            message:
              "An activated Project version must belong to the OwnerEvent's Project.",
            path: ["ownerEvents", index, "projectVersionId"],
          });
        }
      }
    }

    for (const [index, edge] of ledger.provenanceEdges.entries()) {
      requireRecord(edge.projectId, "project", [
        "provenanceEdges",
        index,
        "projectId",
      ]);
      for (const [side, node] of [
        ["subject", edge.subject],
        ["object", edge.object],
      ] as const) {
        const found = records.get(node.id);
        if (found === undefined || found.recordType !== node.recordType) {
          context.addIssue({
            code: "custom",
            message:
              "Every provenance node must resolve to the declared collaboration record.",
            path: ["provenanceEdges", index, side],
          });
        } else if (
          found.projectId !== undefined &&
          found.projectId !== edge.projectId
        ) {
          context.addIssue({
            code: "custom",
            message: "A provenance edge cannot cross Project boundaries.",
            path: ["provenanceEdges", index, side],
          });
        }
      }
    }
  });

export const collaborationRecordStateSchema = z
  .object({
    disposition: z.enum([
      "pending",
      "checkpointed",
      "accepted",
      "rejected",
      "quarantined",
      "superseded",
    ]),
    visibility: z.enum(["private", "shared", "owner-only"]),
  })
  .strict();

const snapshotRestoreDispositionSchema = z.enum([
  "restore-approved",
  "restore-evidence-only",
  "restore-quarantined",
]);

export const snapshotIntelligenceRecordSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(MAX_SUBMISSION_BYTES),
    classification: z.enum(["approved", "unvetted"]),
    contentSha256: sha256HexSchema,
    dependencies: z.array(portableIdSchema).max(256),
    evidenceOnly: z.boolean(),
    originalState: collaborationRecordStateSchema,
    portableObjectId: portableIdSchema,
    projectId: portableIdSchema.nullable(),
    recordId: portableIdSchema,
    recordType: z.union([
      collaborationRecordTypeSchema,
      z.literal("continuity-point"),
      z.literal("policy"),
      z.literal("run"),
      z.literal("actor"),
      z.literal("event-bundle"),
      z.literal("exception"),
      z.literal("elastic-plane"),
      z.literal("elastic-account"),
      z.literal("actor-recovery"),
      z.literal("run-delta"),
      z.literal("run-budget"),
      z.literal("budget-entry"),
      z.literal("run-observation"),
      z.literal("orca-projection"),
      z.literal("policy-binding"),
      z.literal("policy-decision"),
      z.literal("schedule"),
      z.literal("evidence"),
      z.literal("continuity-receipt"),
    ]),
    restoreDisposition: snapshotRestoreDispositionSchema,
    schemaVersion: z.literal(1),
    workItemId: portableIdSchema.nullable(),
  })
  .strict();

export const snapshotIntelligenceEvidenceSchema = z
  .object({
    byteLength: z.number().int().nonnegative().max(MAX_SUBMISSION_BYTES),
    classification: z.enum(["approved", "unvetted"]),
    contentSha256: sha256HexSchema,
    evidenceObjectId: portableIdSchema,
    portableObjectId: portableIdSchema,
    restoreDisposition: z.enum([
      "restore-evidence-only",
      "restore-quarantined",
    ]),
  })
  .strict();

export const snapshotWorkingProfileRecordSchema = z
  .object({
    byteLength: z
      .number()
      .int()
      .positive()
      .max(512 * 1_024),
    contentSha256: sha256HexSchema,
    createdAt: unixSecondsSchema,
    dependencies: z.array(portableIdSchema).max(256),
    portableObjectId: portableIdSchema,
    preferenceId: portableIdSchema.nullable(),
    projectId: portableIdSchema.nullable(),
    recordId: portableIdSchema,
    recordType: workingProfileRecordTypeSchema,
    restoreDisposition: z.literal("restore-quarantined"),
    skillId: portableIdSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const preference = record.recordType.startsWith("preference-");
    const attachment = ["skill-attached", "skill-detached"].includes(
      record.recordType,
    );
    const identityValid = preference
      ? record.preferenceId !== null && record.skillId === null
      : record.preferenceId === null && record.skillId !== null;
    const projectValid = preference
      ? true
      : attachment
        ? record.projectId !== null
        : record.projectId === null;
    if (!identityValid || !projectValid) {
      context.addIssue({
        code: "custom",
        message: "Working-profile identities do not match the record kind.",
        path: ["recordType"],
      });
    }
    if (new Set(record.dependencies).size !== record.dependencies.length) {
      context.addIssue({
        code: "custom",
        message: "Working-profile dependencies must be unique.",
        path: ["dependencies"],
      });
    }
  });

export const snapshotWorkingProfileSectionSchema = z
  .object({
    logicalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    newlyStoredBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    recordCount: z.number().int().nonnegative(),
    records: z
      .array(snapshotWorkingProfileRecordSchema)
      .max(MAX_INTELLIGENCE_RECORDS),
  })
  .strict()
  .superRefine((section, context) => {
    if (section.recordCount !== section.records.length) {
      context.addIssue({
        code: "custom",
        message: "The working-profile count does not match its inventory.",
        path: ["recordCount"],
      });
    }
    const logicalBytes = section.records.reduce(
      (total, record) => total + record.byteLength,
      0,
    );
    if (
      logicalBytes !== section.logicalBytes ||
      section.newlyStoredBytes > logicalBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Working-profile byte totals do not match the inventory.",
        path: ["logicalBytes"],
      });
    }
    const ids = new Set(section.records.map((record) => record.recordId));
    if (ids.size !== section.records.length) {
      context.addIssue({
        code: "custom",
        message: "Working-profile record identities must be unique.",
        path: ["records"],
      });
    }
    for (const [recordIndex, record] of section.records.entries()) {
      for (const [
        dependencyIndex,
        dependency,
      ] of record.dependencies.entries()) {
        if (!ids.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: "Every working-profile dependency must be included.",
            path: ["records", recordIndex, "dependencies", dependencyIndex],
          });
        }
      }
    }
  });

export const snapshotCompoundingRecordSchema = z
  .object({
    byteLength: z
      .number()
      .int()
      .positive()
      .max(512 * 1_024),
    contentSha256: sha256HexSchema,
    createdAt: unixSecondsSchema,
    dependencies: z.array(portableIdSchema).max(16),
    draftId: portableIdSchema.nullable(),
    fingerprint: sha256HexSchema,
    observationId: portableIdSchema.nullable(),
    portableObjectId: portableIdSchema,
    projectId: portableIdSchema.nullable(),
    recordId: portableIdSchema,
    recordType: z.enum([
      "checkpoint-observation",
      "draft-version",
      "draft-accepted",
      "draft-ignored",
      "draft-deleted",
    ]),
    restoreDisposition: z.literal("restore-quarantined"),
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((record, context) => {
    const observation = record.recordType === "checkpoint-observation";
    if (
      (observation &&
        (record.observationId === null || record.draftId !== null)) ||
      (!observation &&
        (record.draftId === null || record.observationId !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Compounding identity does not match its record kind.",
        path: ["recordType"],
      });
    }
    if (new Set(record.dependencies).size !== record.dependencies.length) {
      context.addIssue({
        code: "custom",
        message: "Compounding dependencies must be unique.",
        path: ["dependencies"],
      });
    }
  });

export const snapshotCompoundingSectionSchema = z
  .object({
    logicalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    newlyStoredBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    recordCount: z.number().int().nonnegative(),
    records: z
      .array(snapshotCompoundingRecordSchema)
      .max(MAX_INTELLIGENCE_RECORDS),
  })
  .strict()
  .superRefine((section, context) => {
    if (section.recordCount !== section.records.length) {
      context.addIssue({
        code: "custom",
        message: "The compounding count does not match its inventory.",
        path: ["recordCount"],
      });
    }
    const logicalBytes = section.records.reduce(
      (total, record) => total + record.byteLength,
      0,
    );
    if (
      logicalBytes !== section.logicalBytes ||
      section.newlyStoredBytes > logicalBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "Compounding byte totals do not match the inventory.",
        path: ["logicalBytes"],
      });
    }
    if (
      new Set(section.records.map((record) => record.recordId)).size !==
      section.records.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Compounding record identities must be unique.",
        path: ["records"],
      });
    }
  });

export const snapshotIntelligenceSectionSchema = z
  .object({
    classification: z.enum(["approved", "unvetted"]),
    evidenceObjectCount: z.number().int().nonnegative(),
    evidenceObjects: z
      .array(snapshotIntelligenceEvidenceSchema)
      .max(MAX_INTELLIGENCE_EVIDENCE_OBJECTS),
    logicalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    newlyStoredBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INTELLIGENCE_LOGICAL_BYTES),
    recordCount: z.number().int().nonnegative(),
    records: z
      .array(snapshotIntelligenceRecordSchema)
      .max(MAX_INTELLIGENCE_RECORDS),
  })
  .strict()
  .superRefine((section, context) => {
    if (section.recordCount !== section.records.length) {
      context.addIssue({
        code: "custom",
        message: "The intelligence record count does not match its inventory.",
        path: ["recordCount"],
      });
    }
    if (section.evidenceObjectCount !== section.evidenceObjects.length) {
      context.addIssue({
        code: "custom",
        message:
          "The intelligence evidence count does not match its inventory.",
        path: ["evidenceObjectCount"],
      });
    }
    const bytes = [...section.records, ...section.evidenceObjects].reduce(
      (total, value) => total + value.byteLength,
      0,
    );
    if (bytes !== section.logicalBytes) {
      context.addIssue({
        code: "custom",
        message:
          "The intelligence logical byte count does not match its inventory.",
        path: ["logicalBytes"],
      });
    }
    if (section.newlyStoredBytes > section.logicalBytes) {
      context.addIssue({
        code: "custom",
        message: "Newly stored intelligence bytes cannot exceed logical bytes.",
        path: ["newlyStoredBytes"],
      });
    }
    for (const [index, record] of section.records.entries()) {
      const expectedDisposition =
        section.classification === "unvetted"
          ? "restore-quarantined"
          : [
                "policy-binding",
                "policy-decision",
                "schedule",
                "evidence",
                "continuity-receipt",
              ].includes(record.recordType)
            ? "restore-quarantined"
            : record.recordType === "continuity-point"
              ? "restore-approved"
              : record.evidenceOnly
                ? "restore-evidence-only"
                : "restore-approved";
      if (
        record.classification !== section.classification ||
        record.restoreDisposition !== expectedDisposition
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Record classification and restore disposition disagree with the section.",
          path: ["records", index],
        });
      }
      if (
        section.classification === "approved" &&
        !record.evidenceOnly &&
        record.originalState.disposition !== "accepted" &&
        !(
          record.recordType === "continuity-point" &&
          record.originalState.disposition === "checkpointed"
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "An Approved root must have an accepted original disposition.",
          path: ["records", index, "originalState", "disposition"],
        });
      }
      if (
        section.classification === "unvetted" &&
        (record.evidenceOnly ||
          record.originalState.disposition === "accepted" ||
          record.recordType === "continuity-point")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Accepted roots and evidence-only closure records belong in Approved Intelligence.",
          path: ["records", index],
        });
      }
      if (new Set(record.dependencies).size !== record.dependencies.length) {
        context.addIssue({
          code: "custom",
          message: "Snapshot dependencies must be unique.",
          path: ["records", index, "dependencies"],
        });
      }
    }
    for (const [index, evidence] of section.evidenceObjects.entries()) {
      const expectedDisposition =
        section.classification === "approved"
          ? "restore-evidence-only"
          : "restore-quarantined";
      if (
        evidence.classification !== section.classification ||
        evidence.restoreDisposition !== expectedDisposition
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Evidence classification and restore disposition disagree with the section.",
          path: ["evidenceObjects", index],
        });
      }
    }
  });

export const snapshotIntelligenceManifestSchema = z
  .object({
    approved: snapshotIntelligenceSectionSchema.nullable(),
    compounding: snapshotCompoundingSectionSchema.optional(),
    excludedAuthority: z.tuple([
      z.literal("oauth-access-tokens"),
      z.literal("oauth-refresh-tokens"),
      z.literal("oauth-authorization-codes"),
      z.literal("oauth-protocol-storage"),
      z.literal("sessions"),
      z.literal("passkeys"),
      z.literal("pairing-secrets"),
      z.literal("vault-credentials"),
      z.literal("live-agent-grants"),
      z.literal("recovery-private-keys"),
      z.literal("harness-context"),
      z.literal("provider-credentials"),
      z.literal("runtime-caches"),
    ]),
    format: z.literal(OWD_SNAPSHOT_INTELLIGENCE_FORMAT),
    requiredCapabilities: z
      .array(snapshotIntelligenceRequiredCapabilitySchema)
      .max(4),
    schemaVersion: z.literal(1),
    selection: z.enum(["none", "approved", "approved-and-unvetted"]),
    unvetted: snapshotIntelligenceSectionSchema.nullable(),
    workingProfile: snapshotWorkingProfileSectionSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const required = manifest.requiredCapabilities.filter(
      (capability) =>
        capability !== WORKING_PROFILE_SNAPSHOT_CAPABILITY &&
        capability !== COMPOUNDING_SNAPSHOT_CAPABILITY,
    );
    const selectionShapeIsValid =
      (manifest.selection === "none" &&
        manifest.approved === null &&
        manifest.unvetted === null &&
        required.length === 0) ||
      (manifest.selection === "approved" &&
        manifest.approved?.classification === "approved" &&
        manifest.unvetted === null &&
        required.length === 1 &&
        required[0] === APPROVED_INTELLIGENCE_CAPABILITY) ||
      (manifest.selection === "approved-and-unvetted" &&
        manifest.approved?.classification === "approved" &&
        manifest.unvetted?.classification === "unvetted" &&
        required.length === 2 &&
        required[0] === APPROVED_INTELLIGENCE_CAPABILITY &&
        required[1] === QUARANTINED_INTELLIGENCE_CAPABILITY);
    if (!selectionShapeIsValid) {
      context.addIssue({
        code: "custom",
        message:
          "Intelligence selection, sections, and required capabilities disagree.",
        path: ["selection"],
      });
    }
    const hasProfileCapability = manifest.requiredCapabilities.includes(
      WORKING_PROFILE_SNAPSHOT_CAPABILITY,
    );
    if (hasProfileCapability !== (manifest.workingProfile !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "The working-profile section and required capability must appear together.",
        path: ["workingProfile"],
      });
    }
    const hasCompoundingCapability = manifest.requiredCapabilities.includes(
      COMPOUNDING_SNAPSHOT_CAPABILITY,
    );
    if (hasCompoundingCapability !== (manifest.compounding !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "The compounding section and required capability must appear together.",
        path: ["compounding"],
      });
    }

    const totalRecordCount =
      (manifest.approved?.records.length ?? 0) +
      (manifest.unvetted?.records.length ?? 0) +
      (manifest.workingProfile?.records.length ?? 0) +
      (manifest.compounding?.records.length ?? 0);
    const totalEvidenceObjectCount =
      (manifest.approved?.evidenceObjects.length ?? 0) +
      (manifest.unvetted?.evidenceObjects.length ?? 0);
    const totalLogicalBytes =
      (manifest.approved?.logicalBytes ?? 0) +
      (manifest.unvetted?.logicalBytes ?? 0) +
      (manifest.workingProfile?.logicalBytes ?? 0) +
      (manifest.compounding?.logicalBytes ?? 0);
    if (
      totalRecordCount > MAX_INTELLIGENCE_RECORDS ||
      totalEvidenceObjectCount > MAX_INTELLIGENCE_EVIDENCE_OBJECTS ||
      totalLogicalBytes > MAX_INTELLIGENCE_LOGICAL_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The selected intelligence inventory exceeds the aggregate snapshot budget.",
        path: ["selection"],
      });
    }

    const approvedIds = new Set<string>();
    const allIds = new Set<string>();
    for (const record of manifest.approved?.records ?? []) {
      approvedIds.add(record.recordId);
      allIds.add(record.recordId);
    }
    for (const evidence of manifest.approved?.evidenceObjects ?? []) {
      approvedIds.add(evidence.evidenceObjectId);
      allIds.add(evidence.evidenceObjectId);
    }
    for (const record of manifest.unvetted?.records ?? [])
      allIds.add(record.recordId);
    for (const evidence of manifest.unvetted?.evidenceObjects ?? []) {
      allIds.add(evidence.evidenceObjectId);
    }
    for (const record of manifest.workingProfile?.records ?? []) {
      allIds.add(record.recordId);
    }
    for (const record of manifest.compounding?.records ?? []) {
      allIds.add(record.recordId);
    }
    const inventoryCount =
      (manifest.approved?.records.length ?? 0) +
      (manifest.approved?.evidenceObjects.length ?? 0) +
      (manifest.unvetted?.records.length ?? 0) +
      (manifest.unvetted?.evidenceObjects.length ?? 0) +
      (manifest.workingProfile?.records.length ?? 0) +
      (manifest.compounding?.records.length ?? 0);
    if (allIds.size !== inventoryCount) {
      context.addIssue({
        code: "custom",
        message: "Snapshot intelligence identities must be globally unique.",
        path: ["approved"],
      });
    }
    const portableObjects = new Map<
      string,
      { byteLength: number; contentSha256: string }
    >();
    for (const value of [
      ...(manifest.approved?.records ?? []),
      ...(manifest.approved?.evidenceObjects ?? []),
      ...(manifest.unvetted?.records ?? []),
      ...(manifest.unvetted?.evidenceObjects ?? []),
      ...(manifest.workingProfile?.records ?? []),
      ...(manifest.compounding?.records ?? []),
    ]) {
      const existing = portableObjects.get(value.portableObjectId);
      if (
        existing !== undefined &&
        (existing.byteLength !== value.byteLength ||
          existing.contentSha256 !== value.contentSha256)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "One portable object identity cannot describe different content.",
          path: ["approved"],
        });
      }
      portableObjects.set(value.portableObjectId, {
        byteLength: value.byteLength,
        contentSha256: value.contentSha256,
      });
    }
    for (const [sectionName, records] of [
      ["approved", manifest.approved?.records ?? []],
      ["unvetted", manifest.unvetted?.records ?? []],
    ] as const) {
      for (const [recordIndex, record] of records.entries()) {
        for (const [
          dependencyIndex,
          dependency,
        ] of record.dependencies.entries()) {
          const allowed =
            sectionName === "approved"
              ? approvedIds.has(dependency)
              : allIds.has(dependency);
          if (!allowed) {
            context.addIssue({
              code: "custom",
              message:
                sectionName === "approved"
                  ? "Approved Intelligence cannot depend on an Unvetted or missing object."
                  : "Every Unvetted dependency must resolve inside the selected recovery closure.",
              path: [
                sectionName,
                "records",
                recordIndex,
                "dependencies",
                dependencyIndex,
              ],
            });
          }
        }
      }
    }
    for (const [recordIndex, record] of (
      manifest.compounding?.records ?? []
    ).entries()) {
      for (const [
        dependencyIndex,
        dependency,
      ] of record.dependencies.entries()) {
        if (!allIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            message:
              "Every compounding dependency must resolve in the snapshot.",
            path: [
              "compounding",
              "records",
              recordIndex,
              "dependencies",
              dependencyIndex,
            ],
          });
        }
      }
    }
  });

export const collaborationCapabilityProfileSchema = z
  .object({
    collaborationLedgerFormats: z.tuple([
      z.literal(OWD_COLLABORATION_LEDGER_FORMAT),
    ]),
    format: z.literal(OWD_COLLABORATION_CAPABILITIES_FORMAT),
    mcpProtocolRevision: z.literal("2025-11-25"),
    recordSchemaVersions: z.record(collaborationRecordTypeSchema, z.literal(1)),
    schemaVersion: z.literal(1),
    snapshotRequiredCapabilities: z.tuple([
      z.literal(APPROVED_INTELLIGENCE_CAPABILITY),
      z.literal(QUARANTINED_INTELLIGENCE_CAPABILITY),
    ]),
    submissionFormats: z.tuple([
      z.literal(OWD_COLLABORATION_SUBMISSION_FORMAT),
    ]),
    workPacketFormats: z.tuple([z.literal(OWD_WORK_PACKET_FORMAT)]),
  })
  .strict();

export const leadContinuityCapabilityProfileSchema = z
  .object({
    continuityPointFormats: z.tuple([z.literal(OWD_CONTINUITY_POINT_FORMAT)]),
    format: z.literal(OWD_LEAD_CONTINUITY_CAPABILITIES_FORMAT),
    mcpProtocolRevision: z.literal("2025-11-25"),
    mcpTools: z.tuple([
      z.literal("claim_project_lead"),
      z.literal("renew_project_lead"),
      z.literal("checkpoint_project"),
      z.literal("resume_project"),
    ]),
    portableBundleFormats: z.tuple([
      z.literal(OWD_PORTABLE_CONTINUITY_BUNDLE_FORMAT),
    ]),
    requiredScope: z.literal("project.lead"),
    schemaVersion: z.literal(1),
  })
  .strict();

export const collaborationProjectCreateRequestSchema = z
  .object({
    knowledgeSpace: z
      .object({
        label: shortLabelSchema,
        members: z
          .array(knowledgeSpaceMemberSchema)
          .min(1)
          .max(MAX_KNOWLEDGE_SPACE_VAULTS),
      })
      .strict(),
    packetExpiresInSeconds: z
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 60 * 60),
    project: z
      .object({
        label: shortLabelSchema,
        objective: proseSchema,
      })
      .strict(),
    requestedRole: roleLabelSchema,
    sourceNotes: z
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
            path: safeMarkdownPathSchema,
            vaultId: portableIdSchema,
          })
          .strict(),
      )
      .max(MAX_PACKET_CITATIONS),
    workItem: workItemBriefSchema,
  })
  .strict();

export type CollaborationProjectCreateRequest = z.infer<
  typeof collaborationProjectCreateRequestSchema
>;

const collaborationProjectBriefUpdateProjectSchema = z
  .object({
    objective: proseSchema,
  })
  .strict();

export const collaborationProjectBriefUpdateRequestSchema = z
  .object({
    expectedProjectVersionId: portableIdSchema,
    expectedWorkItemVersionId: portableIdSchema,
    idempotencyKey: canonicalStringSchema(128).optional(),
    project: collaborationProjectBriefUpdateProjectSchema.optional(),
    workItem: workItemBriefSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.project === undefined && value.workItem === undefined) {
      context.addIssue({
        code: "custom",
        message:
          "A Project brief edit must change the Project or Work Item brief.",
        path: ["workItem"],
      });
    }
  });

export type CollaborationProjectBriefUpdateRequest = z.infer<
  typeof collaborationProjectBriefUpdateRequestSchema
>;

export const collaborationProjectBriefUpdateResponseSchema = z
  .object({
    activeProjectVersionId: portableIdSchema,
    activeWorkItemVersionId: portableIdSchema,
    projectId: portableIdSchema,
    workItemId: portableIdSchema,
  })
  .strict();

export const collaborationContinuationPacketRequestSchema = z
  .object({
    packetExpiresInSeconds: z
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 60 * 60),
    workItemId: portableIdSchema,
  })
  .strict();

export type CollaborationContinuationPacketRequest = z.infer<
  typeof collaborationContinuationPacketRequestSchema
>;

export const collaborationProjectSummarySchema = z
  .object({
    activeGrantCount: z.number().int().nonnegative(),
    activeKnowledgeSpaceVersionId: portableIdSchema,
    activeProjectVersionId: portableIdSchema,
    activeWorkItemVersionId: portableIdSchema.optional(),
    agentVisibility: z.enum(["discoverable", "owner-only"]),
    createdAt: unixSecondsSchema,
    currentPacket: z
      .object({
        createdAt: unixSecondsSchema,
        expiresAt: unixSecondsSchema,
        packetId: portableIdSchema,
        workItemId: portableIdSchema,
      })
      .strict()
      .nullable(),
    currentBrief: z
      .object({
        constraints: z.array(boundedListItemSchema).max(32).optional(),
        definitionOfDone: z.array(boundedListItemSchema).min(1).max(32),
        latestCheckpoint: z
          .object({
            acceptedDecisions: z
              .array(
                z
                  .object({
                    createdAt: unixSecondsSchema,
                    rationale: proseSchema,
                    resolution: z.enum([
                      "accepted",
                      "rejected",
                      "mixed",
                      "deferred",
                    ]),
                  })
                  .strict(),
              )
              .max(MAX_CONTINUITY_REFERENCES),
            acknowledgedAt: unixSecondsSchema,
            blockers: continuityStateListSchema,
            citedEvidence: z
              .array(
                z
                  .object({
                    contentSha256: sha256HexSchema,
                    label: shortLabelSchema,
                    path: safeMarkdownPathSchema,
                  })
                  .strict(),
              )
              .max(MAX_CONTINUITY_REFERENCES),
            completedWork: continuityStateListSchema,
            knownRejectedApproaches: continuityStateListSchema,
            openWork: continuityStateListSchema,
          })
          .strict()
          .nullable(),
        nextAction: boundedListItemSchema,
        objective: proseSchema,
        requestedOutput: proseSchema.optional(),
      })
      .strict()
      .nullable(),
    duplicateGroupSize: z.number().int().positive(),
    label: shortLabelSchema,
    lastActivityAt: unixSecondsSchema,
    objective: proseSchema,
    pendingAuthorizationCount: z.number().int().nonnegative(),
    projectId: portableIdSchema,
    recordCount: z.number().int().nonnegative(),
    sourceVaults: z
      .array(
        z
          .object({
            id: portableIdSchema,
            name: shortLabelSchema,
          })
          .strict(),
      )
      .max(MAX_KNOWLEDGE_SPACE_VAULTS),
    state: z.enum([
      "archived",
      "authorization-required",
      "disconnected",
      "integrity-invalid",
      "packet-expired",
      "packet-missing",
      "packet-stale",
      "project-context-invalid",
      "ready",
      "source-unavailable",
      "work-item-closed",
    ]),
    status: z.enum(["active", "archived"]),
    workItemCount: z.number().int().nonnegative(),
  })
  .strict();

export type CollaborationProjectSummary = z.infer<
  typeof collaborationProjectSummarySchema
>;
export type CollaborationProjectBriefUpdateResponse = z.infer<
  typeof collaborationProjectBriefUpdateResponseSchema
>;

export const collaborationProjectArchiveRequestSchema = z
  .object({
    archived: z.boolean(),
    reason: canonicalStringSchema(1_024),
  })
  .strict();

export const collaborationProjectAgentVisibilityRequestSchema = z
  .object({
    reason: canonicalStringSchema(1_024),
    visibility: z.enum(["discoverable", "owner-only"]),
  })
  .strict();

export const collaborationWorkItemReopenRequestSchema = z
  .object({
    reason: canonicalStringSchema(1_024),
  })
  .strict();

export const collaborationTimelineItemSchema = z
  .object({
    contentSha256: sha256HexSchema,
    createdAt: unixSecondsSchema,
    disposition: z.enum([
      "pending",
      "accepted",
      "rejected",
      "quarantined",
      "superseded",
    ]),
    producerLabel: shortLabelSchema.nullable(),
    projectId: portableIdSchema,
    recordId: portableIdSchema,
    recordType: collaborationRecordTypeSchema,
    visibility: z.enum(["private", "shared", "owner-only"]),
    workItemId: portableIdSchema.nullable(),
  })
  .strict();

export type CollaborationTimelineItem = z.infer<
  typeof collaborationTimelineItemSchema
>;

export const collaborationTimelinePageRequestSchema = z
  .object({
    cursor: z.string().min(1).max(2_048).nullable().default(null),
    kind: z.enum(["inbox", "timeline"]),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .strict();

export const collaborationTimelinePageResponseSchema = z
  .object({
    items: z.array(collaborationTimelineItemSchema).max(50),
    nextCursor: z.string().min(1).max(2_048).nullable(),
  })
  .strict();

export const collaborationParticipantClaimsResponseSchema = z
  .object({
    claimedIdentityLabels: z.array(shortLabelSchema).max(16),
  })
  .strict();

export const collaborationParticipantActivitySchema = z
  .object({
    acceptedRecordCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    authorizationClientId: z.string().min(1).max(2_048),
    authorizationClientName: shortLabelSchema,
    clientOrigin: z.string().min(1).max(2_048),
    claimedIdentityLabels: z.array(shortLabelSchema).max(16),
    grantId: portableIdSchema,
    handoffCount: z.number().int().nonnegative(),
    lastUsedAt: unixSecondsSchema.nullable(),
    pendingOwnerActionCount: z.number().int().nonnegative(),
    projectId: portableIdSchema,
    reviewCount: z.number().int().nonnegative(),
    status: z.enum(["active", "expired", "revoked"]),
  })
  .strict();

export type CollaborationParticipantActivity = z.infer<
  typeof collaborationParticipantActivitySchema
>;

export const collaborationContributionStatisticsSchema = z
  .object({
    acceptedRecordCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    attemptCount: z.number().int().nonnegative(),
    authorizationClientCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    handoffCount: z.number().int().nonnegative(),
    reviewCount: z.number().int().nonnegative(),
  })
  .strict();

export const collaborationPendingActionsSchema = z
  .object({
    handoffsToShare: z.number().int().nonnegative(),
    recordsToReview: z.number().int().nonnegative(),
    reviewsToDecide: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const collaborationDashboardResponseSchema = z
  .object({
    contributionStatistics: collaborationContributionStatisticsSchema,
    inbox: z.array(collaborationTimelineItemSchema).max(100),
    inboxNextCursor: z.string().min(1).max(2_048).nullable(),
    participants: z.array(collaborationParticipantActivitySchema).max(250),
    pendingActions: collaborationPendingActionsSchema,
    projects: z.array(collaborationProjectSummarySchema).max(100),
    timeline: z.array(collaborationTimelineItemSchema).max(250),
    timelineNextCursor: z.string().min(1).max(2_048).nullable(),
  })
  .strict();

export type CollaborationDashboardResponse = z.infer<
  typeof collaborationDashboardResponseSchema
>;

export const collaborationConnectionSchema = z
  .object({
    expiresAt: unixSecondsSchema,
    grantId: portableIdSchema,
    issuedAt: unixSecondsSchema,
    lastUsedAt: unixSecondsSchema.nullable(),
    oauthClientId: z.string().min(1).max(2_048),
    projectId: portableIdSchema,
    projectLabel: shortLabelSchema,
    revokedAt: unixSecondsSchema.nullable(),
    scopes: z.array(collaborationScopeSchema).min(1).max(5),
    status: z.enum(["active", "revoked"]),
  })
  .strict();

export type CollaborationConnection = z.infer<
  typeof collaborationConnectionSchema
>;

export const collaborationConnectionListResponseSchema = z
  .object({
    connections: z.array(collaborationConnectionSchema).max(250),
  })
  .strict();

export type CollaborationConnectionListResponse = z.infer<
  typeof collaborationConnectionListResponseSchema
>;

export const collaborationOwnerRecordActionSchema = z
  .object({
    action: z.enum(["share", "accept", "reject", "quarantine"]),
    reason: canonicalStringSchema(4_096),
    recordId: portableIdSchema,
  })
  .strict();

export const collaborationDecisionCreateRequestSchema = z
  .object({
    inputRecordIds: z.array(portableIdSchema).min(1).max(64),
    rationale: proseSchema,
    resolution: z.enum(["accepted", "rejected", "mixed", "deferred"]),
    workItemId: portableIdSchema,
  })
  .strict();

export const collaborationNotebookProjectionRequestSchema = z
  .object({
    folder: collaborationPathPrefixSchema.refine((value) => value.path !== "", {
      message: "A Project notebook requires a non-root folder.",
    }),
    vaultId: portableIdSchema,
  })
  .strict();

export const collaborationNotebookProjectionSchema = z
  .object({
    contentSha256: sha256HexSchema,
    createdAt: unixSecondsSchema,
    path: safeMarkdownPathSchema,
    projectId: portableIdSchema,
    projectionId: portableIdSchema,
    recordId: portableIdSchema,
    targetContentVersion: sha256HexSchema,
    vaultId: portableIdSchema,
  })
  .strict();

export type CollaborationNotebookProjection = z.infer<
  typeof collaborationNotebookProjectionSchema
>;

const portableExchangeFileSchema = z
  .object({
    contentSha256: sha256HexSchema,
    mediaType: z.enum(["text/markdown", "application/json"]),
    path: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => safeRelativePath(value, false)),
    text: z.string().max(MAX_PACKET_EVIDENCE_BYTES),
  })
  .strict();

export const portableWorkPacketBundleSchema = z
  .object({
    files: z.array(portableExchangeFileSchema).min(3).max(256),
    format: z.literal("owd-portable-work-packet-bundle-v1"),
    packetId: portableIdSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((bundle, context) => {
    const paths = bundle.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Portable exchange file paths must be unique.",
        path: ["files"],
      });
    }
    if (
      !paths.includes("README.md") ||
      !paths.includes("packet.json") ||
      !paths.includes("submission/submission.json")
    ) {
      context.addIssue({
        code: "custom",
        message: "The portable packet bundle is missing a required file.",
        path: ["files"],
      });
    }
  });

export type PortableWorkPacketBundle = z.infer<
  typeof portableWorkPacketBundleSchema
>;

export const portableContinuityBundleSchema = z
  .object({
    continuityPointId: portableIdSchema,
    files: z.array(portableExchangeFileSchema).min(2).max(3),
    format: z.literal(OWD_PORTABLE_CONTINUITY_BUNDLE_FORMAT),
    projectId: portableIdSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((bundle, context) => {
    const paths = bundle.files.map((file) => file.path);
    if (
      new Set(paths).size !== paths.length ||
      !paths.includes("README.md") ||
      !paths.includes("continuity-point.json") ||
      paths.some(
        (path) =>
          path !== "README.md" &&
          path !== "continuity-point.json" &&
          path !== "elastic-records.json",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "The portable continuity bundle is incomplete.",
        path: ["files"],
      });
    }
  });

export type PortableContinuityBundle = z.infer<
  typeof portableContinuityBundleSchema
>;

export const collaborationSubmissionImportSchema = z
  .object({
    artifactBody: z.string().max(MAX_SUBMISSION_BYTES).nullable(),
    submission: collaborationSubmissionSchema,
  })
  .strict();

export const collaborationRestoreVaultMappingSchema = z
  .object({
    sourceVaultId: portableIdSchema,
    targetVaultId: portableIdSchema,
  })
  .strict();

export const collaborationRestoreCreateRequestSchema = z
  .object({
    manifest: snapshotIntelligenceManifestSchema,
    vaultMappings: z
      .array(collaborationRestoreVaultMappingSchema)
      .max(MAX_KNOWLEDGE_SPACE_VAULTS)
      .default([]),
  })
  .strict()
  .refine(
    (value) =>
      value.manifest.selection !== "none" ||
      value.manifest.workingProfile !== undefined,
    { message: "A vault-only snapshot has no portable memory to restore." },
  )
  .superRefine((value, context) => {
    const sourceIds = value.vaultMappings.map(
      (mapping) => mapping.sourceVaultId,
    );
    const targetIds = value.vaultMappings.map(
      (mapping) => mapping.targetVaultId,
    );
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({
        code: "custom",
        message: "A restore may map each source vault only once.",
        path: ["vaultMappings"],
      });
    }
    if (new Set(targetIds).size !== targetIds.length) {
      context.addIssue({
        code: "custom",
        message: "A restore may use each target vault only once.",
        path: ["vaultMappings"],
      });
    }
  });

export const collaborationRestoreItemRequestSchema = z
  .object({
    bytesBase64Url: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_SUBMISSION_BYTES * 4) / 3) + 8)
      .regex(/^[A-Za-z0-9_-]+$/u),
    portableObjectId: portableIdSchema,
  })
  .strict();

export const collaborationRestoreConfirmRequestSchema = z
  .object({
    confirmation: z.literal("RESTORE PORTABLE INTELLIGENCE"),
  })
  .strict();

export const collaborationRestoreJobSchema = z
  .object({
    expectedItemCount: z.number().int().nonnegative(),
    restoreId: portableIdSchema,
    selection: z.enum(["none", "approved", "approved-and-unvetted"]),
    stagedItemCount: z.number().int().nonnegative(),
    status: z.enum(["staging", "preview", "confirmed", "applied", "failed"]),
  })
  .strict();

export type CollaborationRestoreJob = z.infer<
  typeof collaborationRestoreJobSchema
>;

export const collaborationRestoreResultSchema = z
  .object({
    approvedRecordCount: z.number().int().nonnegative(),
    evidenceObjectCount: z.number().int().nonnegative(),
    grantCount: z.literal(0),
    restoreId: portableIdSchema,
    status: z.literal("applied"),
    unvettedQuarantinedCount: z.number().int().nonnegative(),
  })
  .strict();

export type CollaborationRestoreResult = z.infer<
  typeof collaborationRestoreResultSchema
>;

type CanonicalJsonValue =
  | boolean
  | null
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        canonicalJsonValue(item),
      ]),
    );
  }
  throw new TypeError("Only finite JSON values can be canonicalized.");
}

export function canonicalizeCollaborationJson(value: unknown): string {
  const canonicalize = (item: CanonicalJsonValue): string => {
    if (item === null || typeof item !== "object") {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map(canonicalize).join(",")}]`;
    }
    return `{${Object.keys(item)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(item[key] as CanonicalJsonValue)}`,
      )
      .join(",")}}`;
  };
  return canonicalize(canonicalJsonValue(value));
}

export function canonicalizeIntegrityPayload(
  value: { integrity: { digest: string } } & Record<string, unknown>,
): string {
  const { integrity, ...record } = value;
  const { digest: _digest, ...integrityWithoutDigest } = integrity;
  return canonicalizeCollaborationJson({
    ...record,
    integrity: integrityWithoutDigest,
  });
}

export const workPacketJsonSchema = {
  $id: "urn:owd:schema:work-packet:v1",
  ...z.toJSONSchema(workPacketSchema, { target: "draft-2020-12" }),
};

export const collaborationSubmissionJsonSchema = {
  $id: "urn:owd:schema:collaboration-submission:v1",
  ...z.toJSONSchema(collaborationSubmissionSchema, {
    target: "draft-2020-12",
  }),
};

export const collaborationLedgerJsonSchema = {
  $id: "urn:owd:schema:collaboration-ledger:v1",
  ...z.toJSONSchema(collaborationLedgerSchema, { target: "draft-2020-12" }),
};

export const snapshotIntelligenceJsonSchema = {
  $id: "urn:owd:schema:snapshot-intelligence:v1",
  ...z.toJSONSchema(snapshotIntelligenceManifestSchema, {
    target: "draft-2020-12",
  }),
};

export const continuityPointJsonSchema = {
  $id: "urn:owd:schema:continuity-point:v1",
  ...z.toJSONSchema(continuityPointSchema, { target: "draft-2020-12" }),
};

export const projectLeadClaimRequestJsonSchema = {
  $id: "urn:owd:schema:project-lead-claim-request:v1",
  ...z.toJSONSchema(projectLeadClaimRequestSchema, {
    target: "draft-2020-12",
  }),
};

export const projectCheckpointRequestJsonSchema = {
  $id: "urn:owd:schema:project-checkpoint-request:v1",
  ...z.toJSONSchema(projectCheckpointRequestSchema, {
    target: "draft-2020-12",
  }),
};

export type CollaborationGrant = z.infer<typeof collaborationGrantSchema>;
export type CollaborationDecisionCreateRequest = z.infer<
  typeof collaborationDecisionCreateRequestSchema
>;
export type KnowledgeSpace = z.infer<typeof knowledgeSpaceSchema>;
export type KnowledgeSpaceVersion = z.infer<typeof knowledgeSpaceVersionSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectVersion = z.infer<typeof projectVersionSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemVersion = z.infer<typeof workItemVersionSchema>;
export type ParticipantRef = z.infer<typeof participantRefSchema>;
export type WorkPacket = z.infer<typeof workPacketSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type OwnerEvent = z.infer<typeof ownerEventSchema>;
export type ProvenanceEdge = z.infer<typeof provenanceEdgeSchema>;
export type CollaborationSubmission = z.infer<
  typeof collaborationSubmissionSchema
>;
export type CollaborationLedger = z.infer<typeof collaborationLedgerSchema>;
export type SnapshotIntelligenceManifest = z.infer<
  typeof snapshotIntelligenceManifestSchema
>;
export type CollaborationRestoreVaultMapping = z.infer<
  typeof collaborationRestoreVaultMappingSchema
>;
export type ContinuityPoint = z.infer<typeof continuityPointSchema>;
export type ProjectLeadLease = z.infer<typeof projectLeadLeaseSchema>;
export type ProjectLeadClaimRequest = z.infer<
  typeof projectLeadClaimRequestSchema
>;
export type ProjectLeadRenewRequest = z.infer<
  typeof projectLeadRenewRequestSchema
>;
export type ProjectCheckpointRequest = z.infer<
  typeof projectCheckpointRequestSchema
>;
export type ContinuityCheckpointReceipt = z.infer<
  typeof continuityCheckpointReceiptSchema
>;
