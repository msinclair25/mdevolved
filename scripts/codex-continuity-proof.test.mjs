import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { EventEmitter } from "node:events";
import { access, readdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ANSWER_SCHEMA,
  SERVER,
  TOOLS,
  codexArgs,
  createChallenge,
  eventCollector,
  executeProof,
  gradeProof,
  prompts,
  runCodex,
  validateTarget,
} from "./codex-continuity-proof-lib.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const POINT = "22222222-2222-4222-8222-222222222222";
const NEXT = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const target = {
  url: "https://synthetic.example/mcp",
  projectId: PROJECT,
  model: "test-model",
};

function fixture() {
  const challenge = createChallenge();
  const answer = {
    status: "completed",
    threshold: challenge.threshold,
    route: challenge.count >= challenge.threshold ? "express" : "standard",
    avoided: challenge.failure,
    nextAction: challenge.nextAction,
    checkpointId: NEXT,
  };
  const run = (id, calls, value) => ({
    threadId: id,
    completed: true,
    failed: false,
    forbidden: false,
    calls,
    answer: value,
  });
  const call = (tool, data) => ({
    tool,
    arguments:
      tool === "mdevolved_checkpoint"
        ? {
            projectId: PROJECT,
            checkpointBase: HASH,
            idempotencyKey: "synthetic-proof-key-1",
            outcome: "Synthetic checkpoint fixture.",
            nextAction: challenge.nextAction,
          }
        : { projectId: PROJECT },
    data: { ok: true, ...data },
  });
  return {
    projectId: PROJECT,
    challenge,
    control: run("control", [], {
      status: "blocked",
      threshold: null,
      route: "unknown",
      avoided: "",
      nextAction: "",
      checkpointId: "",
    }),
    seed: run(
      "seed",
      [
        call("mdevolved_resume", {
          checkpointBase: HASH,
          contextSha256: HASH,
          contextMode: "focused",
          context: { project: { projectId: PROJECT } },
        }),
        call("mdevolved_checkpoint", {
          checkpoint: {
            projectId: PROJECT,
            continuityPointId: POINT,
            previousContinuityPointId: null,
            acknowledgedAt: 1,
            contentSha256: HASH,
          },
        }),
      ],
      { ...answer, checkpointId: POINT },
    ),
    resumed: run(
      "fresh",
      [
        call("mdevolved_resume", {
          checkpointBase: HASH,
          contextMode: "focused",
          contextSha256: HASH,
          context: {
            project: { projectId: PROJECT },
            currentState: {
              completedWork: [
                `${challenge.marker} threshold ${challenge.threshold}`,
              ],
              knownRejectedApproaches: [challenge.failure],
              nextAction: challenge.nextAction,
            },
          },
        }),
        call("mdevolved_checkpoint", {
          checkpoint: {
            projectId: PROJECT,
            continuityPointId: NEXT,
            acknowledgedAt: 2,
            previousContinuityPointId: POINT,
            contentSha256: HASH,
          },
        }),
      ],
      answer,
    ),
  };
}

test("validates explicit HTTPS target without credentials, query, or fragments", () => {
  assert.deepEqual(validateTarget(target), target);
  for (const url of [
    "http://synthetic.example/mcp",
    "https://user:password@synthetic.example/mcp",
    "https://synthetic.example/mcp?token=x",
    "https://synthetic.example/mcp#secret",
    "https://synthetic.example/api",
  ]) {
    assert.throws(() => validateTarget({ ...target, url }));
  }
  for (const field of ["url", "projectId", "model"]) {
    assert.throws(() => validateTarget({ ...target, [field]: undefined }));
  }
  assert.throws(() => validateTarget({ ...target, model: "x; echo unsafe" }));
});

test("recognizes only the exact disabled-code-mode notice, never arbitrary errors", () => {
  const collector = eventCollector();
  collector.accept({
    type: "item.completed",
    item: {
      type: "error",
      message:
        "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.",
    },
  });
  assert.equal(collector.evidence.forbidden, false);
  collector.accept({
    type: "item.completed",
    item: { type: "error", message: "Authentication failed" },
  });
  assert.equal(collector.evidence.forbidden, true);
});

test("local bearer is never placed in command arguments and cannot target a remote host", async () => {
  const args = codexArgs({
    ...target,
    connected: true,
    localBearer: "synthetic-secret",
    cwd: "/tmp/test",
    schema: "/tmp/test/schema",
  });
  assert.ok(!args.join(" ").includes("synthetic-secret"));
  assert.ok(args.join(" ").includes("bearer_token_env_var"));
  await assert.rejects(
    runCodex({
      target: { ...target, localBearer: "synthetic-secret" },
      connected: true,
      prompt: "test",
    }),
    /invalid_target/,
  );
});

test("fresh/control prompts and schema never contain the random saved facts", () => {
  const challenge = createChallenge();
  const value = prompts(PROJECT, challenge);
  assert.ok(value.seed.includes(challenge.marker));
  assert.ok(value.seed.includes(challenge.failure));
  for (const text of [
    value.control,
    value.resume,
    JSON.stringify(ANSWER_SCHEMA),
  ]) {
    assert.ok(!text.includes(challenge.marker));
    assert.ok(!text.includes(challenge.failure));
    assert.ok(!text.includes(challenge.nextAction));
  }
  assert.notEqual(challenge.marker, createChallenge().marker);
});

test("CLI uses fresh ephemeral processes, explicit restricted tools, no resume/fork or shell", () => {
  const input = {
    ...target,
    cwd: "/tmp/synthetic",
    schema: "/tmp/synthetic/schema.json",
  };
  const args = codexArgs({ ...input, connected: true });
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    "read-only",
    "--json",
    "--output-schema",
  ]) {
    assert.ok(args.includes(flag));
  }
  assert.ok(
    args.includes(
      `mcp_servers.${SERVER}.enabled_tools=${JSON.stringify(TOOLS)}`,
    ),
  );
  assert.ok(args.includes("shell_tool"));
  assert.ok(!args.includes("resume") && !args.includes("fork"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(
    !codexArgs({ ...input, connected: false })
      .join(" ")
      .includes("mcp_servers"),
  );
});

test("grader requires actual scoped MCP readback and a linked successor, not model claims", () => {
  assert.equal(gradeProof(fixture()).passed, true);
  const mutations = [
    (f) => {
      f.seed.answer.status = "blocked";
    },
    (f) => {
      f.seed.calls[1].arguments.checkpointBase = "b".repeat(64);
    },
    (f) => {
      f.resumed.calls[1].arguments.checkpointBase = "b".repeat(64);
    },
    (f) => {
      f.resumed.calls[0].data.checkpointBase = "invalid";
    },
    (f) => {
      f.seed.calls[0].data.checkpointBase = "invalid";
    },
    (f) => {
      f.resumed.calls[1].data.checkpoint.acknowledgedAt = -1;
    },
    (f) => {
      f.resumed.calls[1].data.checkpoint.continuityPointId = POINT;
      f.resumed.answer.checkpointId = POINT;
    },
    (f) => {
      f.resumed.calls = [];
    },
    (f) => {
      f.resumed.threadId = f.seed.threadId;
    },
    (f) => {
      f.resumed.calls[0].arguments.projectId = NEXT;
    },
    (f) => {
      f.resumed.calls[0].data.context.project.projectId = NEXT;
    },
    (f) => {
      f.resumed.calls[0].data.context.currentState = null;
    },
    (f) => {
      f.resumed.calls[0].data.contextSha256 = "not-a-hash";
    },
    (f) => {
      f.resumed.calls[0].data.ok = false;
    },
    (f) => {
      f.resumed.calls[1].data.checkpoint.previousContinuityPointId = NEXT;
    },
    (f) => {
      f.resumed.answer.route =
        f.resumed.answer.route === "express" ? "standard" : "express";
    },
    (f) => {
      f.resumed.answer.avoided = "forgot";
    },
    (f) => {
      f.control.answer.status = "completed";
    },
    (f) => {
      f.resumed.failed = true;
    },
    (f) => {
      f.resumed.completed = false;
    },
    (f) => {
      f.seed.forbidden = true;
    },
    (f) => {
      f.seed.answer.checkpointId = NEXT;
    },
    (f) => {
      f.resumed.calls.reverse();
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.equal(gradeProof(f).passed, false, mutate.toString());
  }
});

test("event reduction supports SDK structured/text envelopes and discards reasoning", () => {
  for (const result of [
    { structuredContent: { ok: true } },
    { structured_content: { ok: true } },
    { content: [{ type: "text", text: '{"ok":true}' }] },
  ]) {
    const collector = eventCollector();
    collector.accept({ type: "thread.started", thread_id: "fresh" });
    collector.accept({
      type: "item.completed",
      item: { type: "reasoning", text: "NEVER SAVE THIS" },
    });
    collector.accept({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: SERVER,
        tool: "mdevolved_resume",
        arguments: { projectId: PROJECT },
        status: "completed",
        result,
      },
    });
    collector.accept({ type: "turn.completed", usage: { input_tokens: 10 } });
    assert.deepEqual(collector.evidence.calls[0].data, { ok: true });
    assert.ok(!JSON.stringify(collector.evidence).includes("NEVER SAVE THIS"));
  }
});

test("errors, unexpected tool types, malformed answers and excessive calls cannot pass", () => {
  for (const type of [
    "command_execution",
    "file_change",
    "web_search",
    "unknown_tool",
  ]) {
    const c = eventCollector();
    c.accept({ type: "item.started", item: { type } });
    assert.equal(c.evidence.forbidden, true);
  }
  const c = eventCollector();
  const event = {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: SERVER,
      tool: "mdevolved_resume",
      status: "completed",
      result: { isError: true, structuredContent: { ok: true } },
    },
  };
  c.accept(event);
  assert.equal(c.evidence.calls[0].data, null);
  c.accept({
    type: "item.completed",
    item: { type: "agent_message", text: "I remember everything" },
  });
  assert.equal(c.evidence.answer, null);
  c.accept({ type: "turn.failed" });
  assert.equal(c.evidence.failed, true);
  assert.throws(() => {
    for (let i = 0; i < 13; i++) c.accept(event);
  }, /budget/u);
});

test("receipt excludes project IDs, marker, endpoint, payloads and raw usage", () => {
  const f = fixture();
  const receipt = JSON.stringify(gradeProof(f));
  for (const forbidden of [
    PROJECT,
    POINT,
    NEXT,
    f.challenge.marker,
    target.url,
    "threadId",
    "completedWork",
  ]) {
    assert.ok(!receipt.includes(forbidden));
  }
});

test("orchestration runs control before any remote seed and stops on failure", async () => {
  let calls = 0;
  await assert.rejects(
    executeProof(target, async ({ connected }) => {
      calls++;
      assert.equal(connected, false);
      return { completed: false };
    }),
    /control_failed/u,
  );
  assert.equal(calls, 1);
});

test("default/help are offline and missing live opt-in fails closed", () => {
  const entry = fileURLToPath(
    new URL("./codex-continuity-proof.mjs", import.meta.url),
  );
  for (const args of [[], ["--help"]]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /three Codex sessions/u);
  }
  const result = spawnSync(
    process.execPath,
    [entry, "--live", "--url", "https://secret.example/mcp"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("secret.example"));
});

test("process adapter bounds execution and removes its schema-only workspace on success/failure", async () => {
  for (const mode of [
    "success",
    "timeout",
    "oversize",
    "malformed",
    "exit-failure",
  ]) {
    let ownedDirectory;
    let sent = "";
    let killed = false;
    const spawnProcess = (_command, args, options) => {
      ownedDirectory = options.cwd;
      assert.equal(options.shell, false);
      assert.equal(args.at(-1), "-");
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on("data", (data) => {
        sent += data.toString();
      });
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit("close", null));
      };
      child.stdin.on("finish", () => {
        queueMicrotask(() => {
          if (mode === "timeout") return;
          if (mode === "oversize") {
            child.stderr.write("x".repeat(2_000_001));
            return;
          }
          if (mode === "malformed") {
            child.stdout.write("not json\n");
            return;
          }
          if (mode === "exit-failure") {
            child.emit("close", 1);
            return;
          }
          child.stdout.write(
            JSON.stringify({ type: "thread.started", thread_id: "synthetic" }) +
              "\n",
          );
          child.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
          child.emit("close", 0);
        });
      });
      return child;
    };
    const result = runCodex({
      target,
      prompt: "Synthetic prompt",
      connected: false,
      timeoutMs: 20,
      spawnProcess,
    });
    if (mode === "success") assert.equal((await result).threadId, "synthetic");
    else await assert.rejects(result);
    assert.equal(sent, "Synthetic prompt");
    assert.equal(killed, ["timeout", "oversize", "malformed"].includes(mode));
    await assert.rejects(access(ownedDirectory));
  }
});

test("running process receives only the generic schema file, never an answer or prior prompt", async () => {
  let listing;
  const spawnProcess = (_command, _args, options) => {
    listing = readdir(options.cwd);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on("finish", () =>
      queueMicrotask(() => child.emit("close", 0)),
    );
    return child;
  };
  await runCodex({
    target,
    prompt: "Synthetic only",
    connected: false,
    spawnProcess,
  });
  assert.deepEqual(await listing, ["answer.schema.json"]);
});
