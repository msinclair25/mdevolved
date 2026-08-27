import {
  prepareMarkdownNotePath,
  validateMarkdownVaultPath,
} from "@mdevolved/contracts";
import { describe, expect, it } from "vitest";

describe("friendly Markdown note paths", () => {
  it.each([
    ["Project ideas", "Project ideas.md"],
    ["Projects/Project ideas", "Projects/Project ideas.md"],
    ["Already.md", "Already.md"],
    ["Upper.MD", "Upper.MD"],
    ["  Inbox/Cafe\u0301  ", "Inbox/Café.md"],
  ])("prepares %j as %j", (input, expected) => {
    const result = prepareMarkdownNotePath(input);

    expect(result).toEqual({
      changed: input !== expected,
      ok: true,
      path: expected,
    });
    if (result.ok) {
      expect(validateMarkdownVaultPath(result.path).path).toBe(expected);
    }
  });

  it.each([
    ["", "Enter a note name."],
    ["Projects/", "Add a note name after the final folder."],
    ["../Escape", "Do not use . or .. as a folder name."],
    [".obsidian/Plugin", ".obsidian folder"],
    ["Folder\\Note", "Use / between folder names"],
    ["bad:name", "reserved characters"],
  ])("explains why %j cannot be prepared", (input, message) => {
    const result = prepareMarkdownNotePath(input);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(message);
  });
});
