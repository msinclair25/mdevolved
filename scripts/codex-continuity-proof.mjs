import { parseArgs } from "node:util";
import { executeProof, validateTarget } from "./codex-continuity-proof-lib.mjs";

const HELP = `Codex fresh-session continuity proof (three Codex sessions, no automatic retries).
Prerequisite: normal Codex OAuth and an explicitly approved disposable synthetic
MDevolved Project, with project.read/project.lead authority, on server mdevolved-proof.
Usage: node scripts/codex-continuity-proof.mjs --live --allow-model-usage
  --disposable-project UUID --url https://YOUR-HOST/mcp --model YOUR-CODEX-MODEL
Writes two synthetic checkpoints remotely. Does not cancel a subscription,
change grants, deploy, save transcripts, or configure your Codex installation.
Per-process timeout: 120 seconds. This is not a hard token/dollar spending cap.
Without both explicit opt-ins no model or remote service is called.
See docs/CODEX-CONTINUITY-PROOF.md for setup and limitations.`;

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      live: { type: "boolean" },
      "allow-model-usage": { type: "boolean" },
      "disposable-project": { type: "string" },
      url: { type: "string" },
      model: { type: "string" },
    },
  });
  if (values.help || process.argv.length === 2) console.log(HELP);
  else {
    if (!values.live || !values["allow-model-usage"])
      throw new Error("opt_in_required");
    const target = validateTarget({
      url: values.url,
      projectId: values["disposable-project"],
      model: values.model,
    });
    const receipt = await executeProof(target);
    console.log(JSON.stringify(receipt, null, 2));
    if (!receipt.passed) process.exitCode = 1;
  }
} catch (error) {
  // Do not echo CLI arguments, model stderr, endpoints, or remote payloads.
  const safeCodes = new Set([
    "invalid_target",
    "opt_in_required",
    "control_failed",
    "seed_failed",
    "session_timeout",
    "output_budget_exceeded",
    "invalid_event_stream",
    "stdin_failed",
    "codex_unavailable",
    "codex_failed",
  ]);
  console.error(
    JSON.stringify({
      format: "mdevolved-codex-proof-v1",
      passed: false,
      status: "blocked-or-failed",
      errorCode: safeCodes.has(error?.message)
        ? error.message
        : "invalid_configuration_or_evidence",
      message:
        "Proof not established. Check documented prerequisites and CLI compatibility; no raw diagnostics retained.",
    }),
  );
  process.exitCode = 1;
}
