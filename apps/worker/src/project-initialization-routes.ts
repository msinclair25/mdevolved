import {
  projectInitializationApprovalRequestSchema,
  projectInitializationConsentContextSchema,
  projectInitializationDecisionRequestSchema,
  projectInitializationDecisionResponseSchema,
  vaultIdSchema,
} from "@owd/contracts";
import type { Hono } from "hono";
import { readActiveAgentGrant } from "./agent-access-store";
import { ApiProblem } from "./api-problem";
import { createCollaborationProject } from "./collaboration-service";
import { readCollaborationRecord } from "./collaboration-store";
import { requireOwnerSession } from "./owner-session";
import {
  getProjectInitializationConsent,
  initializationProjectRequest,
  ProjectInitializationProblem,
  revalidateProjectAccessSelection,
  validateProjectSourceAccess,
} from "./project-initialization-service";
import {
  projectContextPolicyFromMember,
  projectContextSelectorSha256,
} from "./project-context-policy";
import {
  adoptBoundProjectCreationContract,
  approveInitializationWithProjectGrant,
  bindProjectCreationReservation,
  claimInitializationForApproval,
  claimProjectCreationReservation,
  ensureProjectCreationIdentity,
  insertInitializationTokenAlias,
  projectCreationContractSha256,
  projectCreationLabelKey,
  readInitializationById,
  readInitializationProjectReceipt,
  recoverInitializationForBrowser,
  releaseProjectCreationReservation,
  rejectInitialization,
  returnInitializationToPending,
  type ProjectCreationReservation,
} from "./project-initialization-store";
import { parseJsonBody, randomToken } from "./security";
import type { AppBindings } from "./types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

const PROJECT_CREATION_WAIT_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1_600];

function waitForProjectCreation(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

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

function throwInitializationProblem(error: unknown): never {
  if (!(error instanceof ProjectInitializationProblem)) throw error;
  const status =
    error.code === "initialization_not_found" ||
    error.code === "project_not_joinable"
      ? 404
      : error.code === "initialization_scope_required"
        ? 403
        : error.code === "library_not_ready"
          ? 409
          : [
                "authorization_request_invalid",
                "context_policy_invalid",
                "folder_scope_invalid",
                "source_context_invalid",
              ].includes(error.code)
            ? 400
            : 409;
  throw new ApiProblem(
    status,
    error.code,
    status === 404
      ? error.code === "project_not_joinable"
        ? "The selected Project is no longer available to this vault connection."
        : "The Project request was not found."
      : status === 403
        ? "This connection cannot request Project setup or access."
        : error.code === "library_not_ready"
          ? "OWD does not yet have an exact-current searchable library for this vault. Keep Obsidian open and retry shortly; if library status reports a failure, use Build now in OWD."
          : error.code === "initialization_approval_in_progress"
            ? "This Project approval is already completing. Keep this page open; the agent can continue as soon as the in-flight approval finishes."
            : error.code === "project_already_exists"
              ? "This Project already exists for the selected vault. Connect to the existing Project instead of creating a duplicate."
              : status === 400
                ? "The proposed Project context is invalid or outside the approved vault boundary."
                : "The Project request is expired or already decided.",
  );
}

export function registerProjectInitializationRoutes(
  app: Hono<AppBindings>,
): void {
  app.get("/api/project-initializations/context", async (context) => {
    await requireOwnerSession(context, { csrf: false });
    let token = context.req.query("request") ?? "";
    const recoveryRequestId = context.req.query("requestId");
    if (token === "" && recoveryRequestId !== undefined) {
      const parsedRequestId = vaultIdSchema.safeParse(recoveryRequestId);
      if (!parsedRequestId.success) {
        throw new ApiProblem(
          404,
          "initialization_not_found",
          "The Project request was not found.",
        );
      }
      let value = await readInitializationById(
        context.env.DB,
        parsedRequestId.data,
      );
      const now = nowSeconds();
      if (value?.status === "approving") {
        value = await recoverInitializationForBrowser(context.env.DB, {
          initializationId: value.id,
          now,
        });
        if (value?.status === "approving") {
          throw new ApiProblem(
            409,
            "initialization_approval_in_progress",
            "This Project approval is already completing. Keep this page open; the agent can continue as soon as the in-flight approval finishes.",
          );
        }
      }
      if (
        value === null ||
        value.status !== "pending" ||
        value.expiresAt <= now
      ) {
        throw new ApiProblem(
          409,
          "initialization_expired",
          "The Project initialization request is expired or already decided.",
        );
      }
      token = randomToken();
      if (
        !(await insertInitializationTokenAlias(context.env.DB, {
          expiresAt: value.expiresAt,
          initializationId: value.id,
          now,
          token,
        }))
      ) {
        throw new ApiProblem(
          503,
          "initialization_recovery_failed",
          "The pending Project request could not be reopened.",
        );
      }
    }
    try {
      const result = await getProjectInitializationConsent(context.env.DB, {
        now: nowSeconds(),
        token,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(
        projectInitializationConsentContextSchema.parse(result.context),
      );
    } catch (error) {
      return throwInitializationProblem(error);
    }
  });

  app.post("/api/project-initializations/deny", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = projectInitializationDecisionRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "initialization_request_invalid",
        "The Project initialization decision is invalid.",
      );
    }
    const rejected = await rejectInitialization(context.env.DB, {
      now: nowSeconds(),
      requestId: context.get("requestId"),
      token: parsed.data.initializationToken,
    });
    if (!rejected) {
      throw new ApiProblem(
        409,
        "initialization_expired",
        "The Project initialization request is expired or already decided.",
      );
    }
    return context.body(null, 204);
  });

  app.post("/api/project-initializations/approve", async (context) => {
    await requireOwnerSession(context, { csrf: true });
    const parsed = projectInitializationApprovalRequestSchema.safeParse(
      await parseJsonBody(context),
    );
    if (!parsed.success) {
      throw new ApiProblem(
        400,
        "initialization_request_invalid",
        "The Project initialization decision is invalid.",
      );
    }
    const now = nowSeconds();
    const claimed = await claimInitializationForApproval(
      context.env.DB,
      parsed.data.initializationToken,
      now,
    );
    if (claimed === null) {
      throw new ApiProblem(
        409,
        "initialization_expired",
        "The Project initialization request is expired or already decided.",
      );
    }
    const { approvalClaimId, value } = claimed;

    try {
      const bootstrapGrant = await readActiveAgentGrant(context.env.DB, {
        audience: value.audience,
        clientId: value.oauthClientId,
        grantId: value.bootstrapAgentGrantId,
      });
      if (bootstrapGrant === null || bootstrapGrant.vaultId !== value.vaultId) {
        throw new ApiProblem(
          409,
          "agent_grant_revoked",
          "The bootstrap vault connection is revoked or no longer valid.",
        );
      }
      let created: {
        packetId: string;
        projectId: string;
        workItemId: string;
      };
      let creationContractSha256: string | undefined;
      let legacyCreationContractCreatorId: string | null = null;
      let expectedKnowledgeSpaceVersionId: string | null = null;
      let expectedSelectorSha256: string | null = null;
      if (value.draft.requestKind === "create") {
        await validateProjectSourceAccess(
          context.env.DB,
          bootstrapGrant,
          value.draft.sourceNotePaths.map((note) => note.path),
        );
        const projectRequest = initializationProjectRequest(
          value,
          parsed.data.contextPolicy,
          bootstrapGrant,
        );
        expectedSelectorSha256 = await projectContextSelectorSha256(
          projectRequest.knowledgeSpace.members,
        );
        const approvedMember = projectRequest.knowledgeSpace.members.find(
          (member) => member.vaultId === value.vaultId,
        );
        if (approvedMember === undefined) {
          throw new ApiProblem(
            409,
            "context_policy_changed",
            "The approved vault is missing from the proposed Project context.",
          );
        }
        creationContractSha256 = await projectCreationContractSha256({
          approvedContextPolicy: projectContextPolicyFromMember(approvedMember),
          draft: value.draft,
          folderPathKey: value.folderPathKey,
          vaultId: value.vaultId,
        });
        let reservation = await ensureProjectCreationIdentity(context.env.DB, {
          initializationId: value.id,
          now,
          projectLabelKey: projectCreationLabelKey(value.draft.project.label),
          vaultId: value.vaultId,
        });
        if (reservation === null) {
          throw new ApiProblem(
            503,
            "project_identity_unavailable",
            "OWD could not reserve this Project identity.",
          );
        }

        for (let attempt = 0; ; attempt += 1) {
          reservation = await claimProjectCreationReservation(context.env.DB, {
            creationContractSha256,
            initializationId: value.id,
            now,
          });
          if (reservation === null) {
            throw new ApiProblem(
              503,
              "project_identity_unavailable",
              "OWD could not read this Project identity reservation.",
            );
          }

          let bound = boundProjectCreation(reservation);
          if (
            bound !== null &&
            reservation.creationContractSha256 === null &&
            reservation.creatorInitializationRequestId !== null
          ) {
            let verifiedLegacyContract: string | null = null;
            if (reservation.creatorInitializationRequestId === value.id) {
              verifiedLegacyContract = creationContractSha256;
            } else {
              const legacyCreator = await readInitializationById(
                context.env.DB,
                reservation.creatorInitializationRequestId,
              );
              if (
                legacyCreator?.status === "approved" &&
                legacyCreator.draft.requestKind === "create"
              ) {
                verifiedLegacyContract = await projectCreationContractSha256({
                  approvedContextPolicy: legacyCreator.draft.contextPolicy,
                  draft: legacyCreator.draft,
                  folderPathKey: legacyCreator.folderPathKey,
                  vaultId: legacyCreator.vaultId,
                });
              }
            }
            if (verifiedLegacyContract === creationContractSha256) {
              legacyCreationContractCreatorId =
                reservation.creatorInitializationRequestId;
            }
          }

          if (bound !== null) {
            if (
              reservation.creationContractSha256 !== creationContractSha256 &&
              legacyCreationContractCreatorId === null
            ) {
              throw new ApiProblem(
                409,
                "project_identity_conflict",
                "A Project with this name already exists in this vault with a different approved definition. Return to the same agent and open that exact Project; do not create a duplicate.",
              );
            }
            created = bound;
            break;
          }

          if (
            reservation.creatorInitializationRequestId === value.id &&
            reservation.creationContractSha256 === creationContractSha256
          ) {
            const receipt = await readInitializationProjectReceipt(
              context.env.DB,
              value.id,
            );
            if (receipt === null) {
              await createCollaborationProject(
                context.env.DB,
                context.env.VAULT_STORAGE,
                projectRequest,
                now,
                context.get("requestId"),
                {
                  activationReason:
                    "Owner approved the exact agent-requested Project initialization.",
                  initializationRequestId: value.id,
                },
              );
            }
            reservation = await bindProjectCreationReservation(
              context.env.DB,
              value.id,
              now,
            );
            if (reservation === null) {
              throw new ApiProblem(
                503,
                "project_identity_unavailable",
                "OWD created the Project but could not recover its durable identity receipt.",
              );
            }
            const creatorBound = boundProjectCreation(reservation);
            if (
              creatorBound === null ||
              reservation.creationContractSha256 !== creationContractSha256
            ) {
              throw new ApiProblem(
                503,
                "project_identity_unavailable",
                "OWD created the Project but could not bind its durable identity receipt.",
              );
            }
            created = creatorBound;
            break;
          }

          if (
            reservation.creationContractSha256 !== null &&
            reservation.creationContractSha256 !== creationContractSha256
          ) {
            throw new ApiProblem(
              409,
              "project_identity_conflict",
              "Another approved request is creating this Project name with a different definition. Return to the same agent and open the resulting Project; do not create a duplicate.",
            );
          }
          const delay = PROJECT_CREATION_WAIT_DELAYS_MS[attempt];
          if (delay === undefined) {
            throw new ApiProblem(
              409,
              "project_creation_in_progress",
              "The same Project is being created by another approved agent request. Retry this approval once; OWD will attach it to that Project and will not create a duplicate.",
            );
          }
          await waitForProjectCreation(delay);
        }
      } else {
        const selected = await revalidateProjectAccessSelection(
          context.env.DB,
          context.env.VAULT_STORAGE,
          {
            grant: bootstrapGrant,
            now,
            rawContextPolicy: parsed.data.contextPolicy,
            value,
          },
        );
        created = {
          packetId: selected.packetId,
          projectId: selected.projectId,
          workItemId: selected.workItemId,
        };
        expectedKnowledgeSpaceVersionId = selected.knowledgeSpaceVersionId;
      }
      const project = await context.env.DB.prepare(
        `SELECT active_knowledge_space_version_id
         FROM collaboration_projects
         WHERE project_id = ? AND status = 'active'
           AND agent_visibility = 'discoverable'`,
      )
        .bind(created.projectId)
        .first<{ active_knowledge_space_version_id: string }>();
      if (project === null) {
        throw new ApiProblem(
          409,
          "project_reference_invalid",
          "The initialized Project is not active.",
        );
      }
      if (
        expectedKnowledgeSpaceVersionId !== null &&
        project.active_knowledge_space_version_id !==
          expectedKnowledgeSpaceVersionId
      ) {
        throw new ApiProblem(
          409,
          "project_context_changed",
          "The selected Project context changed before approval. Return to the same agent and retry open_project for this exact Project; do not reconnect or create a duplicate.",
        );
      }
      const knowledgeSpaceVersion = await readCollaborationRecord(
        context.env.DB,
        context.env.VAULT_STORAGE,
        project.active_knowledge_space_version_id,
      );
      if (
        knowledgeSpaceVersion?.record.recordType !==
          "knowledge-space-version" ||
        (expectedSelectorSha256 !== null &&
          knowledgeSpaceVersion.record.selectorSha256 !==
            expectedSelectorSha256)
      ) {
        throw new ApiProblem(
          409,
          "context_policy_changed",
          "This retry does not match the Project context previously created for the request.",
        );
      }
      const approvedMember = knowledgeSpaceVersion.record.members.find(
        (member) => member.vaultId === value.vaultId,
      );
      if (approvedMember === undefined) {
        throw new ApiProblem(
          409,
          "context_policy_changed",
          "The approved vault is no longer a member of this Project.",
        );
      }
      if (
        legacyCreationContractCreatorId !== null &&
        creationContractSha256 !== undefined
      ) {
        const upgradedReservation = await adoptBoundProjectCreationContract(
          context.env.DB,
          {
            creationContractSha256,
            creatorInitializationId: legacyCreationContractCreatorId,
            initializationId: value.id,
            now,
          },
        );
        const upgradedBound =
          upgradedReservation === null
            ? null
            : boundProjectCreation(upgradedReservation);
        if (
          upgradedReservation?.creationContractSha256 !==
            creationContractSha256 ||
          upgradedBound?.projectId !== created.projectId ||
          upgradedBound.workItemId !== created.workItemId ||
          upgradedBound.packetId !== created.packetId
        ) {
          throw new ApiProblem(
            409,
            "project_identity_conflict",
            "OWD could not safely upgrade this legacy Project identity. Return to the same agent and open the existing Project; do not create a duplicate.",
          );
        }
      }
      const authorization = await approveInitializationWithProjectGrant(
        context.env.DB,
        {
          approvalClaimId,
          approvedContextPolicy: projectContextPolicyFromMember(approvedMember),
          creationContractSha256,
          initializationId: value.id,
          knowledgeSpaceVersionId: project.active_knowledge_space_version_id,
          now,
          packetId: created.packetId,
          projectId: created.projectId,
          requestId: context.get("requestId"),
          sourceGrant: bootstrapGrant,
          workItemId: created.workItemId,
        },
      );
      if (authorization === null) {
        throw new ApiProblem(
          503,
          "initialization_failed",
          "The Project approval could not be recorded.",
        );
      }
      context.header("Cache-Control", "private, no-store");
      return context.json(
        projectInitializationDecisionResponseSchema.parse({
          nextAction:
            "Project access is ready. Continue in the agent; no reconnect or reauthorization is required.",
          projectId: created.projectId,
          status: "approved",
        }),
      );
    } catch (error) {
      if (value.draft.requestKind === "create") {
        await releaseProjectCreationReservation(context.env.DB, {
          initializationId: value.id,
          now,
        });
      }
      await returnInitializationToPending(
        context.env.DB,
        value.id,
        approvalClaimId,
      );
      if (error instanceof ProjectInitializationProblem) {
        return throwInitializationProblem(error);
      }
      throw error;
    }
  });
}
