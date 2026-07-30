import { describe, expect, it } from "vitest";
import {
  canStageRestorePreview,
  recoveryWorkflowInstruction,
  recoveryWorkflowStage,
  type RecoveryWorkflowStage,
} from "../src/recovery-workflow";

describe("recovery workflow", () => {
  it("requires an active target before staging a restore preview", () => {
    expect(
      canStageRestorePreview({
        crossVaultConfirmed: true,
        crossesVaultIds: false,
        targetVaultId: "",
        working: false,
      }),
    ).toBe(false);
    expect(
      canStageRestorePreview({
        crossVaultConfirmed: true,
        crossesVaultIds: false,
        targetVaultId: "11111111-1111-4111-8111-111111111111",
        working: false,
      }),
    ).toBe(true);
  });

  it.each<{
    expected: RecoveryWorkflowStage;
    identityReady: boolean;
    jobStatus: "applied" | "applying" | "failed" | "preview" | "staging" | null;
    sourceReady: boolean;
    validated: boolean;
  }>([
    {
      expected: "source",
      identityReady: false,
      jobStatus: null,
      sourceReady: false,
      validated: false,
    },
    {
      expected: "identity",
      identityReady: false,
      jobStatus: null,
      sourceReady: true,
      validated: false,
    },
    {
      expected: "validate",
      identityReady: true,
      jobStatus: null,
      sourceReady: true,
      validated: false,
    },
    {
      expected: "target",
      identityReady: false,
      jobStatus: null,
      sourceReady: false,
      validated: true,
    },
    {
      expected: "preview",
      identityReady: false,
      jobStatus: "staging",
      sourceReady: false,
      validated: true,
    },
    {
      expected: "confirm",
      identityReady: false,
      jobStatus: "preview",
      sourceReady: false,
      validated: true,
    },
    {
      expected: "apply",
      identityReady: false,
      jobStatus: "applying",
      sourceReady: false,
      validated: false,
    },
    {
      expected: "failed",
      identityReady: false,
      jobStatus: "failed",
      sourceReady: false,
      validated: false,
    },
    {
      expected: "complete",
      identityReady: false,
      jobStatus: "applied",
      sourceReady: false,
      validated: false,
    },
  ])("returns the $expected stage", (input) => {
    expect(recoveryWorkflowStage(input)).toBe(input.expected);
    expect(recoveryWorkflowInstruction(input.expected)).not.toHaveLength(0);
  });
});
