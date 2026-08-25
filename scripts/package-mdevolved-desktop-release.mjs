import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getMdevolvedRelease } from "./mdevolved-release-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "mdevolved-desktop");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verify(directory) {
  const expectedCountArgument = process.argv.indexOf("--expected-count");
  const expectedCount =
    expectedCountArgument === -1
      ? undefined
      : Number(process.argv[expectedCountArgument + 1]);
  const checksumFiles = readdirSync(directory).filter((name) =>
    name.endsWith(".sha256"),
  );
  if (checksumFiles.length === 0) {
    throw new Error(`No checksum files found in ${directory}.`);
  }

  const verifiedArchives = new Set();
  for (const checksumName of checksumFiles) {
    const checksumPath = path.join(directory, checksumName);
    const [expected, archiveName] = readFileSync(checksumPath, "utf8")
      .trim()
      .split(/\s+/, 2);
    if (
      !/^[a-f0-9]{64}$/u.test(expected) ||
      path.basename(archiveName) !== archiveName ||
      !checksumName.endsWith(`${archiveName}.sha256`)
    ) {
      throw new Error(`Malformed checksum file ${checksumName}.`);
    }
    const archivePath = path.join(directory, archiveName);
    if (sha256(archivePath) !== expected) {
      throw new Error(`Checksum mismatch for ${archiveName}.`);
    }
    verifiedArchives.add(archiveName);
  }

  const archives = readdirSync(directory).filter((name) =>
    name.endsWith(".tar.gz"),
  );
  if (
    archives.length !== verifiedArchives.size ||
    archives.some((name) => !verifiedArchives.has(name))
  ) {
    throw new Error("Every desktop archive must have exactly one checksum.");
  }
  if (
    expectedCount !== undefined &&
    (!Number.isSafeInteger(expectedCount) || archives.length !== expectedCount)
  ) {
    throw new Error(
      `Expected ${expectedCount} desktop archives; found ${archives.length}.`,
    );
  }
  process.stdout.write(
    `Verified ${checksumFiles.length} desktop archive(s).\n`,
  );
}

if (process.argv[2] === "--verify") {
  verify(path.resolve(process.argv[3] ?? outputDirectory));
} else {
  const { version } = getMdevolvedRelease();
  const releaseDirectory = path.join(root, "apps", "desktop", "release");
  const packagedDirectories = readdirSync(releaseDirectory, {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());

  if (packagedDirectories.length !== 1) {
    throw new Error(
      `Expected exactly one packaged desktop directory; found ${packagedDirectories.length}.`,
    );
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const archiveName = `mdevolved-sync-${version}-${process.platform}-${process.arch}.tar.gz`;
  const archivePath = path.join(outputDirectory, archiveName);
  const packagedDirectory = packagedDirectories[0].name;
  const result = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", releaseDirectory, packagedDirectory],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed with status ${result.status ?? "unknown"}.`);
  }

  const checksum = sha256(archivePath);
  writeFileSync(
    `${archivePath}.sha256`,
    `${checksum}  ${archiveName}\n`,
    "utf8",
  );
  process.stdout.write(`${archivePath}\n`);
}
