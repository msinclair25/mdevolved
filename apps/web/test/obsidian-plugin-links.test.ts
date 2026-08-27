import { describe, expect, it } from "vitest";
import {
  LEGACY_OWD_SYNC_REQUIRED_VERSION,
  MDEVOLVED_SYNC_ARCHIVE_URL,
  MDEVOLVED_SYNC_BRAT_INSTALL_URL,
  MDEVOLVED_SYNC_CHECKSUMS_URL,
  MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY,
  MDEVOLVED_SYNC_RELEASES_URL,
  MDEVOLVED_SYNC_REQUIRED_VERSION,
} from "../src/obsidian-plugin-links";

describe("Obsidian plugin links", () => {
  it("targets the canonical MDevolved Sync repository through BRAT", () => {
    const installUrl = new URL(MDEVOLVED_SYNC_BRAT_INSTALL_URL);

    expect(installUrl.protocol).toBe("obsidian:");
    expect(installUrl.hostname).toBe("brat");
    expect(installUrl.searchParams.get("plugin")).toBe(
      MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY,
    );
    expect(installUrl.searchParams.get("version")).toBe(
      MDEVOLVED_SYNC_REQUIRED_VERSION,
    );
  });

  it("pins every tester fallback to the canonical release", () => {
    expect(MDEVOLVED_SYNC_REQUIRED_VERSION).toBe("0.2.0-alpha.1");
    expect(
      MDEVOLVED_SYNC_RELEASES_URL.endsWith(
        "/releases/tag/mdevolved-sync-v0.2.0-alpha.1",
      ),
    ).toBe(true);
    expect(
      MDEVOLVED_SYNC_ARCHIVE_URL.endsWith(
        "/releases/download/mdevolved-sync-v0.2.0-alpha.1/mdevolved-sync-0.2.0-alpha.1.zip",
      ),
    ).toBe(true);
    expect(
      MDEVOLVED_SYNC_CHECKSUMS_URL.endsWith(
        "/releases/download/mdevolved-sync-v0.2.0-alpha.1/checksums.txt",
      ),
    ).toBe(true);
  });

  it("keeps the old alpha release identifiable as a legacy input", () => {
    expect(LEGACY_OWD_SYNC_REQUIRED_VERSION).toBe("0.1.7");
  });
});
