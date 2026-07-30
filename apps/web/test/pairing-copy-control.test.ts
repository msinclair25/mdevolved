import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PairingCopyControl,
  type PairingCopyState,
} from "../src/PairingCopyControl";

function render(state: PairingCopyState): string {
  return renderToStaticMarkup(
    createElement(PairingCopyControl, {
      onCopy: () => undefined,
      state,
    }),
  );
}

describe("pairing copy confirmation", () => {
  it("reserves a local status region before the link is copied", () => {
    const html = render({ kind: "idle" });

    expect(html).toContain("Copy pairing link");
    expect(html).toContain('id="pairing-copy-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain("The short-lived link will be copied");
  });

  it("shows a persistent visual and accessible success confirmation", () => {
    const html = render({ kind: "copied" });

    expect(html).toContain("Copied");
    expect(html).toContain("✓");
    expect(html).toContain("Copied to this device");
    expect(html).toContain('aria-describedby="pairing-copy-status"');
  });

  it("keeps clipboard failures beside the retry control", () => {
    const html = render({
      kind: "error",
      message: "Clipboard access was blocked.",
    });

    expect(html).toContain("Try copying again");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Clipboard access was blocked.");
  });
});
