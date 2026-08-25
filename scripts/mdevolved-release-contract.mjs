import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackage(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

export function getMdevolvedRelease() {
  const cli = readPackage("packages/mdevolved-cli/package.json");
  const desktop = readPackage("apps/desktop/package.json");

  if (cli.version !== desktop.version) {
    throw new Error(
      `MDevolved CLI ${cli.version} and desktop ${desktop.version} versions differ.`,
    );
  }

  return {
    version: cli.version,
    tag: `mdevolved-v${cli.version}`,
  };
}

export function assertMdevolvedReleaseTag(actualTag) {
  const release = getMdevolvedRelease();
  if (actualTag !== release.tag) {
    throw new Error(
      `Expected release tag ${release.tag}; received ${actualTag}.`,
    );
  }
  return release;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const actualTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!actualTag) {
    throw new Error("Pass the release tag or set GITHUB_REF_NAME.");
  }
  const release = assertMdevolvedReleaseTag(actualTag);
  process.stdout.write(`${JSON.stringify(release)}\n`);
}
