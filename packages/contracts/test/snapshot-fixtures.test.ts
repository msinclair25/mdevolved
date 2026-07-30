import {
  snapshotExportIndexSchema,
  snapshotManifestSchema,
} from "@owd/contracts";
import { describe, expect, it } from "vitest";
import indexFixture from "../fixtures/owd-snapshot-v2-index.json";
import manifestFixture from "../fixtures/owd-snapshot-v2-manifest.json";

describe("published snapshot format fixtures", () => {
  it("keeps the provider-neutral public index and complete manifest compatible", () => {
    const index = snapshotExportIndexSchema.parse(indexFixture);
    const manifest = snapshotManifestSchema.parse(manifestFixture);
    expect(index.snapshotId).toBe(manifest.snapshotId);
    expect(index.requiredCapabilities).toEqual(manifest.requiredCapabilities);
    expect(
      index.parts
        .filter((part) => part.role === "content")
        .map((part) => part.portableObjectId)
        .sort(),
    ).toEqual(manifest.objects.map((object) => object.portableObjectId).sort());
    expect(JSON.stringify(index)).not.toMatch(
      /workers\.dev|cloudflare|r2|d1|object_key|source_vault_id/iu,
    );
  });

  it("rejects declared content objects that no vault entry references", () => {
    const unreferenced = structuredClone(manifestFixture);
    unreferenced.objects.push({
      byteLength: 1,
      contentSha256: "c".repeat(64),
      portableObjectId: "77777777-7777-4777-8777-777777777777",
      section: "notes",
    });
    expect(snapshotManifestSchema.safeParse(unreferenced).success).toBe(false);
  });
});
