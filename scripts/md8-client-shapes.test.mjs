import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../packages/contracts/fixtures/mdevolved-client-shapes-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const expectedClients = [
  "Antigravity",
  "Claude app",
  "Claude Code",
  "Codex app",
  "Codex CLI",
  "Cursor",
  "Cursor CLI",
  "Grok Build",
  "Hermes Agent",
  "LangChain",
  "LangGraph",
  "Orca ADE",
  "T3 Code",
];

test("freezes representative client families without runtime product enums", () => {
  assert.equal(fixture.format, "mdevolved-client-shapes-v1");
  assert.equal(fixture.schemaVersion, 1);
  const members = fixture.shapes.flatMap((shape) => shape.members).sort();
  assert.deepEqual(members, expectedClients.toSorted());
  assert.equal(new Set(members).size, members.length);
  assert.equal(fixture.universalContract.durableProductEnum, false);
  assert.equal(fixture.universalContract.harnessOwnsExecution, true);
});

test("every client family has MCP plus a portable authority-free fallback", () => {
  const allowed = new Set(["direct-mcp", "lead-mediated-mcp"]);
  for (const shape of fixture.shapes) {
    assert.equal(allowed.has(shape.primaryConnectionMode), true);
  }
  assert.deepEqual(fixture.universalContract.connectionModes, [
    "direct-mcp",
    "lead-mediated-mcp",
    "portable-handoff",
  ]);
  assert.equal(fixture.universalContract.capabilityNegotiationRequired, true);
  assert.equal(fixture.universalContract.portableFallbackRequired, true);
  assert.equal(fixture.universalContract.restoresAuthority, false);
});
