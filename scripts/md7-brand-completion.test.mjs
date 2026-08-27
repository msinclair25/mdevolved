import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const sourceExtensions = new Set([".html", ".json", ".md", ".ts", ".tsx"]);

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "node_modules", "release"].includes(entry.name)) continue;
      files.push(...(await sourceFiles(path)));
    } else if (sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function removeFrozenIdentifiers(line) {
  return line
    .replace(/\bOWD_[A-Z0-9_]+\b/gu, "")
    .replace(/\bX-OWD-[A-Za-z-]+\b/gu, "")
    .replace(/\bOWD-BACKUP-V1\b/gu, "")
    .replace(/\bOWD-SNAPSHOT-EXPORT-V2\b/gu, "")
    .replace(/\bOWD Sync remote conflict\b/gu, "")
    .replace(/\bOWD Sync conflict\b/gu, "")
    .replace(/\bOWD\s+resume project\b/gu, "")
    .replace(/\bConnect this project to OWD\./gu, "")
    .replace(/\bformerly called (?:\*\*)?OWD(?:\*\*)?/gu, "")
    .replace(/\bretains the OWD name\b/gu, "");
}

async function assertNoProductNameLeaks(paths) {
  const failures = [];
  for (const path of paths) {
    const text = removeFrozenIdentifiers(await readFile(path, "utf8"));
    for (const [index, line] of text.split("\n").entries()) {
      if (/\bOWD\b/u.test(line)) {
        failures.push(`${path}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(failures, []);
}

test("normal user and agent surfaces use MDevolved as the product name", async () => {
  const roots = [
    "apps/desktop/src",
    "apps/marketing",
    "apps/web/src",
    "apps/worker/src",
    "packages/client-packs/src",
    "packages/client-packs/owd-albatross",
    "packages/client-packs/owd-eve",
    "packages/client-packs/owd-obsidian-mind",
    "packages/contracts/src",
    "packages/mdevolved-cli/src",
    "packages/obsidian-plugin/src",
    "packages/obsidian-plugin/vendor/yaos-src",
  ];
  const files = (await Promise.all(roots.map(sourceFiles)))
    .flat()
    .filter((path) => !/[.]test[.]/u.test(path));
  await assertNoProductNameLeaks(files);
});

test("current public documentation uses MDevolved outside explicit compatibility history", async () => {
  const excluded = new Set([
    "docs/BRAND-COMPATIBILITY.md",
    "docs/MD6-TEST-MATRIX.md",
    "docs/MDEVOLVED-PLAN.md",
  ]);
  const docs = (await sourceFiles("docs")).filter(
    (path) => !excluded.has(path),
  );
  await assertNoProductNameLeaks([
    "AGENTS.md",
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "packages/yaos-core/UPSTREAM.md",
    "apps/web/vite.config.ts",
    ...docs,
  ]);
});

test("the human-facing spelling and product labels are exact", async () => {
  const files = [
    "AGENTS.md",
    "README.md",
    "apps/marketing/index.html",
    "apps/web/src/App.tsx",
    "packages/obsidian-plugin/manifest.json",
    "packages/obsidian-plugin/src/pairing-modal.ts",
  ];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    const visibleText = text.replace(/`md-evolved`/gu, "");
    assert.doesNotMatch(
      visibleText,
      /\bMD Evolved\b|\bMD evolved\b|\bMDEvolved\b|\bmd-evolved\b/u,
    );
  }

  const pluginManifest = JSON.parse(
    await readFile("packages/obsidian-plugin/manifest.json", "utf8"),
  );
  assert.equal(pluginManifest.name, "MDevolved Sync for Obsidian");
  assert.match(
    await readFile("apps/web/src/App.tsx", "utf8"),
    /Set up MDevolved/u,
  );
  assert.match(
    await readFile("packages/obsidian-plugin/src/pairing-modal.ts", "utf8"),
    /MDevolved dashboard/u,
  );
});

test("frozen protocol, storage, plugin, and deployment identities remain intact", async () => {
  const [contracts, plugin, pairing, worker, webLinks, wrangler, brand] =
    await Promise.all([
      readFile("packages/contracts/src/index.ts", "utf8"),
      readFile("packages/obsidian-plugin/manifest.json", "utf8"),
      readFile("packages/obsidian-plugin/src/pairing-contract.ts", "utf8"),
      readFile("apps/worker/src/mcp-server.ts", "utf8"),
      readFile("apps/web/src/obsidian-plugin-links.ts", "utf8"),
      readFile("wrangler.jsonc", "utf8"),
      readFile("docs/BRAND-COMPATIBILITY.md", "utf8"),
    ]);

  assert.match(contracts, /owd-snapshot-v2/u);
  assert.equal(JSON.parse(plugin).id, "owd-sync");
  assert.match(pairing, /owd-pair:/u);
  for (const tool of ["owd_resume", "owd_find", "owd_checkpoint"]) {
    assert.match(worker, new RegExp(tool, "u"));
  }
  assert.match(webLinks, /msinclair25\/owd-sync/u);
  assert.match(wrangler, /"name": "owd-platform"/u);
  assert.match(
    brand,
    /Existing users require no migration, data edit, re-pairing, MCP reconnect/u,
  );
});

test("new and legacy natural-language resume phrases remain equivalent", async () => {
  const files = [
    "apps/worker/src/mcp-server.ts",
    "apps/worker/src/project-context-policy.ts",
    "packages/client-packs/src/albatross.ts",
    "packages/client-packs/owd-albatross/SKILL.md",
    "packages/client-packs/src/eve.ts",
    "packages/client-packs/src/obsidian-mind.ts",
  ];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    assert.match(text, /MDevolved resume project/u);
    assert.match(text, /OWD resume project/u);
  }
});
