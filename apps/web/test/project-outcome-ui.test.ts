import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProjectOutcomePanel,
  projectOutcomeDate,
  projectOutcomePath,
} from "../src/ProjectOutcomePanel";

describe("Project outcome UI", () => {
  it("is quiet, collapsed, accessible, and explains local-only evidence", () => {
    const source = ProjectOutcomePanel.toString();
    const html = renderToStaticMarkup(
      createElement(ProjectOutcomePanel, {
        projectId: "10000000-0000-4000-8000-000000000001",
      }),
    );
    expect(html).toContain('<details class="project-outcome">');
    expect(html).toContain("Project outcome evidence");
    expect(html).toContain("not a success score");
    expect(html).toContain("does not send telemetry");
    expect(source).toContain("role");
    expect(source).toContain("summary");
    expect(source).toContain("Local-only signals");
  });

  it("uses only the opaque Project query and handles the zero timestamp", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    expect(projectOutcomePath(id)).toBe(
      `/api/project-outcomes?projectId=${id}`,
    );
    expect(projectOutcomeDate(null)).toBe("No checkpoint yet");
    expect(projectOutcomeDate(1_700_000_000)).toContain("2023");
  });
});
