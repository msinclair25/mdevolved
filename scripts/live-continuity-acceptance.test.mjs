import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointArguments,
  checkpointReferences,
  continuityPoint,
  distinctCellOrigin,
  documentationPlan,
  exactHttpsOrigin,
  freshCellAttestation,
  redactedReceipt,
  sameContinuityPoint,
} from "./live-continuity-acceptance-lib.mjs";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PACKET_ID = "22222222-2222-4222-8222-222222222222";
const WORK_ITEM_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ID = "44444444-4444-4444-8444-444444444444";
const POINT_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "66666666-6666-4666-8666-666666666666";
const CITATION_ID = "77777777-7777-4777-8777-777777777777";

function packet() {
  return {
    includedRecords: [
      { includedAs: "shared-handoff", recordId: LEASE_ID },
      { includedAs: "accepted-decision", recordId: DECISION_ID },
    ],
    packetId: PACKET_ID,
    projectId: PROJECT_ID,
    sourceCitations: [{ citationId: CITATION_ID }],
    workItemId: WORK_ITEM_ID,
  };
}

function point() {
  return {
    acceptedDecisions: [],
    artifacts: [],
    authority: {
      liveAuthorityIncluded: false,
      restoredAuthorityAllowed: false,
    },
    blockers: [],
    citedEvidence: [],
    completedWork: ["Source completed."],
    continuityPointId: POINT_ID,
    context: {},
    format: "owd-continuity-point-v1",
    integrity: {},
    knownRejectedApproaches: [],
    nextAction: "Authorize a replacement.",
    objective: {},
    openWork: ["Replace the lead."],
    previousContinuityPointId: null,
    project: { projectId: PROJECT_ID },
    provenance: {
      producerVerification: "authorization-bound-client",
    },
    recordType: "continuity-point",
    risks: [],
    schemaVersion: 1,
    workItem: {},
  };
}

test("builds a bounded checkpoint from packet-owned references", () => {
  assert.deepEqual(checkpointReferences(packet()), {
    acceptedDecisionIds: [DECISION_ID],
    artifactIds: [],
    citationIds: [CITATION_ID],
  });
  const request = checkpointArguments({
    leaseInput: {
      fencingToken: 7,
      leaseId: LEASE_ID,
      projectId: PROJECT_ID,
    },
    packetInput: packet(),
    phase: "replacement",
    previousContinuityPointId: POINT_ID,
    projectId: PROJECT_ID,
  });
  assert.equal(request.fencingToken, 7);
  assert.equal(request.previousContinuityPointId, POINT_ID);
  assert.match(request.idempotencyKey, /^continuity-replacement-/u);
  assert.deepEqual(request.acceptedDecisionIds, [DECISION_ID]);
  assert.deepEqual(request.citationIds, [CITATION_ID]);
});

test("fails closed when packet and lease boundaries differ", () => {
  assert.throws(
    () =>
      checkpointArguments({
        leaseInput: {
          fencingToken: 1,
          leaseId: LEASE_ID,
          projectId: "88888888-8888-4888-8888-888888888888",
        },
        packetInput: packet(),
        phase: "source",
        previousContinuityPointId: null,
        projectId: PROJECT_ID,
      }),
    /different Project/u,
  );
});

test("accepts only inert provider-neutral Continuity Points", () => {
  assert.equal(
    continuityPoint(point(), { projectId: PROJECT_ID }).continuityPointId,
    POINT_ID,
  );
  assert.equal(
    sameContinuityPoint(point(), structuredClone(point()), PROJECT_ID)
      .continuityPointId,
    POINT_ID,
  );
  const reordered = Object.fromEntries(Object.entries(point()).reverse());
  assert.equal(
    sameContinuityPoint(reordered, point(), PROJECT_ID).continuityPointId,
    POINT_ID,
  );
  const hostile = point();
  hostile.authority.liveAuthorityIncluded = true;
  assert.throws(
    () => continuityPoint(hostile, { projectId: PROJECT_ID }),
    /inert provider-neutral contract/u,
  );
});

test("keeps the final receipt free of deployment and Project identifiers", () => {
  const receipt = redactedReceipt({
    freshCellOwnerAttested: true,
    postRestoreFence: 1,
    restoreVerified: true,
    sourceRevoked: true,
    substitutionElapsedMs: 42_100.7,
    successorRevoked: true,
    targetOriginDistinct: true,
  });
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.substitutionElapsedMs, 42_101);
  assert.equal(receipt.substitutionUnderFiveMinutes, true);
  assert.equal(receipt.identifiersRetained, false);
  assert.equal(receipt.postRestoreFence, 1);
  assert.equal(receipt.targetOriginDistinct, true);
  assert.doesNotMatch(serialized, /example|11111111|https:/u);
});

test("validates HTTPS origins and factual root Markdown inventories", () => {
  const source = exactHttpsOrigin("https://cell.example/", "cell");
  assert.equal(source.href, "https://cell.example/");
  assert.throws(
    () => exactHttpsOrigin("https://cell.example/path", "cell"),
    /HTTPS origin/u,
  );
  assert.equal(
    distinctCellOrigin(
      source,
      exactHttpsOrigin("https://restored.example/", "restored cell"),
    ),
    true,
  );
  assert.throws(() => distinctCellOrigin(source, source), /different cell/u);
  assert.equal(freshCellAttestation("fresh-blank"), true);
  assert.throws(() => freshCellAttestation("yes"), /did not attest/u);
  assert.deepEqual(documentationPlan("README.md,AGENTS.md").rootMarkdownPaths, [
    "README.md",
    "AGENTS.md",
  ]);
  assert.throws(() => documentationPlan("README.md,readme.md"), /unique/u);
});
