import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMdevolvedReleaseTag,
  getMdevolvedRelease,
} from "./mdevolved-release-contract.mjs";

test("MDevolved desktop and CLI share one prerelease version", () => {
  assert.deepEqual(getMdevolvedRelease(), {
    version: "0.1.0-alpha.4",
    tag: "mdevolved-v0.1.0-alpha.4",
  });
});

test("MDevolved release tags must exactly match the package version", () => {
  assert.equal(
    assertMdevolvedReleaseTag("mdevolved-v0.1.0-alpha.4").version,
    "0.1.0-alpha.4",
  );
  assert.throws(
    () => assertMdevolvedReleaseTag("mdevolved-v0.1.0"),
    /Expected release tag/,
  );
});
