import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startLocalProof } from "./codex-proof-local.mjs";

test(
  "local proof uses real MCP, rejects outsiders, and immediately enforces revocation",
  { timeout: 60_000 },
  async () => {
    const local = await startLocalProof();
    const url = local.url;
    try {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      assert.equal((await fetch(url)).status, 403);
      const headers = {
        Authorization: `Bearer ${local.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers: { ...headers, Origin: "https://hostile.test" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              method: "tools/call",
              params: {
                name: "mdevolved_resume",
                arguments: { projectId: randomUUID() },
              },
            }),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              method: "tools/call",
              params: {
                name: "open_project",
                arguments: { projectId: local.projectId },
              },
            }),
          })
        ).status,
        403,
      );
      const observedResponse = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "mdevolved_resume",
            arguments: { projectId: local.projectId, contextMode: "focused" },
          },
        }),
      });
      assert.equal(observedResponse.status, 200);
      const observedEnvelope = await observedResponse.json();
      const observed = local.takeCalls();
      assert.equal(observed.length, 1);
      assert.equal(observed[0].tool, "mdevolved_resume");
      assert.equal(observed[0].arguments.projectId, local.projectId);
      assert.deepEqual(
        observed[0].data,
        observedEnvelope.result.structuredContent,
      );
      assert.equal(observed[0].data.ok, true);
      assert.deepEqual(local.takeCalls(), []);
      const resumed = (
        await local.rpc("mdevolved_resume", {
          projectId: local.projectId,
          contextMode: "focused",
        })
      ).result.structuredContent;
      assert.equal(resumed.ok, true);
      const saved = (
        await local.rpc("mdevolved_checkpoint", {
          projectId: local.projectId,
          checkpointBase: resumed.checkpointBase,
          idempotencyKey: randomUUID(),
          outcome: "Synthetic automated test checkpoint.",
          nextAction: "Continue synthetic test.",
        })
      ).result.structuredContent;
      assert.equal(saved.ok, true);
      const readback = (
        await local.rpc("mdevolved_resume", {
          projectId: local.projectId,
          contextMode: "focused",
        })
      ).result.structuredContent;
      assert.equal(
        readback.context.currentState.nextAction,
        "Continue synthetic test.",
      );
      const wrong = await local.rpc("mdevolved_resume", {
        projectId: randomUUID(),
        contextMode: "focused",
      });
      assert.equal(wrong.result.isError, true);
      await local.revoke();
      const revoked = await local.rpc("mdevolved_resume", {
        projectId: local.projectId,
        contextMode: "focused",
      });
      assert.equal(revoked.result.isError, true);
    } finally {
      await local.close();
    }
    await assert.rejects(fetch(url));
  },
);
