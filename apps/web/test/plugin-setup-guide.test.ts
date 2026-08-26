import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginSetupGuide } from "../src/PluginSetupGuide";

function render(): string {
  return renderToStaticMarkup(createElement(PluginSetupGuide));
}

describe("MDevolved Sync for Obsidian setup guide", () => {
  it("leads with one direct local install action and keeps BRAT secondary", () => {
    const html = render();

    expect(html).toContain('id="owd-sync-installer"');
    expect(html).toContain("Private trial · direct local install");
    expect(html).toContain(
      "Choose vault and install MDevolved Sync for Obsidian 0.1.7",
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Community plugins");
    expect(html).toContain("MDevolved cannot bypass it");
    expect(html).toContain("Quit Obsidian");
    expect(html).toContain("⌘Q");
    expect(html).toContain("Closing the Mac window is not enough");
    expect(html).toContain("vault root containing your notes");
    expect(html).toContain("does not enumerate notes");
    expect(html).toContain("does not");
    expect(html).toContain("retain the folder");
    expect(html).toContain(
      "Manual BRAT fallback—only if direct install reports an error",
    );
    expect(html).toContain("obsidian://show-plugin?id=obsidian42-brat");
    expect(html).toContain(
      "obsidian://brat?plugin=msinclair25/owd-sync&amp;version=0.1.7",
    );
    expect(html).toContain("This link opens BRAT");
    expect(html).toContain("it does not finish the install");
    expect(html).toContain(
      "BRAT: Plugins: Add a beta plugin for testing (with or without version)",
    );
    expect(html).toContain("https://github.com/msinclair25/owd-sync");
    expect(html).toContain("Use either the direct installer or BRAT, not both");
    expect(html).toContain("releases/tag/0.1.7");
    expect(html).toContain("owd-sync-0.1.7.zip");
    expect(html).toContain("not a normal tester installation path");
  });

  it("keeps the direct installer visible for every vault", () => {
    const html = render();

    expect(html).toContain("<section");
    expect(html).not.toContain('<details class="plugin-setup-guide"');
    expect(html).toContain("Install MDevolved Sync for Obsidian");
  });
});
