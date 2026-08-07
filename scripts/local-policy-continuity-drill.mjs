import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYNTHETIC_LOCAL_DRILL_INPUT,
  runDisposablePolicyContinuityDrill,
} from "./local-policy-continuity-drill-lib.mjs";

const workspaceRoot = await mkdtemp(
  join(tmpdir(), "owd-r4-local-drill-parent-"),
);
const drillRoot = join(workspaceRoot, "disposable-drill");
let receipt;
try {
  receipt = await runDisposablePolicyContinuityDrill({
    ...SYNTHETIC_LOCAL_DRILL_INPUT,
    workspaceRoot: drillRoot,
  });
} finally {
  await rm(workspaceRoot, { force: true, recursive: true });
}
process.stdout.write(`${JSON.stringify(receipt)}\n`);
