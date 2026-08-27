import assert from "node:assert/strict";
import test from "node:test";

import { assertPluginPackagingRef } from "../packages/obsidian-plugin/scripts/release-tag-policy.mjs";

const manifestVersion = "0.2.0-alpha.1";
const coreVersion = "1.0.0-alpha.7";

test("allows non-tag packaging and Community release tags", () => {
  assert.doesNotThrow(() =>
    assertPluginPackagingRef({
      coreVersion,
      manifestVersion,
      refType: "branch",
    }),
  );
  assert.doesNotThrow(() =>
    assertPluginPackagingRef({
      coreVersion,
      manifestVersion,
      refName: "community-v1.0.0-alpha.7",
      refType: "tag",
    }),
  );
});

test("allows only the exact Community or MDevolved Sync release tag", () => {
  assert.doesNotThrow(() =>
    assertPluginPackagingRef({
      coreVersion,
      manifestVersion,
      refName: "mdevolved-sync-v0.2.0-alpha.1",
      refType: "tag",
    }),
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "mdevolved-sync-v0.2.0-alpha.2",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or mdevolved-sync-v0\.2\.0-alpha\.1/u,
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "unrecognized-v1",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or mdevolved-sync-v0\.2\.0-alpha\.1/u,
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "community-v1.0.0-alpha.6",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or mdevolved-sync-v0\.2\.0-alpha\.1/u,
  );
});
