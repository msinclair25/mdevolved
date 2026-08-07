import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const CONTINUITY_RESOURCE_URI =
  "owd://collaboration/lead-continuity-capabilities/v1";
export const CONTINUITY_TOOLS = [
  "claim_project_lead",
  "renew_project_lead",
  "checkpoint_project",
  "resume_project",
];
export const PROJECT_LEAD_LEASE_SECONDS = 180;
export const SUBSTITUTION_BUDGET_MS = 5 * 60 * 1_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROOT_MARKDOWN_PATTERN = /^[^/\\\p{Cc}\p{Cf}]+\.md$/iu;

export function fail(message) {
  throw new Error(message);
}

export function asRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} was not an object.`);
  }
  return value;
}

export function exactUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(`${label} was not an exact UUID.`);
  }
  return value.toLocaleLowerCase("en-US");
}

export function exactHttpsOrigin(value, label) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail(`${label} was not a valid URL.`);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/"
  ) {
    fail(`${label} must be an HTTPS origin with no path or credentials.`);
  }
  origin.search = "";
  origin.hash = "";
  return origin;
}

export function distinctCellOrigin(sourceOrigin, targetOrigin) {
  if (sourceOrigin.origin === targetOrigin.origin) {
    fail("The restored target must use a different cell origin.");
  }
  return true;
}

export function freshCellAttestation(value) {
  if (value !== "fresh-blank") {
    fail("The owner did not attest to a fresh blank restored target.");
  }
  return true;
}

export function documentationPlan(rootMarkdownInput) {
  const input = rootMarkdownInput.trim();
  if (input === "none") {
    return {
      decision: "no-root-markdown",
      proposedMoves: [],
      retainedRootPaths: [],
      rootMarkdownPaths: [],
    };
  }
  const rootMarkdownPaths = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const normalizedPaths = rootMarkdownPaths.map((value) =>
    value.toLocaleLowerCase("en-US"),
  );
  if (
    rootMarkdownPaths.length === 0 ||
    rootMarkdownPaths.length > 128 ||
    rootMarkdownPaths.some(
      (value) => value.length > 1_024 || !ROOT_MARKDOWN_PATTERN.test(value),
    ) ||
    new Set(normalizedPaths).size !== rootMarkdownPaths.length
  ) {
    fail(
      "Root Markdown inventory must be `none` or a unique comma-separated list of root-level .md filenames.",
    );
  }
  return {
    decision: "keep-current-locations",
    proposedMoves: [],
    retainedRootPaths: rootMarkdownPaths,
    rootMarkdownPaths,
  };
}

export function checkpointReferences(packetInput) {
  const packet = asRecord(packetInput, "Work Packet");
  if (!Array.isArray(packet.sourceCitations)) {
    fail("Work Packet source citations were not an array.");
  }
  if (!Array.isArray(packet.includedRecords)) {
    fail("Work Packet included records were not an array.");
  }
  const citationIds = packet.sourceCitations.map((input, index) => {
    const citation = asRecord(input, `Work Packet citation ${index + 1}`);
    return exactUuid(citation.citationId, "Work Packet citation");
  });
  const acceptedDecisionIds = packet.includedRecords
    .map((input, index) =>
      asRecord(input, `Work Packet included record ${index + 1}`),
    )
    .filter((record) => record.includedAs === "accepted-decision")
    .map((record) => exactUuid(record.recordId, "accepted Decision"));
  return {
    acceptedDecisionIds,
    artifactIds: [],
    citationIds,
  };
}

export function checkpointArguments({
  leaseInput,
  packetInput,
  phase,
  previousContinuityPointId,
  projectId,
}) {
  const packet = asRecord(packetInput, "Work Packet");
  const lease = asRecord(leaseInput, "lead lease");
  const exactProjectId = exactUuid(projectId, "Project ID");
  if (
    exactUuid(packet.projectId, "Work Packet Project ID") !== exactProjectId
  ) {
    fail("Work Packet belongs to a different Project.");
  }
  if (exactUuid(lease.projectId, "lead lease Project ID") !== exactProjectId) {
    fail("Lead lease belongs to a different Project.");
  }
  const references = checkpointReferences(packet);
  const predecessor =
    previousContinuityPointId === null
      ? null
      : exactUuid(previousContinuityPointId, "previous Continuity Point ID");
  const phaseState =
    phase === "source"
      ? {
          completedWork: [
            "Authorized a synthetic source lead and verified the current Work Packet.",
          ],
          nextAction:
            "Remove the source client, authorize an independent replacement, and resume this exact point.",
          openWork: [
            "Complete the independent replacement takeover within five minutes.",
          ],
        }
      : phase === "replacement"
        ? {
            completedWork: [
              "Resumed the source Continuity Point under an independently authorized replacement client.",
            ],
            nextAction:
              "Create and restore an encrypted snapshot into a fresh cell, then prove the point remains inert.",
            openWork: [
              "Verify the restored Continuity Point without restoring its lease or grant.",
            ],
          }
        : phase === "restored"
          ? {
              completedWork: [
                "Verified the encrypted restore retained the Continuity Point without live authority.",
              ],
              nextAction:
                "Record the R1 go/no-go decision and remove every disposable test resource.",
              openWork: ["Complete the disposable-cell cleanup receipt."],
            }
          : fail("Unknown continuity drill phase.");
  return {
    ...references,
    blockers: [],
    completedWork: phaseState.completedWork,
    fencingToken: lease.fencingToken,
    idempotencyKey: `continuity-${phase}-${randomUUID()}`,
    knownRejectedApproaches: [
      "Restoring or inferring live authority from a checkpoint or backup.",
    ],
    leaseId: exactUuid(lease.leaseId, "lead lease ID"),
    nextAction: phaseState.nextAction,
    openWork: phaseState.openWork,
    packetId: exactUuid(packet.packetId, "Work Packet ID"),
    previousContinuityPointId: predecessor,
    projectId: exactProjectId,
    risks: [
      "A stale packet, revoked grant, or expired lease must fail closed.",
    ],
    workItemId: exactUuid(packet.workItemId, "Work Item ID"),
  };
}

export function continuityPoint(value, expected) {
  const point = asRecord(value, "Continuity Point");
  const authority = asRecord(point.authority, "Continuity Point authority");
  const project = asRecord(point.project, "Continuity Point Project");
  const provenance = asRecord(point.provenance, "Continuity Point provenance");
  const expectedProjectId = exactUuid(
    expected.projectId,
    "expected Project ID",
  );
  if (
    point.format !== "owd-continuity-point-v1" ||
    point.recordType !== "continuity-point" ||
    point.schemaVersion !== 1 ||
    authority.liveAuthorityIncluded !== false ||
    authority.restoredAuthorityAllowed !== false ||
    exactUuid(project.projectId, "Continuity Point Project ID") !==
      expectedProjectId ||
    provenance.producerVerification !== "authorization-bound-client"
  ) {
    fail("Continuity Point failed the inert provider-neutral contract.");
  }
  const pointId = exactUuid(point.continuityPointId, "Continuity Point ID");
  if (
    expected.continuityPointId !== undefined &&
    pointId !==
      exactUuid(expected.continuityPointId, "expected Continuity Point ID")
  ) {
    fail("A different Continuity Point was resumed.");
  }
  return point;
}

export function sameContinuityPoint(actual, expected, projectId) {
  const actualPoint = continuityPoint(actual, { projectId });
  const expectedPoint = continuityPoint(expected, { projectId });
  if (!isDeepStrictEqual(actualPoint, expectedPoint)) {
    fail("The resumed Continuity Point did not exactly match its checkpoint.");
  }
  return actualPoint;
}

export function redactedReceipt({
  freshCellOwnerAttested,
  postRestoreFence,
  restoreVerified,
  sourceRevoked,
  substitutionElapsedMs,
  successorRevoked,
  targetOriginDistinct,
}) {
  const elapsedMs = Math.round(substitutionElapsedMs);
  return {
    event: "owd.continuity_r1.live_drill.protocol_complete",
    freshCellOwnerAttested,
    identifiersRetained: false,
    liveAuthorityRestored: false,
    postRestoreFence,
    restoreVerified,
    sourceRevoked,
    substitutionElapsedMs: elapsedMs,
    substitutionUnderFiveMinutes: elapsedMs < SUBSTITUTION_BUDGET_MS,
    successorRevoked,
    targetOriginDistinct,
  };
}
