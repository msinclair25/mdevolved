import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { unstable_splitSqlQuery } from "wrangler";

const CORE_VERSION = "1.0.0-alpha.7";
const corePackages = [
  "package.json",
  "apps/web/package.json",
  "apps/worker/package.json",
  "packages/client-packs/package.json",
  "packages/contracts/package.json",
  "packages/yaos-core/package.json",
];
const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
const platformRepositoryUrl = "https://github.com/msinclair25/mdevolved";
const publicDeployUrl = `https://deploy.workers.cloudflare.com/?url=${platformRepositoryUrl}`;

for (const filename of corePackages) {
  const value = JSON.parse(await readFile(filename, "utf8"));
  if (value.version !== CORE_VERSION) {
    throw new Error(
      `${filename} must use Community core version ${CORE_VERSION}; found ${String(value.version)}.`,
    );
  }
}

if (
  rootPackage.scripts?.["db:migrations:apply"] !==
    "wrangler d1 migrations apply DB --remote" ||
  rootPackage.scripts?.deploy !==
    "pnpm build && pnpm db:migrations:apply && wrangler deploy" ||
  rootPackage.scripts?.["deploy:manual"] !== "pnpm deploy" ||
  rootPackage.scripts?.build !== "pnpm package:plugin && pnpm build:web" ||
  rootPackage.scripts?.["release:check"] !==
    "node --test scripts/plugin-release-tag-policy.test.mjs scripts/mdevolved-release-contract.test.mjs && pnpm package:plugin && node scripts/check-release-contract.mjs && node scripts/check-release-regressions.mjs"
) {
  throw new Error(
    "Release scripts must rebuild the exact web/plugin source, apply every D1 migration, and only then deploy the Worker.",
  );
}

const rootReadme = await readFile("README.md", "utf8");
const pluginReadme = await readFile(
  "packages/obsidian-plugin/README.md",
  "utf8",
);
const marketingSite = await readFile("apps/marketing/index.html", "utf8");
const marketingReadme = await readFile("apps/marketing/README.md", "utf8");
const marketingWrangler = await readFile(
  "apps/marketing/wrangler.jsonc",
  "utf8",
);
const marketingWorker = await readFile("apps/marketing/src/worker.ts", "utf8");
const marketingManifest = await readFile(
  "apps/marketing/public/site.webmanifest",
  "utf8",
);
await readFile("apps/marketing/public/og-mdevolved.png");
const releaseCompatibility = await readFile(
  "docs/RELEASE-COMPATIBILITY.md",
  "utf8",
);
const eveCompatibility = await readFile("docs/EVE-COMPATIBILITY.md", "utf8");
const albatrossCompatibility = await readFile(
  "docs/ALBATROSS-COMPATIBILITY.md",
  "utf8",
);
const pluginSettings = await readFile(
  "packages/obsidian-plugin/vendor/yaos-src/settings/settingsTab.ts",
  "utf8",
);
const normalizedRootReadme = rootReadme.replace(/\s+/gu, " ");
const normalizedMarketingReadme = marketingReadme.replace(/\s+/gu, " ");
const normalizedAlbatrossCompatibility = albatrossCompatibility.replace(
  /\s+/gu,
  " ",
);
const normalizedMarketingSite = marketingSite
  .replace(/<[^>]+>/gu, " ")
  .replace(/\s+/gu, " ");
const canonicalPromise = "Every AI. One durable Project memory.";

if (
  !normalizedRootReadme.includes(canonicalPromise) ||
  !normalizedMarketingSite.includes(canonicalPromise) ||
  !normalizedMarketingReadme.includes(canonicalPromise) ||
  !marketingSite.includes("/og-mdevolved.png") ||
  !marketingManifest.includes(
    "Source-independent, owner-controlled Project memory",
  ) ||
  normalizedMarketingSite.includes(
    "Turn the agents you already use into a team",
  ) ||
  marketingManifest.includes("into a team")
) {
  throw new Error(
    "MDevolved public copy must preserve the approved source-independent Project-memory promise and must not regress to generic AI-team positioning.",
  );
}
if (
  !eveCompatibility.includes(
    "This is a source-verified compatibility profile",
  ) ||
  !eveCompatibility.includes("| Eve               | `0.29.4`") ||
  !eveCompatibility.includes("| `@vercel/connect` | `0.6.0`") ||
  !marketingSite.includes('id="eve"') ||
  !normalizedMarketingSite.includes(
    "Eve runs the agent. MDevolved makes the work portable.",
  ) ||
  !normalizedMarketingSite.includes("Source-verified Eve.dev integration") ||
  !normalizedMarketingSite.includes("No custom transport")
) {
  throw new Error(
    "MDevolved public copy must keep the source-verified Eve.dev integration visible without claiming a custom transport or completed live acceptance.",
  );
}
if (
  !albatrossCompatibility.includes(
    "This is a source-verified compatibility profile",
  ) ||
  !albatrossCompatibility.includes("| Albatross               | `2.0.3`") ||
  !albatrossCompatibility.includes(
    "| Temporary MCP bridge    | `mcp-remote` `0.1.38`",
  ) ||
  !normalizedAlbatrossCompatibility.includes(
    "It does not claim vendor certification or a completed live Albatross acceptance run",
  ) ||
  !releaseCompatibility.includes("| Albatross profile") ||
  !releaseCompatibility.includes("`0543226b800ee57659f200c1ef928925868c90c9`")
) {
  throw new Error(
    "MDevolved public copy must keep the source-verified Albatross profile visible, pin its temporary bridge, and avoid claiming completed live acceptance.",
  );
}
if (
  !marketingSite.includes('action="/api/alpha-access"') ||
  !marketingSite.includes("data-alpha-form") ||
  !marketingSite.includes("support@mdevolved.com") ||
  !marketingWrangler.includes('"allowed_destination_addresses": [') ||
  !marketingWrangler.includes('"support@mdevolved.com"') ||
  !marketingWrangler.includes('"allowed_sender_addresses": [') ||
  !marketingWrangler.includes('"alpha@mdevolved.com"') ||
  !marketingWrangler.includes('"run_worker_first": ["/api/*"]') ||
  !marketingWorker.includes('const SUPPORT_EMAIL = "support@mdevolved.com"') ||
  !marketingWorker.includes('const SENDER_EMAIL = "alpha@mdevolved.com"')
) {
  throw new Error(
    "The public alpha request must keep its same-origin form endpoint and fixed Cloudflare Email Service sender/destination restrictions.",
  );
}
if (
  !releaseCompatibility.includes("`open_project`") ||
  !releaseCompatibility.includes("Project lifecycle") ||
  !releaseCompatibility.includes("`owd-snapshot-v2`")
) {
  throw new Error(
    "The compatibility contract must describe the current Project and recovery runtime.",
  );
}

if (
  !normalizedRootReadme.includes(
    "complete Apache-2.0 Community source is public",
  ) ||
  !rootReadme.includes(publicDeployUrl) ||
  !normalizedRootReadme.includes("managed service remains invitation-only")
) {
  throw new Error(
    "The public README must expose Community deployment and distinguish the invitation-only managed alpha.",
  );
}
if (
  !pluginReadme.includes("temporary direct desktop installer") ||
  pluginReadme.includes("/blob/main/docs/TRUSTED-TESTER-START.md") ||
  pluginReadme.includes("deploys the private MDevolved Platform fork")
) {
  throw new Error(
    "MDevolved Sync alpha guidance must use the version-matched desktop installer without a private repository handoff.",
  );
}
if (
  !pluginSettings.includes(publicDeployUrl) ||
  pluginSettings.includes(`${platformRepositoryUrl}/tree/`) ||
  pluginSettings.includes(`${platformRepositoryUrl}/blob/`)
) {
  throw new Error(
    `The future plugin Deploy MDevolved action must retain cloneable source ${platformRepositoryUrl}.`,
  );
}

const wrangler = await readFile("wrangler.jsonc", "utf8");
const legacyWrangler = await readFile("wrangler.legacy.jsonc", "utf8");
if (!wrangler.includes(`"APP_VERSION": "${CORE_VERSION}"`)) {
  throw new Error(`wrangler.jsonc must expose APP_VERSION ${CORE_VERSION}.`);
}
if (
  !wrangler.includes('"name": "mdevolved-community"') ||
  !wrangler.includes('"database_name": "mdevolved-community-db"') ||
  !wrangler.includes('"bucket_name": "mdevolved-community-sources"') ||
  !legacyWrangler.includes('"name": "owd-platform"') ||
  !legacyWrangler.includes('"database_name": "owd-platform-db"') ||
  !legacyWrangler.includes('"bucket_name": "owd-platform-vaults"')
) {
  throw new Error(
    "Fresh Community installs must use canonical MDevolved resources while existing cells retain the explicit legacy config.",
  );
}

const generatedBindings = await readFile(
  "apps/worker/src/worker-configuration.d.ts",
  "utf8",
);
if (!generatedBindings.includes(`APP_VERSION: "${CORE_VERSION}"`)) {
  throw new Error(
    `Generated Worker bindings must expose APP_VERSION ${CORE_VERSION}.`,
  );
}

const migrationFiles = (await readdir("migrations"))
  .filter((filename) => filename.endsWith(".sql"))
  .sort()
  .map((filename) => `migrations/${filename}`);
for (const filename of migrationFiles) {
  const source = await readFile(filename, "utf8");
  for (const statement of unstable_splitSqlQuery(source)) {
    if (
      /^\s*CREATE\s+TRIGGER\b/iu.test(statement) &&
      !statement.trimEnd().endsWith(";")
    ) {
      throw new Error(
        `${filename} contains a CREATE TRIGGER statement that Wrangler will send to remote D1 without its terminating semicolon.`,
      );
    }
  }
}

const pluginPackage = JSON.parse(
  await readFile("packages/obsidian-plugin/package.json", "utf8"),
);
const pluginManifest = JSON.parse(
  await readFile("packages/obsidian-plugin/manifest.json", "utf8"),
);
const pluginVersions = JSON.parse(
  await readFile("packages/obsidian-plugin/versions.json", "utf8"),
);
const pluginLinks = await readFile(
  "apps/web/src/obsidian-plugin-links.ts",
  "utf8",
);
const pluginInstaller = await readFile(
  "apps/web/src/obsidian-plugin-installer.ts",
  "utf8",
);
const pluginPackager = await readFile(
  "packages/obsidian-plugin/scripts/package-release.mjs",
  "utf8",
);
const webViteConfig = await readFile("apps/web/vite.config.ts", "utf8");
if (
  pluginPackage.version !== pluginManifest.version ||
  pluginVersions[pluginManifest.version] !== pluginManifest.minAppVersion
) {
  throw new Error(
    "MDevolved Sync package, manifest, and Obsidian minimum-version metadata disagree.",
  );
}
if (
  !pluginLinks.includes(
    `export const MDEVOLVED_SYNC_REQUIRED_VERSION = "${pluginManifest.version}"`,
  )
) {
  throw new Error(
    "The tester installer must display the exact compatible MDevolved Sync version.",
  );
}
if (
  !pluginPackager.includes("assertPluginPackagingRef({") ||
  !pluginPackager.includes("coreVersion: corePackage.version") ||
  !pluginPackager.includes("manifestVersion: manifest.version")
) {
  throw new Error(
    "MDevolved Sync packaging must apply the tested namespace-aware tag policy.",
  );
}

const installerAssetNames = ["main.js", "manifest.json", "styles.css"];
const installerAssets = await Promise.all(
  installerAssetNames.map(async (name) => {
    const bytes = await readFile(`packages/obsidian-plugin/release/${name}`);
    return {
      bytes: bytes.byteLength,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const packagedPluginManifest = JSON.parse(
  await readFile("packages/obsidian-plugin/release/manifest.json", "utf8"),
);
const packagedChecksums = await readFile(
  "packages/obsidian-plugin/release/checksums.txt",
  "utf8",
);
if (
  packagedPluginManifest.id !== pluginManifest.id ||
  packagedPluginManifest.version !== pluginManifest.version
) {
  throw new Error(
    "The packaged MDevolved Sync release does not match the source plugin identity and version.",
  );
}
if (
  !pluginInstaller.includes("mdevolved-sync-web-installer-v1") ||
  !pluginInstaller.includes(
    "`/mdevolved-sync/${MDEVOLVED_SYNC_REQUIRED_VERSION}`",
  ) ||
  !webViteConfig.includes("../../packages/obsidian-plugin/release/") ||
  !webViteConfig.includes("installer-manifest.json") ||
  installerAssetNames.some(
    (name) =>
      !pluginInstaller.includes(`"${name}"`) ||
      !webViteConfig.includes(`"${name}"`),
  )
) {
  throw new Error(
    "The web installer must bundle the exact versioned MDevolved Sync release asset set.",
  );
}
if (
  installerAssets.some(
    (asset) =>
      asset.bytes <= 0 ||
      asset.bytes > 2 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      !packagedChecksums.includes(`${asset.sha256}  ${asset.name}`),
  )
) {
  throw new Error(
    "An MDevolved Sync web-installer asset is empty, oversized, or disagrees with the packaged checksums.",
  );
}

console.log(
  `Release contract verified: Community ${CORE_VERSION}, MDevolved Sync ${pluginManifest.version}, direct installer ${installerAssets.length} hashed assets.`,
);
