import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDeprovisionPlan,
  hashManifestSource,
  hashMigrationLedger,
  validateCellBuildManifest,
  validateRateLimitRegistry,
} from "./cell-lifecycle-manifest-lib.mjs";

const [action, manifestPath, ...flags] = process.argv.slice(2);
const showTargets = flags.includes("--show-targets");
const fixtureMode = flags.includes("--fixture");
const registryFlagIndex = flags.indexOf("--registry");
const registryPath =
  registryFlagIndex === -1 ? undefined : flags[registryFlagIndex + 1];
const consumedFlags = new Set([
  ...(showTargets ? ["--show-targets"] : []),
  ...(fixtureMode ? ["--fixture"] : []),
  ...(registryPath ? ["--registry", registryPath] : []),
]);
const unknownFlags = flags.filter((flag) => !consumedFlags.has(flag));
if (!action || !manifestPath || !["check", "plan"].includes(action)) {
  console.error(
    "Usage: node scripts/cell-lifecycle-manifest.mjs <check|plan> <manifest.json> [--registry <registry.json>] [--show-targets]",
  );
  process.exitCode = 2;
} else if (
  unknownFlags.length > 0 ||
  (registryFlagIndex !== -1 && !registryPath) ||
  (showTargets && action !== "plan") ||
  (fixtureMode &&
    (action !== "check" ||
      resolve(manifestPath) !==
        resolve("infra/managed/examples/disposable-cell-build.example.json")))
) {
  throw new Error("Unsupported or incomplete lifecycle-manifest option.");
} else {
  const source = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > 131_072) {
    throw new Error("Managed cell build manifests are limited to 128 KiB.");
  }
  const manifest = JSON.parse(source);
  const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
  const wrangler = await readFile("wrangler.jsonc", "utf8");
  const compatibilityDate = wrangler.match(
    /"compatibility_date"\s*:\s*"([0-9]{4}-[0-9]{2}-[0-9]{2})"/u,
  )?.[1];
  if (!compatibilityDate) {
    throw new Error("wrangler.jsonc must contain one compatibility_date.");
  }
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
    communityVersion: rootPackage.version,
    compatibilityDate,
    migrationFiles,
    migrationLedgerSha256: hashMigrationLedger(migrationEntries),
    requireFutureExpiry: action === "check" && !fixtureMode,
  };
  validateCellBuildManifest(manifest, expectations);
  if (registryPath) {
    const registrySource = await readFile(registryPath, "utf8");
    if (Buffer.byteLength(registrySource, "utf8") > 131_072) {
      throw new Error("Managed rate-limit registries are limited to 128 KiB.");
    }
    validateRateLimitRegistry(
      JSON.parse(registrySource),
      manifest,
      hashManifestSource(source),
      { requireFresh: action === "check" && !fixtureMode },
    );
  } else if (action === "check") {
    throw new Error(
      "Pre-invitation checks require the complete account-scoped rate-limit registry.",
    );
  }
  if (action === "check") {
    console.log(
      `Managed cell build manifest and account-scoped rate-limit reservation are complete for ${rootPackage.version} (${migrationFiles.length} migrations).`,
    );
  } else {
    console.log(
      JSON.stringify(
        createDeprovisionPlan(manifest, {
          expectations,
          showTargets,
        }),
        null,
        2,
      ),
    );
  }
}
