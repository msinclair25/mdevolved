import { readActiveAgentGrant } from "./agent-access-store";
import { createCollaborationProject } from "./collaboration-service";
import { readCollaborationRecord } from "./collaboration-store";
import {
  projectContextPolicyFromMember,
  projectContextSelectorSha256,
} from "./project-context-policy";
import {
  initializationProjectRequest,
  revalidateProjectAccessSelection,
  validateProjectSourceAccess,
} from "./project-initialization-service";
import {
  approveInitializationWithProjectGrant,
  bindProjectCreationReservation,
  claimInitializationForApprovalById,
  claimProjectCreationReservation,
  ensureProjectCreationIdentity,
  projectCreationContractSha256,
  projectCreationLabelKey,
  readInitializationById,
  readInitializationProjectReceipt,
  releaseProjectCreationReservation,
  returnInitializationToPending,
  type ProjectCreationReservation,
} from "./project-initialization-store";
import {
  claimPreparedProjectHandoff,
  consumePreparedProjectHandoff,
  preparedProjectHandoffClaimInProgress,
  releasePreparedProjectHandoff,
} from "./prepared-project-handoff-store";

export type PreparedProjectApprovalResult =
  "approved" | "failed" | "in-progress" | "not-prepared";

function boundProjectCreation(
  reservation: ProjectCreationReservation,
): { packetId: string; projectId: string; workItemId: string } | null {
  return reservation.projectId === null ||
    reservation.workItemId === null ||
    reservation.packetId === null
    ? null
    : {
        packetId: reservation.packetId,
        projectId: reservation.projectId,
        workItemId: reservation.workItemId,
      };
}

export async function approvePreparedProjectHandoff(
  db: D1Database,
  storage: R2Bucket,
  input: {
    initializationId: string;
    now: number;
    requestId: string;
  },
): Promise<PreparedProjectApprovalResult> {
  const pending = await readInitializationById(db, input.initializationId);
  if (pending === null) return "not-prepared";
  if (pending.status === "approved") return "approved";
  if (
    pending.status !== "pending" ||
    pending.expiresAt <= input.now ||
    (pending.draft.requestKind === "join" &&
      pending.draft.ownerAction !== undefined)
  ) {
    return pending.status === "approving" ? "in-progress" : "not-prepared";
  }

  const handoff = await claimPreparedProjectHandoff(db, {
    agentGrantId: pending.bootstrapAgentGrantId,
    folderPathKey: pending.folderPathKey,
    initializationRequestId: pending.id,
    now: input.now,
    projectLabelKey: projectCreationLabelKey(pending.draft.project.label),
    requestId: input.requestId,
    vaultId: pending.vaultId,
  });
  if (handoff === null) {
    return (await preparedProjectHandoffClaimInProgress(db, {
      agentGrantId: pending.bootstrapAgentGrantId,
      folderPathKey: pending.folderPathKey,
      initializationRequestId: pending.id,
      now: input.now,
      projectLabelKey: projectCreationLabelKey(pending.draft.project.label),
      vaultId: pending.vaultId,
    }))
      ? "in-progress"
      : "not-prepared";
  }

  const claimed = await claimInitializationForApprovalById(
    db,
    pending.id,
    input.now,
  );
  if (claimed === null) {
    await releasePreparedProjectHandoff(db, {
      handoffId: handoff.id,
      initializationRequestId: pending.id,
    });
    return "in-progress";
  }

  const { approvalClaimId, value } = claimed;
  let creationStarted = false;
  try {
    if (
      value.id !== handoff.initializationRequestId ||
      value.bootstrapAgentGrantId !== handoff.agentGrantId ||
      value.vaultId !== handoff.vaultId ||
      value.folderPathKey !== handoff.folderPathKey ||
      projectCreationLabelKey(value.draft.project.label) !==
        handoff.projectLabelKey
    ) {
      throw new Error("prepared_project_handoff_mismatch");
    }
    const sourceGrant = await readActiveAgentGrant(db, {
      audience: value.audience,
      clientId: value.oauthClientId,
      grantId: value.bootstrapAgentGrantId,
    });
    if (sourceGrant === null || sourceGrant.vaultId !== value.vaultId) {
      throw new Error("prepared_project_agent_unavailable");
    }

    let created: {
      packetId: string;
      projectId: string;
      workItemId: string;
    };
    let creationContractSha256: string | undefined;
    let expectedKnowledgeSpaceVersionId: string | null = null;
    let expectedSelectorSha256: string | null = null;

    if (value.draft.requestKind === "create") {
      creationStarted = true;
      await validateProjectSourceAccess(
        db,
        sourceGrant,
        value.draft.sourceNotePaths.map((note) => note.path),
      );
      const projectRequest = initializationProjectRequest(
        value,
        value.draft.contextPolicy,
        sourceGrant,
      );
      expectedSelectorSha256 = await projectContextSelectorSha256(
        projectRequest.knowledgeSpace.members,
      );
      const approvedMember = projectRequest.knowledgeSpace.members.find(
        (member) => member.vaultId === value.vaultId,
      );
      if (approvedMember === undefined) {
        throw new Error("prepared_project_context_missing");
      }
      creationContractSha256 = await projectCreationContractSha256({
        approvedContextPolicy: projectContextPolicyFromMember(approvedMember),
        draft: value.draft,
        folderPathKey: value.folderPathKey,
        vaultId: value.vaultId,
      });
      let reservation = await ensureProjectCreationIdentity(db, {
        initializationId: value.id,
        now: input.now,
        projectLabelKey: projectCreationLabelKey(value.draft.project.label),
        vaultId: value.vaultId,
      });
      if (reservation === null) {
        throw new Error("prepared_project_identity_unavailable");
      }
      reservation = await claimProjectCreationReservation(db, {
        creationContractSha256,
        initializationId: value.id,
        now: input.now,
      });
      if (reservation === null) {
        throw new Error("prepared_project_identity_unavailable");
      }
      let bound = boundProjectCreation(reservation);
      if (bound !== null) {
        if (reservation.creationContractSha256 !== creationContractSha256) {
          throw new Error("prepared_project_identity_conflict");
        }
      } else {
        if (
          reservation.creatorInitializationRequestId !== value.id ||
          reservation.creationContractSha256 !== creationContractSha256
        ) {
          throw new Error("prepared_project_creation_in_progress");
        }
        const receipt = await readInitializationProjectReceipt(db, value.id);
        if (receipt === null) {
          await createCollaborationProject(
            db,
            storage,
            projectRequest,
            input.now,
            input.requestId,
            {
              activationReason:
                "Owner prepared this exact first Project handoff during onboarding.",
              initializationRequestId: value.id,
            },
          );
        }
        reservation = await bindProjectCreationReservation(
          db,
          value.id,
          input.now,
        );
        bound = reservation === null ? null : boundProjectCreation(reservation);
        if (
          bound === null ||
          reservation?.creationContractSha256 !== creationContractSha256
        ) {
          throw new Error("prepared_project_identity_unavailable");
        }
      }
      created = bound;
    } else {
      const selected = await revalidateProjectAccessSelection(db, storage, {
        grant: sourceGrant,
        now: input.now,
        rawContextPolicy: value.draft.contextPolicy,
        value,
      });
      created = {
        packetId: selected.packetId,
        projectId: selected.projectId,
        workItemId: selected.workItemId,
      };
      expectedKnowledgeSpaceVersionId = selected.knowledgeSpaceVersionId;
    }

    const project = await db
      .prepare(
        `SELECT active_knowledge_space_version_id
         FROM collaboration_projects
         WHERE project_id = ? AND status = 'active'
           AND agent_visibility = 'discoverable'`,
      )
      .bind(created.projectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (
      project === null ||
      (expectedKnowledgeSpaceVersionId !== null &&
        project.active_knowledge_space_version_id !==
          expectedKnowledgeSpaceVersionId)
    ) {
      throw new Error("prepared_project_reference_changed");
    }
    const knowledgeSpaceVersion = await readCollaborationRecord(
      db,
      storage,
      project.active_knowledge_space_version_id,
    );
    if (
      knowledgeSpaceVersion?.record.recordType !== "knowledge-space-version" ||
      (expectedSelectorSha256 !== null &&
        knowledgeSpaceVersion.record.selectorSha256 !== expectedSelectorSha256)
    ) {
      throw new Error("prepared_project_context_changed");
    }
    const approvedMember = knowledgeSpaceVersion.record.members.find(
      (member) => member.vaultId === value.vaultId,
    );
    if (approvedMember === undefined) {
      throw new Error("prepared_project_context_missing");
    }
    const authorization = await approveInitializationWithProjectGrant(db, {
      approvalClaimId,
      approvedContextPolicy: projectContextPolicyFromMember(approvedMember),
      creationContractSha256,
      initializationId: value.id,
      knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
      now: input.now,
      packetId: created.packetId,
      preparedProjectHandoffId: handoff.id,
      projectId: created.projectId,
      requestId: input.requestId,
      sourceGrant,
      workItemId: created.workItemId,
    });
    if (authorization === null) {
      throw new Error("prepared_project_authorization_failed");
    }
    if (
      !(await consumePreparedProjectHandoff(db, {
        handoffId: handoff.id,
        initializationRequestId: value.id,
        now: input.now,
        requestId: input.requestId,
      }))
    ) {
      console.error(
        JSON.stringify({
          event: "project.handoff_consumption_receipt_failed",
          level: "error",
          requestId: input.requestId,
        }),
      );
    }
    return "approved";
  } catch (error) {
    if (creationStarted) {
      await releaseProjectCreationReservation(db, {
        initializationId: value.id,
        now: input.now,
      });
    }
    await returnInitializationToPending(db, value.id, approvalClaimId);
    await releasePreparedProjectHandoff(db, {
      handoffId: handoff.id,
      initializationRequestId: value.id,
    });
    console.error(
      JSON.stringify({
        code: error instanceof Error ? error.message : "unknown",
        event: "project.handoff_automatic_approval_failed",
        level: "error",
        requestId: input.requestId,
      }),
    );
    return "failed";
  }
}
