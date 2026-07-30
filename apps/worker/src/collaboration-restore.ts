import {
  canonicalizeCollaborationJson,
  collaborationDurableRecordSchema,
  collaborationRestoreCreateRequestSchema,
  collaborationRestoreItemRequestSchema,
  collaborationRestoreJobSchema,
  collaborationRestoreResultSchema,
  ownerEventSchema,
  provenanceEdgeSchema,
  snapshotIntelligenceManifestSchema,
  type CollaborationRestoreJob,
  type CollaborationRestoreResult,
  type SnapshotIntelligenceManifest,
} from "@owd/contracts";
import { CollaborationProblem } from "./collaboration-service";
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
import { projectCreationLabelKey } from "./project-initialization-store";
import { decodeBase64Url, sha256HexBytes } from "./security";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
export const MAX_COLLABORATION_RESTORE_MANIFEST_BYTES = 1_750_000;

type RestoreRow = {
  expected_item_count: number;
  id: string;
  manifest_json: string;
  staged_item_count: number;
  status: CollaborationRestoreJob["status"];
};

function manifestItems(manifest: SnapshotIntelligenceManifest) {
  return [
    ...(manifest.approved?.records ?? []),
    ...(manifest.approved?.evidenceObjects ?? []),
    ...(manifest.unvetted?.records ?? []),
    ...(manifest.unvetted?.evidenceObjects ?? []),
  ];
}

function jobFromRow(row: RestoreRow): CollaborationRestoreJob {
  const manifest = snapshotIntelligenceManifestSchema.parse(
    JSON.parse(row.manifest_json) as unknown,
  );
  if (manifest.selection === "none") {
    throw new CollaborationProblem("submission_invalid");
  }
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
  const manifestJson = JSON.stringify(parsed.data.manifest);
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
  const manifest = snapshotIntelligenceManifestSchema.parse(
    JSON.parse(row.manifest_json) as unknown,
  );
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
): StoredCollaborationRecord {
  if (recordType === "owner-event") return ownerEventSchema.parse(value);
  if (recordType === "provenance-edge") {
    return provenanceEdgeSchema.parse(value);
  }
  return collaborationDurableRecordSchema.parse(value);
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
  const manifest = snapshotIntelligenceManifestSchema.parse(
    JSON.parse(row.manifest_json) as unknown,
  );
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
  const evidenceDescriptors = [
    ...(manifest.approved?.evidenceObjects ?? []),
    ...(manifest.unvetted?.evidenceObjects ?? []),
  ];
  const preparedRecords: PreparedCollaborationRecord[] = [];
  const preparedContent: StoredContentObject[] = [];
  try {
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
      const value = JSON.parse(decoder.decode(bytes)) as unknown;
      const record = parseRecord(descriptor.recordType, value);
      if (canonicalizeCollaborationJson(record) !== decoder.decode(bytes)) {
        throw new CollaborationProblem("integrity_mismatch");
      }
      const existing = await db
        .prepare(
          `SELECT id FROM collaboration_records
           WHERE id = ? OR portable_object_id = ? LIMIT 1`,
        )
        .bind(descriptor.recordId, descriptor.portableObjectId)
        .first<{ id: string }>();
      if (existing !== null) {
        throw new CollaborationProblem("portable_identity_collision");
      }
      preparedRecords.push(
        await prepareCollaborationRecord(storage, {
          now,
          portableObjectId: descriptor.portableObjectId,
          record,
          restoredAt: now,
        }),
      );
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
    const projections = projectionStatements(db, preparedRecords);
    statements.push(...projections.statements);
    for (const descriptor of recordDescriptors) {
      for (const dependencyId of descriptor.dependencies) {
        statements.push(
          dependencyStatement(
            db,
            descriptor.recordId,
            dependencyId,
            evidenceIds.has(dependencyId) ? "evidence" : "record",
          ),
        );
        if (evidenceIds.has(dependencyId)) {
          statements.push(
            recordContentStatement(db, descriptor.recordId, dependencyId),
          );
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
        await storage.delete(stagedRows.results.map((item) => item.object_key));
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
    unvettedQuarantinedCount: manifest.unvetted?.recordCount ?? 0,
  });
}
