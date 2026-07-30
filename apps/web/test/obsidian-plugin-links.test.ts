import { describe, expect, it } from "vitest";
import {
  OWD_SYNC_ARCHIVE_URL,
  OWD_SYNC_BRAT_INSTALL_URL,
  OWD_SYNC_CHECKSUMS_URL,
  OWD_SYNC_RELEASES_URL,
  OWD_SYNC_REQUIRED_VERSION,
} from "../src/obsidian-plugin-links";

describe("Obsidian plugin links", () => {
  it("targets the public OWD Sync beta repository through BRAT", () => {
    const installUrl = new URL(OWD_SYNC_BRAT_INSTALL_URL);

    expect(installUrl.protocol).toBe("obsidian:");
    expect(installUrl.hostname).toBe("brat");
    expect(installUrl.searchParams.get("plugin")).toBe("msinclair25/owd-sync");
  });

  it("pins every tester fallback to the compatible OWD Sync release", () => {
    expect(OWD_SYNC_REQUIRED_VERSION).toBe("0.1.6");
    expect(OWD_SYNC_RELEASES_URL.endsWith("/releases/tag/0.1.6")).toBe(true);
    expect(
      OWD_SYNC_ARCHIVE_URL.endsWith(
        "/releases/download/0.1.6/owd-sync-0.1.6.zip",
      ),
    ).toBe(true);
    expect(
      OWD_SYNC_CHECKSUMS_URL.endsWith("/releases/download/0.1.6/checksums.txt"),
    ).toBe(true);
  });
});
