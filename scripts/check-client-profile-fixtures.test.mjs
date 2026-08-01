import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEveConnectionSource } from "../packages/client-packs/src/eve.ts";

const normalizeSource = (source) => source.replace(/\s+/gu, " ").trim();

test("the generated Eve connection matches the pinned type-checked fixture", async () => {
  const fixture = await readFile(
    new URL(
      "../packages/client-packs/test/fixtures/eve-0.29.4-connection.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const generated = createEveConnectionSource(
    "https://private-deployment.example/mcp",
  );

  assert.equal(normalizeSource(generated), normalizeSource(fixture));
});
