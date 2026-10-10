import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ANSWER_SCHEMA,
  SERVER,
  TOOLS,
  executeProof,
} from "./codex-continuity-proof-lib.mjs";

export function claudeArgs({ model, config, connected }) {
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--restricted",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--tools",
    "",
    "--allowedTools",
    [
      "StructuredOutput",
      ...(connected ? TOOLS.map((tool) => `mcp__${SERVER}__${tool}`) : []),
    ].join(","),
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--model",
    model,
    "--json-schema",
    JSON.stringify(ANSWER_SCHEMA),
  ];
}

export function claudeCollector() {
  const evidence = {
    threadId: null,
    completed: false,
    failed: false,
    forbidden: false,
    calls: [],
    answer: null,
  };
  const requested = [];
  let results = 0;
  return {
    evidence,
    accept(event) {
      if (event.parent_tool_use_id) evidence.forbidden = true;
      if (event.type === "system" && event.subtype === "init") {
        if (evidence.threadId) evidence.failed = true;
        evidence.threadId = event.session_id;
      }
      if (
        event.type === "system" &&
        ["permission_denied", "error"].includes(event.subtype)
      )
        evidence.failed = true;
      if (event.type === "assistant") {
        for (const item of event.message?.content ?? []) {
          if (item.type !== "tool_use") continue;
          if (item.name === "StructuredOutput") continue;
          const tool = TOOLS.find(
            (name) => item.name === `mcp__${SERVER}__${name}`,
          );
          if (!tool) evidence.forbidden = true;
          requested.push({ tool, arguments: item.input });
          if (requested.length > 12) throw new Error("tool_budget_exceeded");
        }
      }
      if (event.type === "result") {
        results++;
        evidence.completed = true;
        evidence.failed ||=
          event.subtype !== "success" ||
          event.is_error !== false ||
          results !== 1 ||
          event.session_id !== evidence.threadId ||
          (event.permission_denials?.length ?? 0) > 0;
        if (JSON.stringify(event.structured_output ?? null).length > 8192)
          throw new Error("answer_too_large");
        evidence.answer = event.structured_output ?? null;
      }
    },
    finish(serverCalls) {
      evidence.calls = serverCalls;
      // The model's requests must match what the real Worker actually handled.
      if (
        !isDeepStrictEqual(
          requested,
          serverCalls.map(({ tool, arguments: args }) => ({
            tool,
            arguments: args,
          })),
        )
      )
        evidence.failed = true;
      return evidence;
    },
  };
}

export async function runClaude({
  target,
  prompt,
  connected,
  timeoutMs = 120_000,
  spawnProcess = spawn,
}) {
  if (
    !/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/u.test(target.url ?? "") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(target.model ?? "") ||
    typeof target.takeCalls !== "function" ||
    typeof target.localBearer !== "string" ||
    !target.localBearer
  )
    throw new Error("invalid_target");
  if (target.takeCalls().length) throw new Error("unexpected_prior_calls");
  const cwd = await mkdtemp(join(tmpdir(), "mdevolved-claude-proof-"));
  try {
    const config = join(cwd, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: connected
          ? {
              [SERVER]: {
                type: "http",
                url: target.url,
                headers: { Authorization: "Bearer ${MDEVOLVED_PROOF_TOKEN}" },
              },
            }
          : {},
      }),
      { mode: 0o600 },
    );
    const collector = claudeCollector();
    await new Promise((resolve, reject) => {
      const child = spawnProcess(
        "claude",
        claudeArgs({ ...target, config, connected }),
        {
          cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            MDEVOLVED_PROOF_TOKEN: connected ? target.localBearer : "",
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            CLAUDE_CODE_DISABLE_CRON: "1",
            CLAUDE_CODE_DISABLE_ARTIFACT: "1",
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            ENABLE_TOOL_SEARCH: "false",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
        },
      );
      let pending = "";
      let bytes = 0;
      let failure;
      const stop = (code) => {
        failure ??= code;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop("session_timeout"), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2_000_000) {
          stop("output_budget_exceeded");
          return;
        }
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines)
          if (line.trim()) {
            try {
              collector.accept(JSON.parse(line));
            } catch {
              stop("invalid_event_stream");
            }
          }
      });
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) stop("output_budget_exceeded");
      });
      child.stdin.on("error", () => stop("stdin_failed"));
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("claude_unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0 || pending.trim())
          reject(new Error(failure ?? "claude_failed"));
        else resolve();
      });
      child.stdin.end(prompt);
    });
    return collector.finish(target.takeCalls());
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function executeClaudeProof(target, run = runClaude) {
  const result = await executeProof(target, run);
  return {
    ...result,
    format: "mdevolved-claude-proof-v1",
    evidenceKind: "live-claude-mcp",
  };
}
