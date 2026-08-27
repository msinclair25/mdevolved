import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const identityPath = new URL(
  "../compatibility/identities.json",
  import.meta.url,
);

async function identities() {
  return JSON.parse(await readFile(identityPath, "utf8"));
}

function flattenStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) => [
      key,
      ...flattenStrings(nested),
    ]);
  }
  return [];
}

test("MD9 freezes one canonical-new-write and legacy-read identity matrix", async () => {
  const matrix = await identities();
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.milestone, "MD9");
  assert.equal(matrix.policy, "canonical-new-write-dual-read");
  assert.match(matrix.authorityRule, /No import, restore, alias/u);
  assert.match(matrix.authorityRule, /grants, credentials, actors, leases/u);
  assert.ok(
    matrix.frozenStorageInternals.includes("existing D1 migration names"),
  );
});

test("canonical identities contain no former brand or package scope", async () => {
  const matrix = await identities();
  const canonical = flattenStrings(matrix.canonical);
  for (const value of canonical) {
    assert.doesNotMatch(value, /(?:^|[^a-z])owd(?:[^a-z]|$)/iu);
    assert.doesNotMatch(value, /@owd\//u);
  }
  for (const values of [
    matrix.canonical.packages,
    matrix.canonical.mcp.tools,
    matrix.canonical.mcp.resources,
  ]) {
    assert.equal(new Set(values).size, values.length);
  }
});

test("every canonical MCP alias maps to one unique legacy identity", async () => {
  const matrix = await identities();
  for (const mapping of [
    matrix.aliases.mcp.tools,
    matrix.aliases.mcp.resources,
  ]) {
    const canonical = Object.keys(mapping);
    const legacy = Object.values(mapping);
    assert.equal(new Set(canonical).size, canonical.length);
    assert.equal(new Set(legacy).size, legacy.length);
    assert.ok(canonical.every((value) => value.startsWith("mdevolved")));
    assert.ok(legacy.every((value) => value.startsWith("owd")));
  }
});

test("portable formats are versioned and cannot be confused with legacy bytes", async () => {
  const matrix = await identities();
  assert.notEqual(
    matrix.canonical.portable.backupMagic,
    matrix.legacyReadOnly.portable.backupMagic,
  );
  assert.notEqual(
    matrix.canonical.portable.snapshotMagic,
    matrix.legacyReadOnly.portable.snapshotMagic,
  );
  assert.match(matrix.canonical.portable.backupFormat, /-v\d+$/u);
  assert.match(matrix.canonical.portable.snapshotFormat, /-v\d+$/u);
});

test("new and existing deployment identities are disjoint", async () => {
  const matrix = await identities();
  const current = Object.values(matrix.canonical.newCommunityDeployment);
  const legacy = Object.values(
    matrix.legacyReadOnly.existingCommunityDeployment,
  );
  assert.equal(
    current.some((value) => legacy.includes(value)),
    false,
  );
});

test("canonical client skills keep the legacy receipt path explicit", async () => {
  for (const [pack, canonicalResumeTool] of [
    ["mdevolved-albatross", "mcp__mdevolved__mdevolved_resume"],
    ["mdevolved-eve", "mdevolved__mdevolved_resume"],
    ["mdevolved-obsidian-mind", "mdevolved__mdevolved_resume"],
  ]) {
    const skill = await readFile(
      new URL(`../packages/client-packs/${pack}/SKILL.md`, import.meta.url),
      "utf8",
    );
    assert.match(skill, /\.mdevolvedignore/u);
    assert.match(skill, /\.owdignore/u);
    assert.match(skill, /legacy/iu);
    assert.match(skill, /MDevolved/u);
    assert.match(skill, new RegExp(`\\b${canonicalResumeTool}\\b`, "u"));
  }
});
