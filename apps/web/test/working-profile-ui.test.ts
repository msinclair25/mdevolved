import { workingPreferenceSchema } from "@mdevolved/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkingProfilePanel,
  applyLatestWorkingProfileLoad,
  displayedSkillSummary,
  parseAgentSkillEnvelope,
  preferenceRows,
  skillAttachmentPath,
  shouldStartWorkingProfileLoad,
} from "../src/WorkingProfilePanel";
import {
  CompoundingDraftsPanel,
  compoundingDraftActionPath,
  compoundingDraftDate,
  draftCandidateLabel,
  draftScopeLabel,
} from "../src/CompoundingDraftsPanel";
import { compoundingDraftSchema } from "@mdevolved/contracts";

const personal = workingPreferenceSchema.parse({
  key: "package-manager",
  preferenceId: "10000000-0000-4000-8000-000000000001",
  projectId: null,
  sourceLabel: "Owner",
  sourceUrl: null,
  updatedAt: 1,
  value: "Use npm",
  versionRecordId: "20000000-0000-4000-8000-000000000002",
});
const project = workingPreferenceSchema.parse({
  ...personal,
  preferenceId: "30000000-0000-4000-8000-000000000003",
  projectId: "40000000-0000-4000-8000-000000000004",
  value: "Use pnpm",
  versionRecordId: "50000000-0000-4000-8000-000000000005",
});

describe("Project Working Profile UI", () => {
  it("renders personal and Project controls with inert, no-authority messaging", () => {
    const html = renderToStaticMarkup(
      createElement(WorkingProfilePanel, {
        projectId: project.projectId!,
        projectLabel: "Website",
      }),
    );
    expect(html).toContain("Memory &amp; Skills");
    expect(html).toContain("Personal");
    expect(html).toContain("This Project");
    expect(html).toContain("never executed by MDevolved");
    expect(html).toContain("grants no authority or tools");
    expect(html).toContain("Validate and import skill");
    expect(WorkingProfilePanel.toString()).toContain('role: "alert"');
    expect(WorkingProfilePanel.toString()).toContain('"aria-live": "polite"');
  });

  it("starts collapsed and gates profile requests until the first open", () => {
    const html = renderToStaticMarkup(
      createElement(WorkingProfilePanel, {
        projectId: project.projectId!,
        projectLabel: "Website",
      }),
    );
    expect(html).toContain('<details class="working-profile">');
    expect(html).not.toContain('<details class="working-profile" open');
    expect(shouldStartWorkingProfileLoad(false, false)).toBe(false);
    expect(shouldStartWorkingProfileLoad(true, false)).toBe(true);
    expect(shouldStartWorkingProfileLoad(true, true)).toBe(false);
  });

  it("keeps an overridden personal source visible beside the Project override", () => {
    expect(preferenceRows([personal], [project])).toEqual([
      { overridden: true, preference: personal },
      { overridden: false, preference: project },
    ]);
  });

  it("accepts only the exact regular-file-list import envelope", () => {
    expect(
      parseAgentSkillEnvelope(
        JSON.stringify({
          files: [{ contentBase64: "IyBUZXN0", path: "SKILL.md" }],
        }),
      ),
    ).toEqual([{ contentBase64: "IyBUZXN0", path: "SKILL.md" }]);
    expect(() => parseAgentSkillEnvelope("not json")).toThrow();
    expect(() =>
      parseAgentSkillEnvelope(
        JSON.stringify({
          files: [{ contentBase64: "IyBUZXN0", path: "SKILL.md" }],
          format: "archive",
        }),
      ),
    ).toThrow("exact JSON envelope");
  });

  it("exposes attach, detach, export, and delete affordance copy", () => {
    const source = WorkingProfilePanel.toString();
    expect(source).toContain('attached ? "Detach" : "Attach"');
    expect(source).toContain("Export");
    expect(source).toContain("Delete");
    expect(source).toContain("Changes apply on the next agent call");
    expect(skillAttachmentPath(false)).toBe(
      "/api/working-profile/skills/attach",
    );
    expect(skillAttachmentPath(true)).toBe(
      "/api/working-profile/skills/detach",
    );
  });

  it("shows the exact pinned attachment after a newer skill import", () => {
    const current = {
      description: "Version two",
      name: "release-check",
      skillId: "60000000-0000-4000-8000-000000000006",
      updatedAt: 2,
      versionRecordId: "70000000-0000-4000-8000-000000000007",
    };
    const pinned = {
      ...current,
      description: "Version one",
      updatedAt: 1,
      versionRecordId: "80000000-0000-4000-8000-000000000008",
    };
    expect(
      displayedSkillSummary(current, new Map([[current.skillId, pinned]])),
    ).toBe(pinned);
    expect(displayedSkillSummary(current, new Map())).toBe(current);
  });

  it("describes every imported file as inert without rejecting scripts", () => {
    const html = renderToStaticMarkup(
      createElement(WorkingProfilePanel, {
        projectId: project.projectId!,
        projectLabel: "Website",
      }),
    );
    expect(html).toContain("Unsafe paths and credentials are rejected");
    expect(html).toContain("every stored file remains inert");
    expect(html).not.toContain("executable content");
  });

  it("does not apply an older Project load after selection changes", async () => {
    let generation = 1;
    let resolveOld!: (value: string) => void;
    const oldLoad = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const applied: string[] = [];
    const pending = applyLatestWorkingProfileLoad({
      apply: (value) => applied.push(value),
      currentGeneration: () => generation,
      generation,
      load: () => oldLoad,
    });
    generation = 2;
    resolveOld("old Project");
    expect(await pending).toBe("stale");
    expect(applied).toEqual([]);
  });

  it("keeps suggested memory lazy and exposes bounded evidence plus all owner actions", () => {
    const html = renderToStaticMarkup(
      createElement(CompoundingDraftsPanel, {
        enabled: false,
        onAccepted: () => undefined,
        projectId: project.projectId!,
        projectLabel: "Website",
      }),
    );
    const source = CompoundingDraftsPanel.toString();
    expect(html).toBe("");
    expect(source).toContain("/api/compounding/drafts?projectId=");
    expect(source).toContain('compoundingDraftActionPath("accept", projectId)');
    expect(compoundingDraftActionPath("ignore", project.projectId!)).toBe(
      `/api/compounding/drafts/ignore?projectId=${project.projectId}`,
    );
    expect(compoundingDraftActionPath("delete", project.projectId!)).toBe(
      `/api/compounding/drafts/delete?projectId=${project.projectId}`,
    );
    expect(source).toContain("attachProjectSkillDraftId === draft.draftId");
    expect(source).toContain("Edit & accept");
    expect(source).toContain("Accept edited suggestion");
    expect(source).toContain("draft.correlationNote");
    expect(source).toContain("Evidence:");
    expect(source).toContain("Conflicts with another pending suggestion");
    expect(source).toContain("Existing live memory was not changed.");
    expect(source).toContain("Attach this skill to ");
    expect(source).toContain("projectLabel");
    expect(source).toContain('role: "status"');
    expect(source).toContain('role: "alert"');
    expect(source).toContain('"aria-live": "polite"');
  });

  it("formats draft scope, candidate content, and bounded evidence dates", () => {
    const draft = compoundingDraftSchema.parse({
      candidate: {
        key: "package-manager",
        kind: "preference",
        projectId: project.projectId,
        scope: "project",
        value: "Use pnpm",
      },
      conflict: true,
      correlationNote: "Suggestion only; correlation is not proof.",
      draftId: "60000000-0000-4000-8000-000000000006",
      evidence: [
        {
          acknowledgedAt: 1_700_000_000,
          continuityPointId: "70000000-0000-4000-8000-000000000007",
          contentSha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          producerClientId: "codex",
        },
        {
          acknowledgedAt: 1_700_086_400,
          continuityPointId: "80000000-0000-4000-8000-000000000008",
          contentSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          producerClientId: "claude",
        },
      ],
      fingerprint:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      firstObservedAt: 1_700_000_000,
      lastObservedAt: 1_700_086_400,
      observationCount: 2,
      projectId: project.projectId,
      scope: "project",
      status: "pending",
    });
    expect(draftScopeLabel(draft)).toBe("This Project");
    expect(draftCandidateLabel(draft.candidate)).toBe(
      "package-manager: Use pnpm",
    );
    expect(compoundingDraftDate(1_700_000_000)).toMatch(/2023/);
  });
});
