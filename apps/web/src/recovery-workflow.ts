import type { RestoreJob } from "@owd/contracts";

export type RecoveryWorkflowStage =
  | "source"
  | "identity"
  | "validate"
  | "target"
  | "preview"
  | "confirm"
  | "apply"
  | "failed"
  | "complete";

export function canStageRestorePreview(input: {
  crossVaultConfirmed: boolean;
  crossesVaultIds: boolean;
  targetVaultId: string;
  working: boolean;
}): boolean {
  return (
    !input.working &&
    input.targetVaultId !== "" &&
    (!input.crossesVaultIds || input.crossVaultConfirmed)
  );
}

export function recoveryWorkflowStage(input: {
  identityReady: boolean;
  jobStatus: RestoreJob["status"] | null;
  sourceReady: boolean;
  validated: boolean;
}): RecoveryWorkflowStage {
  if (input.jobStatus === "applied") return "complete";
  if (input.jobStatus === "failed") return "failed";
  if (input.jobStatus === "applying") return "apply";
  if (input.jobStatus === "preview") return "confirm";
  if (input.jobStatus === "staging") return "preview";
  if (input.validated) return "target";
  if (!input.sourceReady) return "source";
  if (!input.identityReady) return "identity";
  return "validate";
}

export function recoveryWorkflowInstruction(
  stage: RecoveryWorkflowStage,
): string {
  switch (stage) {
    case "source":
      return "Choose the encrypted backup you want to recover.";
    case "identity":
      return "Choose the recovery-key file saved with this backup.";
    case "validate":
      return "Both files are ready. Check them safely in this browser.";
    case "target":
      return "Backup checked. Choose the destination Source.";
    case "preview":
      return "Preparing the preview. The destination is still unchanged.";
    case "confirm":
      return "Review what will change, then confirm the destination Source.";
    case "apply":
      return "Restoring the approved notes and checking the result.";
    case "failed":
      return "Restore stopped safely. Start over to prepare a fresh preview.";
    case "complete":
      return "Restore complete. The destination passed its safety check.";
  }
}
