import assert from "node:assert/strict";
import test from "node:test";

import {
  loadConfiguration,
  matchesCriticalPath,
  renderProfileReport,
  validateEvidence,
} from "./check-upstream-compatibility.mjs";

test("loads one reviewed profile for each supported upstream", async () => {
  const configuration = await loadConfiguration();
  assert.deepEqual(
    configuration.profiles.map((profile) => profile.id),
    ["obsidian-mind", "eve"],
  );
  await validateEvidence(configuration);
});

test("matches configured compatibility paths without widening directories", () => {
  const patterns = [
    ".claude/scripts/lib/mcp-*.ts",
    "packages/eve/src/runtime/connections/**",
  ];
  assert.equal(
    matchesCriticalPath(".claude/scripts/lib/mcp-server.ts", patterns),
    true,
  );
  assert.equal(
    matchesCriticalPath(
      "packages/eve/src/runtime/connections/auth/provider.ts",
      patterns,
    ),
    true,
  );
  assert.equal(
    matchesCriticalPath("packages/eve/src/runtime/session.ts", patterns),
    false,
  );
});

test("renders a single stable review issue with critical source paths", () => {
  const report = renderProfileReport({
    id: "eve",
    name: "Eve.dev",
    reviewedAt: "2026-07-30",
    drift: true,
    source: {
      kind: "github-release",
      drift: true,
      reviewedTag: "eve@0.29.2",
      reviewedCommit: "a".repeat(40),
      latestTag: "eve@0.30.0",
      latestCommit: "b".repeat(40),
      releaseUrl: "https://github.com/vercel/eve/releases/tag/eve%400.30.0",
      compareUrl: "https://github.com/vercel/eve/compare/a...b",
      compareIncomplete: false,
      changedFiles: ["packages/eve/src/runtime/connections/types.ts"],
      criticalFiles: ["packages/eve/src/runtime/connections/types.ts"],
    },
    dependencies: [
      {
        kind: "npm",
        package: "@vercel/connect",
        drift: false,
        reviewedVersion: "0.6.0",
        latestVersion: "0.6.0",
        packageUrl: "https://www.npmjs.com/package/@vercel/connect",
      },
    ],
  });
  assert.match(report, /<!-- owd-upstream:eve -->/u);
  assert.match(report, /Compatibility-critical paths changed/u);
  assert.match(report, /never auto-advances an OWD compatibility claim/u);
});
