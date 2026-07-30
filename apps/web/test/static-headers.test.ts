import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";

describe("static asset headers", () => {
  it("hardens the application shell without routing assets through the Worker", () => {
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("Permissions-Policy:");
    expect(headers).toContain("Referrer-Policy: no-referrer");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain(
      "Cache-Control: public, max-age=0, must-revalidate, no-transform",
    );
  });

  it("uses immutable browser caching only for fingerprinted Vite assets", () => {
    const [applicationHeaders, fingerprintedAssetHeaders] =
      headers.split("\n/assets/*\n");
    expect(applicationHeaders).toBeDefined();
    expect(fingerprintedAssetHeaders).toContain("! Cache-Control");
    expect(fingerprintedAssetHeaders).toContain(
      "Cache-Control: public, max-age=31536000, immutable",
    );
    expect(applicationHeaders).toContain(
      "Cache-Control: public, max-age=0, must-revalidate, no-transform",
    );
  });
});
