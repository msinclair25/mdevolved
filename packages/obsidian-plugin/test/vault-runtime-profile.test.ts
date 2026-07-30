import { describe, expect, it } from "vitest";
import { parseObsidianMindRuntimeProfile } from "../src/vault-runtime-profile";

describe("Obsidian Mind runtime profile", () => {
  it("derives the upstream exposure boundary without widening folder globs", () => {
    expect(
      parseObsidianMindRuntimeProfile(
        JSON.stringify({
          mcp_exposed_roots: [],
          mcp_never_expose: ["SOUL.md", "North Star.md"],
          memory_root: "memories",
          template: "obsidian-mind",
          user_content_roots: [
            "work/active/",
            "perf/h*-*/",
            "perf/competencies/*.md",
            "brain/*.md",
            "memories/",
          ],
          version: "8.1.0",
        }),
      ),
    ).toEqual({
      contentRoots: ["work/active", "perf/competencies", "brain"],
      id: "obsidian-mind",
      memoryRoot: "memories",
      neverExposeFileNames: ["SOUL.md", "North Star.md"],
      version: "8.1.0",
    });
  });

  it("honors an explicit narrower exposure list", () => {
    expect(
      parseObsidianMindRuntimeProfile(
        JSON.stringify({
          mcp_exposed_roots: ["brain", "memories", "../escape"],
          memory_root: "memories",
          template: "obsidian-mind",
          user_content_roots: ["work/active"],
          version: "8.1.0",
        }),
      )?.contentRoots,
    ).toEqual(["brain"]);
  });

  it("rejects an unrelated or malformed manifest", () => {
    expect(
      parseObsidianMindRuntimeProfile(
        JSON.stringify({ template: "other", version: "8.1.0" }),
      ),
    ).toBeNull();
    expect(parseObsidianMindRuntimeProfile("{")).toBeNull();
  });
});
