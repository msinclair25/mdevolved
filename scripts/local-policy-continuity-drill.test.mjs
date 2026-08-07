import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SYNTHETIC_LOCAL_DRILL_INPUT,
  runDisposablePolicyContinuityDrill,
} from "./local-policy-continuity-drill-lib.mjs";

test("runs a disposable fresh-Community continuity drill and removes every temporary object", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owd-r4-drill-test-"));
  const workspaceRoot = join(parent, "drill");
  try {
    const receipt = await runDisposablePolicyContinuityDrill({
      ...SYNTHETIC_LOCAL_DRILL_INPUT,
      workspaceRoot,
    });
    assert.equal(receipt.outcome, "pass");
    assert.equal(receipt.leadReplaced, true);
    assert.equal(receipt.freshCommunityInstall, true);
    assert.deepEqual(receipt.metrics, {
      continuityAgeSeconds: 45,
      recoveryChecksPassed: 8,
      recoveryChecksTotal: 8,
      recoveryQualityBps: 10_000,
      rpoSeconds: 10,
      rtoSeconds: 28,
      runtimeIndependent: true,
    });
    assert.equal(receipt.cleanup.remainingAuthorityCount, 0);
    assert.ok(Object.values(receipt.authority).every((value) => !value));
    assert.ok(Object.values(receipt.redaction).every((value) => !value));
    await assert.rejects(access(workspaceRoot));
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      "access_token",
      "client_secret",
      "terminal command",
      "transcript body",
      "provider credential",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("rejects a reversed continuity timeline and still cleans up", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owd-r4-drill-order-test-"));
  const workspaceRoot = join(parent, "drill");
  try {
    await assert.rejects(
      runDisposablePolicyContinuityDrill({
        ...SYNTHETIC_LOCAL_DRILL_INPUT,
        latestAcknowledgedPointAt:
          SYNTHETIC_LOCAL_DRILL_INPUT.simulatedLeadLossAt + 1,
        restoredPointAcknowledgedAt:
          SYNTHETIC_LOCAL_DRILL_INPUT.simulatedLeadLossAt + 1,
        workspaceRoot,
      }),
      /invalid_drill_timeline/u,
    );
    await assert.rejects(access(workspaceRoot));
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
