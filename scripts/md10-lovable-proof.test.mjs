import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = async (path) => readFile(new URL(path, root), "utf8");
const expectedActions = [
  "Deploy or open MDevolved",
  "Claim it with a passkey",
  "Connect one disposable Markdown folder",
  "Authorize one compatible agent",
  "Connect the Project",
  "Resume in a fresh session",
];

function markdownQuickstart(value) {
  const match = value.match(
    /<!-- md10-quickstart:start -->([\s\S]*?)<!-- md10-quickstart:end -->/u,
  );
  assert.ok(match, "MD10 quickstart markers are required");
  return match[1].replace(/\s+/gu, " ").trim();
}

function pngSize(bytes) {
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("public discovery surfaces share one jargon-free six-action path", async () => {
  const [readme, guide, packageReadme, marketing] = await Promise.all([
    read("README.md"),
    read("docs/AGENT-FIRST-QUICKSTART.md"),
    read("packages/mdevolved-cli/README.md"),
    read("apps/marketing/index.html"),
  ]);
  const quickstarts = [readme, guide, packageReadme].map(markdownQuickstart);
  assert.equal(new Set(quickstarts).size, 1);

  const websiteMatch = marketing.match(
    /<ol class="journey-list" data-md10-quickstart>([\s\S]*?)<\/ol>/u,
  );
  assert.ok(websiteMatch);
  const websiteQuickstart = websiteMatch[1];
  assert.equal((websiteQuickstart.match(/<li\b/gu) ?? []).length, 6);

  for (const surface of [...quickstarts, websiteQuickstart]) {
    let offset = -1;
    for (const action of expectedActions) {
      const next = surface.indexOf(action);
      assert.ok(next > offset, `${action} must appear in order`);
      offset = next;
    }
    assert.match(surface, /npx mdevolved@latest sync \./u);
    assert.doesNotMatch(surface, /\b(?:MCP|receipt|migration|Obsidian)\b/u);
  }
});

test("the 25-second demo has real captures and static fallbacks", async () => {
  const [marketing, script, styles] = await Promise.all([
    read("apps/marketing/index.html"),
    read("apps/marketing/src/main.js"),
    read("apps/marketing/src/styles.css"),
  ]);
  assert.match(marketing, /data-demo-duration="25000"/u);
  assert.equal((marketing.match(/data-demo-frame/gu) ?? []).length, 5);
  assert.match(marketing, /Reduced-motion and no-script visitors/u);
  assert.match(script, /prefers-reduced-motion: reduce/u);
  assert.match(script, /data-demo-replay/u);
  assert.match(styles, /handoff-demo\[data-reduced-motion\]/u);

  for (const name of [
    "01-passkey-claim",
    "02-source-connected",
    "03-agent-authorization",
    "04-checkpoint",
    "05-resume",
  ]) {
    const bytes = await readFile(
      new URL(`apps/marketing/public/demo/${name}.png`, root),
    );
    assert.deepEqual(pngSize(bytes), [1280, 720]);
  }
});

test("marketing internal links and social preview assets resolve", async () => {
  const marketing = await read("apps/marketing/index.html");
  for (const [, id] of marketing.matchAll(/href="#([^"]+)"/gu)) {
    assert.match(marketing, new RegExp(`id="${id}"`, "u"));
  }
  const social = await readFile(
    new URL("apps/marketing/public/og-mdevolved.png", root),
  );
  assert.deepEqual(pngSize(social), [1200, 630]);
  assert.match(marketing, /https:\/\/mdevolved\.com\/og-mdevolved\.png/u);
  assert.match(
    marketing,
    /https:\/\/github\.com\/msinclair25\/mdevolved-sync/u,
  );
});
