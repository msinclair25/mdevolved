import {
  APPROVED_INTELLIGENCE_CAPABILITY,
  OWD_SNAPSHOT_INTELLIGENCE_FORMAT,
  QUARANTINED_INTELLIGENCE_CAPABILITY,
  snapshotIntelligenceEvidenceSchema,
  snapshotIntelligenceManifestSchema,
  snapshotIntelligenceRecordSchema,
  type SnapshotIntelligenceManifest,
  type SnapshotIntelligenceSummary,
} from "@owd/contracts";

export type IntelligenceSelection =
  "approved" | "approved-and-unvetted" | "none";

type RecordInventoryRow = {
  actor_id?: string | null;
  body_object_key: string;
  byte_length: number;
  content_sha256: string;
  disposition:
    | "accepted"
    | "checkpointed"
    | "pending"
    | "quarantined"
    | "rejected"
    | "superseded";
  id: string;
  portable_object_id: string;
  project_id: string | null;
  record_type: ReturnType<
    typeof snapshotIntelligenceRecordSchema.parse
  >["recordType"];
  schema_version: 1;
  run_id?: string | null;
  visibility: "owner-only" | "private" | "shared";
  work_item_id: string | null;
};

type EvidenceInventoryRow = {
  byte_length: number;
  content_sha256: string;
  id: string;
  object_key: string;
  portable_object_id: string;
};

type PlannedItem = {
  classification: "approved" | "unvetted";
  descriptor:
    | ReturnType<typeof snapshotIntelligenceEvidenceSchema.parse>
    | ReturnType<typeof snapshotIntelligenceRecordSchema.parse>;
  itemId: string;
  itemKind: "evidence" | "record";
  sourceObjectKey: string;
};

type IntelligencePlan = {
  approved: PlannedItem[];
  selection: IntelligenceSelection;
  unvetted: PlannedItem[];
};

export class CollaborationSnapshotError extends Error {
  constructor(
    readonly code:
      | "snapshot_dependency_missing"
      | "snapshot_selection_invalid"
      | "snapshot_identity_collision",
  ) {
    super(code);
    this.name = "CollaborationSnapshotError";
  }
}

async function buildPlan(
  db: D1Database,
  selection: IntelligenceSelection,
): Promise<IntelligencePlan> {
  if (
    selection !== "none" &&
    selection !== "approved" &&
    selection !== "approved-and-unvetted"
  ) {
    throw new CollaborationSnapshotError("snapshot_selection_invalid");
  }
  if (selection === "none") {
    return { approved: [], selection, unvetted: [] };
  }
  const recordRows = await db
    .prepare(
      `SELECT r.id, r.record_type, r.schema_version, r.project_id,
        r.work_item_id, r.portable_object_id, r.body_object_key,
        r.content_sha256, r.byte_length, s.visibility, s.disposition
       FROM collaboration_records r
       JOIN collaboration_record_states s ON s.record_id = r.id`,
    )
    .all<RecordInventoryRow>();
  const operationalRows = await db
    .prepare(
      `SELECT operational_record_id AS id, record_type, 1 AS schema_version,
        project_id, NULL AS work_item_id, run_id, portable_object_id,
        body_object_key, content_sha256, byte_length, 'owner-only' AS visibility,
        CASE WHEN restore_state = 'live' THEN 'accepted'
          ELSE 'quarantined' END AS disposition
       FROM project_operational_records`,
    )
    .all<RecordInventoryRow>();
  const continuityRows = await db
    .prepare(
      `SELECT continuity_point_id AS id, 'continuity-point' AS record_type,
        1 AS schema_version, project_id, work_item_id, portable_object_id,
        body_object_key, content_sha256, byte_length,
        'owner-only' AS visibility, 'checkpointed' AS disposition
       FROM project_continuity_points`,
    )
    .all<RecordInventoryRow>();
  const operationRows = await db
    .prepare(
      `SELECT operation_record_id AS id, record_type, 1 AS schema_version,
        project_id, work_item_id, portable_object_id, body_object_key,
        content_sha256, byte_length, 'owner-only' AS visibility,
        'pending' AS disposition
       FROM project_operation_records`,
    )
    .all<RecordInventoryRow>();
  const elasticRows = await db
    .prepare(
      `SELECT elastic_record_id AS id,
        CASE record_type
          WHEN 'plane' THEN 'elastic-plane'
          WHEN 'account' THEN 'elastic-account'
          WHEN 'recovery' THEN 'actor-recovery'
          WHEN 'delta' THEN 'run-delta'
          WHEN 'budget' THEN 'run-budget'
          WHEN 'budget-entry' THEN 'budget-entry'
          WHEN 'observation' THEN 'run-observation'
          WHEN 'orca' THEN 'orca-projection'
        END AS record_type,
        1 AS schema_version, project_id, NULL AS work_item_id, run_id,
        actor_id, portable_object_id, body_object_key, content_sha256,
        byte_length, 'owner-only' AS visibility,
        'pending' AS disposition
       FROM project_elastic_records`,
    )
    .all<RecordInventoryRow>();
  const allRecordRows = [
    ...recordRows.results,
    ...continuityRows.results,
    ...operationRows.results,
    ...elasticRows.results,
    ...operationalRows.results,
  ];
  const evidenceRows = await db
    .prepare(
      `SELECT id, portable_object_id, object_key, content_sha256, byte_length
       FROM collaboration_content_objects`,
    )
    .all<EvidenceInventoryRow>();
  const dependencyRows = await db
    .prepare(
      `SELECT record_id, dependency_id
       FROM collaboration_dependencies ORDER BY record_id, dependency_id`,
    )
    .all<{ dependency_id: string; record_id: string }>();
  const continuityDependencyRows = await db
    .prepare(
      `SELECT continuity_point_id AS record_id, dependency_id
       FROM continuity_point_dependencies
       ORDER BY continuity_point_id, dependency_id`,
    )
    .all<{ dependency_id: string; record_id: string }>();
  const operationalDependencyRows = await db
    .prepare(
      `SELECT operational_record_id AS record_id, dependency_id
       FROM project_operational_dependencies
       ORDER BY operational_record_id, dependency_id`,
    )
    .all<{ dependency_id: string; record_id: string }>();
  const provenanceRows = await db
    .prepare(
      `SELECT edge_id, subject_id
       FROM collaboration_provenance_edges ORDER BY subject_id, edge_id`,
    )
    .all<{ edge_id: string; subject_id: string }>();
  const records = new Map<string, RecordInventoryRow>();
  const portableObjectIds = new Set<string>();
  for (const row of allRecordRows) {
    if (records.has(row.id) || portableObjectIds.has(row.portable_object_id)) {
      throw new CollaborationSnapshotError("snapshot_identity_collision");
    }
    records.set(row.id, row);
    portableObjectIds.add(row.portable_object_id);
  }
  const evidence = new Map<string, EvidenceInventoryRow>();
  for (const row of evidenceRows.results) {
    if (
      evidence.has(row.id) ||
      records.has(row.id) ||
      portableObjectIds.has(row.portable_object_id)
    ) {
      throw new CollaborationSnapshotError("snapshot_identity_collision");
    }
    evidence.set(row.id, row);
    portableObjectIds.add(row.portable_object_id);
  }
  const dependencies = new Map<string, string[]>();
  for (const row of [
    ...dependencyRows.results,
    ...continuityDependencyRows.results,
    ...operationalDependencyRows.results,
  ]) {
    const values = dependencies.get(row.record_id) ?? [];
    values.push(row.dependency_id);
    dependencies.set(row.record_id, values);
  }
  for (const row of provenanceRows.results) {
    const values = dependencies.get(row.subject_id) ?? [];
    if (!values.includes(row.edge_id)) values.push(row.edge_id);
    dependencies.set(row.subject_id, values);
  }
  for (const row of operationRows.results) {
    const values = dependencies.get(row.id) ?? [];
    for (const dependencyId of [row.project_id, row.work_item_id]) {
      if (
        dependencyId !== null &&
        records.has(dependencyId) &&
        !values.includes(dependencyId)
      ) {
        values.push(dependencyId);
      }
    }
    dependencies.set(row.id, values.sort());
  }
  for (const row of elasticRows.results) {
    const values = dependencies.get(row.id) ?? [];
    for (const dependencyId of [
      row.project_id,
      row.work_item_id,
      row.run_id,
      row.actor_id,
    ]) {
      if (
        dependencyId !== null &&
        dependencyId !== undefined &&
        records.has(dependencyId) &&
        !values.includes(dependencyId)
      ) {
        values.push(dependencyId);
      }
    }
    dependencies.set(row.id, values.sort());
  }

  const approvedRootIds = new Set(
    allRecordRows
      .filter(
        (row) =>
          (row.disposition === "accepted" ||
            (row.record_type === "continuity-point" &&
              row.disposition === "checkpointed")) &&
          row.record_type !== "provenance-edge",
      )
      .map((row) => row.id),
  );
  const approvedRecordIds = new Set<string>();
  const approvedEvidenceIds = new Set<string>();
  const includeClosure = (
    rootId: string,
    targetRecords: Set<string>,
    targetEvidence: Set<string>,
    allowedExisting: Set<string>,
  ): void => {
    const pending = [rootId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (
        id === undefined ||
        targetRecords.has(id) ||
        allowedExisting.has(id)
      ) {
        continue;
      }
      const row = records.get(id);
      if (row === undefined) {
        throw new CollaborationSnapshotError("snapshot_dependency_missing");
      }
      targetRecords.add(id);
      for (const dependencyId of dependencies.get(id) ?? []) {
        if (records.has(dependencyId)) {
          if (
            !targetRecords.has(dependencyId) &&
            !allowedExisting.has(dependencyId)
          ) {
            pending.push(dependencyId);
          }
        } else if (evidence.has(dependencyId)) {
          if (!allowedExisting.has(dependencyId)) {
            targetEvidence.add(dependencyId);
          }
        } else {
          throw new CollaborationSnapshotError("snapshot_dependency_missing");
        }
      }
    }
  };
  for (const id of approvedRootIds) {
    includeClosure(id, approvedRecordIds, approvedEvidenceIds, new Set());
  }

  const unvettedRecordIds = new Set<string>();
  const unvettedEvidenceIds = new Set<string>();
  if (selection === "approved-and-unvetted") {
    const alreadyApproved = new Set([
      ...approvedRecordIds,
      ...approvedEvidenceIds,
    ]);
    for (const row of allRecordRows) {
      if (
        row.disposition !== "accepted" &&
        row.record_type !== "continuity-point"
      ) {
        includeClosure(
          row.id,
          unvettedRecordIds,
          unvettedEvidenceIds,
          alreadyApproved,
        );
      }
    }
  }

  const recordItem = (
    row: RecordInventoryRow,
    classification: "approved" | "unvetted",
  ): PlannedItem => {
    const evidenceOnly =
      classification === "approved" && !approvedRootIds.has(row.id);
    const quarantineOnlyRecord =
      row.record_type === "policy-binding" ||
      row.record_type === "policy-decision" ||
      row.record_type === "schedule" ||
      row.record_type === "evidence" ||
      row.record_type === "continuity-receipt";
    return {
      classification,
      descriptor: snapshotIntelligenceRecordSchema.parse({
        byteLength: row.byte_length,
        classification,
        contentSha256: row.content_sha256,
        dependencies: dependencies.get(row.id) ?? [],
        evidenceOnly,
        originalState: {
          disposition: row.disposition,
          visibility: row.visibility,
        },
        portableObjectId: row.portable_object_id,
        projectId: row.project_id,
        recordId: row.id,
        recordType: row.record_type,
        restoreDisposition:
          classification === "unvetted" || quarantineOnlyRecord
            ? "restore-quarantined"
            : evidenceOnly
              ? "restore-evidence-only"
              : "restore-approved",
        schemaVersion: row.schema_version,
        workItemId: row.work_item_id,
      }),
      itemId: row.id,
      itemKind: "record",
      sourceObjectKey: row.body_object_key,
    };
  };
  const evidenceItem = (
    row: EvidenceInventoryRow,
    classification: "approved" | "unvetted",
  ): PlannedItem => ({
    classification,
    descriptor: snapshotIntelligenceEvidenceSchema.parse({
      byteLength: row.byte_length,
      classification,
      contentSha256: row.content_sha256,
      evidenceObjectId: row.id,
      portableObjectId: row.portable_object_id,
      restoreDisposition:
        classification === "approved"
          ? "restore-evidence-only"
          : "restore-quarantined",
    }),
    itemId: row.id,
    itemKind: "evidence",
    sourceObjectKey: row.object_key,
  });
  const planned = (
    recordIds: Set<string>,
    evidenceIds: Set<string>,
    classification: "approved" | "unvetted",
  ): PlannedItem[] => [
    ...[...recordIds]
      .sort()
      .map((id) => recordItem(records.get(id)!, classification)),
    ...[...evidenceIds]
      .sort()
      .map((id) => evidenceItem(evidence.get(id)!, classification)),
  ];
  return {
    approved: planned(approvedRecordIds, approvedEvidenceIds, "approved"),
    selection,
    unvetted: planned(unvettedRecordIds, unvettedEvidenceIds, "unvetted"),
  };
}

function sectionSummary(items: PlannedItem[]) {
  const records = items.filter((item) => item.itemKind === "record");
  const evidence = items.filter((item) => item.itemKind === "evidence");
  const logicalBytes = items.reduce(
    (total, item) => total + item.descriptor.byteLength,
    0,
  );
  return {
    evidenceObjectCount: evidence.length,
    logicalBytes,
    newlyStoredBytes: logicalBytes,
    recordCount: records.length,
  };
}

export async function estimateCollaborationSnapshot(
  db: D1Database,
  selection: IntelligenceSelection,
): Promise<SnapshotIntelligenceSummary> {
  const plan = await buildPlan(db, selection);
  return {
    approved: selection === "none" ? null : sectionSummary(plan.approved),
    selection,
    unvetted:
      selection === "approved-and-unvetted"
        ? sectionSummary(plan.unvetted)
        : null,
  };
}

export async function stageCollaborationSnapshot(
  db: D1Database,
  input: {
    now: number;
    selection: IntelligenceSelection;
    snapshotId: string;
  },
): Promise<void> {
  const plan = await buildPlan(db, input.selection);
  const approved = sectionSummary(plan.approved);
  const unvetted = sectionSummary(plan.unvetted);
  await db
    .prepare(
      `INSERT INTO snapshot_intelligence_selections (
        snapshot_id, selection, approved_record_count,
        approved_evidence_count, approved_logical_bytes,
        approved_newly_stored_bytes, unvetted_record_count,
        unvetted_evidence_count, unvetted_logical_bytes,
        unvetted_newly_stored_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.snapshotId,
      input.selection,
      approved.recordCount,
      approved.evidenceObjectCount,
      approved.logicalBytes,
      approved.newlyStoredBytes,
      unvetted.recordCount,
      unvetted.evidenceObjectCount,
      unvetted.logicalBytes,
      unvetted.newlyStoredBytes,
      input.now,
    )
    .run();
  const items = [...plan.approved, ...plan.unvetted];
  for (let index = 0; index < items.length; index += 40) {
    await db.batch(
      items.slice(index, index + 40).map((item) =>
        db
          .prepare(
            `INSERT INTO snapshot_intelligence_items (
              snapshot_id, item_id, item_kind, classification,
              portable_object_id, descriptor_json, source_object_key,
              content_sha256, byte_length, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .bind(
            input.snapshotId,
            item.itemId,
            item.itemKind,
            item.classification,
            item.descriptor.portableObjectId,
            JSON.stringify(item.descriptor),
            item.sourceObjectKey,
            item.descriptor.contentSha256,
            item.descriptor.byteLength,
          ),
      ),
    );
  }
}

type SelectionRow = {
  approved_evidence_count: number;
  approved_logical_bytes: number;
  approved_newly_stored_bytes: number;
  approved_record_count: number;
  selection: IntelligenceSelection;
  unvetted_evidence_count: number;
  unvetted_logical_bytes: number;
  unvetted_newly_stored_bytes: number;
  unvetted_record_count: number;
};

async function selectionRow(
  db: D1Database,
  snapshotId: string,
): Promise<SelectionRow | null> {
  return db
    .prepare(
      `SELECT selection, approved_record_count, approved_evidence_count,
        approved_logical_bytes, approved_newly_stored_bytes,
        unvetted_record_count, unvetted_evidence_count,
        unvetted_logical_bytes, unvetted_newly_stored_bytes
       FROM snapshot_intelligence_selections WHERE snapshot_id = ?`,
    )
    .bind(snapshotId)
    .first<SelectionRow>();
}

export async function readCollaborationSnapshotSummary(
  db: D1Database,
  snapshotId: string,
): Promise<SnapshotIntelligenceSummary> {
  const row = await selectionRow(db, snapshotId);
  if (row === null || row.selection === "none") {
    return { approved: null, selection: "none", unvetted: null };
  }
  return {
    approved: {
      evidenceObjectCount: row.approved_evidence_count,
      logicalBytes: row.approved_logical_bytes,
      newlyStoredBytes: row.approved_newly_stored_bytes,
      recordCount: row.approved_record_count,
    },
    selection: row.selection,
    unvetted:
      row.selection === "approved-and-unvetted"
        ? {
            evidenceObjectCount: row.unvetted_evidence_count,
            logicalBytes: row.unvetted_logical_bytes,
            newlyStoredBytes: row.unvetted_newly_stored_bytes,
            recordCount: row.unvetted_record_count,
          }
        : null,
  };
}

export async function buildCollaborationSnapshotManifest(
  db: D1Database,
  snapshotId: string,
): Promise<SnapshotIntelligenceManifest> {
  const summary = await readCollaborationSnapshotSummary(db, snapshotId);
  const rows = await db
    .prepare(
      `SELECT item_kind, classification, descriptor_json
       FROM snapshot_intelligence_items
       WHERE snapshot_id = ? AND status = 'ready'
       ORDER BY classification, item_kind, portable_object_id`,
    )
    .bind(snapshotId)
    .all<{
      classification: "approved" | "unvetted";
      descriptor_json: string;
      item_kind: "evidence" | "record";
    }>();
  const section = (classification: "approved" | "unvetted") => {
    const selected = rows.results.filter(
      (row) => row.classification === classification,
    );
    const records = selected
      .filter((row) => row.item_kind === "record")
      .map((row) =>
        snapshotIntelligenceRecordSchema.parse(
          JSON.parse(row.descriptor_json) as unknown,
        ),
      );
    const evidenceObjects = selected
      .filter((row) => row.item_kind === "evidence")
      .map((row) =>
        snapshotIntelligenceEvidenceSchema.parse(
          JSON.parse(row.descriptor_json) as unknown,
        ),
      );
    const expected =
      classification === "approved" ? summary.approved : summary.unvetted;
    if (expected === null) return null;
    if (
      records.length !== expected.recordCount ||
      evidenceObjects.length !== expected.evidenceObjectCount
    ) {
      throw new CollaborationSnapshotError("snapshot_dependency_missing");
    }
    return {
      classification,
      evidenceObjectCount: evidenceObjects.length,
      evidenceObjects,
      logicalBytes: expected.logicalBytes,
      newlyStoredBytes: expected.newlyStoredBytes,
      recordCount: records.length,
      records,
    };
  };
  return snapshotIntelligenceManifestSchema.parse({
    approved: summary.selection === "none" ? null : section("approved"),
    excludedAuthority: [
      "oauth-access-tokens",
      "oauth-refresh-tokens",
      "oauth-authorization-codes",
      "oauth-protocol-storage",
      "sessions",
      "passkeys",
      "pairing-secrets",
      "vault-credentials",
      "live-agent-grants",
      "recovery-private-keys",
      "harness-context",
      "provider-credentials",
      "runtime-caches",
    ],
    format: OWD_SNAPSHOT_INTELLIGENCE_FORMAT,
    requiredCapabilities:
      summary.selection === "none"
        ? []
        : summary.selection === "approved"
          ? [APPROVED_INTELLIGENCE_CAPABILITY]
          : [
              APPROVED_INTELLIGENCE_CAPABILITY,
              QUARANTINED_INTELLIGENCE_CAPABILITY,
            ],
    schemaVersion: 1,
    selection: summary.selection,
    unvetted:
      summary.selection === "approved-and-unvetted"
        ? section("unvetted")
        : null,
  });
}
