import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative } from "node:path";

const root = new URL("../", import.meta.url);
const ignoredDirectories = new Set([
  ".git",
  ".wrangler",
  "dist",
  "node_modules",
  "vendor",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const forbiddenPatterns = [
  {
    label: "TypeScript any",
    pattern: /:\s*any\b|<any>|as\s+any\b/,
    extensions: new Set([".ts", ".tsx"]),
  },
  {
    label: "@ts-ignore",
    pattern: /@ts-ignore/,
    extensions: new Set([".ts", ".tsx"]),
  },
  {
    label: "unsafe double assertion",
    pattern: /\bas\s+unknown\s+as\b/,
    extensions: new Set([".ts", ".tsx"]),
  },
  {
    label: "floating work marker",
    pattern: new RegExp("\\bTO" + "DO\\b|\\bFIX" + "ME\\b"),
  },
  {
    label: "committed secret-style assignment",
    pattern:
      /\b(?:API_KEY|AUTH_TOKEN|PRIVATE_KEY|CLIENT_SECRET|SESSION_SECRET)\s*=\s*["'][^"']+["']/,
  },
];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const entryUrl = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...(await collect(entryUrl)));
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(entryUrl);
    }
  }

  return files;
}

const failures = [];

const topologyUrl = new URL("repository-topology.json", root);
const topology = JSON.parse(await readFile(topologyUrl, "utf8"));
const rootPackage = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);

if (topology.schemaVersion !== 1) {
  failures.push("repository-topology.json: unsupported schema version");
}

if (topology.managed.requiredByCommunity !== false) {
  failures.push("repository-topology.json: Community must not require managed");
}

if (topology.managed.isolationModel !== "one-owner-per-cell") {
  failures.push(
    "repository-topology.json: managed isolation must remain one-owner-per-cell",
  );
}

if (rootPackage.private !== true || rootPackage.license !== "Apache-2.0") {
  failures.push(
    "package.json: root must stay private-to-the-registry and Apache-2.0 licensed",
  );
}

for (const requiredPath of topology.community.requiredPaths) {
  try {
    await access(new URL(requiredPath, root));
  } catch {
    failures.push(`${requiredPath}: required Community path is missing`);
  }
}

for (const manifestPath of topology.community.packageManifests) {
  const manifest = JSON.parse(
    await readFile(new URL(manifestPath, root), "utf8"),
  );
  const dependencyGroups = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];

  for (const dependencies of dependencyGroups) {
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      if (
        topology.community.forbiddenDependencyPrefixes.some((prefix) =>
          dependencyName.startsWith(prefix),
        )
      ) {
        failures.push(
          `${manifestPath}: Community package depends on managed code ${dependencyName}`,
        );
      }
    }
  }
}

const communityPackageRoots = topology.community.packageManifests.map((path) =>
  dirname(path),
);

for (const file of await collect(root)) {
  if (file.pathname.endsWith("/worker-configuration.d.ts")) {
    continue;
  }

  const contents = await readFile(file, "utf8");
  const displayPath = relative(root.pathname, file.pathname);
  const extension = extname(file.pathname);

  if (
    communityPackageRoots.some((path) => displayPath.startsWith(`${path}/`)) &&
    [
      "@owd/control-plane",
      "@owd/managed-",
      "../control-plane",
      "/apps/control-plane",
    ].some((managedReference) => contents.includes(managedReference))
  ) {
    failures.push(`${displayPath}: Community source references managed code`);
  }

  for (const rule of forbiddenPatterns) {
    if (
      (!rule.extensions || rule.extensions.has(extension)) &&
      rule.pattern.test(contents)
    ) {
      failures.push(`${displayPath}: ${rule.label}`);
    }
  }
}

if (failures.length > 0) {
  console.error(["Repository policy check failed:", ...failures].join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repository policy check passed.");
}
