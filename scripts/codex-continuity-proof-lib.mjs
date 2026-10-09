import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
export const SERVER = "mdevolved-proof";
export const TOOLS = [
  "mdevolved_resume",
  "mdevolved_find",
  "mdevolved_checkpoint",
];
export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    threshold: { type: ["integer", "null"] },
    route: { type: "string", enum: ["express", "standard", "unknown"] },
    avoided: { type: "string" },
    nextAction: { type: "string" },
    checkpointId: { type: "string" },
  },
  required: [
    "status",
    "threshold",
    "route",
    "avoided",
    "nextAction",
    "checkpointId",
  ],
};

export function validateTarget({ url, projectId, model }) {
  if ([url, projectId, model].some((value) => typeof value !== "string"))
    throw new Error("invalid_target");
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/mcp" ||
    !UUID.test(projectId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(model)
  ) {
    throw new Error("invalid_target");
  }
  return { url: target.href, projectId, model };
}

export function createChallenge() {
  const marker = `proof-${randomBytes(12).toString("hex")}`;
  const threshold = randomInt(20, 91);
  return {
    marker,
    threshold,
    count: randomInt(1, 121),
    failure: `Do not sort by filename; synthetic fixture ${marker} rejects that method.`,
    nextAction: `Classify the pending batch using policy ${marker}.`,
  };
}

export function prompts(projectId, challenge) {
  const task = `Classify the pending batch of ${challenge.count} items using this Project's saved routing policy. Return the exact saved useful-failure sentence as avoided and exact saved next action as nextAction. If the policy is unavailable, report blocked, null threshold, unknown route, and empty strings; do not invent it or ask a person.`;
  const rules = `Synthetic evaluation only. Use only the enabled MDevolved tools for Project ${projectId}. No files, shell, web, other Projects, or connection/permission changes. Resume focused context first. Before finishing any completed work, checkpoint its bounded outcome using the unchanged checkpointBase from resume and a fresh UUID as idempotencyKey. For this minimal checkpoint send only projectId, checkpointBase, idempotencyKey, outcome, nextAction, and usefulFailures (an array of strings); do not add evidence or other optional fields. Do not claim tests were executed. Return JSON matching the supplied schema; checkpointId must come from the successful tool result.`;
  return {
    control: `You have no project memory or tools. ${task}`,
    seed: `${rules}\nEstablish this synthetic policy fixture (not a previously executed experiment): batches with item count >= ${challenge.threshold} route express; smaller batches route standard. Policy reference ${challenge.marker}. Save that full rule in outcome, this exact usefulFailures entry: ${challenge.failure} and this exact nextAction: ${challenge.nextAction}. Return completed only after a successful checkpoint; route may be unknown for this setup phase.`,
    resume: `${rules}\n${task}`,
  };
}

export function codexArgs({ model, url, cwd, schema, connected, localBearer }) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--model",
    model,
    "--cd",
    cwd,
    "--output-schema",
    schema,
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "suppress_unstable_features_warning=true",
  ];
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "unified_exec_tty",
    "view_image",
    "workspace_dependencies",
    "code_mode",
    "apps",
    "plugins",
    "hooks",
    "memories",
    "multi_agent",
    "browser_use",
    "computer_use",
  ]) {
    args.push("--disable", feature);
  }
  args.push("--enable", "skip_host_skill_discovery");
  if (connected) {
    args.push(
      "-c",
      `mcp_servers.${SERVER}.url=${JSON.stringify(url)}`,
      "-c",
      `mcp_servers.${SERVER}.required=true`,
      "-c",
      `mcp_servers.${SERVER}.enabled_tools=${JSON.stringify(TOOLS)}`,
    );
    if (localBearer)
      args.push(
        "-c",
        `mcp_servers.${SERVER}.bearer_token_env_var="MDEVOLVED_PROOF_TOKEN"`,
      );
  }
  return [...args, "-"];
}

function structured(result) {
  if (!result || result.isError === true || result.is_error === true)
    return null;
  const direct = result.structuredContent ?? result.structured_content;
  if (direct) return direct;
  for (const entry of result.content ?? []) {
    if (entry.type === "text") {
      try {
        return JSON.parse(entry.text);
      } catch {
        /* Not a JSON envelope. */
      }
    }
  }
  return null;
}

// Keep only protocol evidence and the bounded final answer in memory. Never
// persist stdout/stderr, reasoning, terminal history, or complete tool payloads.
export function eventCollector() {
  const evidence = {
    threadId: null,
    completed: false,
    failed: false,
    forbidden: false,
    unexpectedItemTypes: [],
    calls: [],
    answer: null,
    usage: null,
  };
  return {
    evidence,
    accept(event) {
      if (event.type === "thread.started") evidence.threadId = event.thread_id;
      if (event.type === "turn.failed" || event.type === "error")
        evidence.failed = true;
      if (event.type === "turn.completed") {
        evidence.completed = true;
        evidence.usage = event.usage;
      }
      const item = event.item;
      if (!item) return;
      // Codex 0.160.1 emits this known disabled-capability notice as an error
      // item even with code_mode=false. Never ignore arbitrary error items.
      if (
        item.type === "error" &&
        item.message ===
          "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`."
      )
        return;
      if (
        ![
          "reasoning",
          "agent_message",
          "mcp_tool_call",
          "plan_update",
        ].includes(item.type)
      ) {
        evidence.forbidden = true;
        if (
          typeof item.type === "string" &&
          /^[a-z_]{1,64}$/u.test(item.type) &&
          !evidence.unexpectedItemTypes.includes(item.type)
        )
          evidence.unexpectedItemTypes.push(item.type);
      }
      if (event.type !== "item.completed") return;
      if (item.type === "mcp_tool_call") {
        if (item.server !== SERVER || !TOOLS.includes(item.tool))
          evidence.forbidden = true;
        evidence.calls.push({
          tool: item.tool,
          arguments: item.arguments,
          data:
            item.status === "completed" && !item.error
              ? structured(item.result)
              : null,
        });
        if (evidence.calls.length > 12) throw new Error("tool_budget_exceeded");
      }
      if (item.type === "agent_message") {
        if (typeof item.text !== "string" || item.text.length > 8192)
          throw new Error("answer_too_large");
        try {
          evidence.answer = JSON.parse(item.text);
        } catch {
          evidence.answer = null;
        }
      }
    },
  };
}

export async function runCodex({
  target,
  prompt,
  connected,
  timeoutMs = 120_000,
  spawnProcess = spawn,
}) {
  if (
    target.localBearer &&
    !/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/u.test(target.url ?? "")
  )
    throw new Error("invalid_target");
  const cwd = await mkdtemp(join(tmpdir(), "mdevolved-codex-proof-"));
  try {
    const schema = join(cwd, "answer.schema.json");
    await writeFile(schema, JSON.stringify(ANSWER_SCHEMA), { mode: 0o600 });
    const collector = eventCollector();
    await new Promise((resolve, reject) => {
      const child = spawnProcess(
        "codex",
        codexArgs({ ...target, cwd, schema, connected }),
        {
          cwd,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env:
            connected && target.localBearer
              ? { ...process.env, MDEVOLVED_PROOF_TOKEN: target.localBearer }
              : process.env,
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
        for (const line of lines) {
          if (!line.trim()) continue;
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
        reject(new Error("codex_unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0 || pending.trim())
          reject(new Error(failure ?? "codex_failed"));
        else resolve();
      });
      child.stdin.end(prompt);
    });
    return collector.evidence;
  } finally {
    // Only this mkdtemp-owned, synthetic directory is removed.
    await rm(cwd, { recursive: true, force: true });
  }
}

function healthy(run) {
  return Boolean(
    run?.completed &&
    !run.failed &&
    !run.forbidden &&
    typeof run.threadId === "string" &&
    run.threadId &&
    run.answer,
  );
}

function scopedCalls(run, projectId) {
  return (
    run.calls.length > 0 &&
    run.calls.every(
      (call) =>
        TOOLS.includes(call.tool) &&
        call.arguments?.projectId === projectId &&
        call.data?.ok === true,
    )
  );
}

function boundCheckpoint(run, projectId) {
  let base;
  let checkpoints = 0;
  for (const call of run.calls) {
    if (call.tool === "mdevolved_resume") {
      if (
        !HASH.test(call.data?.checkpointBase ?? "") ||
        !HASH.test(call.data?.contextSha256 ?? "") ||
        call.data?.contextMode !== "focused" ||
        call.data?.context?.project?.projectId !== projectId
      )
        return false;
      base = call.data.checkpointBase;
    }
    if (call.tool === "mdevolved_checkpoint") {
      checkpoints++;
      const point = call.data?.checkpoint;
      if (
        !base ||
        call.arguments?.checkpointBase !== base ||
        !/^[A-Za-z0-9._~-]{16,128}$/u.test(
          call.arguments?.idempotencyKey ?? "",
        ) ||
        point?.projectId !== projectId ||
        !UUID.test(point?.continuityPointId ?? "") ||
        !HASH.test(point?.contentSha256 ?? "") ||
        !Number.isSafeInteger(point?.acknowledgedAt) ||
        point.acknowledgedAt < 0 ||
        !(
          point.previousContinuityPointId === null ||
          UUID.test(point.previousContinuityPointId ?? "")
        )
      )
        return false;
    }
  }
  return checkpoints === 1;
}

export function gradeProof({ control, seed, resumed, projectId, challenge }) {
  const checkpoint = seed.calls.find(
    (call) => call.tool === "mdevolved_checkpoint",
  )?.data?.checkpoint;
  const resume = resumed.calls.find(
    (call) => call.tool === "mdevolved_resume",
  )?.data;
  const finish = resumed.calls.find(
    (call) => call.tool === "mdevolved_checkpoint",
  )?.data?.checkpoint;
  const state = resume?.context?.currentState;
  const answer = resumed.answer;
  const checks = {
    freshProcesses:
      [control, seed, resumed].every(healthy) &&
      new Set([control.threadId, seed.threadId, resumed.threadId]).size === 3,
    controlDoesNotInvent:
      healthy(control) &&
      control.calls.length === 0 &&
      control.answer.status === "blocked" &&
      control.answer.threshold === null &&
      control.answer.route === "unknown" &&
      control.answer.checkpointId === "" &&
      control.answer.avoided === "" &&
      control.answer.nextAction === "",
    exactScope: scopedCalls(seed, projectId) && scopedCalls(resumed, projectId),
    resumeFirst:
      seed.calls[0]?.tool === "mdevolved_resume" &&
      resumed.calls[0]?.tool === "mdevolved_resume",
    durableCheckpoint:
      seed.answer?.status === "completed" &&
      checkpoint?.projectId === projectId &&
      UUID.test(checkpoint?.continuityPointId ?? "") &&
      HASH.test(checkpoint?.contentSha256 ?? "") &&
      seed.answer?.checkpointId === checkpoint?.continuityPointId,
    checkpointBasesBound:
      boundCheckpoint(seed, projectId) && boundCheckpoint(resumed, projectId),
    serverReadback:
      resume?.context?.project?.projectId === projectId &&
      HASH.test(resume?.contextSha256 ?? "") &&
      (state?.completedWork ?? []).some(
        (text) =>
          text.includes(challenge.marker) &&
          text.includes(String(challenge.threshold)),
      ) &&
      state?.knownRejectedApproaches?.includes(challenge.failure) &&
      state?.nextAction === challenge.nextAction,
    correctContinuation:
      answer?.status === "completed" &&
      answer.threshold === challenge.threshold &&
      answer.route ===
        (challenge.count >= challenge.threshold ? "express" : "standard") &&
      answer.avoided === challenge.failure &&
      answer.nextAction === challenge.nextAction,
    successorCheckpoint:
      finish?.projectId === projectId &&
      UUID.test(finish?.continuityPointId ?? "") &&
      finish.continuityPointId !== checkpoint?.continuityPointId &&
      HASH.test(finish?.contentSha256 ?? "") &&
      finish?.previousContinuityPointId === checkpoint?.continuityPointId &&
      answer?.checkpointId === finish?.continuityPointId,
  };
  return {
    format: "mdevolved-codex-proof-v1",
    evidenceKind: "live-codex-mcp",
    passed: Object.values(checks).every(Boolean),
    checks,
    limits: [
      "synthetic prompted checkpoint",
      "same provider and authorized client",
      "no subscription cancelled",
      "not a filesystem isolation certification",
      "no cross-provider or usability certification",
    ],
  };
}

export async function executeProof(target, run = runCodex) {
  const challenge = createChallenge();
  const prompt = prompts(target.projectId, challenge);
  const control = await run({
    target,
    prompt: prompt.control,
    connected: false,
  });
  if (!healthy(control)) throw new Error("control_failed");
  const seed = await run({ target, prompt: prompt.seed, connected: true });
  if (
    !healthy(seed) ||
    !scopedCalls(seed, target.projectId) ||
    !seed.calls.some(
      (call) =>
        call.tool === "mdevolved_checkpoint" &&
        call.data?.checkpoint?.projectId === target.projectId,
    )
  )
    throw new Error("seed_failed");
  const resumed = await run({ target, prompt: prompt.resume, connected: true });
  return gradeProof({
    control,
    seed,
    resumed,
    projectId: target.projectId,
    challenge,
  });
}
