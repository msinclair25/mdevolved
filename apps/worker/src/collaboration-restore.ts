import {
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  compoundingRecordBodySchema,
  collaborationDurableRecordSchema,
  continuityPointSchema,
  collaborationRestoreCreateRequestSchema,
  collaborationRestoreItemRequestSchema,
  collaborationRestoreJobSchema,
  collaborationRestoreResultSchema,
  MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS,
  ownerEventSchema,
  provenanceEdgeSchema,
  snapshotIntelligenceManifestSchema,
  type CollaborationRestoreJob,
  type CollaborationRestoreResult,
  type CollaborationRestoreVaultMapping,
  type ElasticOperationRecord,
  type LeadOperationRecord,
  type PolicyOperationalRecord,
  type SnapshotIntelligenceManifest,
  type ContinuityPoint,
  workingProfileRecordBodySchema,
  workingProfileRecordTypeSchema,
  leadOperationRecordSchema,
  elasticOperationRecordSchema,
  policyOperationalRecordSchema,
} from "@mdevolved/contracts";
import { CollaborationProblem } from "./collaboration-service";
import {
  insertQuarantinedElasticOperationRecordStatement,
  prepareElasticOperationRecord,
  type PreparedElasticOperationRecord,
} from "./elastic-operation-store";
import {
  insertContentObjectStatement,
  insertRecordStatement,
  insertStateStatement,
  prepareCollaborationRecord,
  prepareContentObject,
  type PreparedCollaborationRecord,
  type StoredCollaborationRecord,
  type StoredContentObject,
} from "./collaboration-store";
import {
  insertContinuityDependencyStatement,
  insertContinuityPointStatement,
  prepareContinuityPoint,
  type PreparedContinuityPoint,
} from "./continuity-store";
import {
  insertQuarantinedLeadOperationRecordStatement,
  prepareLeadOperationRecord,
  type PreparedLeadOperationRecord,
} from "./lead-operation-store";
import {
  insertQuarantinedPolicyOperationalRecordStatement,
  insertOperationalDependencyStatement,
  preparePolicyOperationalRecord,
  type PreparedPolicyOperationalRecord,
} from "./policy-operation-store";
import { projectContextSelectorSha256 } from "./project-context-policy";
import { projectCreationLabelKey } from "./project-initialization-store";
import { decodeBase64Url, sha256Hex, sha256HexBytes } from "./security";
import {
  canonicalWorkingProfileBody,
  putImmutableWorkingProfileBody,
  type WorkingProfileRecord,
} from "./working-profile-store";
import { putImmutableCompoundingBody } from "./compounding-store";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const R2_DELETE_BATCH_SIZE = 1_000;
export const MAX_COLLABORATION_RESTORE_MANIFEST_BYTES = 1_750_000;

/**
 * A working-profile restore writes one durable body for each inventory item.
 * In a fresh-cell restore that is three R2 subrequests per item (read staged
 * body, inspect the destination key, and put the immutable body), plus one
 * bounded cleanup delete. Fourteen items therefore remain below the 50
 * subrequest floor for Community Workers, with room for the request's other
 * R2 work. Larger manifests need a resumable restore worker and are rejected
 * before a restore job or staging object is created.
 *
 * The imported shared contract constant is also advertised by the additive
 * agent-memory capability resource.
 */
type RestoreRow = {
  expected_item_count: number;
  id: string;
  manifest_json: string;
  staged_item_count: number;
  status: CollaborationRestoreJob["status"];
};

type CollaborationRestorePayload = {
  manifest: SnapshotIntelligenceManifest;
  vaultMappings: CollaborationRestoreVaultMapping[];
};

async function deleteR2Keys(storage: R2Bucket, keys: string[]): Promise<void> {
  for (let index = 0; index < keys.length; index += R2_DELETE_BATCH_SIZE) {
    await storage.delete(keys.slice(index, index + R2_DELETE_BATCH_SIZE));
  }
}

function manifestItems(manifest: SnapshotIntelligenceManifest) {
  return [
    ...(manifest.approved?.records ?? []),
    ...(manifest.approved?.evidenceObjects ?? []),
    ...(manifest.unvetted?.records ?? []),
    ...(manifest.unvetted?.evidenceObjects ?? []),
    ...(manifest.workingProfile?.records ?? []),
    ...(manifest.compounding?.records ?? []),
  ];
}

function validateRestoreOperationBudget(
  manifest: SnapshotIntelligenceManifest,
): void {
  if (
    (manifest.workingProfile === undefined ||
      manifest.workingProfile.records.length === 0) &&
    (manifest.compounding === undefined ||
      manifest.compounding.records.length === 0)
  ) {
    return;
  }
  if (manifestItems(manifest).length > MAX_SAFE_WORKING_PROFILE_RESTORE_ITEMS) {
    throw new CollaborationProblem("submission_too_large");
  }
}

function payloadFromRow(row: RestoreRow): CollaborationRestorePayload {
  let raw: unknown;
  try {
    raw = JSON.parse(row.manifest_json) as unknown;
  } catch {
    throw new CollaborationProblem("submission_invalid");
  }
  const payload = collaborationRestoreCreateRequestSchema.safeParse(raw);
  if (payload.success) return payload.data;
  const legacyManifest = snapshotIntelligenceManifestSchema.safeParse(raw);
  if (
    !legacyManifest.success ||
    (legacyManifest.data.selection === "none" &&
      legacyManifest.data.workingProfile === undefined)
  ) {
    throw new CollaborationProblem("submission_invalid");
  }
  return { manifest: legacyManifest.data, vaultMappings: [] };
}

function jobFromRow(row: RestoreRow): CollaborationRestoreJob {
  const { manifest } = payloadFromRow(row);
  return collaborationRestoreJobSchema.parse({
    expectedItemCount: row.expected_item_count,
    restoreId: row.id,
    selection: manifest.selection,
    stagedItemCount: row.staged_item_count,
    status: row.status,
  });
}

async function readRestore(
  db: D1Database,
  restoreId: string,
): Promise<RestoreRow | null> {
  return db
    .prepare(
      `SELECT id, status, manifest_json, expected_item_count, staged_item_count
       FROM collaboration_restore_jobs WHERE id = ?`,
    )
    .bind(restoreId)
    .first<RestoreRow>();
}

export async function createCollaborationRestore(
  db: D1Database,
  rawRequest: unknown,
  now: number,
): Promise<CollaborationRestoreJob> {
  const parsed = collaborationRestoreCreateRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new CollaborationProblem("submission_invalid");
  validateRestoreOperationBudget(parsed.data.manifest);
  const manifestJson = JSON.stringify(parsed.data);
  if (
    encoder.encode(manifestJson).byteLength >
    MAX_COLLABORATION_RESTORE_MANIFEST_BYTES
  ) {
    throw new CollaborationProblem("submission_too_large");
  }
  const items = manifestItems(parsed.data.manifest);
  const restoreId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO collaboration_restore_jobs (
        id, status, manifest_json, expected_item_count, created_at
      ) VALUES (?, 'staging', ?, ?, ?)`,
    )
    .bind(restoreId, manifestJson, items.length, now)
    .run();
  const row = await readRestore(db, restoreId);
  if (row === null) throw new CollaborationProblem("submission_invalid");
  return jobFromRow(row);
}

export async function stageCollaborationRestoreItem(
  db: D1Database,
  storage: R2Bucket,
  restoreId: string,
  rawRequest: unknown,
): Promise<CollaborationRestoreJob> {
  const parsed = collaborationRestoreItemRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new CollaborationProblem("submission_invalid");
  const row = await readRestore(db, restoreId);
  if (row === null || !["staging", "preview"].includes(row.status)) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  const { manifest } = payloadFromRow(row);
  const descriptor = manifestItems(manifest).find(
    (item) => item.portableObjectId === parsed.data.portableObjectId,
  );
  if (descriptor === undefined) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  const bytes = decodeBase64Url(parsed.data.bytesBase64Url);
  if (
    bytes.byteLength !== descriptor.byteLength ||
    (await sha256HexBytes(bytes)) !== descriptor.contentSha256
  ) {
    throw new CollaborationProblem("integrity_mismatch");
  }
  const objectKey =
    `collaboration/restores/${restoreId}/` + `${descriptor.portableObjectId}`;
  const existing = await storage.head(objectKey);
  if (existing === null) {
    const written = await storage.put(objectKey, bytes, {
      customMetadata: { sha256: descriptor.contentSha256 },
      httpMetadata: {
        cacheControl: "private, no-store",
        contentType: "application/octet-stream",
      },
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: descriptor.contentSha256,
    });
    if (written === null || written.size !== bytes.byteLength) {
      throw new CollaborationProblem("integrity_mismatch");
    }
  } else if (
    existing.size !== bytes.byteLength ||
    existing.customMetadata?.sha256 !== descriptor.contentSha256
  ) {
    throw new CollaborationProblem("portable_identity_collision");
  }
  await db
    .prepare(
      `INSERT INTO collaboration_restore_items (
        restore_id, item_id, portable_object_id, object_key,
        content_sha256, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (restore_id, item_id) DO NOTHING`,
    )
    .bind(
      restoreId,
      "recordId" in descriptor
        ? descriptor.recordId
        : descriptor.evidenceObjectId,
      descriptor.portableObjectId,
      objectKey,
      descriptor.contentSha256,
      descriptor.byteLength,
    )
    .run();
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM collaboration_restore_items
       WHERE restore_id = ?`,
    )
    .bind(restoreId)
    .first<{ count: number }>();
  const stagedItemCount = count?.count ?? 0;
  await db
    .prepare(
      `UPDATE collaboration_restore_jobs
       SET staged_item_count = ?,
         status = CASE WHEN ? = expected_item_count THEN 'preview'
           ELSE 'staging' END
       WHERE id = ? AND status IN ('staging', 'preview')`,
    )
    .bind(stagedItemCount, stagedItemCount, restoreId)
    .run();
  const updated = await readRestore(db, restoreId);
  if (updated === null) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  return jobFromRow(updated);
}

function parseRecord(
  recordType: string,
  value: unknown,
):
  | StoredCollaborationRecord
  | ContinuityPoint
  | LeadOperationRecord
  | ElasticOperationRecord
  | PolicyOperationalRecord {
  if (recordType === "continuity-point") {
    return continuityPointSchema.parse(value);
  }
  if (
    recordType === "policy" ||
    recordType === "run" ||
    recordType === "actor" ||
    recordType === "event-bundle" ||
    recordType === "exception"
  ) {
    return leadOperationRecordSchema.parse(value);
  }
  if (
    recordType === "elastic-plane" ||
    recordType === "elastic-account" ||
    recordType === "actor-recovery" ||
    recordType === "run-delta" ||
    recordType === "run-budget" ||
    recordType === "budget-entry" ||
    recordType === "run-observation" ||
    recordType === "orca-projection"
  ) {
    return elasticOperationRecordSchema.parse(value);
  }
  if (
    recordType === "policy-binding" ||
    recordType === "policy-decision" ||
    recordType === "schedule" ||
    recordType === "evidence" ||
    recordType === "continuity-receipt"
  ) {
    return policyOperationalRecordSchema.parse(value);
  }
  if (recordType === "owner-event") return ownerEventSchema.parse(value);
  if (recordType === "provenance-edge") {
    return provenanceEdgeSchema.parse(value);
  }
  return collaborationDurableRecordSchema.parse(value);
}

function isLeadOperationRecord(
  record:
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord,
): record is LeadOperationRecord {
  return leadOperationRecordSchema.safeParse(record).success;
}

function isElasticOperationRecord(
  record:
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord,
): record is ElasticOperationRecord {
  return elasticOperationRecordSchema.safeParse(record).success;
}

function isPolicyOperationalRecord(
  record:
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord,
): record is PolicyOperationalRecord {
  return policyOperationalRecordSchema.safeParse(record).success;
}

function recordProjectId(
  record:
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord,
): string | null {
  if ("recordType" in record) {
    if (record.recordType === "continuity-point") {
      return record.project.projectId;
    }
    return "projectId" in record && typeof record.projectId === "string"
      ? record.projectId
      : null;
  }
  return record.projectId;
}

async function activeVaultMappings(
  db: D1Database,
  mappings: CollaborationRestoreVaultMapping[],
): Promise<Map<string, string>> {
  if (mappings.length === 0) return new Map();
  const targetIds = mappings.map((mapping) => mapping.targetVaultId);
  const active = await db
    .prepare(
      `SELECT id FROM vaults
       WHERE status = 'active'
         AND id IN (SELECT value FROM json_each(?) WHERE type = 'text')`,
    )
    .bind(JSON.stringify(targetIds))
    .all<{ id: string }>();
  if (active.results.length !== targetIds.length) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  return new Map(
    mappings.map((mapping) => [mapping.sourceVaultId, mapping.targetVaultId]),
  );
}

function requireCompleteVaultMappingCoverage(
  records: Array<
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord
  >,
  mappings: Map<string, string>,
): void {
  if (mappings.size === 0) return;
  const referencedSourceVaultIds = new Set<string>();
  for (const record of records) {
    if (
      isLeadOperationRecord(record) ||
      isElasticOperationRecord(record) ||
      isPolicyOperationalRecord(record)
    )
      continue;
    if (record.recordType === "knowledge-space-version") {
      for (const member of record.members) {
        referencedSourceVaultIds.add(member.vaultId);
      }
    } else if (record.recordType === "work-packet") {
      for (const citation of record.sourceCitations) {
        referencedSourceVaultIds.add(citation.vaultId);
      }
    }
  }
  if (
    mappings.size !== referencedSourceVaultIds.size ||
    [...referencedSourceVaultIds].some(
      (sourceVaultId) => !mappings.has(sourceVaultId),
    )
  ) {
    throw new CollaborationProblem("project_reference_invalid");
  }
}

async function remapActiveProjectVaultReferences(
  record:
    | StoredCollaborationRecord
    | ContinuityPoint
    | LeadOperationRecord
    | ElasticOperationRecord
    | PolicyOperationalRecord,
  mappings: Map<string, string>,
): Promise<
  | StoredCollaborationRecord
  | ContinuityPoint
  | LeadOperationRecord
  | ElasticOperationRecord
  | PolicyOperationalRecord
> {
  if (
    mappings.size === 0 ||
    isLeadOperationRecord(record) ||
    isElasticOperationRecord(record) ||
    isPolicyOperationalRecord(record) ||
    record.recordType === "continuity-point"
  ) {
    return record;
  }
  if (record.recordType === "knowledge-space-version") {
    const members = record.members.map((member) => ({
      ...member,
      vaultId: mappings.get(member.vaultId) ?? member.vaultId,
    }));
    if (
      members.every(
        (member, index) => member.vaultId === record.members[index]?.vaultId,
      )
    ) {
      return record;
    }
    return collaborationDurableRecordSchema.parse({
      ...record,
      members,
      selectorSha256: await projectContextSelectorSha256(members),
    });
  }
  if (record.recordType === "work-packet") {
    const sourceCitations = record.sourceCitations.map((citation) => ({
      ...citation,
      vaultId: mappings.get(citation.vaultId) ?? citation.vaultId,
    }));
    if (
      sourceCitations.every(
        (citation, index) =>
          citation.vaultId === record.sourceCitations[index]?.vaultId,
      )
    ) {
      return record;
    }
    const pending = {
      ...record,
      integrity: { ...record.integrity, digest: "0".repeat(64) },
      sourceCitations,
    };
    return collaborationDurableRecordSchema.parse({
      ...pending,
      integrity: {
        ...pending.integrity,
        digest: await sha256Hex(
          canonicalizeIntegrityPayload(
            pending as typeof pending & Record<string, unknown>,
          ),
        ),
      },
    });
  }
  return record;
}

function orderContinuityPoints(
  records: PreparedContinuityPoint[],
): PreparedContinuityPoint[] {
  const pending = new Map(
    records.map((record) => [record.point.continuityPointId, record]),
  );
  for (const record of pending.values()) {
    const previousId = record.point.previousContinuityPointId;
    if (previousId === null) continue;
    const previous = pending.get(previousId);
    if (
      previous === undefined ||
      previous.point.project.projectId !== record.point.project.projectId
    ) {
      throw new CollaborationProblem("snapshot_dependency_missing");
    }
  }
  const ordered: PreparedContinuityPoint[] = [];
  const restored = new Set<string>();
  while (pending.size > 0) {
    const next = [...pending.values()].find(
      (record) =>
        record.point.previousContinuityPointId === null ||
        restored.has(record.point.previousContinuityPointId),
    );
    if (next === undefined) {
      throw new CollaborationProblem("snapshot_dependency_missing");
    }
    pending.delete(next.point.continuityPointId);
    restored.add(next.point.continuityPointId);
    ordered.push(next);
  }
  return ordered;
}

function dependencyStatement(
  db: D1Database,
  recordId: string,
  dependencyId: string,
  kind: "evidence" | "record",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collaboration_dependencies (
        record_id, dependency_id, dependency_kind
      ) VALUES (?, ?, ?)`,
    )
    .bind(recordId, dependencyId, kind);
}

function recordContentStatement(
  db: D1Database,
  recordId: string,
  contentObjectId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collaboration_record_content (
        record_id, content_object_id
      ) VALUES (?, ?)`,
    )
    .bind(recordId, contentObjectId);
}

type RestoredProjectCreationCommit = {
  createdAt: number;
  packetId: string;
  projectId: string;
  projectLabelKey: string;
  vaultId: string;
  workItemId: string;
};

function restoredProjectCreationCommitStatement(
  db: D1Database,
  rows: RestoredProjectCreationCommit[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO project_creation_commits (
        vault_id, project_label_key, creation_payload_sha256,
        project_id, work_item_id, packet_id, created_at
      )
      SELECT
        json_extract(item.value, '$.vaultId'),
        json_extract(item.value, '$.projectLabelKey'),
        NULL,
        json_extract(item.value, '$.projectId'),
        json_extract(item.value, '$.workItemId'),
        json_extract(item.value, '$.packetId'),
        json_extract(item.value, '$.createdAt')
      FROM json_each(?) AS item
      ORDER BY
        json_extract(item.value, '$.vaultId'),
        json_extract(item.value, '$.projectLabelKey')`,
    )
    .bind(JSON.stringify(rows));
}

async function restoredProjectCreationIdentityExists(
  db: D1Database,
  rows: RestoredProjectCreationCommit[],
): Promise<boolean> {
  if (rows.length === 0) return false;
  const existing = await db
    .prepare(
      `SELECT 1 AS found
       FROM project_creation_commits commits
       JOIN json_each(?) item
         ON commits.vault_id = json_extract(item.value, '$.vaultId')
        AND commits.project_label_key =
          json_extract(item.value, '$.projectLabelKey')
       LIMIT 1`,
    )
    .bind(JSON.stringify(rows))
    .first<{ found: number }>();
  return existing !== null;
}

function projectionStatements(
  db: D1Database,
  records: PreparedCollaborationRecord[],
): {
  creationCommits: RestoredProjectCreationCommit[];
  statements: D1PreparedStatement[];
} {
  const values = records.map((record) => record.record);
  const knowledgeSpaceVersions = values.filter(
    (value) => value.recordType === "knowledge-space-version",
  );
  const projectVersions = values
    .filter((value) => value.recordType === "project-version")
    .sort((left, right) => left.version - right.version);
  const workPackets = values.filter(
    (value) => value.recordType === "work-packet",
  );
  const workItemVersions = values
    .filter((value) => value.recordType === "work-item-version")
    .sort((left, right) => left.version - right.version);
  const statements: D1PreparedStatement[] = [];
  const creationCommits: RestoredProjectCreationCommit[] = [];
  const creationIdentityKeys = new Set<string>();
  for (const project of values.filter(
    (value) => value.recordType === "project",
  )) {
    const version = projectVersions
      .filter((candidate) => candidate.projectId === project.projectId)
      .at(-1);
    if (version === undefined) continue;
    const knowledgeSpaceVersion = knowledgeSpaceVersions.find(
      (candidate) =>
        candidate.knowledgeSpaceVersionId === version.knowledgeSpaceVersionId,
    );
    const projectPackets = workPackets
      .filter((candidate) => candidate.projectId === project.projectId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.packetId.localeCompare(right.packetId),
      );
    const activePackets = projectPackets.filter(
      (candidate) =>
        candidate.projectVersionId === version.projectVersionId &&
        candidate.knowledgeSpaceVersionId === version.knowledgeSpaceVersionId,
    );
    const packet = (
      activePackets.length > 0 ? activePackets : projectPackets
    ).at(-1);
    if (knowledgeSpaceVersion === undefined || packet === undefined) {
      throw new CollaborationProblem("snapshot_dependency_missing");
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO collaboration_projects (
            project_id, active_project_version_id,
            active_knowledge_space_version_id, label, objective,
            status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .bind(
          project.projectId,
          version.projectVersionId,
          version.knowledgeSpaceVersionId,
          project.initialLabel,
          version.objective,
          project.createdAt,
        ),
    );
    for (const member of knowledgeSpaceVersion.members) {
      const creationCommit = {
        createdAt: project.createdAt,
        packetId: packet.packetId,
        projectId: project.projectId,
        projectLabelKey: projectCreationLabelKey(project.initialLabel),
        vaultId: member.vaultId,
        workItemId: packet.workItemId,
      };
      const identityKey = canonicalizeCollaborationJson([
        creationCommit.vaultId,
        creationCommit.projectLabelKey,
      ]);
      if (creationIdentityKeys.has(identityKey)) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      creationIdentityKeys.add(identityKey);
      creationCommits.push(creationCommit);
    }
  }
  for (const workItem of values.filter(
    (value) => value.recordType === "work-item",
  )) {
    const version = workItemVersions
      .filter((candidate) => candidate.workItemId === workItem.workItemId)
      .at(-1);
    if (version === undefined) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO collaboration_work_items (
            work_item_id, project_id, active_work_item_version_id,
            status, created_at
          ) VALUES (?, ?, ?, 'open', ?)`,
        )
        .bind(
          workItem.workItemId,
          workItem.projectId,
          version.workItemVersionId,
          workItem.createdAt,
        ),
    );
  }
  for (const event of values.filter(
    (value) => value.recordType === "owner-event",
  )) {
    statements.push(
      db
        .prepare(
          `INSERT INTO collaboration_owner_events (
            event_id, project_id, event_type, target_record_id,
            replacement_record_id, work_item_id, project_version_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.eventId,
          event.projectId,
          event.eventType,
          "target" in event ? event.target.recordId : null,
          "replacement" in event ? event.replacement.recordId : null,
          "workItemId" in event ? event.workItemId : null,
          "projectVersionId" in event ? event.projectVersionId : null,
          event.createdAt,
        ),
    );
  }
  for (const edge of values.filter(
    (value) => value.recordType === "provenance-edge",
  )) {
    statements.push(
      db
        .prepare(
          `INSERT INTO collaboration_provenance_edges (
            edge_id, project_id, relation, subject_id, subject_type,
            subject_class, object_id, object_type, object_class, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          edge.edgeId,
          edge.projectId,
          edge.relation,
          edge.subject.id,
          edge.subject.recordType,
          edge.subject.provClass,
          edge.object.id,
          edge.object.recordType,
          edge.object.provClass,
          edge.createdAt,
        ),
    );
  }
  if (creationCommits.length > 0) {
    statements.push(
      restoredProjectCreationCommitStatement(db, creationCommits),
    );
  }
  return { creationCommits, statements };
}

export async function applyCollaborationRestore(
  db: D1Database,
  storage: R2Bucket,
  restoreId: string,
  now: number,
): Promise<CollaborationRestoreResult> {
  const row = await readRestore(db, restoreId);
  if (
    row === null ||
    row.status !== "preview" ||
    row.staged_item_count !== row.expected_item_count
  ) {
    throw new CollaborationProblem("project_reference_invalid");
  }
  const { manifest, vaultMappings } = payloadFromRow(row);
  // Recheck the bound for jobs created by an older Worker before reading or
  // writing any staged content. This keeps an old oversized job from turning
  // into a partial authority-affecting restore after an upgrade.
  validateRestoreOperationBudget(manifest);
  const stagedRows = await db
    .prepare(
      `SELECT item_id, portable_object_id, object_key, content_sha256,
        byte_length
       FROM collaboration_restore_items WHERE restore_id = ?`,
    )
    .bind(restoreId)
    .all<{
      byte_length: number;
      content_sha256: string;
      item_id: string;
      object_key: string;
      portable_object_id: string;
    }>();
  const staged = new Map(
    stagedRows.results.map((item) => [item.portable_object_id, item]),
  );
  const recordDescriptors = [
    ...(manifest.approved?.records ?? []),
    ...(manifest.unvetted?.records ?? []),
  ];
  const compoundingDescriptors = manifest.compounding?.records ?? [];
  const profileDescriptors = manifest.workingProfile?.records ?? [];
  const evidenceDescriptors = [
    ...(manifest.approved?.evidenceObjects ?? []),
    ...(manifest.unvetted?.evidenceObjects ?? []),
  ];
  const preparedRecords: PreparedCollaborationRecord[] = [];
  const preparedContinuityPoints: PreparedContinuityPoint[] = [];
  const preparedLeadOperationRecords: PreparedLeadOperationRecord[] = [];
  const preparedElasticOperationRecords: PreparedElasticOperationRecord[] = [];
  const preparedPolicyOperationalRecords: PreparedPolicyOperationalRecord[] =
    [];
  const preparedContent: StoredContentObject[] = [];
  const preparedProfileRecords: WorkingProfileRecord[] = [];
  const newProfileObjectKeys: string[] = [];
  const preparedCompoundingRecords: Array<{
    bodyObjectKey: string;
    byteLength: number;
    contentSha256: string;
    createdAt: number;
    draftId: string | null;
    fingerprint: string;
    observationId: string | null;
    portableObjectId: string;
    projectId: string | null;
    recordId: string;
    recordType: (typeof compoundingDescriptors)[number]["recordType"];
  }> = [];
  const newCompoundingObjectKeys: string[] = [];
  try {
    const resolvedVaultMappings = await activeVaultMappings(db, vaultMappings);
    const sourceRecords: Array<{
      descriptor: (typeof recordDescriptors)[number];
      record:
        | StoredCollaborationRecord
        | ContinuityPoint
        | LeadOperationRecord
        | ElasticOperationRecord
        | PolicyOperationalRecord;
    }> = [];
    for (const descriptor of recordDescriptors) {
      const item = staged.get(descriptor.portableObjectId);
      const object =
        item === undefined ? null : await storage.get(item.object_key);
      if (object === null) {
        throw new CollaborationProblem("evidence_unavailable");
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== descriptor.byteLength ||
        (await sha256HexBytes(bytes)) !== descriptor.contentSha256
      ) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const text = decoder.decode(bytes);
      const value = JSON.parse(text) as unknown;
      const sourceRecord = parseRecord(descriptor.recordType, value);
      if (isPolicyOperationalRecord(sourceRecord)) {
        const sourceRecordId =
          sourceRecord.format === "owd-policy-binding-v1"
            ? sourceRecord.bindingId
            : sourceRecord.format === "owd-policy-decision-v1"
              ? sourceRecord.decisionId
              : sourceRecord.format === "owd-operational-schedule-v1"
                ? sourceRecord.scheduleId
                : sourceRecord.format === "owd-operational-evidence-v1"
                  ? sourceRecord.evidenceId
                  : sourceRecord.receiptId;
        if (
          sourceRecordId !== descriptor.recordId ||
          sourceRecord.projectId !== descriptor.projectId
        ) {
          throw new CollaborationProblem("portable_identity_collision");
        }
      }
      if (canonicalizeCollaborationJson(sourceRecord) !== text) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      sourceRecords.push({ descriptor, record: sourceRecord });
    }
    const sourceRecordById = new Map(
      sourceRecords.map(({ descriptor, record }) => [
        descriptor.recordId,
        record,
      ]),
    );
    const profileDescriptorById = new Map(
      profileDescriptors.map((descriptor) => [descriptor.recordId, descriptor]),
    );
    for (const descriptor of profileDescriptors) {
      const item = staged.get(descriptor.portableObjectId);
      const object =
        item === undefined ? null : await storage.get(item.object_key);
      if (object === null)
        throw new CollaborationProblem("evidence_unavailable");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== descriptor.byteLength ||
        (await sha256HexBytes(bytes)) !== descriptor.contentSha256
      ) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const text = decoder.decode(bytes);
      const body = workingProfileRecordBodySchema.parse(
        JSON.parse(text) as unknown,
      );
      if (
        canonicalWorkingProfileBody(body) !== text ||
        body.recordId !== descriptor.recordId ||
        body.type !== descriptor.recordType ||
        ("projectId" in body ? body.projectId : null) !==
          descriptor.projectId ||
        ("preferenceId" in body ? body.preferenceId : null) !==
          descriptor.preferenceId ||
        ("skillId" in body ? body.skillId : null) !== descriptor.skillId
      ) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      const existing = await db
        .prepare(
          `SELECT record_id FROM working_profile_records
           WHERE record_id = ? OR portable_object_id = ? LIMIT 1`,
        )
        .bind(descriptor.recordId, descriptor.portableObjectId)
        .first<{ record_id: string }>();
      if (existing !== null) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      for (const dependencyId of descriptor.dependencies) {
        const dependency = profileDescriptorById.get(dependencyId);
        if (dependency === undefined) {
          throw new CollaborationProblem("snapshot_dependency_missing");
        }
        if (
          descriptor.preferenceId !== null &&
          (dependency.preferenceId !== descriptor.preferenceId ||
            dependency.projectId !== descriptor.projectId)
        ) {
          throw new CollaborationProblem("project_reference_invalid");
        }
        if (
          descriptor.skillId !== null &&
          dependency.skillId !== descriptor.skillId
        ) {
          throw new CollaborationProblem("project_reference_invalid");
        }
        if (
          descriptor.projectId !== null &&
          dependency.projectId !== null &&
          dependency.projectId !== descriptor.projectId
        ) {
          throw new CollaborationProblem("project_reference_invalid");
        }
      }
      if (
        (body.type === "skill-attached" || body.type === "skill-detached") &&
        (!descriptor.dependencies.includes(body.skillVersionRecordId) ||
          profileDescriptorById.get(body.skillVersionRecordId)?.recordType !==
            "skill-version")
      ) {
        throw new CollaborationProblem("snapshot_dependency_missing");
      }
      const storedBody = await putImmutableWorkingProfileBody(
        storage,
        text,
        descriptor.portableObjectId,
      );
      newProfileObjectKeys.push(storedBody.bodyObjectKey);
      preparedProfileRecords.push({
        ...storedBody,
        createdAt: descriptor.createdAt,
        dependencies: descriptor.dependencies,
        portableObjectId: descriptor.portableObjectId,
        preferenceId: descriptor.preferenceId,
        projectId: descriptor.projectId,
        recordId: descriptor.recordId,
        recordType: workingProfileRecordTypeSchema.parse(descriptor.recordType),
        skillId: descriptor.skillId,
      });
    }
    const restoreIdentityIds = new Set([
      ...recordDescriptors.map((descriptor) => descriptor.recordId),
      ...profileDescriptors.map((descriptor) => descriptor.recordId),
      ...compoundingDescriptors.map((descriptor) => descriptor.recordId),
    ]);
    for (const descriptor of compoundingDescriptors) {
      const item = staged.get(descriptor.portableObjectId);
      const object =
        item === undefined ? null : await storage.get(item.object_key);
      if (object === null)
        throw new CollaborationProblem("evidence_unavailable");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== descriptor.byteLength ||
        (await sha256HexBytes(bytes)) !== descriptor.contentSha256
      ) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const text = decoder.decode(bytes);
      const parsedBody = compoundingRecordBodySchema.safeParse(
        JSON.parse(text) as unknown,
      );
      if (
        !parsedBody.success ||
        canonicalizeCollaborationJson(parsedBody.data) !== text
      ) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const body = parsedBody.data;
      if (
        body.recordId !== descriptor.recordId ||
        body.type !== descriptor.recordType
      ) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      if (body.type === "checkpoint-observation") {
        if (
          body.observationId !== descriptor.observationId ||
          body.fingerprint !== descriptor.fingerprint ||
          descriptor.dependencies.length !== 1 ||
          descriptor.dependencies[0] !== body.point.continuityPointId ||
          !restoreIdentityIds.has(body.point.continuityPointId)
        ) {
          throw new CollaborationProblem("snapshot_dependency_missing");
        }
      } else if (
        body.draft.draftId !== descriptor.draftId ||
        body.draft.fingerprint !== descriptor.fingerprint ||
        body.draft.projectId !== descriptor.projectId ||
        descriptor.dependencies.length !==
          new Set(body.draft.evidence.map((item) => item.continuityPointId))
            .size ||
        body.draft.evidence.some(
          (item) =>
            !descriptor.dependencies.includes(item.continuityPointId) ||
            !restoreIdentityIds.has(item.continuityPointId),
        )
      ) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      for (const dependencyId of descriptor.dependencies) {
        if (!restoreIdentityIds.has(dependencyId)) {
          throw new CollaborationProblem("snapshot_dependency_missing");
        }
      }
      const existing = await db
        .prepare(
          `SELECT record_id FROM compounding_records
           WHERE record_id = ? OR portable_object_id = ? LIMIT 1`,
        )
        .bind(descriptor.recordId, descriptor.portableObjectId)
        .first<{ record_id: string }>();
      if (existing !== null) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      const storedBody = await putImmutableCompoundingBody(
        storage,
        text,
        descriptor.recordId,
      );
      newCompoundingObjectKeys.push(storedBody.bodyObjectKey);
      preparedCompoundingRecords.push({
        ...storedBody,
        createdAt: descriptor.createdAt,
        draftId: descriptor.draftId,
        fingerprint: descriptor.fingerprint,
        observationId: descriptor.observationId,
        portableObjectId: descriptor.portableObjectId,
        projectId: descriptor.projectId,
        recordId: descriptor.recordId,
        recordType: descriptor.recordType,
      });
    }
    for (const { descriptor, record } of sourceRecords) {
      for (const dependencyId of descriptor.dependencies) {
        const dependency = sourceRecordById.get(dependencyId);
        const projectId = recordProjectId(record);
        const dependencyProjectId =
          dependency === undefined ? null : recordProjectId(dependency);
        if (
          projectId !== null &&
          dependencyProjectId !== null &&
          dependencyProjectId !== projectId
        ) {
          throw new CollaborationProblem("project_reference_invalid");
        }
      }
    }
    requireCompleteVaultMappingCoverage(
      sourceRecords.map(({ record }) => record),
      resolvedVaultMappings,
    );
    for (const { descriptor, record: sourceRecord } of sourceRecords) {
      const record = await remapActiveProjectVaultReferences(
        sourceRecord,
        resolvedVaultMappings,
      );
      const existing = await db
        .prepare(
          `SELECT id FROM collaboration_records
           WHERE id = ? OR portable_object_id = ?
           UNION ALL
           SELECT continuity_point_id AS id FROM project_continuity_points
           WHERE continuity_point_id = ? OR portable_object_id = ?
           UNION ALL
           SELECT operation_record_id AS id FROM project_operation_records
           WHERE operation_record_id = ? OR portable_object_id = ?
           UNION ALL
           SELECT elastic_record_id AS id FROM project_elastic_records
           WHERE elastic_record_id = ? OR portable_object_id = ?
           UNION ALL
           SELECT operational_record_id AS id FROM project_operational_records
           WHERE operational_record_id = ? OR portable_object_id = ?
           LIMIT 1`,
        )
        .bind(
          descriptor.recordId,
          descriptor.portableObjectId,
          descriptor.recordId,
          descriptor.portableObjectId,
          descriptor.recordId,
          descriptor.portableObjectId,
          descriptor.recordId,
          descriptor.portableObjectId,
          descriptor.recordId,
          descriptor.portableObjectId,
        )
        .first<{ id: string }>();
      if (existing !== null) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      if (isLeadOperationRecord(record)) {
        preparedLeadOperationRecords.push(
          await prepareLeadOperationRecord(storage, {
            now,
            portableObjectId: descriptor.portableObjectId,
            record,
            restoredAt: now,
          }),
        );
      } else if (isElasticOperationRecord(record)) {
        preparedElasticOperationRecords.push(
          await prepareElasticOperationRecord(storage, {
            elasticRecordId: descriptor.recordId,
            now,
            portableObjectId: descriptor.portableObjectId,
            record,
            restoredAt: now,
          }),
        );
      } else if (isPolicyOperationalRecord(record)) {
        preparedPolicyOperationalRecords.push(
          await preparePolicyOperationalRecord(storage, {
            now,
            operationalRecordId: descriptor.recordId,
            portableObjectId: descriptor.portableObjectId,
            record,
            restoredAt: now,
          }),
        );
      } else if (record.recordType === "continuity-point") {
        preparedContinuityPoints.push(
          await prepareContinuityPoint(
            storage,
            record,
            descriptor.portableObjectId,
          ),
        );
      } else {
        preparedRecords.push(
          await prepareCollaborationRecord(storage, {
            now,
            portableObjectId: descriptor.portableObjectId,
            record,
            restoredAt: now,
          }),
        );
      }
    }
    const packetEvidenceIds = new Set(
      recordDescriptors
        .filter((descriptor) => descriptor.recordType === "work-packet")
        .flatMap((descriptor) => descriptor.dependencies),
    );
    const evidenceMediaTypes = new Map<
      string,
      "application/json" | "text/markdown"
    >();
    for (const record of preparedRecords.map((prepared) => prepared.record)) {
      if (record.recordType === "work-packet") {
        for (const evidence of record.evidenceObjects) {
          evidenceMediaTypes.set(evidence.evidenceObjectId, evidence.mediaType);
        }
      }
      if (
        record.recordType === "artifact" &&
        record.content.kind === "stored-object"
      ) {
        const descriptor = recordDescriptors.find(
          (candidate) => candidate.recordId === record.artifactId,
        );
        const contentId = descriptor?.dependencies.find((dependencyId) =>
          evidenceDescriptors.some(
            (evidence) => evidence.evidenceObjectId === dependencyId,
          ),
        );
        if (contentId !== undefined) {
          evidenceMediaTypes.set(contentId, record.content.mediaType);
        }
      }
    }
    for (const descriptor of evidenceDescriptors) {
      const item = staged.get(descriptor.portableObjectId);
      const object =
        item === undefined ? null : await storage.get(item.object_key);
      if (object === null) {
        throw new CollaborationProblem("evidence_unavailable");
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== descriptor.byteLength ||
        (await sha256HexBytes(bytes)) !== descriptor.contentSha256
      ) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const existing = await db
        .prepare(
          `SELECT id FROM collaboration_content_objects
           WHERE id = ? OR portable_object_id = ? LIMIT 1`,
        )
        .bind(descriptor.evidenceObjectId, descriptor.portableObjectId)
        .first<{ id: string }>();
      if (existing !== null) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      preparedContent.push(
        await prepareContentObject(storage, {
          bytes,
          createdAt: now,
          id: descriptor.evidenceObjectId,
          mediaType:
            evidenceMediaTypes.get(descriptor.evidenceObjectId) ??
            "text/markdown",
          objectKind: packetEvidenceIds.has(descriptor.evidenceObjectId)
            ? "packet-evidence"
            : "artifact-content",
          portableObjectId: descriptor.portableObjectId,
          restoredAt: now,
        }),
      );
    }
    const descriptorsById = new Map(
      recordDescriptors.map((descriptor) => [descriptor.recordId, descriptor]),
    );
    const evidenceIds = new Set(
      evidenceDescriptors.map((descriptor) => descriptor.evidenceObjectId),
    );
    const statements: D1PreparedStatement[] = [];
    for (const record of preparedRecords) {
      const descriptor = descriptorsById.get(record.metadata.id);
      if (descriptor === undefined) {
        throw new CollaborationProblem("snapshot_dependency_missing");
      }
      statements.push(
        insertRecordStatement(db, record),
        insertStateStatement(db, {
          changedAt: now,
          disposition:
            descriptor.restoreDisposition === "restore-approved"
              ? "accepted"
              : "quarantined",
          recordId: descriptor.recordId,
          visibility: "owner-only",
        }),
      );
    }
    for (const object of preparedContent) {
      statements.push(insertContentObjectStatement(db, object));
    }
    for (const record of preparedCompoundingRecords) {
      statements.push(
        db
          .prepare(
            `INSERT INTO compounding_records (
              record_id, record_type, portable_object_id, project_id,
              source_project_id, draft_id, observation_id, fingerprint,
              body_object_key, content_sha256, byte_length, created_at,
              restored_at, restore_state, restored_authority_allowed
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'quarantined', 0)`,
          )
          .bind(
            record.recordId,
            record.recordType,
            record.portableObjectId,
            record.projectId,
            record.draftId,
            record.observationId,
            record.fingerprint,
            record.bodyObjectKey,
            record.contentSha256,
            record.byteLength,
            record.createdAt,
            now,
          ),
      );
    }
    const projections = projectionStatements(db, preparedRecords);
    statements.push(...projections.statements);
    for (const record of preparedProfileRecords) {
      statements.push(
        db
          .prepare(
            `INSERT INTO working_profile_records (
              record_id, record_type, portable_object_id, project_id,
              source_project_id,
              preference_id, skill_id, dependencies_json, body_object_key,
              content_sha256, byte_length, created_at, restored_at,
              restore_state, restored_authority_allowed
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', 0)`,
          )
          .bind(
            record.recordId,
            record.recordType,
            record.portableObjectId,
            record.projectId,
            record.preferenceId,
            record.skillId,
            canonicalWorkingProfileBody(record.dependencies),
            record.bodyObjectKey,
            record.contentSha256,
            record.byteLength,
            record.createdAt,
            now,
          ),
      );
    }
    for (const record of preparedLeadOperationRecords) {
      statements.push(
        insertQuarantinedLeadOperationRecordStatement(db, record),
      );
    }
    for (const record of preparedElasticOperationRecords) {
      statements.push(
        insertQuarantinedElasticOperationRecordStatement(db, record),
      );
    }
    for (const record of preparedPolicyOperationalRecords) {
      statements.push(
        insertQuarantinedPolicyOperationalRecordStatement(db, record),
      );
    }
    for (const point of orderContinuityPoints(preparedContinuityPoints)) {
      statements.push(
        insertContinuityPointStatement(db, point, {
          producerClientId: null,
          restoredAt: now,
          sourceLeaseId: null,
        }),
      );
    }
    const operationalRecordIds = new Set(
      recordDescriptors
        .filter((descriptor) =>
          [
            "policy-binding",
            "policy-decision",
            "schedule",
            "evidence",
            "continuity-receipt",
          ].includes(descriptor.recordType),
        )
        .map((descriptor) => descriptor.recordId),
    );
    for (const descriptor of recordDescriptors) {
      if (
        descriptor.recordType === "policy" ||
        descriptor.recordType === "run" ||
        descriptor.recordType === "actor" ||
        descriptor.recordType === "event-bundle" ||
        descriptor.recordType === "exception" ||
        descriptor.recordType === "elastic-plane" ||
        descriptor.recordType === "elastic-account" ||
        descriptor.recordType === "actor-recovery" ||
        descriptor.recordType === "run-delta" ||
        descriptor.recordType === "run-budget" ||
        descriptor.recordType === "budget-entry" ||
        descriptor.recordType === "run-observation" ||
        descriptor.recordType === "orca-projection"
      ) {
        continue;
      }
      const operationalDescriptor = operationalRecordIds.has(
        descriptor.recordId,
      );
      for (const dependencyId of descriptor.dependencies) {
        const kind = evidenceIds.has(dependencyId) ? "evidence" : "record";
        if (operationalDescriptor) {
          statements.push(
            insertOperationalDependencyStatement(db, {
              dependencyId,
              dependencyKind: evidenceIds.has(dependencyId)
                ? "evidence"
                : operationalRecordIds.has(dependencyId)
                  ? "operational"
                  : "record",
              operationalRecordId: descriptor.recordId,
            }),
          );
          continue;
        }
        if (descriptor.recordType === "continuity-point") {
          statements.push(
            insertContinuityDependencyStatement(db, {
              continuityPointId: descriptor.recordId,
              dependencyId,
              dependencyKind: kind,
            }),
          );
        } else {
          statements.push(
            dependencyStatement(db, descriptor.recordId, dependencyId, kind),
          );
          if (kind === "evidence") {
            statements.push(
              recordContentStatement(db, descriptor.recordId, dependencyId),
            );
          }
        }
      }
    }
    statements.push(
      db
        .prepare(
          `UPDATE collaboration_restore_jobs
           SET status = 'applied', confirmed_at = ?, applied_at = ?
           WHERE id = ? AND status = 'preview'`,
        )
        .bind(now, now, restoreId),
    );
    try {
      await db.batch(statements);
    } catch (error) {
      try {
        if (
          await restoredProjectCreationIdentityExists(
            db,
            projections.creationCommits,
          )
        ) {
          throw new CollaborationProblem("portable_identity_collision");
        }
      } catch (probeError) {
        if (probeError instanceof CollaborationProblem) throw probeError;
      }
      throw error;
    }
    try {
      if (stagedRows.results.length > 0) {
        await deleteR2Keys(
          storage,
          stagedRows.results.map((item) => item.object_key),
        );
      }
      await db
        .prepare(`DELETE FROM collaboration_restore_items WHERE restore_id = ?`)
        .bind(restoreId)
        .run();
    } catch {
      // The durable restore is already applied. Retained staging remains
      // inert and is safe for a later reference-aware cleanup pass.
    }
  } catch (error) {
    if (newProfileObjectKeys.length > 0) {
      try {
        for (let index = 0; index < newProfileObjectKeys.length; index += 40) {
          await db.batch(
            newProfileObjectKeys.slice(index, index + 40).map((objectKey) =>
              db
                .prepare(
                  `INSERT OR IGNORE INTO snapshot_gc_objects (
                    object_key, queued_at
                  ) VALUES (?, ?)`,
                )
                .bind(objectKey, now),
            ),
          );
        }
      } catch {
        // Best-effort queueing must not replace the original restore failure.
      }
    }
    if (newCompoundingObjectKeys.length > 0) {
      try {
        for (
          let index = 0;
          index < newCompoundingObjectKeys.length;
          index += 40
        ) {
          await db.batch(
            newCompoundingObjectKeys.slice(index, index + 40).map((objectKey) =>
              db
                .prepare(
                  `INSERT OR IGNORE INTO snapshot_gc_objects (
                    object_key, queued_at
                  ) VALUES (?, ?)`,
                )
                .bind(objectKey, now),
            ),
          );
        }
      } catch {
        // Preserve the original restore failure; cleanup can retry safely.
      }
    }
    await db
      .prepare(
        `UPDATE collaboration_restore_jobs
         SET status = 'failed', failure_code = ?
         WHERE id = ? AND status IN ('staging', 'preview', 'confirmed')`,
      )
      .bind(
        error instanceof CollaborationProblem
          ? error.code
          : "submission_invalid",
        restoreId,
      )
      .run();
    throw error;
  }
  return collaborationRestoreResultSchema.parse({
    approvedRecordCount: manifest.approved?.recordCount ?? 0,
    evidenceObjectCount:
      (manifest.approved?.evidenceObjectCount ?? 0) +
      (manifest.unvetted?.evidenceObjectCount ?? 0),
    grantCount: 0,
    restoreId,
    status: "applied",
    unvettedQuarantinedCount:
      (manifest.unvetted?.recordCount ?? 0) +
      (manifest.compounding?.recordCount ?? 0),
  });
}
