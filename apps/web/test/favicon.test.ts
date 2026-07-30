import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import favicon from "../public/favicon.svg?raw";

describe("OWD favicon", () => {
  it("publishes the branded SVG favicon from the application shell", () => {
    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    );
  });

  it("uses the compact OWD mark without active or external content", () => {
    expect(favicon).toContain('viewBox="0 0 64 64"');
    expect(favicon).toContain('fill="#0a0c0b"');
    expect(favicon).toContain('stroke="#44503d"');
    expect(favicon).toContain('stroke="#b4f257"');
    expect(favicon).not.toContain("<script");
    expect(favicon).not.toContain("href=");
  });
});
