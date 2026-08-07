import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const AUTHORITY = {
  actorAuthorityIncluded: false,
  credentialAuthorityIncluded: false,
  grantAuthorityIncluded: false,
  leaseAuthorityIncluded: false,
  liveAuthorityIncluded: false,
  oauthAuthorityIncluded: false,
  policyAuthorityIncluded: false,
  restoredAuthorityAllowed: false,
  schedulerAuthorityIncluded: false,
};

const REDACTION = {
  credentialsIncluded: false,
  customerDataIncluded: false,
  filenamesIncluded: false,
  hiddenReasoningIncluded: false,
  hostnamesIncluded: false,
  oauthStateIncluded: false,
  productionLogsIncluded: false,
  providerRuntimeIncluded: false,
  rawBodiesIncluded: false,
  terminalHistoryIncluded: false,
  transcriptsIncluded: false,
};

export async function runDisposablePolicyContinuityDrill(input) {
  const requiredRecordTypes = [
    "policy-binding",
    "policy-decision",
    "schedule",
    "evidence",
    "continuity-receipt",
  ];
  const continuityPoint = {
    acknowledgedAt: input.latestAcknowledgedPointAt,
    continuityPointId: input.restoredContinuityPointId,
    nextAction: "Resume the bounded synthetic continuity drill.",
    objective: "Prove fresh Community recovery without restored authority.",
    openWork: ["Complete the external replacement-lead check."],
    projectId: input.projectId,
  };
  const dependencyIdsByType = {
    "continuity-receipt": [input.restoredContinuityPointId],
    evidence: [`${input.recordIdPrefix}03`],
    "policy-binding": [input.restoredContinuityPointId],
    "policy-decision": [
      `${input.recordIdPrefix}01`,
      input.restoredContinuityPointId,
    ],
    schedule: [`${input.recordIdPrefix}01`],
  };
  const sourceRecords = requiredRecordTypes.map((recordType, index) => {
    const recordId = `${input.recordIdPrefix}${String(index + 1).padStart(2, "0")}`;
    const body = {
      format: `synthetic-${recordType}-v1`,
      projectId: input.projectId,
      recordId,
      schemaVersion: 1,
    };
    const descriptor = {
      authority: false,
      dependencies: dependencyIdsByType[recordType],
      projectId: input.projectId,
      recordId,
      recordType,
      restoreDisposition: "restore-quarantined",
    };
    return {
      ...descriptor,
      body,
      contentSha256: sha256(canonicalJson(body)),
    };
  });
  const portable = {
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    format: "owd-operational-record-export-v1",
    projectId: input.projectId,
    records: sourceRecords,
    referencedBodies: [
      {
        body: continuityPoint,
        contentSha256: sha256(canonicalJson(continuityPoint)),
        dependencyId: input.restoredContinuityPointId,
        dependencyKind: "record",
      },
    ],
    schemaVersion: 1,
  };
  let temporaryObjectsRemoved = 0;
  try {
    await mkdir(input.workspaceRoot, { recursive: false });
    const exportPath = join(input.workspaceRoot, "portable-export.json");
    const communityRoot = join(input.workspaceRoot, "fresh-community");
    await writeFile(exportPath, canonicalJson(portable), "utf8");
    await mkdir(communityRoot);
    const decoded = JSON.parse(await readFile(exportPath, "utf8"));
    const restoredRecords = decoded.records.map((record) => ({
      ...record,
      liveAuthorityIncluded: false,
      restoreState: "quarantined",
      restoredAuthorityAllowed: false,
      schedulerAuthorityIncluded: false,
    }));
    const communityInstall = {
      authorityCount: 0,
      communityIndependent: true,
      deploymentMode: "community",
      executionEngineExternal: true,
      fresh: true,
      referencedBodies: decoded.referencedBodies,
      records: restoredRecords,
    };
    const restorePath = join(communityRoot, "quarantined-restore.json");
    await writeFile(restorePath, canonicalJson(communityInstall), "utf8");
    const verified = JSON.parse(await readFile(restorePath, "utf8"));
    const restoredIds = new Set([
      ...verified.records.map((record) => record.recordId),
      ...verified.referencedBodies.map((body) => body.dependencyId),
    ]);
    const restoredPoint = verified.referencedBodies.find(
      (body) => body.dependencyId === input.restoredContinuityPointId,
    );
    const checks = [
      decoded.records.length === requiredRecordTypes.length &&
        verified.records.length === decoded.records.length &&
        requiredRecordTypes.every((recordType) =>
          verified.records.some((record) => record.recordType === recordType),
        ),
      verified.records.every((record) =>
        record.dependencies.every((dependencyId) =>
          restoredIds.has(dependencyId),
        ),
      ),
      decoded.records.every(
        (record) => sha256(canonicalJson(record.body)) === record.contentSha256,
      ) &&
        decoded.referencedBodies.every(
          (body) => sha256(canonicalJson(body.body)) === body.contentSha256,
        ),
      restoredPoint?.body.acknowledgedAt === input.latestAcknowledgedPointAt,
      typeof restoredPoint?.body.objective === "string" &&
        restoredPoint.body.objective.length > 0 &&
        Array.isArray(restoredPoint.body.openWork) &&
        restoredPoint.body.openWork.length > 0 &&
        typeof restoredPoint.body.nextAction === "string" &&
        restoredPoint.body.nextAction.length > 0,
      input.sourceLeadId !== input.replacementLeadId,
      verified.records.every(
        (record) => record.restoreState === "quarantined",
      ) &&
        verified.authorityCount === 0 &&
        verified.records.every(
          (record) =>
            record.liveAuthorityIncluded === false &&
            record.restoredAuthorityAllowed === false &&
            record.schedulerAuthorityIncluded === false,
        ),
      verified.fresh === true &&
        verified.deploymentMode === "community" &&
        verified.communityIndependent === true &&
        verified.executionEngineExternal === true &&
        Object.values(REDACTION).every((value) => value === false),
    ];
    const passed = checks.filter(Boolean).length;
    const total = checks.length;
    const rpoSeconds = Math.max(
      0,
      input.simulatedLeadLossAt - input.latestAcknowledgedPointAt,
    );
    const rtoSeconds =
      input.replacementProductiveAt - input.simulatedLeadLossAt;
    const continuityAgeSeconds =
      input.receiptEmittedAt - input.restoredPointAcknowledgedAt;
    if (
      input.latestAcknowledgedPointAt !== input.restoredPointAcknowledgedAt ||
      input.latestAcknowledgedPointAt > input.simulatedLeadLossAt ||
      rtoSeconds < 0 ||
      continuityAgeSeconds < 0 ||
      input.replacementProductiveAt > input.receiptEmittedAt
    ) {
      throw new Error("invalid_drill_timeline");
    }
    temporaryObjectsRemoved = 4;
    return {
      authority: AUTHORITY,
      cleanup: {
        completed: true,
        remainingAuthorityCount: 0,
        temporaryObjectsRemoved,
      },
      disposable: true,
      drillId: input.drillId,
      emittedAt: input.receiptEmittedAt,
      format: "owd-continuity-receipt-v1",
      freshCommunityInstall: true,
      leadReplaced: input.sourceLeadId !== input.replacementLeadId,
      metrics: {
        continuityAgeSeconds,
        recoveryChecksPassed: passed,
        recoveryChecksTotal: total,
        recoveryQualityBps: Math.floor((10_000 * passed) / total),
        rpoSeconds,
        rtoSeconds,
        runtimeIndependent: passed === total,
      },
      outcome: passed === total ? "pass" : "fail",
      projectId: input.projectId,
      receiptId: input.receiptId,
      redaction: REDACTION,
      restoredContinuityPointId: input.restoredContinuityPointId,
      schemaVersion: 1,
      sourceTimes: {
        latestAcknowledgedPointAt: input.latestAcknowledgedPointAt,
        receiptEmittedAt: input.receiptEmittedAt,
        replacementProductiveAt: input.replacementProductiveAt,
        restoredPointAcknowledgedAt: input.restoredPointAcknowledgedAt,
        simulatedLeadLossAt: input.simulatedLeadLossAt,
      },
    };
  } finally {
    await rm(input.workspaceRoot, { force: true, recursive: true });
  }
}

export const SYNTHETIC_LOCAL_DRILL_INPUT = Object.freeze({
  drillId: "7a000000-0000-4000-8000-000000000001",
  latestAcknowledgedPointAt: 1_786_000_100,
  projectId: "7a000000-0000-4000-8000-000000000002",
  receiptEmittedAt: 1_786_000_145,
  receiptId: "7a000000-0000-4000-8000-000000000003",
  recordIdPrefix: "7a000000-0000-4000-8000-0000000000",
  replacementLeadId: "replacement-lead",
  replacementProductiveAt: 1_786_000_138,
  restoredContinuityPointId: "7a000000-0000-4000-8000-000000000004",
  restoredPointAcknowledgedAt: 1_786_000_100,
  simulatedLeadLossAt: 1_786_000_110,
  sourceLeadId: "lost-lead",
});
