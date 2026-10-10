import { parseArgs } from "node:util";
import { executeClaudeProof } from "./claude-continuity-proof-lib.mjs";

let local;
try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      model: { type: "string" },
      "allow-model-usage": { type: "boolean" },
      smoke: { type: "boolean" },
    },
  });
  if (values.help || process.argv.length === 2)
    console.log(
      "Usage: pnpm proof:claude:local --allow-model-usage --model sonnet\nRequires Claude Code signed in locally. Three fresh sessions; no passkey, production changes, or persistent MCP config. --smoke checks local setup without calling Claude.",
    );
  else {
    if (
      !values.smoke &&
      (!values["allow-model-usage"] ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(values.model ?? ""))
    )
      throw new Error("explicit_model_usage_required");
    const { startLocalProof } = await import("./codex-proof-local.mjs");
    local = await startLocalProof((stage) => console.error(stage));
    const receipt = values.smoke
      ? {
          passed:
            (
              await local.rpc("mdevolved_resume", {
                projectId: local.projectId,
                contextMode: "focused",
              })
            ).result?.structuredContent?.ok === true,
          evidenceKind: "local-setup-only-no-model",
        }
      : await executeClaudeProof({
          url: local.url,
          projectId: local.projectId,
          model: values.model,
          localBearer: local.bearerToken,
          takeCalls: local.takeCalls,
        });
    console.log(
      JSON.stringify(
        {
          ...receipt,
          environment: "disposable-local-worker",
          productionTouched: false,
        },
        null,
        2,
      ),
    );
    if (!receipt.passed) process.exitCode = 1;
  }
} catch (error) {
  const safe = new Set([
    "explicit_model_usage_required",
    "invalid_target",
    "unexpected_prior_calls",
    "control_failed",
    "seed_failed",
    "session_timeout",
    "output_budget_exceeded",
    "invalid_event_stream",
    "stdin_failed",
    "claude_unavailable",
    "claude_failed",
  ]);
  console.error(
    JSON.stringify({
      passed: false,
      errorCode: safe.has(error?.message)
        ? error.message
        : "local_setup_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await local?.close();
}
