import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  claudeArgs,
  claudeCollector,
  runClaude,
} from "./claude-continuity-proof-lib.mjs";

const target = {
  url: "http://127.0.0.1:12345/mcp",
  projectId: "11111111-1111-4111-8111-111111111111",
  model: "sonnet",
  localBearer: "synthetic-test-secret",
  takeCalls: () => [],
};
const answer = {
  status: "blocked",
  threshold: null,
  route: "unknown",
  avoided: "",
  nextAction: "",
  checkpointId: "",
};
const init = { type: "system", subtype: "init", session_id: "session-a" };
const final = {
  type: "result",
  subtype: "success",
  session_id: "session-a",
  is_error: false,
  structured_output: answer,
};
const requested = {
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_use",
        name: "mcp__mdevolved-proof__mdevolved_resume",
        input: { projectId: target.projectId },
      },
    ],
  },
};

test("Claude flags preserve login, restrict tools/settings, and never pass a bearer in argv", () => {
  const args = claudeArgs({
    ...target,
    config: "/tmp/mcp.json",
    connected: true,
  });
  for (const flag of [
    "--restricted",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--json-schema",
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(
    args[args.indexOf("--allowedTools") + 1].includes(
      "mcp__mdevolved-proof__mdevolved_checkpoint",
    ),
  );
  assert.ok(
    !args.includes("--bare") &&
      !args.includes("--dangerously-skip-permissions"),
  );
  assert.ok(!args.join(" ").includes(target.localBearer));
  assert.ok(
    !claudeArgs({ ...target, config: "/tmp/mcp.json", connected: false })
      .join(" ")
      .includes("mcp__"),
  );
});

test("Claude evidence must match real server requests; reasoning/text is ignored", () => {
  const c = claudeCollector();
  c.accept(init);
  c.accept(requested);
  c.accept({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "never retain" },
        { type: "text", text: "I claim success" },
      ],
    },
  });
  c.accept(final);
  const calls = [
    {
      tool: "mdevolved_resume",
      arguments: { projectId: target.projectId },
      data: { ok: true },
    },
  ];
  const e = c.finish(calls);
  assert.equal(e.failed, false);
  assert.deepEqual(e.calls, calls);
  assert.deepEqual(e.answer, answer);
  assert.ok(!JSON.stringify(e).includes("never retain"));
  const missing = claudeCollector();
  missing.accept(init);
  missing.accept(requested);
  missing.accept(final);
  assert.equal(missing.finish([]).failed, true);
  const invented = claudeCollector();
  invented.accept(init);
  invented.accept(final);
  assert.equal(invented.finish(calls).failed, true);
});

test("denials, subagents, unexpected tools, duplicate results, and session mismatch fail", () => {
  for (const event of [
    { type: "system", subtype: "permission_denied" },
    { ...requested, parent_tool_use_id: "other-agent" },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "bad" } },
        ],
      },
    },
    { ...final, session_id: "other" },
    { ...final, subtype: "error_max_turns" },
    { ...final, permission_denials: [{}] },
  ]) {
    const c = claudeCollector();
    c.accept(init);
    c.accept(event);
    c.accept(final);
    const e = c.finish([]);
    assert.ok(e.failed || e.forbidden);
  }
});

function fakeSpawn(mode, inspect) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    child.stdin.on("finish", () => {
      void (async () => {
        await inspect(command, args, options);
        if (mode === "timeout") return;
        if (mode === "unavailable") {
          child.emit("error", new Error("synthetic"));
          return;
        }
        if (mode === "invalid") child.stdout.write("not-json\n");
        else if (mode === "oversize") child.stdout.write("x".repeat(2_000_001));
        else
          child.stdout.write(
            `${JSON.stringify(init)}\n${JSON.stringify(final)}\n`,
          );
        child.emit("close", mode === "nonzero" ? 1 : 0);
      })().catch((error) => child.emit("error", error));
    });
    return child;
  };
}

test("Claude child is bounded and ephemeral on success and failures", async () => {
  for (const mode of [
    "success",
    "timeout",
    "invalid",
    "oversize",
    "nonzero",
    "unavailable",
  ]) {
    let directory;
    let checked = false;
    const operation = runClaude({
      target,
      prompt: "synthetic control",
      connected: false,
      timeoutMs: 100,
      spawnProcess: fakeSpawn(mode, async (command, args, options) => {
        directory = options.cwd;
        assert.equal(command, "claude");
        assert.equal(options.shell, false);
        const config = await readFile(
          args[args.indexOf("--mcp-config") + 1],
          "utf8",
        );
        assert.deepEqual(JSON.parse(config), { mcpServers: {} });
        assert.equal(options.env.MDEVOLVED_PROOF_TOKEN, "");
        assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
        checked = true;
      }),
    });
    if (mode === "success") assert.equal((await operation).completed, true);
    else await assert.rejects(operation);
    assert.equal(checked, true);
    await assert.rejects(access(directory));
  }
});

test("connected config references an ephemeral env token, never embeds it", async () => {
  await runClaude({
    target,
    prompt: "synthetic",
    connected: true,
    spawnProcess: fakeSpawn("success", async (_command, args, options) => {
      const config = await readFile(
        args[args.indexOf("--mcp-config") + 1],
        "utf8",
      );
      assert.ok(config.includes("${MDEVOLVED_PROOF_TOKEN}"));
      assert.ok(!config.includes(target.localBearer));
      assert.equal(options.env.MDEVOLVED_PROOF_TOKEN, target.localBearer);
    }),
  });
  await assert.rejects(
    runClaude({
      target: { ...target, url: "https://remote.example/mcp" },
      prompt: "no",
      connected: true,
    }),
    /invalid_target/,
  );
});

test("Claude command help is offline, and paid execution requires explicit opt-in", () => {
  const file = new URL("./claude-continuity-local.mjs", import.meta.url);
  for (const args of [[], ["--help"]]) {
    const r = spawnSync(process.execPath, [file.pathname, ...args], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /proof:claude:local/);
  }
  const r = spawnSync(process.execPath, [file.pathname, "--model", "sonnet"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /explicit_model_usage_required/);
});
