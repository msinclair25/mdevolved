import {
  OWD_CONTINUITY_POINT_FORMAT,
  OWD_PORTABLE_CONTINUITY_BUNDLE_FORMAT,
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  continuityCheckpointReceiptSchema,
  continuityPointSchema,
  elasticPortableExportSchema,
  portableContinuityBundleSchema,
  projectCheckpointRequestSchema,
  projectLeadClaimRequestSchema,
  projectLeadRenewRequestSchema,
  type Artifact,
  type ContinuityCheckpointReceipt,
  type ContinuityPoint,
  type Decision,
  type PortableContinuityBundle,
  type ProjectLeadLease,
} from "@owd/contracts";
import {
  CollaborationProblem,
  authorizeCollaboration,
  type CollaborationAuthorizationContext,
} from "./collaboration-service";
import {
  idempotencyKeyHash,
  readCollaborationRecords,
  touchCollaborationGrant,
} from "./collaboration-store";
import {
  claimProjectLeadLeaseRow,
  insertCheckpointReceiptStatement,
  insertContinuityDependenciesStatement,
  insertContinuityPointStatement,
  prepareContinuityPoint,
  readCheckpointReceipt,
  readContinuityPoint,
  readLatestContinuityPoint,
  readProjectLeadLease,
  renewProjectLeadLeaseRow,
  releaseProjectLeadLeaseStatement,
  revokeProjectLeadLeaseRow,
  type StoredCheckpointReceipt,
  type StoredContinuityPoint,
} from "./continuity-store";
import { queueCollaborationObjectCleanup } from "./collaboration-retention";
import { readElasticOperationRecord } from "./elastic-operation-store";
import { sha256Hex } from "./security";

type AuthorizedContinuityInput = {
  authorization: CollaborationAuthorizationContext;
  now: number;
  projectId: string;
};

function authorityKey(grantId: string): string {
  return `grant:${grantId}`;
}

export const AGENT_MEMORY_FACADE_LEAD_IDENTITY = {
  claimedHarness: {
    assertedBy: "client" as const,
    name: "owd-agent-memory-facade",
    verification: "claimed" as const,
    version: "1",
  },
  claimedModel: null,
  displayName: "Connected MDevolved agent",
};

async function requestSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeCollaborationJson(value));
}

export async function claimProjectLead(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<ProjectLeadLease> {
  const parsed = projectLeadClaimRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new CollaborationProblem("submission_invalid");
  const grant = await authorizeCollaboration(db, storage, input.authorization, {
    now: input.now,
    projectId: parsed.data.projectId,
    requiredScope: "project.lead",
  });
  const claimAuthorityKey = authorityKey(grant.grantId);
  const claimIdempotencyKeySha256 = await idempotencyKeyHash(
    parsed.data.idempotencyKey,
  );
  const claimRequestSha256 = await requestSha256(parsed.data);
  const current = await readProjectLeadLease(
    db,
    parsed.data.projectId,
    input.now,
  );
  if (
    current?.claimAuthorityKey === claimAuthorityKey &&
    current.claimIdempotencyKeySha256 === claimIdempotencyKeySha256
  ) {
    if (current.claimRequestSha256 !== claimRequestSha256) {
      throw new CollaborationProblem("idempotency_conflict");
    }
    if (
      current.holderGrantId !== grant.grantId ||
      current.holderClientId !== grant.oauthClientId ||
      current.lease.status !== "active"
    ) {
      throw new CollaborationProblem("lead_lease_invalid");
    }
    await touchCollaborationGrant(db, grant.grantId, input.now);
    return current.lease;
  }
  const claimed = await claimProjectLeadLeaseRow(db, {
    authorityKey: claimAuthorityKey,
    claimIdempotencyKeySha256,
    claimRequestSha256,
    clientId: grant.oauthClientId,
    expiresAt: input.now + parsed.data.leaseExpiresInSeconds,
    grantId: grant.grantId,
    leadIdentity: parsed.data.leadIdentity,
    leaseId: crypto.randomUUID(),
    now: input.now,
    projectId: parsed.data.projectId,
  });
  if (claimed !== null) {
    await touchCollaborationGrant(db, grant.grantId, input.now);
    return claimed.lease;
  }
  const raced = await readProjectLeadLease(
    db,
    parsed.data.projectId,
    input.now,
  );
  if (
    raced?.claimAuthorityKey === claimAuthorityKey &&
    raced.claimIdempotencyKeySha256 === claimIdempotencyKeySha256 &&
    raced.claimRequestSha256 === claimRequestSha256 &&
    raced.holderGrantId === grant.grantId &&
    raced.holderClientId === grant.oauthClientId &&
    raced.lease.status === "active"
  ) {
    return raced.lease;
  }
  throw new CollaborationProblem("lead_lease_conflict");
}

export async function renewProjectLead(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    now: number;
    request: unknown;
  },
): Promise<ProjectLeadLease> {
  const parsed = projectLeadRenewRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new CollaborationProblem("submission_invalid");
  const grant = await authorizeCollaboration(db, storage, input.authorization, {
    now: input.now,
    projectId: parsed.data.projectId,
    requiredScope: "project.lead",
  });
  const renewed = await renewProjectLeadLeaseRow(db, {
    clientId: grant.oauthClientId,
    expiresAt: input.now + parsed.data.leaseExpiresInSeconds,
    fencingToken: parsed.data.fencingToken,
    grantId: grant.grantId,
    leaseId: parsed.data.leaseId,
    now: input.now,
    projectId: parsed.data.projectId,
  });
  if (renewed === null) {
    throw new CollaborationProblem("lead_lease_invalid");
  }
  await touchCollaborationGrant(db, grant.grantId, input.now);
  return renewed.lease;
}

export async function revokeProjectLead(
  db: D1Database,
  input: { now: number; projectId: string },
): Promise<boolean> {
  return revokeProjectLeadLeaseRow(db, input);
}

async function loadRecords(
  db: D1Database,
  storage: R2Bucket,
  ids: string[],
): ReturnType<typeof readCollaborationRecords> {
  const loaded = new Map<
    string,
    Awaited<ReturnType<typeof readCollaborationRecords>> extends Map<
      string,
      infer Value
    >
      ? Value
      : never
  >();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = await readCollaborationRecords(
      db,
      storage,
      ids.slice(offset, offset + 50),
    );
    for (const [id, value] of batch) loaded.set(id, value);
  }
  return loaded;
}

async function checkpointReferenceStates(
  db: D1Database,
  ids: string[],
): Promise<
  Map<
    string,
    {
      disposition:
        "accepted" | "pending" | "quarantined" | "rejected" | "superseded";
      producerClientId: string | null;
      visibility: "owner-only" | "private" | "shared";
    }
  >
> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT records.id, records.producer_client_id,
        states.disposition, states.visibility
       FROM collaboration_records records
       JOIN collaboration_record_states states ON states.record_id = records.id
       JOIN json_each(?) selected ON selected.value = records.id`,
    )
    .bind(JSON.stringify(ids))
    .all<{
      disposition:
        "accepted" | "pending" | "quarantined" | "rejected" | "superseded";
      id: string;
      producer_client_id: string | null;
      visibility: "owner-only" | "private" | "shared";
    }>();
  return new Map(
    rows.results.map((row) => [
      row.id,
      {
        disposition: row.disposition,
        producerClientId: row.producer_client_id,
        visibility: row.visibility,
      },
    ]),
  );
}

function checkpointDependencies(point: ContinuityPoint): Array<{
  dependencyId: string;
  dependencyKind: "evidence" | "record";
}> {
  const values: Array<{
    dependencyId: string;
    dependencyKind: "evidence" | "record";
  }> = [
    { dependencyId: point.project.projectId, dependencyKind: "record" },
    {
      dependencyId: point.project.projectVersionId,
      dependencyKind: "record",
    },
    { dependencyId: point.workItem.workItemId, dependencyKind: "record" },
    {
      dependencyId: point.workItem.workItemVersionId,
      dependencyKind: "record",
    },
    {
      dependencyId: point.context.knowledgeSpaceVersionId,
      dependencyKind: "record",
    },
    {
      dependencyId: point.context.workPacketId,
      dependencyKind: "record",
    },
    ...point.acceptedDecisions.map((value) => ({
      dependencyId: value.decision.decisionId,
      dependencyKind: "record" as const,
    })),
    ...point.artifacts.map((value) => ({
      dependencyId: value.artifact.artifactId,
      dependencyKind: "record" as const,
    })),
    ...point.citedEvidence.map((value) => ({
      dependencyId: value.evidence.evidenceObjectId,
      dependencyKind: "evidence" as const,
    })),
  ];
  if (point.previousContinuityPointId !== null) {
    values.push({
      dependencyId: point.previousContinuityPointId,
      dependencyKind: "record",
    });
  }
  return [
    ...new Map(values.map((value) => [value.dependencyId, value])).values(),
  ];
}

function publicReceipt(
  receipt: StoredCheckpointReceipt,
): ContinuityCheckpointReceipt {
  return continuityCheckpointReceiptSchema.parse({
    acknowledgedAt: receipt.acknowledgedAt,
    contentSha256: receipt.contentSha256,
    continuityPointId: receipt.continuityPointId,
    idempotencyKeySha256: receipt.idempotencyKeySha256,
    previousContinuityPointId: receipt.previousContinuityPointId,
    projectId: receipt.projectId,
  });
}

export async function checkpointProject(
  db: D1Database,
  storage: R2Bucket,
  input: {
    authorization: CollaborationAuthorizationContext;
    facadeLeaseRelease?: {
      clientId: string;
      fencingToken: number;
      grantId: string;
      leaseId: string;
      projectId: string;
    };
    now: number;
    request: unknown;
  },
): Promise<{
  continuityPoint: ContinuityPoint;
  receipt: ContinuityCheckpointReceipt;
}> {
  const parsed = projectCheckpointRequestSchema.safeParse(input.request);
  if (!parsed.success) throw new CollaborationProblem("submission_invalid");
  const request = parsed.data;
  const grant = await authorizeCollaboration(db, storage, input.authorization, {
    now: input.now,
    projectId: request.projectId,
    requiredScope: "project.lead",
  });
  const checkpointAuthorityKey = authorityKey(grant.grantId);
  const idempotencyKeySha256 = await idempotencyKeyHash(request.idempotencyKey);
  const checkpointRequestSha256 = await requestSha256(request);
  const existingReceipt = await readCheckpointReceipt(db, {
    authorityKey: checkpointAuthorityKey,
    idempotencyKeySha256,
  });
  if (existingReceipt !== null) {
    if (existingReceipt.requestSha256 !== checkpointRequestSha256) {
      throw new CollaborationProblem("idempotency_conflict");
    }
    const existingPoint = await readContinuityPointByReceipt(
      db,
      storage,
      existingReceipt,
    );
    return {
      continuityPoint: existingPoint.point,
      receipt: publicReceipt(existingReceipt),
    };
  }
  const latest = await readLatestContinuityPoint(
    db,
    storage,
    request.projectId,
  );
  if (
    (latest?.point.continuityPointId ?? null) !==
    request.previousContinuityPointId
  ) {
    throw new CollaborationProblem("continuity_point_conflict");
  }
  const lease = await readProjectLeadLease(db, request.projectId, input.now);
  if (
    lease === null ||
    lease.lease.status !== "active" ||
    lease.lease.leaseId !== request.leaseId ||
    lease.lease.fencingToken !== request.fencingToken ||
    lease.holderGrantId !== grant.grantId ||
    lease.holderClientId !== grant.oauthClientId
  ) {
    throw new CollaborationProblem("lead_lease_invalid");
  }
  if (
    input.facadeLeaseRelease !== undefined &&
    (input.facadeLeaseRelease.projectId !== request.projectId ||
      input.facadeLeaseRelease.leaseId !== lease.lease.leaseId ||
      input.facadeLeaseRelease.fencingToken !== lease.lease.fencingToken ||
      input.facadeLeaseRelease.grantId !== grant.grantId ||
      input.facadeLeaseRelease.clientId !== grant.oauthClientId ||
      canonicalizeCollaborationJson(lease.lease.leadIdentity) !==
        canonicalizeCollaborationJson(AGENT_MEMORY_FACADE_LEAD_IDENTITY))
  ) {
    throw new CollaborationProblem("lead_lease_invalid");
  }
  const projection = await db
    .prepare(
      `SELECT project.active_project_version_id,
        project.active_knowledge_space_version_id, project.objective,
        work_item.active_work_item_version_id, work_item.status
       FROM collaboration_projects project
       JOIN collaboration_work_items work_item
         ON work_item.project_id = project.project_id
       WHERE project.project_id = ? AND project.status = 'active'
         AND work_item.work_item_id = ? AND work_item.status = 'open'`,
    )
    .bind(request.projectId, request.workItemId)
    .first<{
      active_knowledge_space_version_id: string;
      active_project_version_id: string;
      active_work_item_version_id: string;
      objective: string;
      status: "open";
    }>();
  const latestPacket = await db
    .prepare(
      `SELECT id FROM collaboration_records
       WHERE project_id = ? AND work_item_id = ?
         AND record_type = 'work-packet'
       ORDER BY received_at DESC, id DESC LIMIT 1`,
    )
    .bind(request.projectId, request.workItemId)
    .first<{ id: string }>();
  if (
    projection === null ||
    latestPacket?.id !== request.packetId ||
    projection.active_knowledge_space_version_id !==
      grant.knowledgeSpaceVersionId
  ) {
    throw new CollaborationProblem("work_packet_stale");
  }
  const coreIds = [
    projection.active_project_version_id,
    projection.active_work_item_version_id,
    request.packetId,
  ];
  const references = await loadRecords(db, storage, [
    ...coreIds,
    ...request.acceptedDecisionIds,
    ...request.artifactIds,
  ]);
  const projectVersion = references.get(coreIds[0] ?? "");
  const workItemVersion = references.get(coreIds[1] ?? "");
  const packet = references.get(request.packetId);
  if (
    projectVersion?.record.recordType !== "project-version" ||
    projectVersion.record.projectId !== request.projectId ||
    workItemVersion?.record.recordType !== "work-item-version" ||
    workItemVersion.record.projectId !== request.projectId ||
    workItemVersion.record.workItemId !== request.workItemId ||
    packet?.record.recordType !== "work-packet" ||
    packet.record.projectId !== request.projectId ||
    packet.record.workItemId !== request.workItemId ||
    packet.record.projectVersionId !== projection.active_project_version_id ||
    packet.record.workItemVersionId !==
      projection.active_work_item_version_id ||
    packet.record.knowledgeSpaceVersionId !==
      projection.active_knowledge_space_version_id ||
    packet.record.expiresAt <= input.now
  ) {
    throw new CollaborationProblem("work_packet_stale");
  }
  const states = await checkpointReferenceStates(db, [
    ...request.acceptedDecisionIds,
    ...request.artifactIds,
  ]);
  const acceptedDecisions: Array<{
    decision: Decision;
    recordSha256: string;
  }> = [];
  for (const decisionId of request.acceptedDecisionIds) {
    const loaded = references.get(decisionId);
    if (
      loaded?.record.recordType !== "decision" ||
      loaded.record.projectId !== request.projectId ||
      loaded.record.workItemId !== request.workItemId ||
      states.get(decisionId)?.disposition !== "accepted"
    ) {
      throw new CollaborationProblem("project_reference_invalid");
    }
    acceptedDecisions.push({
      decision: loaded.record,
      recordSha256: loaded.metadata.contentSha256,
    });
  }
  const artifacts: Array<{
    artifact: Artifact;
    disposition:
      "accepted" | "pending" | "quarantined" | "rejected" | "superseded";
    recordSha256: string;
    visibility: "owner-only" | "private" | "shared";
  }> = [];
  for (const artifactId of request.artifactIds) {
    const loaded = references.get(artifactId);
    const state = states.get(artifactId);
    if (
      loaded?.record.recordType !== "artifact" ||
      loaded.record.projectId !== request.projectId ||
      loaded.record.workItemId !== request.workItemId ||
      state === undefined ||
      (state.disposition !== "accepted" &&
        state.visibility !== "shared" &&
        state.producerClientId !== grant.oauthClientId)
    ) {
      throw new CollaborationProblem("artifact_not_visible");
    }
    artifacts.push({
      artifact: loaded.record,
      disposition: state.disposition,
      recordSha256: loaded.metadata.contentSha256,
      visibility: state.visibility,
    });
  }
  const citations = new Map(
    packet.record.sourceCitations.map((citation) => [
      citation.citationId,
      citation,
    ]),
  );
  const evidence = new Map(
    packet.record.evidenceObjects.map((value) => [
      value.evidenceObjectId,
      value,
    ]),
  );
  const citedEvidence = request.citationIds.map((citationId) => {
    const citation = citations.get(citationId);
    const retained =
      citation === undefined
        ? undefined
        : evidence.get(citation.evidenceObjectId);
    if (citation === undefined || retained === undefined) {
      throw new CollaborationProblem("evidence_unavailable");
    }
    return { citation, evidence: retained };
  });
  const continuityPointId = crypto.randomUUID();
  const pointWithoutDigest = continuityPointSchema.parse({
    acceptedDecisions,
    artifacts,
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    blockers: request.blockers,
    citedEvidence,
    completedWork: request.completedWork,
    continuityPointId,
    context: {
      createdAt: packet.record.createdAt,
      expiresAt: packet.record.expiresAt,
      knowledgeSpaceVersionId: packet.record.knowledgeSpaceVersionId,
      workPacketId: packet.record.packetId,
      workPacketSha256: packet.metadata.contentSha256,
    },
    format: OWD_CONTINUITY_POINT_FORMAT,
    integrity: {
      algorithm: "sha-256-jcs-rfc8785",
      digest: "0".repeat(64),
      scope: "object-with-integrity-digest-omitted",
    },
    knownRejectedApproaches: request.knownRejectedApproaches,
    nextAction: request.nextAction,
    objective: {
      project: projectVersion.record.objective,
      workItem: workItemVersion.record.brief,
    },
    openWork: request.openWork,
    previousContinuityPointId: request.previousContinuityPointId,
    project: {
      projectId: request.projectId,
      projectVersionId: projectVersion.record.projectVersionId,
      projectVersionSha256: projectVersion.metadata.contentSha256,
    },
    provenance: {
      acknowledgedAt: input.now,
      leadFencingToken: lease.lease.fencingToken,
      leadIdentity: lease.lease.leadIdentity,
      producerVerification: "authorization-bound-client",
    },
    recordType: "continuity-point",
    risks: request.risks,
    schemaVersion: 1,
    workItem: {
      status: projection.status,
      workItemId: request.workItemId,
      workItemVersionId: workItemVersion.record.workItemVersionId,
      workItemVersionSha256: workItemVersion.metadata.contentSha256,
    },
  });
  pointWithoutDigest.integrity.digest = await sha256Hex(
    canonicalizeIntegrityPayload(
      pointWithoutDigest as ContinuityPoint & Record<string, unknown>,
    ),
  );
  const point = continuityPointSchema.parse(pointWithoutDigest);
  let prepared: Awaited<ReturnType<typeof prepareContinuityPoint>>;
  try {
    prepared = await prepareContinuityPoint(storage, point);
  } catch (error) {
    if (error instanceof Error && error.message === "submission_too_large") {
      throw new CollaborationProblem("submission_too_large");
    }
    if (error instanceof Error && error.message === "integrity_mismatch") {
      throw new CollaborationProblem("integrity_mismatch");
    }
    throw error;
  }
  const collision = await db
    .prepare(
      `SELECT 1 AS present FROM collaboration_records
       WHERE id = ? OR portable_object_id = ?
       UNION ALL
       SELECT 1 AS present FROM project_continuity_points
       WHERE continuity_point_id = ? OR portable_object_id = ?
       LIMIT 1`,
    )
    .bind(
      point.continuityPointId,
      prepared.portableObjectId,
      point.continuityPointId,
      prepared.portableObjectId,
    )
    .first<{ present: number }>();
  if (collision !== null) {
    throw new CollaborationProblem("portable_identity_collision");
  }
  const storedReceipt: StoredCheckpointReceipt = {
    acknowledgedAt: input.now,
    contentSha256: prepared.contentSha256,
    continuityPointId: point.continuityPointId,
    idempotencyKeySha256,
    previousContinuityPointId: point.previousContinuityPointId,
    projectId: request.projectId,
    requestSha256: checkpointRequestSha256,
  };
  try {
    const statements = [
      insertContinuityPointStatement(db, prepared, {
        producerClientId: grant.oauthClientId,
        restoredAt: null,
        sourceLeaseId: lease.lease.leaseId,
      }),
      insertContinuityDependenciesStatement(
        db,
        point.continuityPointId,
        checkpointDependencies(point),
      ),
      insertCheckpointReceiptStatement(db, {
        ...storedReceipt,
        authorityKey: checkpointAuthorityKey,
      }),
    ];
    if (input.facadeLeaseRelease !== undefined) {
      statements.push(
        releaseProjectLeadLeaseStatement(db, {
          ...input.facadeLeaseRelease,
          leadIdentity: AGENT_MEMORY_FACADE_LEAD_IDENTITY,
          now: input.now,
        }),
      );
    }
    await db.batch(statements);
  } catch (error) {
    try {
      await queueCollaborationObjectCleanup(
        db,
        [prepared.bodyObjectKey],
        input.now,
      );
    } catch {
      // The failed D1 batch left this immutable object unreachable. A later
      // storage inventory can recover it if the best-effort queue is unavailable.
    }
    if (
      error instanceof Error &&
      error.message.includes("project_lead_lease_invalid")
    ) {
      throw new CollaborationProblem("lead_lease_invalid");
    }
    if (
      error instanceof Error &&
      error.message.includes("project_checkpoint_context_stale")
    ) {
      throw new CollaborationProblem("work_packet_stale");
    }
    if (
      error instanceof Error &&
      error.message.includes("project_continuity_point_conflict")
    ) {
      throw new CollaborationProblem("continuity_point_conflict");
    }
    const racedReceipt = await readCheckpointReceipt(db, {
      authorityKey: checkpointAuthorityKey,
      idempotencyKeySha256,
    });
    if (
      racedReceipt !== null &&
      racedReceipt.requestSha256 === checkpointRequestSha256
    ) {
      const racedPoint = await readContinuityPointByReceipt(
        db,
        storage,
        racedReceipt,
      );
      return {
        continuityPoint: racedPoint.point,
        receipt: publicReceipt(racedReceipt),
      };
    }
    const currentLease = await readProjectLeadLease(
      db,
      request.projectId,
      input.now,
    );
    if (
      currentLease === null ||
      currentLease.lease.status !== "active" ||
      currentLease.lease.leaseId !== request.leaseId ||
      currentLease.lease.fencingToken !== request.fencingToken ||
      currentLease.holderGrantId !== grant.grantId ||
      currentLease.holderClientId !== grant.oauthClientId
    ) {
      throw new CollaborationProblem("lead_lease_invalid");
    }
    const currentPoint = await readLatestContinuityPoint(
      db,
      storage,
      request.projectId,
    );
    if (
      (currentPoint?.point.continuityPointId ?? null) !==
      request.previousContinuityPointId
    ) {
      throw new CollaborationProblem("continuity_point_conflict");
    }
    throw new CollaborationProblem("portable_identity_collision");
  }
  await touchCollaborationGrant(db, grant.grantId, input.now);
  return { continuityPoint: point, receipt: publicReceipt(storedReceipt) };
}

async function readContinuityPointByReceipt(
  db: D1Database,
  storage: R2Bucket,
  receipt: StoredCheckpointReceipt,
): Promise<StoredContinuityPoint> {
  const point = await readContinuityPoint(
    db,
    storage,
    receipt.continuityPointId,
  );
  if (
    point === null ||
    point.contentSha256 !== receipt.contentSha256 ||
    point.point.project.projectId !== receipt.projectId
  ) {
    throw new CollaborationProblem("integrity_mismatch");
  }
  return point;
}

export async function getAuthorizedLatestContinuityPoint(
  db: D1Database,
  storage: R2Bucket,
  input: AuthorizedContinuityInput,
): Promise<ContinuityPoint | null> {
  const grant = await authorizeCollaboration(db, storage, input.authorization, {
    now: input.now,
    projectId: input.projectId,
    requiredScope: "project.read",
  });
  const stored = await readLatestContinuityPoint(db, storage, input.projectId);
  await touchCollaborationGrant(db, grant.grantId, input.now);
  return stored?.point ?? null;
}

export async function buildPortableContinuityBundle(
  db: D1Database,
  storage: R2Bucket,
  projectId: string,
): Promise<PortableContinuityBundle> {
  const stored = await readLatestContinuityPoint(db, storage, projectId);
  if (stored === null) {
    throw new CollaborationProblem("record_not_visible");
  }
  const pointText = canonicalizeCollaborationJson(stored.point);
  const elasticRows = await db
    .prepare(
      `SELECT elastic_record_id, record_type, portable_object_id,
        content_sha256, byte_length
       FROM project_elastic_records WHERE project_id = ?
       ORDER BY received_at, elastic_record_id LIMIT 5001`,
    )
    .bind(projectId)
    .all<{
      byte_length: number;
      content_sha256: string;
      elastic_record_id: string;
      portable_object_id: string;
      record_type:
        | "account"
        | "budget"
        | "budget-entry"
        | "delta"
        | "observation"
        | "orca"
        | "plane"
        | "recovery";
    }>();
  if (elasticRows.results.length > 5_000) {
    throw new CollaborationProblem("submission_too_large");
  }
  const elasticRecords: Array<
    (typeof elasticRows.results)[number] & {
      record: NonNullable<
        Awaited<ReturnType<typeof readElasticOperationRecord>>
      >;
    }
  > = [];
  for (let offset = 0; offset < elasticRows.results.length; offset += 16) {
    const rows = elasticRows.results.slice(offset, offset + 16);
    const records = await Promise.all(
      rows.map((row) =>
        readElasticOperationRecord(db, storage, row.elastic_record_id),
      ),
    );
    for (const [index, row] of rows.entries()) {
      const record = records[index];
      if (record === null || record === undefined)
        throw new CollaborationProblem("integrity_mismatch");
      elasticRecords.push({ ...row, record });
    }
  }
  const elasticExport = elasticPortableExportSchema.parse({
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    format: "owd-elastic-record-export-v1",
    projectId,
    records: elasticRecords.map((row) => ({
      byteLength: row.byte_length,
      contentSha256: row.content_sha256,
      elasticRecordId: row.elastic_record_id,
      portableObjectId: row.portable_object_id,
      record: row.record,
      recordType: row.record_type,
    })),
    schemaVersion: 1,
  });
  const elasticText = canonicalizeCollaborationJson(elasticExport);
  if (elasticText.length > 4 * 1024 * 1024) {
    throw new CollaborationProblem("submission_too_large");
  }
  const readme = `# MDevolved Project Continuity\n\nThis provider-neutral bundle contains the latest acknowledged Continuity Point for Project ${stored.point.project.projectId}${elasticRecords.length === 0 ? "." : ` and ${elasticRecords.length} inert elastic continuity record${elasticRecords.length === 1 ? "" : "s"} in elastic-records.json.`} It contains no live grant, lease, credential, transcript, hidden reasoning, terminal history, or runtime state. Reauthorize the target client independently before resuming work.\n`;
  return portableContinuityBundleSchema.parse({
    continuityPointId: stored.point.continuityPointId,
    files: [
      {
        contentSha256: await sha256Hex(readme),
        mediaType: "text/markdown",
        path: "README.md",
        text: readme,
      },
      {
        contentSha256: await sha256Hex(pointText),
        mediaType: "application/json",
        path: "continuity-point.json",
        text: pointText,
      },
      ...(elasticRecords.length === 0
        ? []
        : [
            {
              contentSha256: await sha256Hex(elasticText),
              mediaType: "application/json" as const,
              path: "elastic-records.json",
              text: elasticText,
            },
          ]),
    ],
    format: OWD_PORTABLE_CONTINUITY_BUNDLE_FORMAT,
    projectId,
    schemaVersion: 1,
  });
}
