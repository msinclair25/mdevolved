import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeprovisionPlan,
  hashManifestSource,
  hashMigrationLedger,
  validateCellBuildManifest,
  validateEmptyRateLimitRegistryAfterCleanup,
  validateRateLimitRegistry,
} from "./cell-lifecycle-manifest-lib.mjs";

const exampleSource = await readFile(
  "infra/managed/examples/disposable-cell-build.example.json",
  "utf8",
);
const example = JSON.parse(exampleSource);
const registry = JSON.parse(
  await readFile(
    "infra/managed/examples/active-cell-registry.example.json",
    "utf8",
  ),
);
const migrationFiles = (await readdir("migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationEntries = await Promise.all(
  migrationFiles.map(async (name) => ({
    name,
    contents: await readFile(`migrations/${name}`, "utf8"),
  })),
);
const expectations = {
  communityVersion: "1.0.0-alpha.5",
  compatibilityDate: "2026-07-26",
  migrationFiles,
  migrationLedgerSha256: hashMigrationLedger(migrationEntries),
};

function copy() {
  return structuredClone(example);
}

test("accepts the complete synthetic build manifest", () => {
  assert.equal(
    validateCellBuildManifest(copy(), expectations).format,
    example.format,
  );
  assert.equal(
    validateRateLimitRegistry(
      structuredClone(registry),
      copy(),
      hashManifestSource(exampleSource),
    ).format,
    registry.format,
  );
});

test("fails closed when an unlisted secret-shaped field is present", () => {
  const candidate = copy();
  candidate.cloudflare.secretValue = "must-never-be-recorded";
  assert.throws(
    () => validateCellBuildManifest(candidate, expectations),
    /public JSON schema/u,
  );
});

test("fails closed when migration provenance is incomplete", () => {
  const candidate = copy();
  candidate.release.appliedMigrations.pop();
  assert.throws(
    () => validateCellBuildManifest(candidate, expectations),
    /complete ledger/u,
  );
});

test("fails closed when a disposable cell has no explicit data disposition", () => {
  const candidate = copy();
  delete candidate.deprovision.authorizedDisposition;
  assert.throws(
    () => createDeprovisionPlan(candidate, { expectations }),
    /requires an authorized disposition/u,
  );
});

test("accepts an empty account registry after the last cell is removed", () => {
  const emptyRegistry = structuredClone(registry);
  emptyRegistry.reservations = [];
  assert.throws(
    () =>
      validateRateLimitRegistry(
        emptyRegistry,
        copy(),
        hashManifestSource(exampleSource),
      ),
    /no reservation for this cell/u,
  );
  assert.doesNotThrow(() =>
    validateEmptyRateLimitRegistryAfterCleanup(emptyRegistry, {
      phase: "post-delete-absence-verified",
      accountId: emptyRegistry.accountId,
      verifiedAt: "2026-08-06T00:01:00.000Z",
      absenceReceiptSha256:
        "8888888888888888888888888888888888888888888888888888888888888888",
    }),
  );
});

test("ordinary CLI checks reject an empty account registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "owd-cell-registry-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const registryPath = join(directory, "empty-registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({ ...registry, reservations: [] }),
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    [
      "scripts/cell-lifecycle-manifest.mjs",
      "check",
      "infra/managed/examples/disposable-cell-build.example.json",
      "--registry",
      registryPath,
      "--fixture",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no reservation for this cell/u);
});

test("public schema and semantic checks fail closed on hostile shapes", () => {
  const nilVersionId = copy();
  nilVersionId.cloudflare.worker.versionId =
    "00000000-0000-0000-0000-000000000000";
  assert.throws(
    () => validateCellBuildManifest(nilVersionId, expectations),
    /public JSON schema/u,
  );

  const uppercaseWorker = copy();
  uppercaseWorker.cloudflare.worker.name = "OWD-CELL-SYNTHETIC01";
  assert.throws(
    () => validateCellBuildManifest(uppercaseWorker, expectations),
    /public JSON schema/u,
  );

  const uppercaseBucket = copy();
  uppercaseBucket.cloudflare.r2.bucket = "OWD-CELL-SYNTHETIC01-VAULTS";
  assert.throws(
    () => validateCellBuildManifest(uppercaseBucket, expectations),
    /public JSON schema/u,
  );

  const badDate = copy();
  badDate.release.compatibilityDate = "2026-02-31";
  assert.throws(
    () => validateCellBuildManifest(badDate, expectations),
    /public JSON schema/u,
  );

  const duplicateDomain = copy();
  duplicateDomain.cloudflare.worker.customDomains.push({
    ...duplicateDomain.cloudflare.worker.customDomains[0],
    domainId: "3333333333333333333333333333333333333333",
  });
  assert.throws(
    () => validateCellBuildManifest(duplicateDomain, expectations),
    /hostnames must be unique/u,
  );

  const mismatchedDeletion = copy();
  mismatchedDeletion.deprovision.deleteAfter = "2026-08-12T00:00:00.000Z";
  assert.throws(
    () => validateCellBuildManifest(mismatchedDeletion, expectations),
    /must equal expiresAt/u,
  );
});

test("pre-invitation checks reject an expired manifest", () => {
  assert.throws(
    () =>
      validateCellBuildManifest(copy(), {
        ...expectations,
        now: Date.parse("2026-08-14T00:00:00.000Z"),
        requireFutureExpiry: true,
      }),
    /must be in the future/u,
  );
});

test("account registry rejects a reused rate-limit namespace", () => {
  const candidateRegistry = structuredClone(registry);
  candidateRegistry.reservations.push({
    cellRef: "synthetic-cell-02",
    workerName: "owd-cell-synthetic02",
    manifestSha256:
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    namespaceIds: ["710001", "720002", "720003"],
    status: "active",
  });
  assert.throws(
    () =>
      validateRateLimitRegistry(
        candidateRegistry,
        copy(),
        hashManifestSource(exampleSource),
      ),
    /account-scoped rate-limit namespace IDs/u,
  );
});

test("managed cells reject Community rate-limit namespace defaults", () => {
  const candidate = copy();
  candidate.cloudflare.rateLimits[0].namespaceId = "1001";
  assert.throws(
    () => validateCellBuildManifest(candidate, expectations),
    /cannot reuse Community/u,
  );
});

test("pre-invitation registry checks reject stale reservations", () => {
  assert.throws(
    () =>
      validateRateLimitRegistry(
        structuredClone(registry),
        copy(),
        hashManifestSource(exampleSource),
        {
          now: Date.parse("2026-08-06T00:16:00.000Z"),
          requireFresh: true,
        },
      ),
    /refreshed within 15 minutes/u,
  );
});

test("fails closed when a cell records no reachable hostname", () => {
  const candidate = copy();
  candidate.cloudflare.worker.customDomains = [];
  assert.throws(
    () => validateCellBuildManifest(candidate, expectations),
    /reachable route/u,
  );
});

test("redacts every resource target unless explicitly revealed", () => {
  const redacted = JSON.stringify(
    createDeprovisionPlan(copy(), { expectations }),
  );
  assert.equal(redacted.includes(example.cloudflare.worker.name), false);
  assert.equal(redacted.includes(example.cloudflare.d1.name), false);
  assert.equal(redacted.includes(example.cloudflare.r2.bucket), false);
  assert.equal(redacted.includes(example.cloudflare.kv.id), false);
  assert.equal(redacted.includes(example.cloudflare.secretNames[0]), false);
  assert.equal(
    redacted.includes(
      example.deprovision.authorizedDisposition.authorizationReceiptSha256,
    ),
    false,
  );
  assert.match(redacted, /sha256:[0-9a-f]{12}/u);
  assert.match(redacted, /delete-secret-before-worker/u);
  assert.match(redacted, /verify-worker-secret-list-is-absent/u);
  assert.match(redacted, /forceRequired/u);

  const revealedPlan = createDeprovisionPlan(copy(), {
    expectations,
    showTargets: true,
  });
  const revealed = JSON.stringify(revealedPlan);
  assert.equal(revealed.includes(example.cloudflare.worker.name), true);
  assert.equal(revealed.includes(example.cloudflare.d1.name), true);
  assert.equal(revealedPlan.accountRef, example.cloudflare.accountId);
  assert.equal(
    revealedPlan.authorizedDisposition.authorizationReceipt,
    example.deprovision.authorizedDisposition.authorizationReceiptSha256,
  );
  assert.equal(
    revealedPlan.actions.find((action) => action.kind === "worker")
      ?.forceRequired,
    true,
  );
});
