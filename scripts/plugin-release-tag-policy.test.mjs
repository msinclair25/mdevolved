import assert from "node:assert/strict";
import test from "node:test";

import { assertPluginPackagingRef } from "../packages/obsidian-plugin/scripts/release-tag-policy.mjs";

const manifestVersion = "0.1.7";
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

test("allows only the exact Community or OWD Sync release tag", () => {
  assert.doesNotThrow(() =>
    assertPluginPackagingRef({
      coreVersion,
      manifestVersion,
      refName: "owd-sync-v0.1.7",
      refType: "tag",
    }),
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "owd-sync-v0.1.8",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or owd-sync-v0\.1\.7/u,
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "unrecognized-v1",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or owd-sync-v0\.1\.7/u,
  );
  assert.throws(
    () =>
      assertPluginPackagingRef({
        coreVersion,
        manifestVersion,
        refName: "community-v1.0.0-alpha.6",
        refType: "tag",
      }),
    /does not match community-v1\.0\.0-alpha\.7 or owd-sync-v0\.1\.7/u,
  );
});
