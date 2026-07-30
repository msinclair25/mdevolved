import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";

const releaseDirectory = new URL("../release/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  typeof manifest.version !== "string"
) {
  throw new Error("Plugin manifest version is invalid.");
}
const releaseTag = process.env.GITHUB_REF_NAME;
const releaseRefType = process.env.GITHUB_REF_TYPE;
if (
  releaseRefType === "tag" &&
  releaseTag !== `owd-sync-v${manifest.version}`
) {
  throw new Error(
    `Release tag ${releaseTag} does not match plugin version owd-sync-v${manifest.version}.`,
  );
}

const releaseFiles = [
  "LICENSE",
  "UPSTREAM.md",
  "main.js",
  "manifest.json",
  "styles.css",
];
const archive = {};
const checksums = [];

await rm(releaseDirectory, { force: true, recursive: true });
await mkdir(releaseDirectory, { recursive: true });

for (const filename of releaseFiles) {
  const contents = await readFile(new URL(`../${filename}`, import.meta.url));
  archive[`owd-sync/${filename}`] = new Uint8Array(contents);
  await writeFile(new URL(filename, releaseDirectory), contents);
  checksums.push(
    `${createHash("sha256").update(contents).digest("hex")}  ${filename}`,
  );
}

const archiveName = `owd-sync-${manifest.version}.zip`;
// fflate otherwise embeds the packaging clock in every entry. Constructing a
// fixed local date keeps the encoded DOS timestamp identical in every timezone.
const zipped = zipSync(archive, {
  level: 9,
  mtime: new Date(2000, 0, 1, 0, 0, 0),
});
await writeFile(new URL(archiveName, releaseDirectory), zipped);
checksums.push(
  `${createHash("sha256").update(zipped).digest("hex")}  ${archiveName}`,
);
await writeFile(
  new URL("checksums.txt", releaseDirectory),
  `${checksums.join("\n")}\n`,
);

console.log(`Packaged ${archiveName}`);
