import { describe, expect, it } from "vitest";
import {
  agentSkillPackageFileSchema,
  importAgentSkillRequestSchema,
  projectSkillAttachmentListResponseSchema,
  saveWorkingPreferenceRequestSchema,
} from "../src";

describe("working-profile contracts", () => {
  it("accepts canonical bounded preferences and rejects ambiguous keys and URLs", () => {
    const valid = {
      idempotencyKey: "preference-1",
      key: "package-manager",
      projectId: null,
      sourceLabel: "Owner",
      sourceUrl: "https://example.test/source",
      value: "Use pnpm.",
    };
    expect(saveWorkingPreferenceRequestSchema.parse(valid).key).toBe(
      "package-manager",
    );
    expect(
      saveWorkingPreferenceRequestSchema.safeParse({
        ...valid,
        key: "Package_Manager",
      }).success,
    ).toBe(false);
    expect(
      saveWorkingPreferenceRequestSchema.safeParse({
        ...valid,
        sourceUrl: "http://example.test/source",
      }).success,
    ).toBe(false);
  });

  it("freezes the exact ordered regular-file transport and strict base64", () => {
    const files = [
      { contentBase64: "LS0tCm5hbWU6IHRlc3QKLS0tCg==", path: "SKILL.md" },
      { contentBase64: "AAE=", path: "assets/example.bin" },
    ];
    expect(
      importAgentSkillRequestSchema.parse({ files, idempotencyKey: "skill-1" })
        .files,
    ).toEqual(files);
    expect(
      agentSkillPackageFileSchema.safeParse({
        contentBase64: "not base64!",
        path: "SKILL.md",
      }).success,
    ).toBe(false);
    expect(
      importAgentSkillRequestSchema.safeParse({
        files: Array.from({ length: 33 }, (_, index) => ({
          contentBase64: "AA==",
          path: `assets/${index}.bin`,
        })),
        idempotencyKey: "skill-2",
      }).success,
    ).toBe(false);
  });

  it("bounds the transport attachment projection at 32 entries", () => {
    const projectId = crypto.randomUUID();
    const attachment = {
      attachedAt: 1,
      projectId,
      skill: {
        description: "Synthetic attachment",
        name: "synthetic-skill",
        skillId: crypto.randomUUID(),
        updatedAt: 1,
        versionRecordId: crypto.randomUUID(),
      },
    };
    expect(
      projectSkillAttachmentListResponseSchema.safeParse({
        attachments: Array.from({ length: 33 }, () => attachment),
        ok: true,
        projectId,
      }).success,
    ).toBe(false);
  });
});
