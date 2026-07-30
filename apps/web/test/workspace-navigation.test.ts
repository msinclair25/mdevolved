import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkspaceNavigation,
  workspaceSectionFromHash,
} from "../src/WorkspaceNavigation";

describe("workspace navigation", () => {
  it("normalizes deep links and sends legacy or unknown links home", () => {
    expect(workspaceSectionFromHash("#library")).toBe("library");
    expect(workspaceSectionFromHash(" #COLLABORATION ")).toBe("collaboration");
    expect(workspaceSectionFromHash("#start")).toBe("architecture");
    expect(workspaceSectionFromHash("#unknown-internal-tool")).toBe(
      "architecture",
    );
    expect(workspaceSectionFromHash("")).toBe("architecture");
  });

  it("renders every owner section as one file-tree destination", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceNavigation, {
        active: "architecture",
        deploymentLabel: "Managed pilot",
        onNavigate: () => undefined,
        onSignOut: () => undefined,
        summaries: {
          agents: "Ready to connect",
          architecture: "One next action",
          library: "24 notes",
          vaults: "2 active",
        },
      }),
    );

    const labels = [
      "How OWD works",
      "Vaults",
      "Notes",
      "Agents",
      "Projects",
      "Backup &amp; restore",
      "System health",
    ];
    for (const label of labels) {
      expect(html).toContain(label);
    }
    expect(labels.map((label) => html.indexOf(label))).toEqual(
      [...labels]
        .map((label) => html.indexOf(label))
        .sort((left, right) => left - right),
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Open My OWD home"');
    expect(html).toContain('class="workspace-root" href="#architecture"');
    expect(html).toContain('href="#architecture"');
    expect(html).not.toContain('href="#start"');
    expect(html).toContain("One next action");
    expect(html).toContain("Managed pilot workspace");
    expect(html).toContain('class="workspace-mobile-bar"');
    expect(html).toContain('aria-label="OWD workspace menu"');
    expect(html).toContain(
      'aria-label="Open workspace menu. Current: How OWD works"',
    );
  });

  it("names the current folder in the compact navigation menu", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceNavigation, {
        active: "recovery",
        deploymentLabel: "Community",
        onNavigate: () => undefined,
        onSignOut: () => undefined,
        summaries: {
          recovery: "Latest recovery point verified",
        },
      }),
    );

    expect(html).toContain(
      'aria-label="Open workspace menu. Current: Backup &amp; restore"',
    );
    expect(html).toContain("<strong>Backup &amp; restore</strong>");
    expect(html).toContain("Latest recovery point verified");
  });
});
