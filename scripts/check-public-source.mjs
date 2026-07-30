import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const maxBuffer = 64 * 1024 * 1024;
const maxTextBlobBytes = 2 * 1024 * 1024;

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    cwd: root,
    maxBuffer,
    ...options,
  });
}

const forbiddenPaths = [
  {
    label: "environment file",
    pattern: /(^|\/)\.env(?:\.|$)/,
    allowed: /(^|\/)\.env\.example$/,
  },
  {
    label: "Wrangler local secret file",
    pattern: /(^|\/)\.dev\.vars(?:\.|$)/,
    allowed: /(^|\/)\.dev\.vars\.example$/,
  },
  {
    label: "Wrangler local state",
    pattern: /(^|\/)\.wrangler\//,
  },
  {
    label: "private fixture",
    pattern: /(^|\/)fixtures\/private\//,
  },
  {
    label: "local test vault",
    pattern: /(^|\/)test-vaults\/local\//,
  },
  {
    label: "portable snapshot or recovery identity",
    pattern: /\.(?:agekey|owdsnapshot)$/i,
  },
];

const forbiddenContents = [
  {
    label: "private key material",
    pattern:
      /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----|AGE-SECRET-KEY-1(?!EXAMPLE\b)[A-Z0-9]{32,}/,
  },
  {
    label: "committed Cloudflare account identifier",
    pattern: /\b(?:CLOUDFLARE_)?ACCOUNT_ID\s*[:=]\s*["']?[a-f0-9]{32}\b/i,
  },
  {
    label: "committed Cloudflare binding identifier",
    pattern: /\b(?:database_id|namespace_id)\s*[:=]\s*["'][a-f0-9]{32}["']/i,
  },
  {
    label: "credential-bearing URL",
    pattern:
      /https?:\/\/(?!user:password@[^\s/]+\.example\b)[^\s/:@]+:[^\s/@]+@[^\s/]+/i,
  },
  {
    label: "secret-style literal",
    pattern:
      /\b(?:API_KEY|AUTH_TOKEN|CLOUDFLARE_API_TOKEN|CLIENT_SECRET|SESSION_SECRET)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{16,}["']/,
  },
];

const { stdout: revisionOutput } = await git(["rev-list", "--all"]);
const revisions = revisionOutput.trim().split("\n").filter(Boolean);
if (revisions.length === 0) {
  throw new Error(
    "No Git revisions were available for the public-source scan.",
  );
}

const blobs = new Map();
const failures = new Set();

for (const revision of revisions) {
  const { stdout } = await git(["ls-tree", "-r", "-z", revision]);
  for (const row of stdout.split("\0")) {
    if (row.length === 0) continue;
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const metadata = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    const type = metadata[1];
    const objectId = metadata[2];
    if (type !== "blob" || objectId === undefined) continue;

    for (const rule of forbiddenPaths) {
      if (
        rule.pattern.test(path) &&
        (rule.allowed === undefined || !rule.allowed.test(path))
      ) {
        failures.add(
          `${revision.slice(0, 12)}:${path}: ${rule.label} appears in Git history`,
        );
      }
    }

    if (!blobs.has(objectId)) {
      blobs.set(objectId, {
        path,
        revision: revision.slice(0, 12),
      });
    }
  }
}

for (const [objectId, location] of blobs) {
  const { stdout: sizeOutput } = await git(["cat-file", "-s", objectId]);
  const size = Number(sizeOutput.trim());
  if (!Number.isSafeInteger(size) || size > maxTextBlobBytes) continue;

  const { stdout } = await git(["cat-file", "blob", objectId], {
    encoding: "buffer",
  });
  if (stdout.includes(0)) continue;
  const contents = stdout.toString("utf8");

  for (const rule of forbiddenContents) {
    if (rule.pattern.test(contents)) {
      failures.add(
        `${location.revision}:${location.path}: ${rule.label} appears in Git history`,
      );
    }
  }
}

if (failures.size > 0) {
  console.error(
    [
      "Public-source history scan failed.",
      "No matched value is printed; review these revisions and paths privately:",
      ...[...failures].sort(),
      "Publish a clean source snapshot instead of rewriting accepted private history when removal is uncertain.",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `Public-source history scan passed across ${revisions.length} revisions and ${blobs.size} unique blobs.`,
  );
}
