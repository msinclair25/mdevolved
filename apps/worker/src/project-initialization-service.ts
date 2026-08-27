import {
  PROJECT_CONNECTION_SCOPE,
  canonicalizeCollaborationJson,
  canonicalizeIntegrityPayload,
  collaborationProjectCreateRequestSchema,
  joinableProjectListResponseSchema,
  projectAccessRequestResponseSchema,
  projectAccessRequestSchema,
  projectAccessStatusResponseSchema,
  projectInitializationRequestResponseSchema,
  projectInitializationRequestSchema,
  type CollaborationProjectCreateRequest,
  type CollaborationScope,
  type JoinableProject,
  type JoinableProjectListResponse,
  type KnowledgeSpaceVersion,
  type ProjectAccessRequestResponse,
  type ProjectAccessStatusResponse,
  type ProjectContextPolicy,
  type ProjectInitializationConsentContext,
  type ProjectInitializationOwnerAction,
  type ProjectInitializationRequestResponse,
  type ProjectInitializationStatusResponse,
  type StoredProjectSetupDraft,
  type WorkPacket,
} from "@owd/contracts";
import {
  readActiveAgentGrant,
  type ActiveAgentGrant,
} from "./agent-access-store";
import {
  readCollaborationRecord,
  readCollaborationRecords,
} from "./collaboration-store";
import {
  readMaterializedNoteRestoreAccessBatch,
  readMaterializedNotes,
  readUsableMaterialization,
} from "./materialization-store";
import {
  agentVisibilityForGrant,
  visibilityAllowsPath,
  visibilityAllowsPrefix,
} from "./agent-visibility";
import {
  refreshContinuationWorkPacketIfNeeded,
  workPacketNeedsAutomaticRefresh,
} from "./collaboration-service";
import {
  compileProjectContextPolicy,
  ProjectContextPolicyProblem,
  projectContextPolicyFromMember,
  projectContextSelectorSha256,
  projectContinuityReceipt,
} from "./project-context-policy";
import { sha256Hex } from "./security";
import {
  INITIALIZATION_LIFETIME_SECONDS,
  initializationConsentContext,
  initializationStatus,
  insertInitializationRequest,
  insertInitializationTokenAlias,
  isSameOrSuccessorPacket,
  projectCreationLabelKey,
  readInitializationById,
  readInitializationBySemanticKey,
  readInitializationByToken,
  readInitializationProjectReceipt,
  rebindInitializationToEquivalentActiveSuccessor,
  recoverInitializationForBrowser,
  renewExpiredInitializationRequest,
  resolveApprovedProjectAuthorization,
  supersedeInitializationForFreshApproval,
  type StoredProjectInitialization,
} from "./project-initialization-store";
import { VaultPathError, validateMarkdownVaultPath } from "./vault-path";

export type ProjectInitializationProblemCode =
  | "authorization_request_invalid"
  | "context_policy_invalid"
  | "folder_scope_invalid"
  | "idempotency_conflict"
  | "initialization_expired"
  | "initialization_approval_in_progress"
  | "initialization_not_found"
  | "initialization_scope_required"
  | "library_not_ready"
  | "project_not_joinable"
  | "project_already_exists"
  | "source_context_invalid";

type ProjectUnavailableReason =
  | "folder-scope-mismatch"
  | "integrity-invalid"
  | "multi-vault-project"
  | "packet-expired"
  | "packet-missing"
  | "packet-stale"
  | "project-context-invalid"
  | "source-unavailable"
  | "vault-not-member"
  | "work-item-closed";

type ProjectInitializationProblemDetails = {
  nextAction: string;
  reason: ProjectUnavailableReason;
};

export class ProjectInitializationProblem extends Error {
  constructor(
    readonly code: ProjectInitializationProblemCode,
    readonly publicMessage?: string,
    readonly details?: ProjectInitializationProblemDetails,
  ) {
    super(code);
    this.name = "ProjectInitializationProblem";
  }
}

function projectApprovalUrl(
  audience: string,
  initializationId: string,
  requestKind: "create" | "join",
): string {
  const route = requestKind === "join" ? "connect" : "initialize";
  return `${new URL(audience).origin}/${route}?requestId=${encodeURIComponent(initializationId)}`;
}

function normalizeFolder(value: string): { path: string; pathKey: string } {
  if (value === "") return { path: "", pathKey: "" };
  try {
    const directory = value.endsWith("/") ? value.slice(0, -1) : value;
    const sentinel = validateMarkdownVaultPath(
      `${directory}/__owd_project_scope__.md`,
    );
    return {
      path: sentinel.path.slice(0, -"/__owd_project_scope__.md".length),
      pathKey: sentinel.pathKey.slice(0, -"/__owd_project_scope__.md".length),
    };
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new ProjectInitializationProblem("folder_scope_invalid");
    }
    throw error;
  }
}

async function projectSemanticKey(input: {
  draft: StoredProjectSetupDraft;
  folderPathKey: string;
  vaultId: string;
}): Promise<string> {
  return sha256Hex(
    canonicalizeCollaborationJson({
      folderPathKey: input.folderPathKey,
      project: {
        label: input.draft.project.label,
        objective: input.draft.project.objective,
      },
      requestKind: input.draft.requestKind,
      ownerAction:
        input.draft.requestKind === "join"
          ? (input.draft.ownerAction ?? null)
          : null,
      targetProjectId:
        input.draft.requestKind === "join"
          ? input.draft.target.projectId
          : null,
      vaultId: input.vaultId,
    }),
  );
}

function normalizedInitializationStatus(
  value: StoredProjectInitialization,
  now: number,
): StoredProjectInitialization["status"] {
  return value.status === "approving"
    ? "pending"
    : value.status === "pending" && value.expiresAt <= now
      ? "expired"
      : value.status;
}

function pathInside(pathKey: string, folderPathKey: string): boolean {
  return (
    folderPathKey === "" ||
    pathKey === folderPathKey ||
    pathKey.startsWith(`${folderPathKey}/`)
  );
}

function grantAllowsFolder(grant: ActiveAgentGrant, pathKey: string): boolean {
  return visibilityAllowsPrefix(agentVisibilityForGrant(grant), pathKey);
}

function grantAllowsPath(grant: ActiveAgentGrant, pathKey: string): boolean {
  return visibilityAllowsPath(agentVisibilityForGrant(grant), pathKey);
}

function validateBoundedContext(
  grant: ActiveAgentGrant,
  folderBoundary: string,
  sourcePaths: string[],
): { folderPath: string; folderPathKey: string } {
  const folder = normalizeFolder(folderBoundary);
  if (!grantAllowsFolder(grant, folder.pathKey)) {
    throw new ProjectInitializationProblem("folder_scope_invalid");
  }
  for (const path of sourcePaths) {
    let validated;
    try {
      validated = validateMarkdownVaultPath(path);
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new ProjectInitializationProblem("source_context_invalid");
      }
      throw error;
    }
    if (
      !pathInside(validated.pathKey, folder.pathKey) ||
      !grantAllowsPath(grant, validated.pathKey)
    ) {
      throw new ProjectInitializationProblem("source_context_invalid");
    }
  }
  return { folderPath: folder.path, folderPathKey: folder.pathKey };
}

export async function validateProjectSourceAccess(
  db: D1Database,
  grant: ActiveAgentGrant,
  sourcePaths: string[],
): Promise<void> {
  const generation = await readUsableMaterialization(db, grant.vaultId);
  if (generation === null) {
    throw new ProjectInitializationProblem("library_not_ready");
  }
  const pathKeys: string[] = [];
  for (const path of sourcePaths) {
    try {
      const pathKey = validateMarkdownVaultPath(path).pathKey;
      if (!grantAllowsPath(grant, pathKey)) {
        throw new ProjectInitializationProblem("source_context_invalid");
      }
      pathKeys.push(pathKey);
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new ProjectInitializationProblem("source_context_invalid");
      }
      throw error;
    }
  }
  const [notes, restoreAccess] = await Promise.all([
    readMaterializedNotes(db, {
      generationId: generation.generationId,
      pathKeys,
      vaultId: grant.vaultId,
    }),
    readMaterializedNoteRestoreAccessBatch(db, {
      grantId: grant.id,
      pathKeys,
      vaultId: grant.vaultId,
    }),
  ]);
  if (
    pathKeys.some(
      (pathKey) =>
        !notes.has(pathKey) ||
        (grant.runtimeProfile !== null &&
          notes.get(pathKey)?.agent_private === 1) ||
        restoreAccess.get(pathKey)?.allowed !== true,
    )
  ) {
    throw new ProjectInitializationProblem("source_context_invalid");
  }
}

function throwContextPolicyProblem(error: unknown): never {
  if (!(error instanceof ProjectContextPolicyProblem)) throw error;
  throw new ProjectInitializationProblem(error.code);
}

type JoinableProjectRow = {
  active_knowledge_space_version_id: string;
  active_project_version_id: string;
  created_at: number;
  current_packet_id: string | null;
  label: string;
  objective: string;
  project_id: string;
};

type LoadedJoinableProject = {
  candidate: JoinableProject;
  knowledgeSpaceVersionId: string;
  packet: WorkPacket;
};

type LoadedClosedWorkItemProject = LoadedJoinableProject & {
  ownerAction: ProjectInitializationOwnerAction;
};

type ProjectInspection =
  | { loaded: LoadedJoinableProject; unavailable: null }
  | {
      loaded: null;
      unavailable: {
        label: string;
        nextAction: string;
        objective: string;
        projectId: string;
        reason: ProjectUnavailableReason;
      };
    };

type UnavailableProject = Extract<
  ProjectInspection,
  { loaded: null }
>["unavailable"];

export type ExactProjectHintMatch =
  | {
      joinability: "joinable";
      label: string;
      objective: string;
      projectId: string;
    }
  | (UnavailableProject & { joinability: "unavailable" });

export type ExactProjectHintResolution =
  | { state: "not-found" }
  | { project: JoinableProject; state: "joinable" }
  | { project: UnavailableProject; state: "unavailable" }
  | { state: "indeterminate" }
  | {
      catalogComplete: boolean;
      projects: ExactProjectHintMatch[];
      state: "selection-required";
    };

function unavailableProject(
  row: JoinableProjectRow,
  reason: ProjectUnavailableReason,
): ProjectInspection {
  const nextActions: Record<ProjectUnavailableReason, string> = {
    "folder-scope-mismatch":
      "This agent's approved folder does not include the Project sources. MDevolved cannot widen access silently. Approve a folder that includes this exact Project once in the agent's MDevolved connection, then retry the same Project.",
    "integrity-invalid":
      "Open the Project in MDevolved and create a fresh continuation packet.",
    "multi-vault-project":
      "This Project uses more than one vault. Agent-first access currently requires one Project vault so every source is shown in one exact owner approval. Use a single-vault Project; do not create a duplicate just to bypass this boundary.",
    "packet-expired":
      "Retry the Project request. MDevolved refreshes routine agent context automatically; no owner renewal is required.",
    "packet-missing":
      "Open the Project in MDevolved and create its first continuation packet.",
    "packet-stale":
      "This Project's pinned context changed. Repair this existing Project in MDevolved; do not initialize a replacement Project.",
    "project-context-invalid":
      "Open the Project in MDevolved and repair its Knowledge Space before connecting an agent.",
    "source-unavailable":
      "Restore or sync the missing cited note inside this Project's existing vault boundary, then retry the same Project. MDevolved rechecks the current library automatically; do not create a duplicate.",
    "vault-not-member":
      "This local Project receipt belongs to a different approved vault boundary. Open the owner page to choose the Project's existing vault or retire the stale local receipt; MDevolved will not change Knowledge Space membership silently.",
    "work-item-closed":
      "Open this exact Project in MDevolved and select Reopen current Work Item, then retry this same connection. Do not create a duplicate Project.",
  };
  return {
    loaded: null,
    unavailable: {
      label: row.label,
      nextAction: nextActions[reason],
      objective: row.objective,
      projectId: row.project_id,
      reason,
    },
  };
}

async function inspectJoinableProjects(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    projectId?: string;
    projectLabel?: string;
    repairRoutineContext?: boolean;
  },
): Promise<{
  catalogComplete: boolean;
  closed: LoadedClosedWorkItemProject[];
  loaded: LoadedJoinableProject[];
  unresolvedMatchCount: number;
  unavailable: Array<
    Extract<ProjectInspection, { loaded: null }>["unavailable"]
  >;
}> {
  const inspectionLimit = input.projectId === undefined ? 50 : 1;
  const normalizedProjectLabel = input.projectLabel?.trim().toLowerCase();
  const rows = await db
    .prepare(
      `SELECT p.project_id, p.active_project_version_id,
        p.active_knowledge_space_version_id, p.label, p.objective, p.created_at,
        (
          SELECT COUNT(*)
          FROM collaboration_projects active
          WHERE active.status = 'active'
            AND active.agent_visibility = 'discoverable'
            AND (? IS NULL OR LOWER(TRIM(active.label)) = ?)
        ) AS catalog_count,
        (
          SELECT r.id
          FROM collaboration_records r
          JOIN collaboration_work_items w
            ON w.work_item_id = r.work_item_id
          WHERE r.project_id = p.project_id
            AND r.record_type = 'work-packet'
          ORDER BY
            CASE WHEN w.status = 'open' THEN 0 ELSE 1 END,
            r.received_at DESC,
            r.id DESC
          LIMIT 1
        ) AS current_packet_id
       FROM collaboration_projects p
       WHERE p.status = 'active'
         AND p.agent_visibility = 'discoverable'
         AND (? IS NULL OR p.project_id = ?)
         AND (? IS NULL OR LOWER(TRIM(p.label)) = ?)
       ORDER BY p.created_at DESC, p.project_id DESC
       LIMIT ?`,
    )
    .bind(
      normalizedProjectLabel ?? null,
      normalizedProjectLabel ?? null,
      input.projectId ?? null,
      input.projectId ?? null,
      normalizedProjectLabel ?? null,
      normalizedProjectLabel ?? null,
      inspectionLimit,
    )
    .all<JoinableProjectRow & { catalog_count: number }>();
  const catalogComplete =
    input.projectId !== undefined ||
    (rows.results[0]?.catalog_count ?? 0) <= inspectionLimit;
  const closed: LoadedClosedWorkItemProject[] = [];
  const loaded: LoadedJoinableProject[] = [];
  let unresolvedMatchCount = 0;
  const unavailable: Array<
    Extract<ProjectInspection, { loaded: null }>["unavailable"]
  > = [];
  const knowledgeSpaces = await readCollaborationRecords(
    db,
    storage,
    rows.results.map((row) => row.active_knowledge_space_version_id),
  );
  const sameVault: Array<{
    knowledgeSpace: KnowledgeSpaceVersion;
    member: KnowledgeSpaceVersion["members"][number];
    row: JoinableProjectRow;
  }> = [];
  for (const row of rows.results) {
    const value = knowledgeSpaces.get(row.active_knowledge_space_version_id);
    if (value?.record.recordType !== "knowledge-space-version") {
      unresolvedMatchCount += 1;
      continue;
    }
    const member = value.record.members.find(
      (candidate) => candidate.vaultId === input.grant.vaultId,
    );
    if (
      (await projectContextSelectorSha256(value.record.members)) !==
      value.record.selectorSha256
    ) {
      if (member === undefined) {
        unresolvedMatchCount += 1;
      } else {
        unavailable.push(
          unavailableProject(row, "project-context-invalid").unavailable!,
        );
      }
      continue;
    }
    if (member === undefined) {
      // A Project ID from the local continuity receipt is an explicit
      // identity. Return a repair reason for that ID without exposing metadata
      // during ordinary name/catalog discovery across vaults.
      if (input.projectId !== undefined) {
        unavailable.push(
          unavailableProject(row, "vault-not-member").unavailable!,
        );
      }
      continue;
    }
    if (value.record.members.length !== 1) {
      unavailable.push(
        unavailableProject(row, "multi-vault-project").unavailable!,
      );
      continue;
    }
    if (
      member.pathPrefixes.some(
        (prefix) => !grantAllowsFolder(input.grant, prefix.pathKey),
      )
    ) {
      unavailable.push(
        unavailableProject(row, "folder-scope-mismatch").unavailable!,
      );
      continue;
    }
    if (row.current_packet_id === null) {
      unavailable.push(unavailableProject(row, "packet-missing").unavailable!);
      continue;
    }
    sameVault.push({
      knowledgeSpace: value.record,
      member,
      row,
    });
  }
  const packets = await readCollaborationRecords(
    db,
    storage,
    sameVault.flatMap((value) =>
      value.row.current_packet_id === null ? [] : [value.row.current_packet_id],
    ),
  );
  const sourceBearing: Array<{
    citationPathKeys: string[];
    knowledgeSpace: KnowledgeSpaceVersion;
    member: KnowledgeSpaceVersion["members"][number];
    packet: WorkPacket;
    row: JoinableProjectRow;
  }> = [];
  const allCitationPathKeys: string[] = [];
  for (const value of sameVault) {
    const packetValue =
      value.row.current_packet_id === null
        ? undefined
        : packets.get(value.row.current_packet_id);
    if (packetValue?.record.recordType !== "work-packet") {
      unavailable.push(
        unavailableProject(value.row, "project-context-invalid").unavailable!,
      );
      continue;
    }
    let packet = packetValue.record;
    if (
      packet.projectId !== value.row.project_id ||
      packet.projectVersionId !== value.row.active_project_version_id ||
      packet.knowledgeSpaceVersionId !==
        value.row.active_knowledge_space_version_id
    ) {
      if (input.repairRoutineContext === true) {
        try {
          packet = await refreshContinuationWorkPacketIfNeeded(db, storage, {
            force: true,
            now: input.now,
            packet,
            projectId: value.row.project_id,
          });
        } catch {
          unavailable.push(
            unavailableProject(value.row, "packet-stale").unavailable!,
          );
          continue;
        }
      }
      if (
        packet.projectId !== value.row.project_id ||
        packet.projectVersionId !== value.row.active_project_version_id ||
        packet.knowledgeSpaceVersionId !==
          value.row.active_knowledge_space_version_id
      ) {
        unavailable.push(
          unavailableProject(value.row, "packet-stale").unavailable!,
        );
        continue;
      }
    }
    const citationPathKeys: string[] = [];
    let contextInvalid = false;
    for (const citation of packet.sourceCitations) {
      if (citation.vaultId !== input.grant.vaultId) {
        contextInvalid = true;
        break;
      }
      try {
        const pathKey = validateMarkdownVaultPath(citation.path).pathKey;
        if (!grantAllowsPath(input.grant, pathKey)) {
          contextInvalid = true;
          break;
        }
        citationPathKeys.push(pathKey);
      } catch (error) {
        if (!(error instanceof VaultPathError)) throw error;
        contextInvalid = true;
        break;
      }
    }
    if (contextInvalid) {
      unavailable.push(
        unavailableProject(value.row, "project-context-invalid").unavailable!,
      );
      continue;
    }
    allCitationPathKeys.push(...citationPathKeys);
    sourceBearing.push({
      citationPathKeys,
      knowledgeSpace: value.knowledgeSpace,
      member: value.member,
      packet,
      row: value.row,
    });
  }
  const current =
    allCitationPathKeys.length === 0
      ? null
      : await readUsableMaterialization(db, input.grant.vaultId);
  const [currentNotes, restoreAccess] = await Promise.all([
    current === null
      ? Promise.resolve(new Map())
      : readMaterializedNotes(db, {
          generationId: current.generationId,
          pathKeys: allCitationPathKeys,
          vaultId: input.grant.vaultId,
        }),
    readMaterializedNoteRestoreAccessBatch(db, {
      grantId: input.grant.id,
      pathKeys: allCitationPathKeys,
      vaultId: input.grant.vaultId,
    }),
  ]);
  const projectIds = [
    ...new Set(sourceBearing.map((value) => value.row.project_id)),
  ];
  const workItemRows =
    projectIds.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT project_id, work_item_id, active_work_item_version_id,
                status
               FROM collaboration_work_items
               WHERE project_id IN (${projectIds.map(() => "?").join(", ")})`,
            )
            .bind(...projectIds)
            .all<{
              active_work_item_version_id: string;
              project_id: string;
              status: "closed" | "open" | "quarantined";
              work_item_id: string;
            }>()
        ).results;
  const workItems = new Map(
    workItemRows.map((row) => [`${row.project_id}:${row.work_item_id}`, row]),
  );
  for (const value of sourceBearing) {
    const workItem = workItems.get(
      `${value.row.project_id}:${value.packet.workItemId}`,
    );
    if (workItem === undefined || workItem.status === "quarantined") {
      unavailable.push(
        unavailableProject(value.row, "work-item-closed").unavailable!,
      );
      continue;
    }
    const workItemClosed = workItem.status === "closed";
    if (
      value.packet.workItemVersionId !== workItem.active_work_item_version_id
    ) {
      if (input.repairRoutineContext === true) {
        try {
          value.packet = await refreshContinuationWorkPacketIfNeeded(
            db,
            storage,
            {
              force: true,
              now: input.now,
              packet: value.packet,
              projectId: value.row.project_id,
            },
          );
        } catch {
          unavailable.push(
            unavailableProject(value.row, "packet-stale").unavailable!,
          );
          continue;
        }
      }
      if (
        value.packet.workItemVersionId !== workItem.active_work_item_version_id
      ) {
        unavailable.push(
          unavailableProject(value.row, "packet-stale").unavailable!,
        );
        continue;
      }
    }
    if (
      value.citationPathKeys.length > 0 &&
      current === null &&
      value.packet.expiresAt <= input.now
    ) {
      unavailable.push(
        unavailableProject(value.row, "source-unavailable").unavailable!,
      );
      continue;
    }
    let sourceUnavailable = false;
    let packetStale = false;
    for (const [index, citation] of value.packet.sourceCitations.entries()) {
      const pathKey = value.citationPathKeys[index]!;
      if (restoreAccess.get(pathKey)?.allowed !== true) {
        sourceUnavailable = true;
        break;
      }
      if (current === null) continue;
      const currentNote = currentNotes.get(pathKey);
      if (currentNote === undefined) {
        sourceUnavailable = true;
        break;
      }
      if (
        input.grant.runtimeProfile !== null &&
        currentNote.agent_private === 1
      ) {
        sourceUnavailable = true;
        break;
      }
      const citedWholeNote =
        citation.excerptByteRange.start === 0 &&
        citation.excerptByteRange.endExclusive === citation.sourceByteLength;
      if (
        !citedWholeNote &&
        citation.excerptByteRange.endExclusive > currentNote.byte_length
      ) {
        packetStale = true;
        break;
      }
    }
    if (sourceUnavailable || packetStale) {
      unavailable.push(
        unavailableProject(
          value.row,
          packetStale ? "packet-stale" : "source-unavailable",
        ).unavailable!,
      );
      continue;
    }
    if (
      (await sha256Hex(canonicalizeIntegrityPayload(value.packet))) !==
      value.packet.integrity.digest
    ) {
      unavailable.push(
        unavailableProject(value.row, "integrity-invalid").unavailable!,
      );
      continue;
    }
    const loadedProject: LoadedJoinableProject = {
      candidate: {
        contextPolicy: projectContextPolicyFromMember(value.member),
        createdAt: value.row.created_at,
        currentPacket: {
          expiresAt: value.packet.expiresAt,
          packetId: value.packet.packetId,
          requestedRole: value.packet.requestedRole.label,
          workItemId: value.packet.workItemId,
          workItemObjective: value.packet.brief.objective,
        },
        label: value.row.label,
        objective: value.row.objective,
        projectId: value.row.project_id,
      },
      knowledgeSpaceVersionId: value.row.active_knowledge_space_version_id,
      packet: value.packet,
    };
    if (workItemClosed) {
      closed.push({
        ...loadedProject,
        ownerAction: {
          kind: "reopen-work-item-and-connect",
          workItemId: workItem.work_item_id,
          workItemVersionId: workItem.active_work_item_version_id,
        },
      });
    } else {
      loaded.push(loadedProject);
    }
  }
  return {
    catalogComplete,
    closed,
    loaded,
    unavailable,
    unresolvedMatchCount,
  };
}

export async function listJoinableProjects(
  db: D1Database,
  storage: R2Bucket,
  input: { grant: ActiveAgentGrant; now: number },
): Promise<JoinableProjectListResponse> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const inspection = await inspectJoinableProjects(db, storage, input);
  const projects = inspection.loaded;
  const hasCompatibleProject = projects.length > 0;
  const visibility = agentVisibilityForGrant(input.grant);
  const effectivePathPrefixes =
    input.grant.runtimeProfile === null
      ? input.grant.pathPrefixes
      : visibility.pathKeyPrefixes.map((prefix) => prefix.replace(/\/+$/u, ""));
  return joinableProjectListResponseSchema.parse({
    connectedVault: {
      entireVault:
        input.grant.runtimeProfile === null
          ? input.grant.pathPrefixes.length === 0
          : !visibility.denyAll && visibility.pathKeyPrefixes.length === 0,
      id: input.grant.vaultId,
      name: input.grant.vaultName,
      pathPrefixes: effectivePathPrefixes,
    },
    nextAction: hasCompatibleProject
      ? projects.length === 1
        ? "Open this single compatible Project automatically. Ask only if the user explicitly named different work."
        : "More than one compatible Project exists. Ask the user to identify one by its visible name; never guess."
      : inspection.catalogComplete
        ? "No compatible MDevolved Project exists in this exact vault and folder grant. Unavailable Project metadata stays private unless the user explicitly targets its receipt ID. Continue with a New Project draft; do not ask the user to choose between New and Existing."
        : "No compatible MDevolved Project appeared in the bounded automatic scan. Continue with the exact user-named Project or a bounded New Project draft; open_project will check that exact identity across the catalog before creating anything. Unrelated Projects must not block this vault.",
    newProjectAllowed: true,
    projects: projects.map((value) => value.candidate),
    requiresExplicitChoice: projects.length > 1,
    selectionMode: hasCompatibleProject
      ? "choose-existing-project"
      : "create-new-project",
    unavailableProjects: [],
  });
}

export async function loadExactJoinableProject(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    projectId: string;
  },
): Promise<JoinableProjectListResponse["projects"][number]> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const inspection = await inspectJoinableProjects(db, storage, {
    ...input,
    repairRoutineContext: true,
  });
  const exact = inspection.loaded[0]?.candidate;
  if (exact === undefined) throw projectNotJoinableProblem(inspection);
  return exact;
}

export type ProjectConnectionCandidate = {
  candidate: JoinableProject;
  ownerAction: ProjectInitializationOwnerAction | null;
};

export async function loadExactProjectConnectionCandidate(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    projectId: string;
  },
): Promise<ProjectConnectionCandidate> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const inspection = await inspectJoinableProjects(db, storage, {
    ...input,
    repairRoutineContext: true,
  });
  const joinable = inspection.loaded[0];
  if (joinable !== undefined) {
    return { candidate: joinable.candidate, ownerAction: null };
  }
  const closed = inspection.closed[0];
  if (closed !== undefined) {
    return {
      candidate: closed.candidate,
      ownerAction: closed.ownerAction,
    };
  }
  throw projectNotJoinableProblem(inspection);
}

export async function resolveExactProjectHint(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    projectHint: string;
  },
): Promise<ExactProjectHintResolution> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const inspection = await inspectJoinableProjects(db, storage, {
    grant: input.grant,
    now: input.now,
    projectLabel: input.projectHint,
    repairRoutineContext: true,
  });
  const projects: ExactProjectHintMatch[] = [
    ...inspection.loaded.map((value) => ({
      joinability: "joinable" as const,
      label: value.candidate.label,
      objective: value.candidate.objective,
      projectId: value.candidate.projectId,
    })),
    ...inspection.unavailable.map((value) => ({
      ...value,
      joinability: "unavailable" as const,
    })),
    ...inspection.closed.map((value) => ({
      joinability: "unavailable" as const,
      label: value.candidate.label,
      nextAction:
        "Approve one exact owner action to reopen this Work Item and connect this agent. Do not create a duplicate Project or reconnect MCP.",
      objective: value.candidate.objective,
      projectId: value.candidate.projectId,
      reason: "work-item-closed" as const,
    })),
  ].sort((left, right) => left.projectId.localeCompare(right.projectId));
  if (inspection.unresolvedMatchCount > 0) {
    return { state: "indeterminate" };
  }
  if (!inspection.catalogComplete || projects.length > 1) {
    return {
      catalogComplete: inspection.catalogComplete,
      projects,
      state: "selection-required",
    };
  }
  const [match] = projects;
  if (match === undefined) return { state: "not-found" };
  if (match.joinability === "unavailable") {
    return {
      project: {
        label: match.label,
        nextAction: match.nextAction,
        objective: match.objective,
        projectId: match.projectId,
        reason: match.reason,
      },
      state: "unavailable",
    };
  }
  const loaded = inspection.loaded[0];
  if (loaded === undefined) return { state: "not-found" };
  return { project: loaded.candidate, state: "joinable" };
}

function projectNotJoinableProblem(
  inspection: Awaited<ReturnType<typeof inspectJoinableProjects>>,
): ProjectInitializationProblem {
  const closed = inspection.closed[0];
  if (closed !== undefined) {
    return new ProjectInitializationProblem(
      "project_not_joinable",
      "This existing Project has a closed Work Item. Use one owner approval to reopen this exact Work Item and connect the agent; do not create a duplicate Project.",
      {
        nextAction:
          "Approve one exact owner action to reopen this Work Item and connect this agent. Do not create a duplicate Project or reconnect MCP.",
        reason: "work-item-closed",
      },
    );
  }
  const unavailable = inspection.unavailable[0];
  if (unavailable !== undefined) {
    return new ProjectInitializationProblem(
      "project_not_joinable",
      `This existing Project cannot be joined yet (${unavailable.reason}). ${unavailable.nextAction}`,
      {
        nextAction: unavailable.nextAction,
        reason: unavailable.reason,
      },
    );
  }
  return new ProjectInitializationProblem(
    "project_not_joinable",
    "The selected Project is not available to this exact vault and folder connection. Call open_project again with its exact name or local projectId for a truthful repair. Create a New Project only when the user confirms this is different work.",
  );
}

export async function findExistingProjectInitializationReceipt(
  db: D1Database,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    rawRequest: unknown;
    requestId: string;
  },
): Promise<{
  projectAuthorizationExplicitlyRevoked: boolean;
  projectId: string | null;
} | null> {
  if (
    !input.grant.scopes.some((scope) => scope === "project.initialize.request")
  ) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const parsed = projectInitializationRequestSchema.safeParse(input.rawRequest);
  if (!parsed.success) {
    throw new ProjectInitializationProblem("source_context_invalid");
  }
  const request = parsed.data;
  const folder = validateBoundedContext(
    input.grant,
    request.draft.folderBoundary,
    request.draft.sourceNotePaths.map((note) => note.path),
  );
  let contextPolicy: ProjectContextPolicy;
  try {
    contextPolicy = compileProjectContextPolicy(request.draft.contextPolicy, {
      folderBoundary: folder.folderPath,
      grant: input.grant,
      sourcePaths: request.draft.sourceNotePaths.map((note) => note.path),
      vaultId: input.grant.vaultId,
    }).policy;
  } catch (error) {
    throwContextPolicyProblem(error);
  }
  const storedDraft: StoredProjectSetupDraft = {
    ...request.draft,
    contextPolicy,
    folderBoundary: folder.folderPath,
    requestKind: "create",
  };
  let existing = await readInitializationByToken(db, request.idempotencyKey);
  const semanticKeySha256 = await projectSemanticKey({
    draft: storedDraft,
    folderPathKey: folder.folderPathKey,
    vaultId: input.grant.vaultId,
  });
  existing ??= await readInitializationBySemanticKey(db, {
    oauthClientId: input.grant.clientId,
    semanticKeySha256,
    vaultId: input.grant.vaultId,
  });
  if (existing === null) return null;
  const receipt = await readInitializationProjectReceipt(db, existing.id);
  const pendingReceiptFromReplacedSource =
    receipt !== null &&
    (existing.status === "pending" || existing.status === "approving") &&
    existing.bootstrapAgentGrantId !== input.grant.id &&
    existing.oauthClientId === input.grant.clientId &&
    existing.clientName === input.grant.clientName &&
    existing.clientOrigin === input.grant.clientOrigin &&
    existing.audience === input.grant.audience &&
    existing.vaultId === input.grant.vaultId &&
    (await readActiveAgentGrant(db, {
      audience: existing.audience,
      clientId: existing.oauthClientId,
      grantId: existing.bootstrapAgentGrantId,
    })) === null;
  if (pendingReceiptFromReplacedSource) {
    const reboundGrantId =
      await rebindInitializationToEquivalentActiveSuccessor(db, {
        initializationId: existing.id,
        now: input.now,
      });
    if (reboundGrantId === input.grant.id) {
      return {
        projectAuthorizationExplicitlyRevoked: false,
        projectId: null,
      };
    }
  }
  const priorProjectGrant =
    existing.resultCollaborationGrantId === null
      ? null
      : await db
          .prepare(
            `SELECT status
             FROM collaboration_grants
             WHERE id = ?`,
          )
          .bind(existing.resultCollaborationGrantId)
          .first<{ status: "active" | "pending" | "revoked" }>();
  return {
    projectAuthorizationExplicitlyRevoked:
      priorProjectGrant?.status === "revoked",
    projectId: receipt?.projectId ?? existing.resultProjectId,
  };
}

export async function requestProjectInitialization(
  db: D1Database,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    rawRequest: unknown;
    requestId: string;
  },
): Promise<ProjectInitializationRequestResponse> {
  if (
    !input.grant.scopes.some((scope) => scope === "project.initialize.request")
  ) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const parsed = projectInitializationRequestSchema.safeParse(input.rawRequest);
  if (!parsed.success) {
    throw new ProjectInitializationProblem("source_context_invalid");
  }
  const request = parsed.data;
  const folder = validateBoundedContext(
    input.grant,
    request.draft.folderBoundary,
    request.draft.sourceNotePaths.map((note) => note.path),
  );
  await validateProjectSourceAccess(
    db,
    input.grant,
    request.draft.sourceNotePaths.map((note) => note.path),
  );
  let contextPolicy: ProjectContextPolicy;
  try {
    contextPolicy = compileProjectContextPolicy(request.draft.contextPolicy, {
      folderBoundary: folder.folderPath,
      grant: input.grant,
      sourcePaths: request.draft.sourceNotePaths.map((note) => note.path),
      vaultId: input.grant.vaultId,
    }).policy;
  } catch (error) {
    throwContextPolicyProblem(error);
  }
  const normalizedRequest = {
    ...request,
    draft: {
      ...request.draft,
      contextPolicy,
      folderBoundary: folder.folderPath,
    },
  };
  const storedDraft: StoredProjectSetupDraft = {
    ...normalizedRequest.draft,
    requestKind: "create",
  };
  const semanticKeySha256 = await projectSemanticKey({
    draft: storedDraft,
    folderPathKey: folder.folderPathKey,
    vaultId: input.grant.vaultId,
  });
  const requestSha256 = await sha256Hex(
    canonicalizeCollaborationJson(storedDraft),
  );
  const legacyRequestSha256 = await sha256Hex(
    canonicalizeCollaborationJson(normalizedRequest),
  );
  let existing = await readInitializationByToken(db, request.idempotencyKey);
  if (existing !== null) {
    if (
      existing.bootstrapAgentGrantId !== input.grant.id ||
      (existing.draftSha256 !== requestSha256 &&
        existing.draftSha256 !== legacyRequestSha256) ||
      existing.draft.requestKind !== "create"
    ) {
      throw new ProjectInitializationProblem("idempotency_conflict");
    }
    if (normalizedInitializationStatus(existing, input.now) === "expired") {
      existing =
        (await renewExpiredInitializationRequest(db, {
          id: existing.id,
          now: input.now,
          requestId: input.requestId,
        })) ??
        (await readInitializationByToken(db, request.idempotencyKey)) ??
        existing;
    }
    const status = normalizedInitializationStatus(existing, input.now);
    return projectInitializationRequestResponseSchema.parse({
      authorizationUrl: projectApprovalUrl(
        input.grant.audience,
        existing.id,
        "create",
      ),
      expiresAt: existing.expiresAt,
      initializationId: existing.id,
      openMode: request.clientCapabilities.urlElicitation
        ? "url-elicitation"
        : "copy-link",
      status,
    });
  }
  let semanticExisting = await readInitializationBySemanticKey(db, {
    oauthClientId: input.grant.clientId,
    semanticKeySha256,
    vaultId: input.grant.vaultId,
  });
  if (semanticExisting !== null) {
    const sameDraft =
      semanticExisting.draftSha256 === requestSha256 &&
      semanticExisting.draft.requestKind === "create";
    let sameSource = semanticExisting.bootstrapAgentGrantId === input.grant.id;
    const matchingPendingReplacementBoundary =
      (semanticExisting.status === "pending" ||
        semanticExisting.status === "approving") &&
      !sameSource &&
      sameDraft &&
      semanticExisting.clientName === input.grant.clientName &&
      semanticExisting.clientOrigin === input.grant.clientOrigin &&
      semanticExisting.audience === input.grant.audience;
    if (matchingPendingReplacementBoundary) {
      const reboundGrantId =
        await rebindInitializationToEquivalentActiveSuccessor(db, {
          initializationId: semanticExisting.id,
          now: input.now,
        });
      if (reboundGrantId === input.grant.id) {
        semanticExisting =
          (await readInitializationById(db, semanticExisting.id)) ??
          semanticExisting;
        sameSource = true;
      }
    }
    const priorSourceStillActive =
      matchingPendingReplacementBoundary && !sameSource
        ? await readActiveAgentGrant(db, {
            audience: semanticExisting.audience,
            clientId: semanticExisting.oauthClientId,
            grantId: semanticExisting.bootstrapAgentGrantId,
          })
        : null;
    const safePendingSourceReplacement =
      matchingPendingReplacementBoundary &&
      !sameSource &&
      priorSourceStillActive === null;
    if (safePendingSourceReplacement) {
      if (
        !(await supersedeInitializationForFreshApproval(db, {
          blockIfProjectReceipt: true,
          initializationId: semanticExisting.id,
          now: input.now,
          requestId: input.requestId,
          token: request.idempotencyKey,
        }))
      ) {
        throw new ProjectInitializationProblem("project_already_exists");
      }
      semanticExisting = null;
    } else if (!sameSource || !sameDraft) {
      throw new ProjectInitializationProblem("project_already_exists");
    }
  }
  if (semanticExisting !== null) {
    if (
      !(await insertInitializationTokenAlias(db, {
        expiresAt: semanticExisting.expiresAt,
        initializationId: semanticExisting.id,
        now: input.now,
        token: request.idempotencyKey,
      }))
    ) {
      throw new ProjectInitializationProblem("idempotency_conflict");
    }
    return projectInitializationRequestResponseSchema.parse({
      authorizationUrl: projectApprovalUrl(
        input.grant.audience,
        semanticExisting.id,
        "create",
      ),
      expiresAt: semanticExisting.expiresAt,
      initializationId: semanticExisting.id,
      openMode: request.clientCapabilities.urlElicitation
        ? "url-elicitation"
        : "copy-link",
      status: normalizedInitializationStatus(semanticExisting, input.now),
    });
  }

  const initializationId = crypto.randomUUID();
  const inserted = await insertInitializationRequest(db, {
    authorizationUrl: `${new URL(input.grant.audience).origin}/authorize`,
    bootstrapAgentGrantId: input.grant.id,
    clientName: input.grant.clientName,
    clientOrigin: input.grant.clientOrigin,
    draft: storedDraft,
    draftSha256: requestSha256,
    folderPath: folder.folderPath,
    folderPathKey: folder.folderPathKey,
    id: initializationId,
    now: input.now,
    oauthClientId: input.grant.clientId,
    projectCreationIdentity: {
      projectLabelKey: projectCreationLabelKey(storedDraft.project.label),
    },
    requestId: input.requestId,
    resource: input.grant.audience,
    semanticKeySha256,
    token: request.idempotencyKey,
    urlElicitationSupported: request.clientCapabilities.urlElicitation,
    vaultId: input.grant.vaultId,
    vaultName: input.grant.vaultName,
  });
  if (!inserted) {
    const raced = await readInitializationBySemanticKey(db, {
      oauthClientId: input.grant.clientId,
      semanticKeySha256,
      vaultId: input.grant.vaultId,
    });
    if (
      raced !== null &&
      raced.bootstrapAgentGrantId === input.grant.id &&
      raced.draftSha256 === requestSha256 &&
      raced.draft.requestKind === "create" &&
      (await insertInitializationTokenAlias(db, {
        expiresAt: raced.expiresAt,
        initializationId: raced.id,
        now: input.now,
        token: request.idempotencyKey,
      }))
    ) {
      return projectInitializationRequestResponseSchema.parse({
        authorizationUrl: projectApprovalUrl(
          input.grant.audience,
          raced.id,
          "create",
        ),
        expiresAt: raced.expiresAt,
        initializationId: raced.id,
        openMode: request.clientCapabilities.urlElicitation
          ? "url-elicitation"
          : "copy-link",
        status: normalizedInitializationStatus(raced, input.now),
      });
    }
    throw new ProjectInitializationProblem(
      raced === null ? "idempotency_conflict" : "project_already_exists",
    );
  }
  return projectInitializationRequestResponseSchema.parse({
    authorizationUrl: projectApprovalUrl(
      input.grant.audience,
      initializationId,
      "create",
    ),
    expiresAt: input.now + INITIALIZATION_LIFETIME_SECONDS,
    initializationId,
    openMode: request.clientCapabilities.urlElicitation
      ? "url-elicitation"
      : "copy-link",
    status: "pending",
  });
}

function joinConsentBoundary(draft: StoredProjectSetupDraft) {
  if (draft.requestKind !== "join") return null;
  return {
    contextPolicy: draft.contextPolicy,
    documentationPlan: draft.documentationPlan,
    folderBoundary: draft.folderBoundary,
    project: draft.project,
    requestedRole: draft.requestedRole,
    requestedScopes: draft.requestedScopes,
    requestKind: draft.requestKind,
    ownerAction: draft.ownerAction ?? null,
    sourceNotePaths: draft.sourceNotePaths.map((source) => ({
      path: source.path,
    })),
    target: {
      knowledgeSpaceVersionId: draft.target.knowledgeSpaceVersionId,
      projectId: draft.target.projectId,
      workItemId: draft.target.workItemId,
    },
    workItem: draft.workItem,
  };
}

function storedScopesSatisfyLegacyAlias(
  stored: CollaborationScope[],
  requested: CollaborationScope[],
): boolean {
  const key = (scopes: CollaborationScope[]) =>
    JSON.stringify([...scopes].sort());
  if (key(stored) === key(requested)) return true;
  return (
    stored.includes("project.lead") &&
    !requested.includes("project.lead") &&
    key(stored.filter((scope) => scope !== "project.lead")) === key(requested)
  );
}

async function isSafePendingJoinSuccessor(
  db: D1Database,
  previous: StoredProjectInitialization,
  currentDraft: StoredProjectSetupDraft,
): Promise<boolean> {
  const previousBoundary = joinConsentBoundary(previous.draft);
  const currentBoundary = joinConsentBoundary(currentDraft);
  if (
    previous.draft.requestKind !== "join" ||
    currentDraft.requestKind !== "join" ||
    previousBoundary === null ||
    currentBoundary === null ||
    !storedScopesSatisfyLegacyAlias(
      previous.draft.requestedScopes,
      currentDraft.requestedScopes,
    )
  ) {
    return false;
  }
  return (
    canonicalizeCollaborationJson({
      ...previousBoundary,
      requestedScopes: [],
    }) ===
      canonicalizeCollaborationJson({
        ...currentBoundary,
        requestedScopes: [],
      }) &&
    (await isSameOrSuccessorPacket(
      db,
      previous.draft.target.packetId,
      currentDraft.target.packetId,
    ))
  );
}

async function approvedAuthorizationStillResolves(
  db: D1Database,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    projectId: string;
    requestId: string;
    value: StoredProjectInitialization;
  },
): Promise<boolean> {
  return (
    input.value.status === "approved" &&
    input.value.resultProjectId === input.projectId &&
    (await resolveApprovedProjectAuthorization(db, {
      now: input.now,
      projectId: input.projectId,
      requestId: input.requestId,
      sourceGrant: input.grant,
    })) !== null
  );
}

async function rebindPendingInitializationForSource(
  db: D1Database,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    value: StoredProjectInitialization;
  },
): Promise<StoredProjectInitialization> {
  if (
    input.value.bootstrapAgentGrantId === input.grant.id ||
    (input.value.status !== "pending" && input.value.status !== "approving") ||
    input.value.expiresAt <= input.now
  ) {
    return input.value;
  }
  const reboundGrantId = await rebindInitializationToEquivalentActiveSuccessor(
    db,
    {
      initializationId: input.value.id,
      now: input.now,
    },
  );
  if (reboundGrantId !== input.grant.id) return input.value;
  return (await readInitializationById(db, input.value.id)) ?? input.value;
}

export async function requestProjectAccess(
  db: D1Database,
  storage: R2Bucket,
  input: {
    allowClosedWorkItemOwnerAction?: boolean;
    grant: ActiveAgentGrant;
    now: number;
    rawRequest: unknown;
    requestId: string;
  },
): Promise<ProjectAccessRequestResponse> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  const parsed = projectAccessRequestSchema.safeParse(input.rawRequest);
  if (!parsed.success) {
    throw new ProjectInitializationProblem("source_context_invalid");
  }
  const request = parsed.data;
  let inspection = await inspectJoinableProjects(db, storage, {
    grant: input.grant,
    now: input.now,
    projectId: request.projectId,
    repairRoutineContext: true,
  });
  let selectedOwnerAction: ProjectInitializationOwnerAction | undefined;
  let selected: LoadedJoinableProject | undefined = inspection.loaded[0];
  if (selected === undefined && input.allowClosedWorkItemOwnerAction === true) {
    selected = inspection.closed[0];
    selectedOwnerAction = inspection.closed[0]?.ownerAction;
  }
  if (selected === undefined) {
    throw projectNotJoinableProblem(inspection);
  }
  // A combined repair request keeps the closed item's exact packet and version
  // as consent evidence. Only the approval transaction may reopen that item;
  // packet rotation requires it to be open and must not run before consent.
  if (selectedOwnerAction === undefined) {
    try {
      const current = await refreshContinuationWorkPacketIfNeeded(db, storage, {
        now: input.now,
        packet: selected.packet,
        projectId: selected.candidate.projectId,
      });
      if (current.packetId !== selected.packet.packetId) {
        inspection = await inspectJoinableProjects(db, storage, {
          grant: input.grant,
          now: input.now,
          projectId: request.projectId,
          repairRoutineContext: true,
        });
        selected = inspection.loaded[0];
        selectedOwnerAction = undefined;
        if (
          selected === undefined &&
          input.allowClosedWorkItemOwnerAction === true
        ) {
          selected = inspection.closed[0];
          selectedOwnerAction = inspection.closed[0]?.ownerAction;
        }
      }
    } catch {
      throw new ProjectInitializationProblem(
        "project_not_joinable",
        "MDevolved could not refresh this existing Project's context automatically. Retry once; if the source document was removed or moved outside the Project boundary, repair that source in MDevolved.",
      );
    }
  }
  if (selected === undefined) {
    throw projectNotJoinableProblem(inspection);
  }
  if (
    selectedOwnerAction === undefined &&
    workPacketNeedsAutomaticRefresh(selected.packet, input.now)
  ) {
    throw new ProjectInitializationProblem(
      "project_not_joinable",
      "MDevolved did not finish refreshing this existing Project's context. Retry once; no owner renewal is required.",
    );
  }
  const folderBoundary =
    selected.candidate.contextPolicy.includePaths.length === 1
      ? (selected.candidate.contextPolicy.includePaths[0] ?? "")
      : "";
  const draft: StoredProjectSetupDraft = {
    contextPolicy: selected.candidate.contextPolicy,
    documentationPlan: request.documentationPlan,
    folderBoundary,
    packetExpiresInSeconds:
      selected.packet.expiresAt - selected.packet.createdAt,
    project: {
      label: selected.candidate.label,
      objective: selected.candidate.objective,
    },
    requestedRole: selected.packet.requestedRole.label,
    requestedScopes: request.requestedScopes,
    requestKind: "join",
    ...(selectedOwnerAction === undefined
      ? {}
      : { ownerAction: selectedOwnerAction }),
    sourceNotePaths: selected.packet.sourceCitations
      .filter((citation) => citation.vaultId === input.grant.vaultId)
      .map((citation) => ({
        excerptByteRange: citation.excerptByteRange,
        path: citation.path,
      })),
    target: {
      knowledgeSpaceVersionId: selected.knowledgeSpaceVersionId,
      packetId: selected.packet.packetId,
      projectId: selected.candidate.projectId,
      workItemId: selected.packet.workItemId,
    },
    workItem: selected.packet.brief,
  };
  const normalizedRequest = { ...request, draft };
  const folder = normalizeFolder(folderBoundary);
  const semanticKeySha256 = await projectSemanticKey({
    draft,
    folderPathKey: folder.pathKey,
    vaultId: input.grant.vaultId,
  });
  const requestSha256 = await sha256Hex(canonicalizeCollaborationJson(draft));
  const legacyRequestSha256 = await sha256Hex(
    canonicalizeCollaborationJson(normalizedRequest),
  );
  const responseFor = (
    value: StoredProjectInitialization,
  ): ProjectAccessRequestResponse =>
    projectAccessRequestResponseSchema.parse({
      accessRequestId: value.id,
      approvalUrl: projectApprovalUrl(input.grant.audience, value.id, "join"),
      expiresAt: value.expiresAt,
      openMode: request.clientCapabilities.urlElicitation
        ? "url-elicitation"
        : "copy-link",
      status: normalizedInitializationStatus(value, input.now),
    });
  let existing = await readInitializationByToken(db, request.idempotencyKey);
  if (existing !== null) {
    existing = await rebindPendingInitializationForSource(db, {
      grant: input.grant,
      now: input.now,
      value: existing,
    });
    const sameSource = existing.bootstrapAgentGrantId === input.grant.id;
    const sameDraft =
      (existing.draftSha256 === requestSha256 ||
        existing.draftSha256 === legacyRequestSha256) &&
      existing.draft.requestKind === "join";
    const safeSuccessor =
      sameSource && (await isSafePendingJoinSuccessor(db, existing, draft));
    if (
      await approvedAuthorizationStillResolves(db, {
        grant: input.grant,
        now: input.now,
        projectId: request.projectId,
        requestId: input.requestId,
        value: existing,
      })
    ) {
      return responseFor(existing);
    }
    if (
      (existing.status === "pending" || existing.status === "approving") &&
      sameSource &&
      (sameDraft || safeSuccessor)
    ) {
      return responseFor(existing);
    }
    if (
      normalizedInitializationStatus(existing, input.now) === "expired" &&
      sameSource &&
      (sameDraft || safeSuccessor)
    ) {
      const renewed =
        (await renewExpiredInitializationRequest(db, {
          id: existing.id,
          now: input.now,
          requestId: input.requestId,
        })) ?? (await readInitializationByToken(db, request.idempotencyKey));
      if (renewed !== null) return responseFor(renewed);
    }
    if (existing.status === "rejected" && sameSource) {
      return responseFor(existing);
    }
    if (
      (existing.status === "pending" || existing.status === "approving") &&
      existing.expiresAt > input.now &&
      !sameSource
    ) {
      throw new ProjectInitializationProblem("idempotency_conflict");
    }
    if (
      !(await supersedeInitializationForFreshApproval(db, {
        initializationId: existing.id,
        now: input.now,
        requestId: input.requestId,
        token: request.idempotencyKey,
      }))
    ) {
      throw new ProjectInitializationProblem("idempotency_conflict");
    }
    existing = null;
  }
  let semanticExisting = await readInitializationBySemanticKey(db, {
    oauthClientId: input.grant.clientId,
    semanticKeySha256,
    vaultId: input.grant.vaultId,
  });
  if (semanticExisting !== null) {
    semanticExisting = await rebindPendingInitializationForSource(db, {
      grant: input.grant,
      now: input.now,
      value: semanticExisting,
    });
    const sameSource =
      semanticExisting.bootstrapAgentGrantId === input.grant.id;
    const sameDraft =
      semanticExisting.draftSha256 === requestSha256 &&
      semanticExisting.draft.requestKind === "join";
    const safeSuccessor =
      sameSource &&
      (await isSafePendingJoinSuccessor(db, semanticExisting, draft));
    const activeApproval = await approvedAuthorizationStillResolves(db, {
      grant: input.grant,
      now: input.now,
      projectId: request.projectId,
      requestId: input.requestId,
      value: semanticExisting,
    });
    const reusablePending =
      (semanticExisting.status === "pending" ||
        semanticExisting.status === "approving") &&
      sameSource &&
      (sameDraft || safeSuccessor);
    if (!activeApproval && !reusablePending) {
      if (
        ((semanticExisting.status === "pending" ||
          semanticExisting.status === "approving") &&
          semanticExisting.expiresAt > input.now &&
          !sameSource) ||
        semanticExisting.status === "rejected" ||
        !(await supersedeInitializationForFreshApproval(db, {
          initializationId: semanticExisting.id,
          now: input.now,
          requestId: input.requestId,
          token: request.idempotencyKey,
        }))
      ) {
        throw new ProjectInitializationProblem("project_already_exists");
      }
      semanticExisting = null;
    }
  }
  if (semanticExisting !== null) {
    if (
      !(await insertInitializationTokenAlias(db, {
        expiresAt: semanticExisting.expiresAt,
        initializationId: semanticExisting.id,
        now: input.now,
        token: request.idempotencyKey,
      }))
    ) {
      throw new ProjectInitializationProblem("idempotency_conflict");
    }
    return responseFor(semanticExisting);
  }

  const accessRequestId = crypto.randomUUID();
  const inserted = await insertInitializationRequest(db, {
    authorizationUrl: `${new URL(input.grant.audience).origin}/authorize`,
    bootstrapAgentGrantId: input.grant.id,
    clientName: input.grant.clientName,
    clientOrigin: input.grant.clientOrigin,
    draft,
    draftSha256: requestSha256,
    folderPath: folder.path,
    folderPathKey: folder.pathKey,
    id: accessRequestId,
    now: input.now,
    oauthClientId: input.grant.clientId,
    requestId: input.requestId,
    resource: input.grant.audience,
    semanticKeySha256,
    token: request.idempotencyKey,
    urlElicitationSupported: request.clientCapabilities.urlElicitation,
    vaultId: input.grant.vaultId,
    vaultName: input.grant.vaultName,
  });
  if (!inserted) {
    const racedValue = await readInitializationBySemanticKey(db, {
      oauthClientId: input.grant.clientId,
      semanticKeySha256,
      vaultId: input.grant.vaultId,
    });
    const raced =
      racedValue === null
        ? null
        : await rebindPendingInitializationForSource(db, {
            grant: input.grant,
            now: input.now,
            value: racedValue,
          });
    if (
      raced !== null &&
      raced.bootstrapAgentGrantId === input.grant.id &&
      raced.draftSha256 === requestSha256 &&
      raced.draft.requestKind === "join" &&
      (await insertInitializationTokenAlias(db, {
        expiresAt: raced.expiresAt,
        initializationId: raced.id,
        now: input.now,
        token: request.idempotencyKey,
      }))
    ) {
      return projectAccessRequestResponseSchema.parse({
        accessRequestId: raced.id,
        approvalUrl: projectApprovalUrl(input.grant.audience, raced.id, "join"),
        expiresAt: raced.expiresAt,
        openMode: request.clientCapabilities.urlElicitation
          ? "url-elicitation"
          : "copy-link",
        status: normalizedInitializationStatus(raced, input.now),
      });
    }
    throw new ProjectInitializationProblem(
      raced === null ? "idempotency_conflict" : "project_already_exists",
    );
  }
  return projectAccessRequestResponseSchema.parse({
    accessRequestId,
    approvalUrl: projectApprovalUrl(
      input.grant.audience,
      accessRequestId,
      "join",
    ),
    expiresAt: input.now + INITIALIZATION_LIFETIME_SECONDS,
    openMode: request.clientCapabilities.urlElicitation
      ? "url-elicitation"
      : "copy-link",
    status: "pending",
  });
}

export async function getProjectInitializationStatus(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    idempotencyKey: string;
    now: number;
  },
): Promise<ProjectInitializationStatusResponse> {
  if (
    !input.grant.scopes.some((scope) => scope === "project.initialize.request")
  ) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  let value = await readInitializationByToken(db, input.idempotencyKey);
  if (
    value !== null &&
    value.bootstrapAgentGrantId !== input.grant.id &&
    (await rebindInitializationToEquivalentActiveSuccessor(db, {
      initializationId: value.id,
      now: input.now,
    })) === input.grant.id
  ) {
    value = await readInitializationByToken(db, input.idempotencyKey);
  }
  if (
    value === null ||
    value.bootstrapAgentGrantId !== input.grant.id ||
    value.draft.requestKind !== "create"
  ) {
    throw new ProjectInitializationProblem("initialization_not_found");
  }
  return initializationStatus(
    value,
    input.now,
    await approvedContinuity(db, storage, value),
  );
}

async function approvedContinuity(
  db: D1Database,
  storage: R2Bucket,
  value: StoredProjectInitialization,
): Promise<ProjectInitializationStatusResponse["continuity"]> {
  let continuity: ProjectInitializationStatusResponse["continuity"] = null;
  if (value.status === "approved" && value.resultProjectId !== null) {
    const project = await db
      .prepare(
        `SELECT active_knowledge_space_version_id
         FROM collaboration_projects
         WHERE project_id = ? AND status = 'active'
           AND agent_visibility = 'discoverable'`,
      )
      .bind(value.resultProjectId)
      .first<{ active_knowledge_space_version_id: string }>();
    if (project === null) {
      throw new ProjectInitializationProblem("initialization_not_found");
    }
    const loaded = await readCollaborationRecord(
      db,
      storage,
      project.active_knowledge_space_version_id,
    );
    if (
      loaded?.record.recordType !== "knowledge-space-version" ||
      !loaded.record.members.some((member) => member.vaultId === value.vaultId)
    ) {
      throw new ProjectInitializationProblem("context_policy_invalid");
    }
    const selectorSha256 = await projectContextSelectorSha256(
      loaded.record.members,
    );
    if (selectorSha256 !== loaded.record.selectorSha256) {
      throw new ProjectInitializationProblem("context_policy_invalid");
    }
    const member = loaded.record.members.find(
      (candidate) => candidate.vaultId === value.vaultId,
    );
    if (member === undefined) {
      throw new ProjectInitializationProblem("context_policy_invalid");
    }
    continuity = projectContinuityReceipt(
      projectContextPolicyFromMember(member),
      selectorSha256,
      value.resultProjectId,
    );
  }
  return continuity;
}

export async function getProjectAccessStatus(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    idempotencyKey: string;
    now: number;
  },
): Promise<ProjectAccessStatusResponse> {
  if (!input.grant.scopes.some((scope) => scope === PROJECT_CONNECTION_SCOPE)) {
    throw new ProjectInitializationProblem("initialization_scope_required");
  }
  let value = await readInitializationByToken(db, input.idempotencyKey);
  if (
    value !== null &&
    value.bootstrapAgentGrantId !== input.grant.id &&
    (await rebindInitializationToEquivalentActiveSuccessor(db, {
      initializationId: value.id,
      now: input.now,
    })) === input.grant.id
  ) {
    value = await readInitializationByToken(db, input.idempotencyKey);
  }
  if (
    value === null ||
    value.bootstrapAgentGrantId !== input.grant.id ||
    value.draft.requestKind !== "join"
  ) {
    throw new ProjectInitializationProblem("initialization_not_found");
  }
  const status = initializationStatus(
    value,
    input.now,
    await approvedContinuity(db, storage, value),
  );
  const { initializationId, ...accessStatus } = status;
  return projectAccessStatusResponseSchema.parse({
    ...accessStatus,
    accessRequestId: initializationId,
  });
}

export async function getProjectInitializationConsent(
  db: D1Database,
  input: { now: number; token: string },
): Promise<{
  context: ProjectInitializationConsentContext;
  value: StoredProjectInitialization;
}> {
  let value = await readInitializationByToken(db, input.token);
  if (value === null) {
    throw new ProjectInitializationProblem("initialization_not_found");
  }
  if (value.status === "approving") {
    const recovered = await recoverInitializationForBrowser(db, {
      initializationId: value.id,
      now: input.now,
    });
    if (recovered?.status === "approving") {
      throw new ProjectInitializationProblem(
        "initialization_approval_in_progress",
      );
    }
    if (recovered === null) {
      throw new ProjectInitializationProblem("initialization_not_found");
    }
    value = recovered;
  }
  if (value.status !== "pending" || value.expiresAt <= input.now) {
    throw new ProjectInitializationProblem("initialization_expired");
  }
  let bootstrapGrant = await readActiveAgentGrant(db, {
    audience: value.audience,
    clientId: value.oauthClientId,
    grantId: value.bootstrapAgentGrantId,
  });
  if (
    bootstrapGrant === null &&
    (await rebindInitializationToEquivalentActiveSuccessor(db, {
      initializationId: value.id,
      now: input.now,
    })) !== null
  ) {
    value = (await readInitializationById(db, value.id)) ?? value;
    bootstrapGrant = await readActiveAgentGrant(db, {
      audience: value.audience,
      clientId: value.oauthClientId,
      grantId: value.bootstrapAgentGrantId,
    });
  }
  if (bootstrapGrant === null || bootstrapGrant.vaultId !== value.vaultId) {
    throw new ProjectInitializationProblem("initialization_not_found");
  }
  return {
    context: initializationConsentContext(
      value,
      input.token,
      bootstrapGrant.pathPrefixes,
    ),
    value,
  };
}

export function initializationProjectRequest(
  value: StoredProjectInitialization,
  rawContextPolicy: unknown = value.draft.contextPolicy,
  grant?: ActiveAgentGrant,
): CollaborationProjectCreateRequest {
  if (value.draft.requestKind !== "create") {
    throw new ProjectInitializationProblem("project_not_joinable");
  }
  let context: ReturnType<typeof compileProjectContextPolicy>;
  try {
    context = compileProjectContextPolicy(rawContextPolicy, {
      folderBoundary: value.folderPath,
      grant,
      sourcePaths: value.draft.sourceNotePaths.map((note) => note.path),
      vaultId: value.vaultId,
    });
  } catch (error) {
    throwContextPolicyProblem(error);
  }
  return collaborationProjectCreateRequestSchema.parse({
    knowledgeSpace: {
      label: `${value.draft.project.label} context`,
      members: [context.member],
    },
    packetExpiresInSeconds: value.draft.packetExpiresInSeconds,
    project: value.draft.project,
    requestedRole: value.draft.requestedRole,
    sourceNotes: value.draft.sourceNotePaths.map((note) => ({
      excerptByteRange: note.excerptByteRange,
      path: note.path,
      vaultId: value.vaultId,
    })),
    workItem: value.draft.workItem,
  });
}

export async function revalidateProjectAccessSelection(
  db: D1Database,
  storage: R2Bucket,
  input: {
    grant: ActiveAgentGrant;
    now: number;
    rawContextPolicy: unknown;
    value: StoredProjectInitialization;
  },
): Promise<{
  knowledgeSpaceVersionId: string;
  packetId: string;
  projectId: string;
  workItemId: string;
}> {
  if (input.value.draft.requestKind !== "join") {
    throw new ProjectInitializationProblem("project_not_joinable");
  }
  const inspection = await inspectJoinableProjects(db, storage, {
    grant: input.grant,
    now: input.now,
    projectId: input.value.draft.target.projectId,
    repairRoutineContext: true,
  });
  const selectedOwnerAction =
    input.value.draft.ownerAction === undefined
      ? undefined
      : inspection.closed[0]?.ownerAction;
  const selected: LoadedJoinableProject | undefined =
    input.value.draft.ownerAction === undefined
      ? inspection.loaded[0]
      : inspection.closed[0];
  const packetStillAuthorized =
    selected !== undefined &&
    (await isSameOrSuccessorPacket(
      db,
      input.value.draft.target.packetId,
      selected.packet.packetId,
    ));
  const displayedBoundaryStillMatches =
    selected !== undefined &&
    canonicalizeCollaborationJson(
      joinConsentBoundary({
        contextPolicy: selected.candidate.contextPolicy,
        documentationPlan: input.value.draft.documentationPlan,
        folderBoundary: input.value.draft.folderBoundary,
        packetExpiresInSeconds:
          selected.packet.expiresAt - selected.packet.createdAt,
        project: {
          label: selected.candidate.label,
          objective: selected.candidate.objective,
        },
        requestedRole: selected.packet.requestedRole.label,
        requestedScopes: input.value.draft.requestedScopes,
        requestKind: "join",
        ...(input.value.draft.ownerAction === undefined
          ? {}
          : { ownerAction: selectedOwnerAction }),
        sourceNotePaths: selected.packet.sourceCitations
          .filter((citation) => citation.vaultId === input.grant.vaultId)
          .map((citation) => ({
            excerptByteRange: citation.excerptByteRange,
            path: citation.path,
          })),
        target: {
          knowledgeSpaceVersionId: selected.knowledgeSpaceVersionId,
          packetId: selected.packet.packetId,
          projectId: selected.candidate.projectId,
          workItemId: selected.packet.workItemId,
        },
        workItem: selected.packet.brief,
      }),
    ) === canonicalizeCollaborationJson(joinConsentBoundary(input.value.draft));
  if (
    selected === undefined ||
    selected.candidate.projectId !== input.value.draft.target.projectId ||
    selected.knowledgeSpaceVersionId !==
      input.value.draft.target.knowledgeSpaceVersionId ||
    !packetStillAuthorized ||
    !displayedBoundaryStillMatches ||
    selected.packet.workItemId !== input.value.draft.target.workItemId ||
    canonicalizeCollaborationJson(selected.candidate.contextPolicy) !==
      canonicalizeCollaborationJson(input.value.draft.contextPolicy) ||
    canonicalizeCollaborationJson(input.rawContextPolicy) !==
      canonicalizeCollaborationJson(input.value.draft.contextPolicy)
  ) {
    throw new ProjectInitializationProblem("project_not_joinable");
  }
  return {
    knowledgeSpaceVersionId: selected.knowledgeSpaceVersionId,
    packetId: selected.packet.packetId,
    projectId: selected.candidate.projectId,
    workItemId: selected.packet.workItemId,
  };
}
