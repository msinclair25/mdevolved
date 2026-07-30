import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return files.flat();
}

const artifacts = [
  ...(await filesUnder("apps/web/dist")),
  "packages/obsidian-plugin/LICENSE",
  "packages/obsidian-plugin/UPSTREAM.md",
  "packages/obsidian-plugin/main.js",
  "packages/obsidian-plugin/manifest.json",
  "packages/obsidian-plugin/styles.css",
].sort();

for (const filename of artifacts) {
  const digest = createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
  console.log(`${digest}  ${filename}`);
}
