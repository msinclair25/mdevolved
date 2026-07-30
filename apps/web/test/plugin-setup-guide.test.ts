import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginSetupGuide } from "../src/PluginSetupGuide";

function render(): string {
  return renderToStaticMarkup(createElement(PluginSetupGuide));
}

describe("OWD Sync tester setup guide", () => {
  it("leads with one direct local install action and keeps BRAT secondary", () => {
    const html = render();

    expect(html).toContain('id="owd-sync-installer"');
    expect(html).toContain("Private trial · direct local install");
    expect(html).toContain("Install OWD Sync 0.1.6");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Turn on community plugins");
    expect(html).toContain("OWD will not bypass it");
    expect(html).toContain("Close Obsidian, click once");
    expect(html).toContain("choose the vault folder");
    expect(html).toContain("does not enumerate notes");
    expect(html).toContain("does not");
    expect(html).toContain("retain the folder");
    expect(html).toContain(
      "Fallback for Safari, Firefox, or a blocked folder picker",
    );
    expect(html).toContain("obsidian://show-plugin?id=obsidian42-brat");
    expect(html).toContain("obsidian://brat?plugin=msinclair25/owd-sync");
    expect(html).toContain("two-stage path is a technical fallback");
    expect(html).toContain("releases/tag/0.1.6");
    expect(html).toContain("owd-sync-0.1.6.zip");
    expect(html).toContain("not a normal tester installation path");
  });

  it("keeps the direct installer visible for every vault", () => {
    const html = render();

    expect(html).toContain("<section");
    expect(html).not.toContain('<details class="plugin-setup-guide"');
    expect(html).toContain("Install OWD Sync in this vault");
  });
});
