import { parseArgs } from "node:util";
import { executeProof, runCodex } from "./codex-continuity-proof-lib.mjs";
import { startLocalProof } from "./codex-proof-local.mjs";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    "allow-model-usage": { type: "boolean" },
    help: { type: "boolean" },
    smoke: { type: "boolean" },
  },
});
if (values.help || process.argv.length === 2) {
  console.log(
    "Usage: pnpm proof:codex:local --allow-model-usage --model YOUR-MODEL\nOr --smoke for local setup only, no model usage. Synthetic local Worker; no passkeys, cloud setup, or production writes.",
  );
} else {
  let local;
  try {
    if (
      !values.smoke &&
      (!values["allow-model-usage"] ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(values.model ?? ""))
    )
      throw new Error("explicit_model_usage_required");
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
      : await executeProof(
          {
            model: values.model,
            url: local.url,
            projectId: local.projectId,
            localBearer: local.bearerToken,
          },
          async (input) => {
            const result = await runCodex(input);
            console.error(
              JSON.stringify({
                session: input.connected ? "connected" : "control",
                completed: result.completed,
                failed: result.failed,
                forbidden: result.forbidden,
                unexpectedItemTypes: result.unexpectedItemTypes,
                answerStatus: result.answer?.status,
                calls: result.calls.map((call) => ({
                  tool: call.tool,
                  exactProject: call.arguments?.projectId === local.projectId,
                  ok: call.data?.ok === true,
                })),
              }),
            );
            return result;
          },
        );
    console.log(
      JSON.stringify(
        {
          ...receipt,
          environment: "disposable-local-worker",
          authentication: "synthetic-owner-session-and-real-oauth",
          productionTouched: false,
        },
        null,
        2,
      ),
    );
    if (!receipt.passed) process.exitCode = 1;
  } catch (error) {
    const code = /^[a-z_]+$/u.test(error?.message ?? "")
      ? error.message
      : "local_setup_failed";
    console.error(JSON.stringify({ passed: false, errorCode: code }));
    process.exitCode = 1;
  } finally {
    if (local) console.error(JSON.stringify({ transport: local.transport }));
    await local?.close();
  }
}
