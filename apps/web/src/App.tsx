import {
  agentConnectionListResponseSchema,
  apiErrorSchema,
  authenticationOptionsSchema,
  authenticationResultSchema,
  csrfResponseSchema,
  currentMaterializationResponseSchema,
  healthResponseSchema,
  liveMarkdownNoteSchema,
  markdownNoteWriteResponseSchema,
  materializationGenerationSchema,
  materializationJobSchema,
  materializedNotesResponseSchema,
  materializedSearchResponseSchema,
  MAX_MARKDOWN_NOTE_CHARACTERS,
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_LOGICAL_BYTES,
  MAX_SNAPSHOT_VAULTS,
  pairingGrantResponseSchema,
  prepareProjectHandoffResponseSchema,
  prepareMarkdownNotePath,
  registrationOptionsSchema,
  ownerDiagnosticsResponseSchema,
  setupReadinessSchema,
  setupStatusSchema,
  vaultListResponseSchema,
  type AgentConnection,
  type HealthResponse,
  type MaterializedNoteSummary,
  type MaterializedSearchResult,
  type PairingGrantResponse,
  type SetupReadiness,
  type SetupStatus,
  type SetupVaultReadiness,
  type SourceDeviceSummary,
  type VaultSummary,
} from "@mdevolved/contracts";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  PairingCopyControl,
  type PairingCopyState,
} from "./PairingCopyControl";
import { PluginSetupGuide } from "./PluginSetupGuide";
import { SmartCopyField } from "./SmartCopyField";
import {
  OPERATIONAL_REGION_OPEN_EVENT,
  openOperationalRegion,
  OperationalRegion,
  revealOperationalRegion,
} from "./OperationalRegion";
import {
  isWorkspaceSectionId,
  WorkspaceNavigation,
  workspaceSectionFromHash,
  type WorkspaceSectionId,
} from "./WorkspaceNavigation";
import {
  createAlbatrossSetupKit,
  createAntigravityConfig,
  createCodexSetupCommands,
  createCursorInstallUrl,
  createEveConnectionSource,
  createObsidianMindProjectMcpCommand,
} from "./agent-client-config";
import {
  captureOwnerClaimToken,
  clearOwnerClaimToken,
} from "./owner-claim-token";
import { MDEVOLVED_SYNC_REQUIRED_VERSION } from "./obsidian-plugin-links";
import {
  beginLibraryRefresh,
  completeEmptyLibraryRefresh,
  completeLibraryRefresh,
  failLibraryRefresh,
  type LibraryRefreshMode,
  type LibraryState,
} from "./library-refresh-state";
import {
  beginVaultRefresh,
  completeVaultRefresh,
  failVaultRefresh,
  type VaultRefreshMode,
  type VaultState,
} from "./vault-refresh-state";
import {
  requestSetupReadinessRefresh,
  SETUP_READINESS_REFRESH_EVENT,
} from "./setup-readiness-events";
import {
  disconnectedHistoryLabel,
  partitionVaults,
} from "./vault-presentation";

const loadAgentAuthorize = () =>
  import("./AgentAuthorize").then((module) => ({
    default: module.AgentAuthorize,
  }));
const loadBackupPanel = () =>
  import("./BackupPanel").then((module) => ({
    default: module.BackupPanel,
  }));
const loadCollaborationPanel = () =>
  import("./CollaborationPanel").then((module) => ({
    default: module.CollaborationPanel,
  }));
const loadProjectInitialize = () =>
  import("./ProjectInitialize").then((module) => ({
    default: module.ProjectInitialize,
  }));

const AgentAuthorize = lazy(loadAgentAuthorize);
const BackupPanel = lazy(loadBackupPanel);
const CollaborationPanel = lazy(loadCollaborationPanel);
const ProjectInitialize = lazy(loadProjectInitialize);

type LoadState =
  | { kind: "loading" }
  | { health: HealthResponse; kind: "ready"; setup: SetupStatus }
  | { kind: "error" };

type ActionState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      generationId: string;
      kind: "ready";
      results: MaterializedSearchResult[];
    }
  | { kind: "error"; message: string };

type NoteState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | {
      content: string;
      contentVersion: string;
      draft: string;
      generationId: string | null;
      kind: "ready";
      mode: "edit" | "view";
      path: string;
    }
  | { draft: string; kind: "creating"; path: string }
  | { kind: "error"; message: string; path: string };

class ApiRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
  }
}

const architecture = [
  ["Live", "Durable Objects", "One serialized Yjs state owner per vault."],
  ["Browse", "D1 + R2", "Searchable, immutable materialized generations."],
  [
    "Recover",
    "Encrypted export",
    "Independent artifacts with verified manifests.",
  ],
] as const;

async function loadSetup(signal: AbortSignal): Promise<SetupStatus> {
  const response = await fetch("/api/setup/status", {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("Setup status request failed.");
  }

  return setupStatusSchema.parse(await response.json());
}

async function loadHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/healthz", {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("Worker health request failed.");
  }

  return healthResponseSchema.parse(await response.json());
}

async function loadCsrf(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Could not start a secure request.");
  }

  return csrfResponseSchema.parse(await response.json()).csrfToken;
}

async function requestJson(
  path: string,
  csrfToken: string,
  body?: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<unknown> {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-MDevolved-CSRF": csrfToken,
    },
    method,
  });
  const payload: unknown =
    response.status === 204 ? null : await response.json();

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new ApiRequestError(
      parsedError.success ? parsedError.data.error.code : "request_failed",
      parsedError.success
        ? parsedError.data.error.message
        : "The request could not be completed.",
    );
  }

  return payload;
}

async function loadVaultList(signal?: AbortSignal): Promise<VaultSummary[]> {
  const response = await fetch("/api/vaults", {
    headers: { Accept: "application/json" },
    signal,
  });
  const payload: unknown = await response.json();

  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.error.message
        : "Sources could not be loaded.",
    );
  }

  return vaultListResponseSchema.parse(payload).vaults;
}

async function fetchApiJson(
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsedError.success
        ? parsedError.data.error.message
        : "The request could not be completed.",
    );
  }
  return payload;
}

async function postApiJson(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(payload);
    throw new ApiRequestError(
      parsedError.success ? parsedError.data.error.code : "request_failed",
      parsedError.success
        ? parsedError.data.error.message
        : "The request could not be completed.",
    );
  }
  return payload;
}

function formatTimestamp(value: number | null): string {
  if (value === null) return "Not yet";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

function VaultRow({
  isWorking,
  onReconnect,
  onEnrollDevice,
  onRevokeDevice,
  onRevoke,
  vault,
}: {
  isWorking: boolean;
  onReconnect?: (vault: VaultSummary) => Promise<void>;
  onEnrollDevice?: (vault: VaultSummary) => Promise<void>;
  onRevokeDevice?: (
    vault: VaultSummary,
    device: SourceDeviceSummary,
  ) => Promise<void>;
  onRevoke: (vault: VaultSummary) => Promise<void>;
  vault: VaultSummary;
}) {
  return (
    <article className="vault-row">
      <div className="vault-identity">
        <span className={`vault-status vault-status--${vault.status}`}>
          {vault.status}
        </span>
        <span className="vault-kind">Source</span>
        <h3>{vault.displayName ?? "Waiting for Source adapter"}</h3>
        <span className="vault-id">{vault.id}</span>
      </div>
      <dl className="vault-details">
        <div>
          <dt>Paired</dt>
          <dd>{formatTimestamp(vault.pairedAt)}</dd>
        </div>
        <div>
          <dt>Last connected</dt>
          <dd>{formatTimestamp(vault.lastConnectedAt)}</dd>
        </div>
        <div>
          <dt>Source devices</dt>
          <dd>{vault.sourceDevices?.length ?? 0}</dd>
        </div>
        <div>
          <dt>Last published by</dt>
          <dd>
            {vault.lastPublisher === null || vault.lastPublisher === undefined
              ? "Not yet"
              : `${vault.lastPublisher.displayName} · ${formatTimestamp(vault.lastPublisher.lastPublishedAt)}`}
          </dd>
        </div>
      </dl>
      {(vault.sourceDevices?.length ?? 0) > 0 ? (
        <ul className="source-device-list" aria-label="Approved source devices">
          {vault.sourceDevices?.map((device) => (
            <li key={device.deviceId}>
              <span>
                <strong>{device.displayName}</strong>
                <small>
                  {device.status} · boundary {device.boundary.root} · last seen{" "}
                  {formatTimestamp(device.lastSeenAt)}
                </small>
              </span>
              {device.status === "active" && onRevokeDevice !== undefined ? (
                <button
                  className="danger-action"
                  type="button"
                  disabled={isWorking}
                  onClick={() => void onRevokeDevice(vault, device)}
                >
                  Revoke device
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {vault.status !== "revoked" && onReconnect !== undefined ? (
        <div className="vault-row-actions">
          {onEnrollDevice !== undefined ? (
            <button
              className="secondary-action"
              type="button"
              disabled={isWorking}
              onClick={() => void onEnrollDevice(vault)}
            >
              Add approved device
            </button>
          ) : null}
          <button
            className="secondary-action"
            type="button"
            disabled={isWorking}
            onClick={() => void onReconnect(vault)}
          >
            Reconnect same Source
          </button>
          <button
            className="danger-action"
            type="button"
            disabled={isWorking}
            onClick={() => void onRevoke(vault)}
          >
            Revoke access
          </button>
        </div>
      ) : (
        <span className="revoked-note">Access closed</span>
      )}
    </article>
  );
}

function hasUnsavedDraft(state: NoteState): boolean {
  return (
    state.kind === "creating" ||
    (state.kind === "ready" &&
      state.mode === "edit" &&
      state.draft !== state.content)
  );
}

type ConnectionsState =
  | { kind: "loading" }
  | { connections: AgentConnection[]; kind: "ready"; mcpUrl: string }
  | { initial: boolean; kind: "error"; message: string };

type AgentSetupPrerequisite =
  "checking" | "vault-required" | "library-required" | "ready";

function freshAlbatrossParticipantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `agent-${Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
}

type AgentClientId =
  | "albatross"
  | "antigravity"
  | "codex"
  | "cursor"
  | "eve"
  | "obsidian-mind"
  | "other";

const AGENT_CLIENTS: Array<{ id: AgentClientId; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
  { id: "obsidian-mind", label: "Obsidian Mind" },
  { id: "eve", label: "Eve" },
  { id: "albatross", label: "Albatross" },
  { id: "other", label: "Other" },
];

function authorizedFolderLabel(connection: AgentConnection): string {
  return connection.pathPrefixes.length === 0
    ? "Entire Source"
    : connection.pathPrefixes.join(", ");
}

function AuthorizedClientInventory({
  canConnect,
  connections,
  onConnect,
  onRevoke,
  onRevokeAll,
  setupExpanded,
  working,
}: {
  canConnect: boolean;
  connections: AgentConnection[];
  onConnect: () => void;
  onRevoke: (connection: AgentConnection) => Promise<boolean>;
  onRevokeAll: () => Promise<boolean>;
  setupExpanded: boolean;
  working: boolean;
}) {
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const connectionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const connectionLabelCounts = new Map<string, number>();
  for (const connection of connections) {
    const labelKey = `${connection.clientName}\u0000${connection.vaultName}`;
    connectionLabelCounts.set(
      labelKey,
      (connectionLabelCounts.get(labelKey) ?? 0) + 1,
    );
  }
  const selectedConnection =
    connections.find((connection) => connection.id === selectedConnectionId) ??
    null;

  function closeSelectedConnection(): void {
    const connectionId = selectedConnectionId;
    setSelectedConnectionId(null);
    window.requestAnimationFrame(() => {
      if (connectionId !== null) {
        connectionButtonRefs.current.get(connectionId)?.focus();
      }
    });
  }

  function focusAfterAuthorizationRemoved(): void {
    setSelectedConnectionId(null);
    window.requestAnimationFrame(() => {
      const nextButton = connectionButtonRefs.current.values().next().value as
        HTMLButtonElement | undefined;
      (
        nextButton ??
        document.getElementById("agent-setup-heading") ??
        document.getElementById("authorized-client-heading") ??
        document.getElementById("agent-heading")
      )?.focus();
    });
  }

  function focusAfterAllAuthorizationsRemoved(attempt = 0): void {
    window.requestAnimationFrame(() => {
      const setupHeading = document.getElementById("agent-setup-heading");
      if (setupHeading !== null) {
        setupHeading.focus();
        return;
      }
      if (attempt < 4) {
        focusAfterAllAuthorizationsRemoved(attempt + 1);
        return;
      }
      document.getElementById("agent-heading")?.focus();
    });
  }

  return (
    <section
      className="authorized-client-inventory"
      aria-labelledby="authorized-client-heading"
    >
      <div className="authorized-client-heading">
        <div>
          <span className="pairing-label">Reusable MCP access</span>
          <h3 id="authorized-client-heading" tabIndex={-1}>
            {connections.length.toLocaleString()} authorized client
            {connections.length === 1 ? "" : "s"}
          </h3>
          <p>
            Chats and processes can disappear. These buttons represent the
            client authorizations they can reuse after a restart.
          </p>
        </div>
        <div className="authorized-client-heading-actions">
          <button
            aria-controls={
              canConnect ? "agent-new-connection-setup" : undefined
            }
            aria-expanded={canConnect ? setupExpanded : false}
            className="compact-action"
            disabled={!canConnect}
            type="button"
            onClick={onConnect}
          >
            {canConnect
              ? setupExpanded
                ? "Hide setup"
                : "Connect another"
              : "Setup unavailable"}
          </button>
          <button
            className="danger-action"
            type="button"
            disabled={working}
            onClick={() => {
              void onRevokeAll().then((revoked) => {
                if (!revoked) return;
                focusAfterAllAuthorizationsRemoved();
              });
            }}
          >
            Revoke all
          </button>
        </div>
      </div>

      <div
        className="authorized-client-buttons"
        aria-label="Authorized clients"
      >
        {connections.map((connection) => {
          const selected = connection.id === selectedConnectionId;
          const labelCount =
            connectionLabelCounts.get(
              `${connection.clientName}\u0000${connection.vaultName}`,
            ) ?? 1;
          const duplicateLabel = labelCount > 1;
          const shortAuthorizationId = connection.id.slice(0, 8);
          return (
            <button
              aria-controls={
                selected ? `authorized-client-${connection.id}` : undefined
              }
              aria-expanded={selected}
              aria-label={
                duplicateLabel
                  ? `${connection.clientName}, ${connection.vaultName}, authorization ${connection.id}`
                  : `${connection.clientName}, ${connection.vaultName}`
              }
              className="authorized-client-button"
              key={connection.id}
              ref={(element) => {
                if (element === null) {
                  connectionButtonRefs.current.delete(connection.id);
                } else {
                  connectionButtonRefs.current.set(connection.id, element);
                }
              }}
              type="button"
              onClick={() =>
                setSelectedConnectionId(selected ? null : connection.id)
              }
            >
              <span>{connection.clientName}</span>
              <small>
                {connection.vaultName}
                {duplicateLabel
                  ? ` · auth ${shortAuthorizationId} · last used ${formatTimestamp(connection.lastUsedAt)}`
                  : ""}
              </small>
            </button>
          );
        })}
      </div>

      {selectedConnection !== null ? (
        <article
          className="authorized-client-popover"
          id={`authorized-client-${selectedConnection.id}`}
        >
          <div className="authorized-client-popover-heading">
            <div>
              <span className="vault-status vault-status--active">
                Authorized client
              </span>
              <h4>{selectedConnection.clientName}</h4>
            </div>
            <button
              className="text-action"
              type="button"
              onClick={closeSelectedConnection}
            >
              Close
            </button>
          </div>
          <dl className="authorized-client-details">
            <div>
              <dt>Source</dt>
              <dd>{selectedConnection.vaultName}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>{authorizedFolderLabel(selectedConnection)}</dd>
            </div>
            <div>
              <dt>Last used</dt>
              <dd>{formatTimestamp(selectedConnection.lastUsedAt)}</dd>
            </div>
          </dl>
          <div className="authorized-client-continuity" role="note">
            <strong>
              {selectedConnection.writerRole === "primary-writer"
                ? "Primary writer authorization"
                : selectedConnection.writerRole === "read-only-collaborator"
                  ? "Read-only authorization"
                  : "Project not connected yet"}
            </strong>
            <span>
              {selectedConnection.writerRole === "primary-writer"
                ? "A restarted process can retain continuity only through this same authorization."
                : selectedConnection.writerRole === "read-only-collaborator"
                  ? "This authorization remains read-only and cannot be promoted from this global screen."
                  : "Choose the exact first-Project path before asking this client to resume."}
            </span>
          </div>
          {selectedConnection.writerRole !== "unassigned" &&
          selectedConnection.writerEligible ? (
            <div className="authorized-client-resume">
              <div>
                <strong>Restarted the client?</strong>
                <span>Paste this into it to resume the exact Project.</span>
              </div>
              <SmartCopyField
                label="Copy resume instruction"
                value="MDevolved resume project"
              />
            </div>
          ) : selectedConnection.writerRole === "unassigned" &&
            selectedConnection.preparedProjectHandoff !== null ? (
            <div className="authorized-client-resume">
              <div>
                <strong>First Project prepared</strong>
                <span>Paste this into the same client to continue.</span>
              </div>
              <SmartCopyField
                label="Copy Project instruction"
                value="Connect this project to MDevolved"
              />
            </div>
          ) : selectedConnection.writerRole === "unassigned" ? (
            <button
              className="compact-action"
              type="button"
              onClick={() => revealOperationalRegion("architecture")}
            >
              Finish Project 1 setup
            </button>
          ) : (
            <p className="authorized-client-no-project">
              No active Project command is available for this authorization.
            </p>
          )}
          <details className="authorized-client-technical">
            <summary>Technical details</summary>
            <p>
              Origin <code>{selectedConnection.clientOrigin}</code>
            </p>
            <p>
              Authorization <code>{selectedConnection.id}</code>
            </p>
          </details>
          <button
            className="danger-action"
            type="button"
            disabled={working}
            onClick={() => {
              void onRevoke(selectedConnection).then((revoked) => {
                if (revoked) focusAfterAuthorizationRemoved();
              });
            }}
          >
            Revoke authorization
          </button>
        </article>
      ) : null}
    </section>
  );
}

function AgentConnectionsPanel({
  prerequisite,
  readiness,
}: {
  prerequisite: AgentSetupPrerequisite;
  readiness: SetupReadiness | null;
}) {
  const [state, setState] = useState<ConnectionsState>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [albatrossParticipantId, setAlbatrossParticipantId] = useState(
    freshAlbatrossParticipantId,
  );
  const [selectedClient, setSelectedClient] = useState<AgentClientId>("codex");
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [working, setWorking] = useState(false);
  const settledRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const activeConnectionIdsRef = useRef<Set<string> | null>(null);

  async function refresh(signal?: AbortSignal): Promise<void> {
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    try {
      const parsed = agentConnectionListResponseSchema.parse(
        await fetchApiJson("/api/agent/connections", signal),
      );
      if (
        signal?.aborted === true ||
        refreshSequence !== refreshSequenceRef.current
      ) {
        return;
      }
      const activeConnectionIds = new Set(
        parsed.connections
          .filter((connection) => connection.status === "active")
          .map((connection) => connection.id),
      );
      const previousActiveConnectionIds = activeConnectionIdsRef.current;
      if (
        previousActiveConnectionIds !== null &&
        [...activeConnectionIds].some(
          (connectionId) => !previousActiveConnectionIds.has(connectionId),
        )
      ) {
        setSetupExpanded(false);
      }
      activeConnectionIdsRef.current = activeConnectionIds;
      setState({
        connections: parsed.connections,
        kind: "ready",
        mcpUrl: parsed.mcpUrl,
      });
      settledRef.current = true;
    } catch (error: unknown) {
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        signal?.aborted === true ||
        refreshSequence !== refreshSequenceRef.current
      ) {
        return;
      }
      setState({
        initial: !settledRef.current,
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Agent connections could not be loaded.",
      });
      settledRef.current = true;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const refreshOnFocus = () => void refresh();
    const refreshOnSetupChange = () => void refresh();
    void refresh(controller.signal);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener(
      SETUP_READINESS_REFRESH_EVENT,
      refreshOnSetupChange,
    );
    return () => {
      controller.abort();
      refreshSequenceRef.current += 1;
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener(
        SETUP_READINESS_REFRESH_EVENT,
        refreshOnSetupChange,
      );
    };
  }, []);

  async function revoke(connection: AgentConnection): Promise<boolean> {
    if (
      !window.confirm(
        `Revoke ${connection.clientName}'s read access to ${connection.vaultName}? Its next tool call will be denied.`,
      )
    ) {
      return false;
    }
    setWorking(true);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      await requestJson(
        `/api/agent/connections/${encodeURIComponent(connection.id)}/revoke`,
        csrf,
      );
      await refresh();
      requestSetupReadinessRefresh();
      setMessage(
        "Agent access revoked. Existing tokens can no longer read Source data.",
      );
      return true;
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The connection could not be revoked.",
      );
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function revokeAll(): Promise<boolean> {
    if (
      !window.confirm(
        "Revoke every active agent connection? Their next tool calls will all be denied.",
      )
    ) {
      return false;
    }
    setWorking(true);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      await requestJson("/api/agent/connections/revoke-all", csrf);
      await refresh();
      requestSetupReadinessRefresh();
      setMessage("All agent access has been revoked.");
      return true;
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Agent connections could not be revoked.",
      );
      return false;
    } finally {
      setWorking(false);
    }
  }

  const active =
    state.kind === "ready"
      ? state.connections.filter((connection) => connection.status === "active")
      : [];
  const preparedConnections = active.filter(
    (connection) => connection.preparedProjectHandoff !== null,
  );
  const preparedVaultIds = new Set(
    preparedConnections.map((connection) => connection.vaultId),
  );
  const readinessByVault = new Map(
    (readiness?.vaults ?? []).map((vault) => [vault.id, vault]),
  );
  const establishedConnections = active.filter(
    (connection) =>
      connection.writerRole !== "unassigned" ||
      (readinessByVault.get(connection.vaultId)?.activeProjectCount ?? 0) > 0,
  );
  const firstProjectVaults = [
    ...new Map(
      active
        .filter((connection) => {
          const vaultReadiness = readinessByVault.get(connection.vaultId);
          return (
            connection.writerRole === "unassigned" &&
            !preparedVaultIds.has(connection.vaultId) &&
            (vaultReadiness === undefined ||
              (vaultReadiness.preparedProjectHandoff === null &&
                vaultReadiness.activeProjectCount === 0))
          );
        })
        .map((connection) => [
          connection.vaultId,
          { id: connection.vaultId, name: connection.vaultName },
        ]),
    ).values(),
  ];
  const hasEstablishedProject = establishedConnections.length > 0;
  const connectionSummary =
    state.kind === "loading"
      ? "Checking agent access…"
      : state.kind === "error"
        ? "Agent access needs attention"
        : prerequisite === "checking"
          ? "Checking agent prerequisites…"
          : prerequisite === "vault-required"
            ? "Pair a Source before connecting agents"
            : prerequisite === "library-required"
              ? "MDevolved is preparing the Source for agents"
              : active.length === 0
                ? "No authorized clients"
                : `${active.length.toLocaleString()} authorized client${
                    active.length === 1 ? "" : "s"
                  }`;

  const content = (
    <section className="agent-panel" aria-labelledby="agent-heading">
      <div className="section-heading">
        <div>
          <span className="section-kicker">AI agent access</span>
          <h2 id="agent-heading" tabIndex={-1}>
            Authorized clients and Project access.
          </h2>
        </div>
      </div>

      {state.kind === "loading" ? (
        <p className="vault-message">Loading agent access…</p>
      ) : state.kind === "error" ? (
        <p className="action-error" role="alert">
          {state.message}
        </p>
      ) : (
        <>
          {active.length > 0 ? (
            <AuthorizedClientInventory
              canConnect={prerequisite === "ready"}
              connections={active}
              onConnect={() => {
                setSetupExpanded((current) => !current);
              }}
              onRevoke={revoke}
              onRevokeAll={revokeAll}
              setupExpanded={setupExpanded}
              working={working}
            />
          ) : null}

          {prerequisite === "ready" &&
          (active.length === 0 || setupExpanded) ? (
            <>
              <section
                className="agent-setup-flow"
                aria-labelledby="agent-setup-heading"
                id="agent-new-connection-setup"
              >
                <div className="agent-setup-heading">
                  <div>
                    <span className="pairing-label">
                      {active.length === 0
                        ? "Connect a client"
                        : "Connect another client"}
                    </span>
                    <h3 id="agent-setup-heading" tabIndex={-1}>
                      Choose one setup path.
                    </h3>
                    <code className="agent-mcp-endpoint">{state.mcpUrl}</code>
                  </div>
                  <ol
                    className="agent-setup-steps"
                    aria-label="Agent setup steps"
                  >
                    <li>
                      <span>1</span> Choose
                    </li>
                    <li>
                      <span>2</span> Install
                    </li>
                    <li>
                      <span>3</span> Approve Source
                    </li>
                  </ol>
                </div>

                <div className="agent-client-picker" aria-label="Agent clients">
                  {AGENT_CLIENTS.map((client) => (
                    <button
                      aria-pressed={selectedClient === client.id}
                      className="agent-client-choice"
                      key={client.id}
                      type="button"
                      onClick={() => setSelectedClient(client.id)}
                    >
                      {client.label}
                    </button>
                  ))}
                </div>

                <article className="agent-client-guide">
                  {selectedClient === "codex" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">Codex</span>
                          <h3>Install and authenticate</h3>
                        </div>
                        <span className="client-path">
                          Terminal → browser approval → <code>/mcp</code>
                        </span>
                      </div>
                      <SmartCopyField
                        label="Copy setup"
                        value={createCodexSetupCommands(state.mcpUrl)}
                      />
                      <p>
                        Run both lines. Approve the exact Source in the page
                        that opens, restart Codex, then use <code>/mcp</code> to
                        verify.
                      </p>
                      <details className="agent-client-help">
                        <summary>Use Codex Settings instead</summary>
                        <p>
                          Settings → MCP servers → Add server → Streamable HTTP.
                          Paste the MCP URL, save, restart, then choose
                          Authenticate.
                        </p>
                        <SmartCopyField
                          label="Copy MCP URL"
                          value={state.mcpUrl}
                        />
                      </details>
                    </>
                  ) : selectedClient === "cursor" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">Cursor</span>
                          <h3>Install with one click</h3>
                        </div>
                        <span className="client-path">
                          Cursor → browser approval
                        </span>
                      </div>
                      <a
                        className="compact-action"
                        href={createCursorInstallUrl(state.mcpUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Add MDevolved to Cursor ↗
                      </a>
                      <p>
                        Cursor receives only this public MCP URL. MDevolved
                        still asks you to approve the exact Source.
                      </p>
                    </>
                  ) : selectedClient === "antigravity" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">Antigravity</span>
                          <h3>Add one MCP entry</h3>
                        </div>
                        <span className="client-path">
                          Settings → Customizations → MCP Servers
                        </span>
                      </div>
                      <SmartCopyField
                        label="Copy config"
                        value={createAntigravityConfig(state.mcpUrl)}
                      />
                      <p>
                        Merge this entry with your existing servers, then choose
                        Authenticate.
                      </p>
                    </>
                  ) : selectedClient === "obsidian-mind" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">
                            Obsidian Mind 8.x
                          </span>
                          <h3>Add MDevolved beside qmd</h3>
                        </div>
                        <span className="client-path">
                          Workspace root → terminal
                        </span>
                      </div>
                      <SmartCopyField
                        label="Copy setup"
                        value={createObsidianMindProjectMcpCommand(
                          state.mcpUrl,
                        )}
                      />
                      <p>
                        Run once from the workspace root. Claude merges
                        MDevolved into <code>.mcp.json</code> without replacing
                        qmd.
                      </p>
                    </>
                  ) : selectedClient === "eve" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">Eve 0.29</span>
                          <h3>Add a user-scoped connection</h3>
                        </div>
                        <span className="client-path">
                          <code>agent/connections/owd.ts</code>
                        </span>
                      </div>
                      <SmartCopyField
                        label="Copy module"
                        value={createEveConnectionSource(state.mcpUrl)}
                      />
                      <p>
                        Save the complete module at the path above. Eve pauses
                        for your Source approval, then resumes.
                      </p>
                    </>
                  ) : selectedClient === "albatross" ? (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">Albatross 2.0</span>
                          <h3>Authorize one participant</h3>
                        </div>
                        <button
                          className="text-action"
                          type="button"
                          onClick={() =>
                            setAlbatrossParticipantId(
                              freshAlbatrossParticipantId(),
                            )
                          }
                        >
                          New participant ID
                        </button>
                      </div>
                      <SmartCopyField
                        label="Copy setup kit"
                        value={createAlbatrossSetupKit(
                          state.mcpUrl,
                          albatrossParticipantId,
                        )}
                      />
                      <p>
                        Authorize first, merge the included MCP and prompt
                        blocks, then run <code>/mcp trust owd</code>.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="agent-client-guide-heading">
                        <div>
                          <span className="pairing-label">
                            Any compatible client
                          </span>
                          <h3>Add a remote HTTP MCP server</h3>
                        </div>
                        <span className="client-path">
                          Streamable HTTP + OAuth
                        </span>
                      </div>
                      <SmartCopyField
                        label="Copy MCP URL"
                        value={state.mcpUrl}
                      />
                      <p>
                        Add the URL, start authentication, then approve one
                        Source and its folder boundary in MDevolved.
                      </p>
                    </>
                  )}
                </article>
              </section>
            </>
          ) : prerequisite === "library-required" ? (
            <article className="agent-connect-card agent-setup-blocked">
              <div>
                <span className="pairing-label">Library preparing</span>
                <h3>MDevolved is preparing the searchable library</h3>
                <p>
                  MDevolved automatically publishes the current Source after
                  sync settles. Agent authorization opens when that atomic build
                  is ready, so a connection never starts with unusable context.
                </p>
              </div>
              <button
                className="primary-action"
                type="button"
                onClick={() => revealOperationalRegion("library")}
              >
                View library status
              </button>
            </article>
          ) : prerequisite === "vault-required" ? (
            <article className="agent-connect-card agent-setup-blocked">
              <div>
                <span className="pairing-label">Source required first</span>
                <h3>Pair a Source for this workspace before adding agents</h3>
                <p>
                  Agent setup stays closed until MDevolved has an active Source.
                  This prevents a reused workspace from silently offering an
                  older Source or its Project history during authorization.
                </p>
              </div>
              <button
                className="primary-action"
                type="button"
                onClick={() => revealOperationalRegion("vaults")}
              >
                Set up a Source
              </button>
            </article>
          ) : (
            <p className="vault-message">Checking agent prerequisites…</p>
          )}

          {active.length === 0 ? (
            <div className="empty-vaults agent-empty">
              <h3>No authorized clients.</h3>
              <p>
                Nothing can read a Source through MCP until you complete the
                passkey approval screen from an agent client.
              </p>
            </div>
          ) : (
            <>
              {prerequisite === "ready" ? (
                <article
                  className="agent-project-launcher"
                  aria-labelledby="agent-project-handoff-heading"
                >
                  <div className="agent-project-launcher-heading">
                    <div>
                      <span className="pairing-label">
                        {hasEstablishedProject
                          ? "Projects · repeat anytime"
                          : preparedConnections.length > 0
                            ? "Project 1 ready for your agent"
                            : "Project 1"}
                      </span>
                      <h3 id="agent-project-handoff-heading">
                        {hasEstablishedProject
                          ? "Start another Project"
                          : preparedConnections.length === 1
                            ? `${preparedConnections[0]?.preparedProjectHandoff?.projectLabel} is prepared`
                            : preparedConnections.length > 1
                              ? `${preparedConnections.length} first Projects are prepared`
                              : "Finish Project 1 setup"}
                      </h3>
                    </div>
                  </div>
                  {hasEstablishedProject ? (
                    <LaterProjectLauncher
                      connections={establishedConnections}
                    />
                  ) : null}
                  {preparedConnections.map((connection) => (
                    <section
                      className="prepared-project-by-vault"
                      key={connection.id}
                    >
                      {hasEstablishedProject ? (
                        <div className="prepared-project-by-vault-heading">
                          <h4>
                            {connection.preparedProjectHandoff?.projectLabel} is
                            prepared
                          </h4>
                          <span className="client-path">
                            Next: continue in {connection.clientName}
                          </span>
                        </div>
                      ) : (
                        <span className="client-path">
                          Next: continue in {connection.clientName}
                        </span>
                      )}
                      <div className="prepared-project-summary">
                        <span>
                          <b>Agent</b>
                          {connection.clientName}
                        </span>
                        <span>
                          <b>Source</b>
                          {connection.vaultName}
                        </span>
                        <span>
                          <b>Folder</b>
                          {connection.preparedProjectHandoff?.folderBoundary ||
                            "Entire approved Source"}
                        </span>
                      </div>
                      <p className="agent-project-next-step">
                        Ask that agent to start or connect this Project. The
                        exact matching request completes on the same connection.
                      </p>
                      <details className="project-handoff-advanced">
                        <summary>Change the prepared first Project</summary>
                        <ProjectHandoffSetup
                          buttonLabel="Update first Project"
                          onPrepared={refresh}
                          vaultId={connection.vaultId}
                          vaultName={connection.vaultName}
                        />
                      </details>
                    </section>
                  ))}
                  {firstProjectVaults.length > 0 ? (
                    <div className="agent-project-first-step">
                      <p>
                        {hasEstablishedProject
                          ? `${firstProjectVaults.length.toLocaleString()} connected Source${firstProjectVaults.length === 1 ? "" : "s"} still ${firstProjectVaults.length === 1 ? "needs" : "need"} a separate Project 1 setup.`
                          : "Choose the first Project's agent, name, and folder in the guided setup. After that, this card becomes the repeatable Project 2, 3, and later launcher."}
                      </p>
                      {hasEstablishedProject ? (
                        <ul className="agent-project-vault-boundaries">
                          {firstProjectVaults.map((vault) => (
                            <li key={vault.id}>
                              <span>{vault.name}</span>
                              <code>{vault.id}</code>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <button
                        className="compact-action"
                        type="button"
                        onClick={() => revealOperationalRegion("architecture")}
                      >
                        Finish Project 1 setup
                      </button>
                    </div>
                  ) : null}
                </article>
              ) : null}
            </>
          )}
          {message !== null ? (
            <p className="agent-message" aria-live="polite">
              {message}
            </p>
          ) : null}
        </>
      )}
    </section>
  );

  return (
    <OperationalRegion
      attention={state.kind === "error" ? "error" : "none"}
      autoOpen={state.kind === "error" && state.initial}
      heading="Agent access"
      id="agents"
      kicker="MDevolved MCP"
      summary={connectionSummary}
    >
      {content}
    </OperationalRegion>
  );
}

function LaterProjectLauncher({
  connections,
}: {
  connections: AgentConnection[];
}) {
  const eligible = connections.filter(
    (connection) =>
      connection.scopes.some(
        (scope) => scope === "project.initialize.request",
      ) &&
      connection.scopes.some((scope) => scope === "project.connect.request"),
  );
  const [selectedAgentId, setSelectedAgentId] = useState(eligible[0]?.id ?? "");
  const [projectName, setProjectName] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    if (!eligible.some((connection) => connection.id === selectedAgentId)) {
      setSelectedAgentId(eligible[0]?.id ?? "");
    }
  }, [eligible, selectedAgentId]);

  const selectedConnection =
    eligible.find((connection) => connection.id === selectedAgentId) ?? null;
  const trimmedName = projectName.trim();
  const trimmedGoal = goal.trim();
  const request =
    selectedConnection === null || trimmedName === ""
      ? "Name the Project to build the request."
      : `Start a new MDevolved Project named ${JSON.stringify(trimmedName)} for this Source.${
          trimmedGoal === "" ? "" : ` Goal: ${trimmedGoal}`
        } Use MDevolved and keep this connection open while I approve the exact request.`;

  if (eligible.length === 0) {
    return (
      <p className="action-error" role="alert">
        No connected agent has both Project permissions. Reconnect one above,
        then return here.
      </p>
    );
  }

  return (
    <div className="later-project-flow">
      <div className="later-project-fields">
        <label>
          <span>Agent and Source</span>
          <select
            value={selectedAgentId}
            onChange={(event) => setSelectedAgentId(event.target.value)}
          >
            {eligible.map((connection, index) => (
              <option key={connection.id} value={connection.id}>
                {connection.clientName} · {connection.vaultName} · access{" "}
                {index + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Project name</span>
          <input
            maxLength={120}
            placeholder="e.g. Website relaunch"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </label>
        <label>
          <span>What are you trying to get done? · optional</span>
          <input
            maxLength={500}
            placeholder="Plain language is fine"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
      </div>
      <div className="later-project-request">
        <span className="pairing-label">Next action</span>
        <SmartCopyField
          disabled={selectedConnection === null || trimmedName === ""}
          label="Copy request"
          value={request}
        />
        <small>
          Paste this into {selectedConnection?.clientName ?? "the agent"}.
          MDevolved will return one exact approval here, then the agent
          continues on the same connection.
        </small>
      </div>
    </div>
  );
}

type ProjectHandoffSetupState =
  | { kind: "loading" }
  | { connections: AgentConnection[]; kind: "ready" }
  | { kind: "error"; message: string };

function ProjectHandoffSetup({
  buttonLabel = "Prepare Project",
  onPrepared,
  vaultId,
  vaultName,
}: {
  buttonLabel?: string;
  onPrepared: () => Promise<void>;
  vaultId: string;
  vaultName: string;
}) {
  const instanceId = useId();
  const [state, setState] = useState<ProjectHandoffSetupState>({
    kind: "loading",
  });
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [projectLabel, setProjectLabel] = useState(vaultName);
  const [folderBoundary, setFolderBoundary] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchApiJson("/api/agent/connections", controller.signal)
      .then((payload) => {
        const parsed = agentConnectionListResponseSchema.parse(payload);
        const eligible = parsed.connections.filter(
          (connection) =>
            connection.status === "active" &&
            connection.vaultId === vaultId &&
            connection.scopes.some(
              (scope) => scope === "project.initialize.request",
            ) &&
            connection.scopes.some(
              (scope) => scope === "project.connect.request",
            ),
        );
        setState({ connections: eligible, kind: "ready" });
        const preferred =
          eligible.find(
            (connection) => connection.preparedProjectHandoff !== null,
          ) ?? eligible[0];
        setSelectedAgentId(preferred?.id ?? "");
        setProjectLabel(
          preferred?.preparedProjectHandoff?.projectLabel ?? vaultName,
        );
        setFolderBoundary(
          preferred?.preparedProjectHandoff?.folderBoundary ??
            preferred?.pathPrefixes[0] ??
            "",
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Agent connections could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [vaultId, vaultName]);

  const selectedConnection =
    state.kind === "ready"
      ? (state.connections.find(
          (connection) => connection.id === selectedAgentId,
        ) ?? null)
      : null;
  const approvedFolderRoots = selectedConnection?.pathPrefixes ?? [];
  const folderSuggestionsId = `project-folders-${vaultId}-${instanceId}`;

  async function prepare(): Promise<void> {
    if (selectedConnection === null || projectLabel.trim() === "") return;
    setWorking(true);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const response = prepareProjectHandoffResponseSchema.parse(
        await requestJson(
          `/api/agent/connections/${encodeURIComponent(
            selectedConnection.id,
          )}/prepare-first-project`,
          csrf,
          {
            folderBoundary,
            projectLabel,
          },
        ),
      );
      setMessage(
        `${response.handoff.projectLabel} is prepared for ${selectedConnection.clientName}.`,
      );
      requestSetupReadinessRefresh();
      await onPrepared();
    } catch (error: unknown) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The Project could not be prepared.",
      );
    } finally {
      setWorking(false);
    }
  }

  if (state.kind === "loading") {
    return <p className="vault-message">Loading eligible agents…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="action-error" role="alert">
        {state.message}
      </p>
    );
  }
  if (state.connections.length === 0) {
    return (
      <p className="action-error" role="alert">
        No active agent for this Source has both Project permissions. Connect
        one above, then return here.
      </p>
    );
  }

  return (
    <form
      className="project-handoff-form"
      onSubmit={(event) => {
        event.preventDefault();
        void prepare();
      }}
    >
      <label>
        <span>Agent and Source</span>
        <select
          value={selectedAgentId}
          onChange={(event) => {
            const nextAgentId = event.target.value;
            const nextAgent =
              state.connections.find(
                (connection) => connection.id === nextAgentId,
              ) ?? null;
            setSelectedAgentId(nextAgentId);
            setProjectLabel(
              nextAgent?.preparedProjectHandoff?.projectLabel ?? vaultName,
            );
            setFolderBoundary(
              nextAgent?.preparedProjectHandoff?.folderBoundary ??
                nextAgent?.pathPrefixes[0] ??
                "",
            );
            setMessage(null);
          }}
        >
          {state.connections.map((connection, index) => (
            <option key={connection.id} value={connection.id}>
              {connection.clientName} · {connection.vaultName} · access{" "}
              {index + 1}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Project name</span>
        <input
          maxLength={120}
          required
          value={projectLabel}
          onChange={(event) => {
            setProjectLabel(event.target.value);
            setMessage(null);
          }}
        />
      </label>
      <label>
        <span>Project folder</span>
        <input
          list={folderSuggestionsId}
          maxLength={1_024}
          placeholder={
            approvedFolderRoots.length === 0
              ? "Leave blank for the entire approved Source"
              : approvedFolderRoots[0]
          }
          value={folderBoundary}
          onChange={(event) => {
            setFolderBoundary(event.target.value);
            setMessage(null);
          }}
        />
        <datalist id={folderSuggestionsId}>
          {approvedFolderRoots.map((folder) => (
            <option key={folder} value={folder} />
          ))}
        </datalist>
        <small>
          {approvedFolderRoots.length === 0
            ? "Leave blank for the whole approved Source, or enter a narrower folder such as docs."
            : `Use ${approvedFolderRoots.join(
                " or ",
              )}, or a narrower folder inside one of those approved roots.`}
        </small>
      </label>
      <button
        className="compact-action"
        disabled={working || projectLabel.trim() === ""}
        type="submit"
      >
        {working ? "Preparing…" : buttonLabel}
      </button>
      {message !== null ? (
        <small className="setup-receipt" aria-live="polite">
          {message}
        </small>
      ) : null}
    </form>
  );
}

type SetupGuidance = {
  actionLabel: string | null;
  description: string;
  title: string;
};

function setupGuidance(
  step: SetupVaultReadiness["nextStep"] | "connect-vault" | null,
  vaultName: string,
  libraryState: SetupVaultReadiness["libraryState"] | null,
  preparedProjectHandoff: SetupVaultReadiness["preparedProjectHandoff"] | null,
): SetupGuidance {
  switch (step) {
    case "connect-vault":
      return {
        actionLabel: "Connect a source",
        description:
          "Choose a Markdown folder in MDevolved Sync, or install MDevolved Sync for Obsidian in the exact vault you want to use. Then approve its one-time pairing request.",
        title: "Connect the first content source",
      };
    case "sync-vault":
      return {
        actionLabel: "Open Source connection help",
        description: `${vaultName} is paired, but its first durable sync is still finishing. Keep that exact Source open in the folder app or Obsidian adapter; this page updates automatically. A brief Disconnected status can appear during startup. Wait 30 seconds, then restart that adapter once if it has not connected—do not reinstall it.`,
        title: `Finish ${vaultName}'s first sync`,
      };
    case "build-library":
      if (libraryState === "failed") {
        return {
          actionLabel: "Open library repair",
          description: `${vaultName}'s automatic build stopped safely. Open its status and select Build now to retry; the previous generation remains unchanged.`,
          title: `${vaultName}'s library needs attention`,
        };
      }
      return {
        actionLabel: "View library status",
        description: `MDevolved automatically rebuilds ${vaultName}'s searchable library after sync settles. Keep its sync client open; no owner action is required.`,
        title: `Preparing ${vaultName}'s searchable library`,
      };
    case "create-recovery-point":
      return {
        actionLabel: "Connect an agent",
        description: `${vaultName} has a searchable library. Connect the agent you want coordinating Source edits first, then establish its first Project with that agent. You remain the owner; later agents are warned to stay read-only. A recovery point is recommended, not required.`,
        title: `Connect an agent to ${vaultName}`,
      };
    case "connect-agent":
      return {
        actionLabel: "Connect an agent",
        description: `Authorize the agent you want coordinating ${vaultName}'s edits first. You will choose its exact first Project here during the next onboarding step. You remain the owner, and later agents are warned to stay read-only. The consent screen must name this exact Source and folder boundary.`,
        title: `Connect an agent to ${vaultName}`,
      };
    case "prepare-project-handoff":
      return {
        actionLabel: null,
        description: `Choose the agent, exact Project name, and approved folder once. MDevolved will prepare that single first Project so the matching agent request can finish without another website approval.`,
        title: `Prepare ${vaultName}'s first Project`,
      };
    case "approve-project":
      return {
        actionLabel: "Review and approve Project",
        description:
          "This request does not match an unused first-Project handoff, or it is an older/advanced request. Review the exact Project once; do not reconnect or create a duplicate.",
        title: "An exact Project request needs owner review",
      };
    case "create-or-select-project":
      return {
        actionLabel: null,
        description:
          preparedProjectHandoff === null
            ? `In your selected agent, say “Connect this project to MDevolved.” MDevolved will use the exact first Project prepared during onboarding.`
            : `${preparedProjectHandoff.projectLabel} is prepared for ${preparedProjectHandoff.clientName} using ${
                preparedProjectHandoff.folderBoundary ||
                "the entire approved Source"
              }. Go to that agent and say “Connect this project to MDevolved.” The matching first request finishes there—no return to this website, copied prompt, reconnect, or daily renewal.`,
        title:
          preparedProjectHandoff === null
            ? "Tell your agent to connect this Project"
            : `Finish in ${preparedProjectHandoff.clientName}`,
      };
    case "reauthenticate-project":
      return {
        actionLabel: null,
        description:
          "Approval is complete. Continue in your agent—nothing to copy. The current MCP flow will finish this exact Project connection; no reconnect is required.",
        title: "Your exact Project connection is ready",
      };
    case "ready":
      return {
        actionLabel: null,
        description: `${vaultName} has a current library, an approved agent connection, and an approved Project. Continue in your agent. In a new session, MDevolved should resume the exact Project and writer role automatically.`,
        title: `${vaultName} is Project-ready`,
      };
    default:
      return {
        actionLabel: "Checking readiness…",
        description:
          "MDevolved is checking each prerequisite against one coherent source boundary.",
        title: "Checking the next truthful step",
      };
  }
}

function StateAwareSetup({
  onReadinessChange,
}: {
  onReadinessChange: (readiness: SetupReadiness) => void;
}) {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const refreshSequenceRef = useRef(0);

  async function refresh(): Promise<void> {
    const refreshSequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshSequence;
    try {
      const response = await fetch("/api/setup/readiness", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Setup readiness is unavailable.");
      const parsed = setupReadinessSchema.parse(await response.json());
      if (refreshSequence !== refreshSequenceRef.current) return;
      setMessage(null);
      setReadiness(parsed);
      onReadinessChange(parsed);
    } catch (error) {
      if (refreshSequence !== refreshSequenceRef.current) return;
      throw error;
    }
  }

  function refreshWithMessage(): void {
    void refresh().catch(() => setMessage("Setup readiness is unavailable."));
  }

  useEffect(() => {
    refreshWithMessage();
    const onFocus = refreshWithMessage;
    const onStateChange = refreshWithMessage;
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshWithMessage();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(SETUP_READINESS_REFRESH_EVENT, onStateChange);
    return () => {
      refreshSequenceRef.current += 1;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(SETUP_READINESS_REFRESH_EVENT, onStateChange);
    };
  }, []);

  useEffect(() => {
    if (readiness === null) return;
    setSelectedVaultId((current) =>
      readiness.vaults.some((vault) => vault.id === current)
        ? current
        : (readiness.vaults.find((vault) => vault.nextStep !== "ready")?.id ??
          readiness.vaults[0]?.id ??
          ""),
    );
  }, [readiness]);

  const selectedVault =
    readiness?.vaults.find((vault) => vault.id === selectedVaultId) ?? null;
  const selectedStep =
    selectedVault?.nextStep ??
    (readiness !== null && readiness.activeVaultCount === 0
      ? "connect-vault"
      : null);

  useEffect(() => {
    if (
      selectedStep !== "sync-vault" &&
      selectedStep !== "build-library" &&
      selectedStep !== "create-or-select-project" &&
      selectedStep !== "approve-project" &&
      selectedStep !== "ready"
    ) {
      return;
    }
    const interval = window.setInterval(
      () => {
        if (document.visibilityState === "visible") {
          void refresh().catch(() =>
            setMessage("Setup readiness is unavailable."),
          );
        }
      },
      selectedStep === "ready" || selectedStep === "approve-project"
        ? 5_000
        : 2_000,
    );
    return () => window.clearInterval(interval);
  }, [selectedStep]);

  function primaryAction(): void {
    if (selectedStep === null) return;
    if (selectedStep === "connect-vault") {
      revealOperationalRegion("vaults");
      return;
    }
    if (selectedStep === "sync-vault") {
      revealOperationalRegion("vaults");
      return;
    }
    if (selectedStep === "build-library") {
      revealOperationalRegion("library");
      return;
    }
    if (selectedStep === "create-recovery-point") {
      revealOperationalRegion("agents");
      return;
    }
    if (selectedStep === "connect-agent") {
      revealOperationalRegion("agents");
      return;
    }
    if (
      selectedStep === "approve-project" &&
      selectedVault?.pendingProjectReviewUrl !== null &&
      selectedVault?.pendingProjectReviewUrl !== undefined
    ) {
      window.location.assign(selectedVault.pendingProjectReviewUrl);
    }
  }

  const completedMilestones = [
    {
      complete: selectedVault !== null,
      label: "Source credential created",
    },
    {
      complete: selectedVault?.syncConfirmed === true,
      label: "First sync confirmed",
    },
    {
      complete: selectedVault?.libraryReady === true,
      label: "Current searchable library",
    },
    {
      complete: selectedVault?.verifiedSnapshot === true,
      label: "Optional recovery point verified",
    },
    {
      complete: (selectedVault?.activeAgentCount ?? 0) > 0,
      label: "Agent access approved",
    },
    {
      complete: selectedVault?.preparedProjectHandoff != null,
      label: "First Project handoff prepared",
    },
    {
      complete: (selectedVault?.activeProjectCount ?? 0) > 0,
      label: "MDevolved Project selected",
    },
    {
      complete: (selectedVault?.activeProjectGrantCount ?? 0) > 0,
      label: "Project authorization active",
    },
  ].filter((milestone) => milestone.complete);
  const guidance = setupGuidance(
    selectedStep,
    selectedVault?.displayName ?? "This Source",
    selectedVault?.libraryState ?? null,
    selectedVault?.preparedProjectHandoff ?? null,
  );
  const pendingProjectRequests = selectedVault?.pendingProjectRequests ?? [];
  const guidanceActionLabel =
    selectedStep === "approve-project" && pendingProjectRequests.length > 1
      ? null
      : guidance.actionLabel;

  return (
    <section
      className="setup-panel setup-panel--active"
      aria-labelledby="setup-heading"
      id="setup"
    >
      <div className="section-heading">
        <div>
          <span className="section-kicker">Set up MDevolved</span>
          <h2 id="setup-heading">
            Connect a Markdown folder or Obsidian workspace, then let your
            existing AI agents collaborate without moving your work into
            MDevolved.
          </h2>
        </div>
        <span className="time-target">
          {selectedStep === "ready" ? "Project-ready" : "Do this next"}
        </span>
      </div>
      {readiness !== null && readiness.vaults.length > 0 ? (
        <label className="setup-vault-selector">
          <span>Set up this Source workspace</span>
          <select
            aria-label="Set up this Source workspace"
            value={selectedVaultId}
            onChange={(event) => {
              setSelectedVaultId(event.target.value);
              setMessage(null);
            }}
          >
            {readiness.vaults.map((vault) => (
              <option key={vault.id} value={vault.id}>
                {vault.displayName}
                {vault.nextStep === "ready" ? " · Project-ready" : ""}
              </option>
            ))}
          </select>
          <small>
            Each Source completes this journey independently. Progress from
            another Source never fills these steps.
          </small>
        </label>
      ) : null}
      <div className="setup-readiness setup-readiness--single-action">
        <article className="setup-next-action">
          <span>Next action</span>
          <strong>{guidance.title}</strong>
          <p>{guidance.description}</p>
          {selectedStep === "ready" ? (
            <div className="project-resume-cue" role="note">
              <strong>Returning after a crash or new session?</strong>
              <span>
                MDevolved should resume automatically. If it does not, say{" "}
                <q>MDevolved resume project</q>. MDevolved restores the exact
                Project and writer role from <code>.mdevolvedignore</code>—no
                reconnect, copied prompt, or new approval.
              </span>
            </div>
          ) : null}
          {selectedStep === "prepare-project-handoff" &&
          selectedVault !== null ? (
            <ProjectHandoffSetup
              buttonLabel="Prepare first Project"
              key={selectedVault.id}
              onPrepared={refresh}
              vaultId={selectedVault.id}
              vaultName={selectedVault.displayName}
            />
          ) : null}
          {selectedStep === "create-or-select-project" &&
          selectedVault?.preparedProjectHandoff !== null &&
          selectedVault?.preparedProjectHandoff !== undefined ? (
            <>
              <dl className="prepared-project-receipt">
                <div>
                  <dt>Agent</dt>
                  <dd>{selectedVault.preparedProjectHandoff.clientName}</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>{selectedVault.preparedProjectHandoff.projectLabel}</dd>
                </div>
                <div>
                  <dt>Folder</dt>
                  <dd>
                    {selectedVault.preparedProjectHandoff.folderBoundary ||
                      "Entire approved Source"}
                  </dd>
                </div>
                <div>
                  <dt>Say this</dt>
                  <dd>Connect this project to MDevolved</dd>
                </div>
              </dl>
              <details className="project-handoff-advanced">
                <summary>Change the prepared first Project</summary>
                <ProjectHandoffSetup
                  buttonLabel="Update first Project"
                  onPrepared={refresh}
                  vaultId={selectedVault.id}
                  vaultName={selectedVault.displayName}
                />
              </details>
            </>
          ) : null}
          {selectedStep === "approve-project" &&
          pendingProjectRequests.length > 1 ? (
            <div className="setup-pending-projects">
              <p>
                More than one agent is waiting. Choose the named Project and
                client you are currently using; MDevolved will not guess.
              </p>
              {pendingProjectRequests.map((request) => (
                <button
                  className="secondary-action"
                  key={`${request.reviewUrl}:${request.clientName}`}
                  type="button"
                  onClick={() => window.location.assign(request.reviewUrl)}
                >
                  Review {request.projectLabel}
                  <small>
                    {request.requestKind === "create" ? "Create" : "Connect"} ·{" "}
                    {request.clientName}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
          {guidanceActionLabel !== null ? (
            <button
              className="primary-action"
              disabled={selectedStep === null}
              type="button"
              onClick={primaryAction}
            >
              {guidanceActionLabel} <span aria-hidden="true">↗</span>
            </button>
          ) : null}
          {selectedStep === "ready" ? (
            <div className="setup-ready-actions">
              <button
                className="compact-action"
                type="button"
                onClick={() => revealOperationalRegion("agents")}
              >
                Start another Project
              </button>
              <button
                className="text-action setup-projects-action"
                type="button"
                onClick={() => revealOperationalRegion("collaboration")}
              >
                View Projects
              </button>
            </div>
          ) : null}
          {message !== null ? (
            <small className="setup-receipt" aria-live="polite">
              {message}
            </small>
          ) : null}
        </article>
        {selectedVault !== null ? (
          <details className="setup-progress-receipt">
            <summary>
              {completedMilestones.length} verified milestone
              {completedMilestones.length === 1 ? "" : "s"} · show details
            </summary>
            <ul>
              {completedMilestones.map((milestone) => (
                <li key={milestone.label}>{milestone.label}</li>
              ))}
            </ul>
            <p>
              Sync:{" "}
              {selectedVault.syncConfirmed
                ? `confirmed ${formatTimestamp(selectedVault.initialSyncAt)}`
                : "waiting for Obsidian"}
              {" · "}Library: {selectedVault.libraryState}
              {" · "}Last Source change:{" "}
              {formatTimestamp(selectedVault.lastSyncAt)}
            </p>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function initialWorkspaceSection(): WorkspaceSectionId {
  if (typeof window === "undefined") return "architecture";
  return workspaceSectionFromHash(window.location.hash);
}

type DeferredWorkspaceRegionProps = {
  heading: string;
  id: Extract<WorkspaceSectionId, "collaboration" | "recovery">;
  kicker: string;
  summary: string;
};

function DeferredWorkspaceRegion({
  heading,
  id,
  kicker,
  summary,
}: DeferredWorkspaceRegionProps) {
  return (
    <OperationalRegion
      autoOpen
      heading={heading}
      id={id}
      kicker={kicker}
      summary={summary}
    >
      <div
        aria-busy="true"
        aria-live="polite"
        className="workspace-section-loading"
        role="status"
      >
        <span aria-hidden="true" />
        <div>
          <strong>Opening {heading}…</strong>
          <p>The workspace is loading this folder’s private tools.</p>
        </div>
      </div>
    </OperationalRegion>
  );
}

function EmptyRecoveryRegion() {
  return (
    <OperationalRegion
      autoOpen
      heading="Backup and recovery"
      id="recovery"
      kicker="Owner-controlled recovery"
      summary="Connect a source first"
    >
      <section className="workspace-empty-folder">
        <span className="section-kicker">Nothing to protect yet</span>
        <h3>Connect a source before creating a recovery point.</h3>
        <p>
          Recovery is independent from onboarding, but MDevolved still needs one
          paired source before it can create or inspect a backup.
        </p>
        <button
          className="primary-action"
          type="button"
          onClick={() => revealOperationalRegion("vaults")}
        >
          Open Sources <span aria-hidden="true">↗</span>
        </button>
      </section>
    </OperationalRegion>
  );
}

function RouteLoading({ label }: { label: string }) {
  return (
    <main className="route-loading" aria-busy="true" aria-live="polite">
      <span aria-hidden="true" />
      <p>{label}</p>
    </main>
  );
}

function Dashboard() {
  const initialSection = initialWorkspaceSection();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });
  const [vaultState, setVaultState] = useState<VaultState>({ kind: "idle" });
  const [pairingGrant, setPairingGrant] = useState<PairingGrantResponse | null>(
    null,
  );
  const [pairingCopyState, setPairingCopyState] = useState<PairingCopyState>({
    kind: "idle",
  });
  const [pairingClock, setPairingClock] = useState(() =>
    Math.floor(Date.now() / 1_000),
  );
  const [autoOpenVaultRegion, setAutoOpenVaultRegion] = useState(false);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [libraryState, setLibraryState] = useState<LibraryState>({
    kind: "idle",
  });
  const [libraryHasOpened, setLibraryHasOpened] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });
  const [searchQuery, setSearchQuery] = useState("");
  const [noteState, setNoteState] = useState<NoteState>({ kind: "idle" });
  const [onboardingReadiness, setOnboardingReadiness] =
    useState<SetupReadiness | null>(null);
  const [activeWorkspaceSection, setActiveWorkspaceSection] =
    useState<WorkspaceSectionId>(initialSection);
  const [visitedWorkspaceSections, setVisitedWorkspaceSections] = useState<
    ReadonlySet<WorkspaceSectionId>
  >(() => new Set([initialSection]));
  const [pendingAgentAdvanceVaultId, setPendingAgentAdvanceVaultId] = useState<
    string | null
  >(null);
  const [ownerClaimToken] = useState(() => captureOwnerClaimToken());
  const pairingCardRef = useRef<HTMLElement>(null);
  const vaultRefreshControllerRef = useRef<AbortController | null>(null);
  const libraryRefreshControllerRef = useRef<AbortController | null>(null);
  const supportsPasskeys = browserSupportsWebAuthn();
  const noteLibraryOpened = useCallback((open: boolean) => {
    if (open) setLibraryHasOpened(true);
  }, []);
  const rememberWorkspaceSection = useCallback(
    (section: WorkspaceSectionId) => {
      setVisitedWorkspaceSections((current) => {
        if (current.has(section)) return current;
        return new Set([...current, section]);
      });
    },
    [],
  );
  const navigateWorkspace = useCallback(
    (section: WorkspaceSectionId) => {
      rememberWorkspaceSection(section);
      setActiveWorkspaceSection(section);
      const nextHash = `#${section}`;
      if (window.location.hash !== nextHash) {
        window.history.pushState(null, "", nextHash);
      }
      window.requestAnimationFrame(() => openOperationalRegion(section));
    },
    [rememberWorkspaceSection],
  );

  useEffect(() => {
    const useLocation = () => {
      const section = workspaceSectionFromHash(window.location.hash);
      rememberWorkspaceSection(section);
      setActiveWorkspaceSection(section);
    };
    const useOperationalRegion = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        !isWorkspaceSectionId(event.detail)
      ) {
        return;
      }
      rememberWorkspaceSection(event.detail);
      setActiveWorkspaceSection((current) => {
        if (current === event.detail) return current;
        const nextHash = `#${event.detail}`;
        if (window.location.hash !== nextHash) {
          window.history.pushState(null, "", nextHash);
        }
        return event.detail;
      });
    };

    window.addEventListener("hashchange", useLocation);
    window.addEventListener("popstate", useLocation);
    window.addEventListener(
      OPERATIONAL_REGION_OPEN_EVENT,
      useOperationalRegion,
    );
    return () => {
      window.removeEventListener("hashchange", useLocation);
      window.removeEventListener("popstate", useLocation);
      window.removeEventListener(
        OPERATIONAL_REGION_OPEN_EVENT,
        useOperationalRegion,
      );
    };
  }, [rememberWorkspaceSection]);

  useEffect(() => {
    window.requestAnimationFrame(() =>
      openOperationalRegion(activeWorkspaceSection),
    );
  }, [activeWorkspaceSection]);

  async function refreshSetup(signal?: AbortSignal): Promise<void> {
    setLoadState({ kind: "loading" });

    try {
      const requestSignal = signal ?? new AbortController().signal;
      const [setup, health] = await Promise.all([
        loadSetup(requestSignal),
        loadHealth(requestSignal),
      ]);
      setLoadState({
        health,
        kind: "ready",
        setup,
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState({ kind: "error" });
    }
  }

  async function refreshVaults(
    mode: VaultRefreshMode = "background",
  ): Promise<void> {
    vaultRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    vaultRefreshControllerRef.current = controller;
    setVaultState((current) => beginVaultRefresh(current, mode));

    try {
      const vaults = await loadVaultList(controller.signal);
      if (vaultRefreshControllerRef.current !== controller) return;
      if (mode === "initial") {
        setAutoOpenVaultRegion(
          !vaults.some((vault) => vault.status === "active"),
        );
      }
      setPairingGrant((current) =>
        current !== null &&
        vaults.some(
          (vault) => vault.id === current.vaultId && vault.status === "active",
        )
          ? null
          : current,
      );
      setVaultState(completeVaultRefresh(vaults));
      requestSetupReadinessRefresh();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (mode === "initial") setAutoOpenVaultRegion(true);
      const message =
        error instanceof Error ? error.message : "Sources could not be loaded.";
      setVaultState((current) => failVaultRefresh(current, message));
    } finally {
      if (vaultRefreshControllerRef.current === controller) {
        vaultRefreshControllerRef.current = null;
      }
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshSetup(controller.signal);
    return () => controller.abort();
  }, []);

  const setup = loadState.kind === "ready" ? loadState.setup : null;

  useEffect(() => {
    if (setup?.authenticated !== true) {
      setVaultState({ kind: "idle" });
      setAutoOpenVaultRegion(false);
      setPairingGrant(null);
      setSelectedVaultId("");
      setLibraryState({ kind: "idle" });
      setLibraryHasOpened(false);
      setSearchState({ kind: "idle" });
      setNoteState({ kind: "idle" });
      setOnboardingReadiness(null);
      setPendingAgentAdvanceVaultId(null);
      return;
    }

    void refreshVaults("initial");

    return () => {
      vaultRefreshControllerRef.current?.abort();
      vaultRefreshControllerRef.current = null;
    };
  }, [setup?.authenticated]);

  useEffect(() => {
    if (setup?.authenticated !== true) return;

    const warmWorkspaceFolders = () => {
      void Promise.allSettled([loadBackupPanel(), loadCollaborationPanel()]);
    };
    const idleWindow: {
      cancelIdleCallback?: Window["cancelIdleCallback"];
      requestIdleCallback?: Window["requestIdleCallback"];
    } = window;

    if (idleWindow.requestIdleCallback !== undefined) {
      const handle = idleWindow.requestIdleCallback(warmWorkspaceFolders, {
        timeout: 2_500,
      });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }

    const handle = window.setTimeout(warmWorkspaceFolders, 1_200);
    return () => window.clearTimeout(handle);
  }, [setup?.authenticated]);

  useEffect(() => {
    if (setup?.authenticated !== true || pairingGrant === null) return;
    const refreshAfterObsidian = () => {
      if (Math.floor(Date.now() / 1_000) < pairingGrant.expiresAt) {
        void refreshVaults();
      }
    };
    const pollingHandle = window.setInterval(refreshAfterObsidian, 3_000);
    const stopHandle = window.setTimeout(
      () => window.clearInterval(pollingHandle),
      Math.max(0, pairingGrant.expiresAt * 1_000 - Date.now()),
    );
    window.addEventListener("focus", refreshAfterObsidian);
    return () => {
      window.clearInterval(pollingHandle);
      window.clearTimeout(stopHandle);
      window.removeEventListener("focus", refreshAfterObsidian);
    };
  }, [pairingGrant, setup?.authenticated]);

  useEffect(() => {
    if (pairingGrant === null) return;
    setPairingClock(Math.floor(Date.now() / 1_000));
    const clockHandle = window.setInterval(
      () => setPairingClock(Math.floor(Date.now() / 1_000)),
      1_000,
    );
    return () => window.clearInterval(clockHandle);
  }, [pairingGrant]);

  useEffect(() => {
    if (vaultState.kind !== "ready") return;
    const activeVaults = vaultState.vaults.filter(
      (vault) => vault.status === "active",
    );
    setSelectedVaultId((current) =>
      activeVaults.some((vault) => vault.id === current)
        ? current
        : (activeVaults[0]?.id ?? ""),
    );
  }, [vaultState]);

  useEffect(() => {
    if (selectedVaultId === "") {
      libraryRefreshControllerRef.current?.abort();
      libraryRefreshControllerRef.current = null;
      setLibraryState({ kind: "idle" });
      return;
    }
    if (!libraryHasOpened) return;
    void refreshLibrary(selectedVaultId, "initial");
    return () => {
      libraryRefreshControllerRef.current?.abort();
      libraryRefreshControllerRef.current = null;
    };
  }, [libraryHasOpened, selectedVaultId]);

  useEffect(() => {
    if (
      pendingAgentAdvanceVaultId === null ||
      onboardingReadiness === null ||
      !onboardingReadiness.vaults.some(
        (vault) =>
          vault.id === pendingAgentAdvanceVaultId && vault.libraryReady,
      )
    ) {
      return;
    }
    setPendingAgentAdvanceVaultId(null);
    revealOperationalRegion("agents");
  }, [onboardingReadiness, pendingAgentAdvanceVaultId]);

  useEffect(() => {
    if (pairingGrant === null) return;

    window.requestAnimationFrame(() => {
      pairingCardRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      pairingCardRef.current?.focus({ preventScroll: true });
    });
  }, [pairingGrant]);

  async function claimOwner(): Promise<void> {
    setActionState({ kind: "working", label: "Waiting for your passkey…" });

    try {
      const csrfToken = await loadCsrf();
      const options = registrationOptionsSchema.parse(
        await requestJson(
          "/api/auth/register/options",
          csrfToken,
          setup?.claimMode === "invitation"
            ? { claimToken: ownerClaimToken }
            : undefined,
        ),
      );
      const credential = await startRegistration({ optionsJSON: options });
      authenticationResultSchema.parse(
        await requestJson("/api/auth/register/verify", csrfToken, credential),
      );
      clearOwnerClaimToken();
      setActionState({ kind: "idle" });
      await refreshSetup();
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The passkey could not be created.",
      });
    }
  }

  async function signIn(): Promise<void> {
    setActionState({ kind: "working", label: "Waiting for your passkey…" });

    try {
      const csrfToken = await loadCsrf();
      const options = authenticationOptionsSchema.parse(
        await requestJson("/api/auth/login/options", csrfToken),
      );
      const credential = await startAuthentication({ optionsJSON: options });
      authenticationResultSchema.parse(
        await requestJson("/api/auth/login/verify", csrfToken, credential),
      );
      setActionState({ kind: "idle" });
      await refreshSetup();
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The passkey could not be verified.",
      });
    }
  }

  async function addBackupPasskey(): Promise<void> {
    setActionState({
      kind: "working",
      label: "Waiting for your additional passkey…",
    });
    try {
      const csrfToken = await loadCsrf();
      const options = registrationOptionsSchema.parse(
        await requestJson("/api/auth/passkeys/register/options", csrfToken),
      );
      const credential = await startRegistration({ optionsJSON: options });
      await requestJson(
        "/api/auth/passkeys/register/verify",
        csrfToken,
        credential,
      );
      setActionState({
        kind: "success",
        message:
          "Additional passkey added. Test it from another device before relying on it for recovery.",
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The additional passkey could not be added.",
      });
    }
  }

  async function copyOwnerDiagnostics(): Promise<void> {
    setActionState({
      kind: "working",
      label: "Preparing redacted diagnostics…",
    });
    try {
      const diagnostics = ownerDiagnosticsResponseSchema.parse(
        await fetchApiJson("/api/diagnostics"),
      );
      const serialized = `${JSON.stringify(diagnostics, null, 2)}\n`;
      try {
        await navigator.clipboard.writeText(serialized);
        setActionState({
          kind: "success",
          message:
            "Redacted diagnostics copied. They contain IDs and state, but no names, note paths, content, credentials, or Project text.",
        });
      } catch {
        const url = URL.createObjectURL(
          new Blob([serialized], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.download = `owd-diagnostics-${diagnostics.generatedAt}.json`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        setActionState({
          kind: "success",
          message:
            "Clipboard access was blocked, so MDevolved downloaded the redacted diagnostics instead.",
        });
      }
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The redacted diagnostics could not be prepared.",
      });
    }
  }

  async function signOut(): Promise<void> {
    setActionState({ kind: "working", label: "Ending the owner session…" });

    try {
      const csrfToken = await loadCsrf();
      await requestJson("/api/auth/logout", csrfToken);
      setActionState({ kind: "idle" });
      await refreshSetup();
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Sign out could not finish.",
      });
    }
  }

  async function createPairingLink(): Promise<void> {
    setActionState({ kind: "working", label: "Creating a private link…" });

    try {
      const csrfToken = await loadCsrf();
      const grant = pairingGrantResponseSchema.parse(
        await requestJson("/api/pairing/grants", csrfToken),
      );
      setPairingGrant(grant);
      setPairingCopyState({ kind: "idle" });
      setActionState({
        kind: "success",
        message: "Pairing request ready. Open it from the panel below.",
      });
      await refreshVaults();
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The pairing link could not be created.",
      });
    }
  }

  async function copyPairingLink(): Promise<void> {
    if (pairingGrant === null) return;

    try {
      await navigator.clipboard.writeText(pairingGrant.pairingUrl);
      setPairingCopyState({ kind: "copied" });
    } catch {
      setPairingCopyState({
        kind: "error",
        message:
          "The browser blocked clipboard access. Allow clipboard access and copy the pairing link again.",
      });
    }
  }

  async function createReconnectLink(vault: VaultSummary): Promise<void> {
    setActionState({
      kind: "working",
      label: `Creating a reconnect request for ${vault.displayName ?? "this Source"}…`,
    });
    try {
      const csrfToken = await loadCsrf();
      const grant = pairingGrantResponseSchema.parse(
        await requestJson(
          `/api/vaults/${encodeURIComponent(vault.id)}/reconnect-grant`,
          csrfToken,
        ),
      );
      setPairingGrant(grant);
      setPairingCopyState({ kind: "idle" });
      setActionState({
        kind: "success",
        message:
          "Reconnect request ready. It preserves this Source identity and rotates the old credential only after the new sync is confirmed.",
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The Source reconnect request could not be created.",
      });
    }
  }

  async function createDeviceEnrollmentLink(
    vault: VaultSummary,
  ): Promise<void> {
    setActionState({
      kind: "working",
      label: `Approving another device for ${vault.displayName ?? "this source"}…`,
    });
    try {
      const csrfToken = await loadCsrf();
      const grant = pairingGrantResponseSchema.parse(
        await requestJson(
          `/api/vaults/${encodeURIComponent(vault.id)}/device-enrollment-grants`,
          csrfToken,
          {},
        ),
      );
      setPairingGrant(grant);
      setPairingCopyState({ kind: "idle" });
      setActionState({
        kind: "success",
        message:
          "A single-use device approval is ready. It preserves the existing source boundary and does not grant Project authority.",
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The source device approval could not be created.",
      });
    }
  }

  async function revokeSourceDeviceAccess(
    vault: VaultSummary,
    device: SourceDeviceSummary,
  ): Promise<void> {
    if (
      !window.confirm(
        `Revoke ${device.displayName}? Its sync credential will stop working immediately. Durable Project data is unchanged.`,
      )
    )
      return;
    setActionState({ kind: "working", label: "Revoking source device…" });
    try {
      const csrfToken = await loadCsrf();
      await requestJson(
        `/api/vaults/${encodeURIComponent(vault.id)}/devices/${encodeURIComponent(device.deviceId)}/revoke`,
        csrfToken,
      );
      await refreshVaults();
      setActionState({ kind: "idle" });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The device could not be revoked.",
      });
    }
  }

  async function revokeVaultAccess(vault: VaultSummary): Promise<void> {
    const vaultName = vault.displayName ?? "this pending Source";
    if (
      !window.confirm(
        `Revoke sync access for ${vaultName}? Any active connection will close immediately. Your stored vault data will not be deleted.`,
      )
    ) {
      return;
    }

    setActionState({ kind: "working", label: "Revoking Source access…" });

    try {
      const csrfToken = await loadCsrf();
      await requestJson(
        `/api/vaults/${encodeURIComponent(vault.id)}/revoke`,
        csrfToken,
      );
      if (pairingGrant?.vaultId === vault.id) setPairingGrant(null);
      await refreshVaults();
      setActionState({ kind: "idle" });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Source access could not be revoked.",
      });
    }
  }

  async function refreshLibrary(
    vaultId = selectedVaultId,
    mode: LibraryRefreshMode = "background",
    requireGeneration = false,
  ): Promise<boolean> {
    if (vaultId === "") return false;
    libraryRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    libraryRefreshControllerRef.current = controller;
    const previousGenerationId =
      libraryState.kind === "ready"
        ? libraryState.generation.generationId
        : null;
    setLibraryState((current) => beginLibraryRefresh(current, mode));

    try {
      const status = currentMaterializationResponseSchema.parse(
        await fetchApiJson(
          `/api/vaults/${encodeURIComponent(vaultId)}/materialization`,
          controller.signal,
        ),
      );
      if (libraryRefreshControllerRef.current !== controller) return false;
      if (status.generation === null) {
        setLibraryState(completeEmptyLibraryRefresh());
        setSearchState({ kind: "idle" });
        setNoteState({ kind: "idle" });
        return !requireGeneration;
      }
      const page = materializedNotesResponseSchema.parse(
        await postApiJson(
          `/api/vaults/${encodeURIComponent(vaultId)}/notes`,
          { cursor: null },
          controller.signal,
        ),
      );
      if (libraryRefreshControllerRef.current !== controller) return false;
      if (page.generation.generationId !== status.generation.generationId) {
        throw new Error(
          "The library changed while notes were loading. Refresh it.",
        );
      }
      setLibraryState(
        completeLibraryRefresh(page.generation, page.notes, page.nextCursor),
      );
      if (
        mode === "initial" ||
        previousGenerationId !== page.generation.generationId
      ) {
        setSearchState({ kind: "idle" });
        setNoteState({ kind: "idle" });
      }
      return true;
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError")
        return false;
      const message =
        error instanceof Error
          ? error.message
          : "The searchable library could not be loaded.";
      setLibraryState((current) => failLibraryRefresh(current, message));
      return false;
    } finally {
      if (libraryRefreshControllerRef.current === controller) {
        libraryRefreshControllerRef.current = null;
      }
    }
  }

  async function buildMaterialization(): Promise<void> {
    if (selectedVaultId === "") return;
    const vaultId = selectedVaultId;
    const selectedReadiness = onboardingReadiness?.vaults.find(
      (vault) => vault.id === vaultId,
    );
    const shouldAdvanceToAgents =
      selectedReadiness?.libraryReady === false ||
      libraryState.kind === "empty";
    setActionState({
      kind: "working",
      label: "Building an immutable searchable library…",
    });

    try {
      const csrfToken = await loadCsrf();
      let job = materializationJobSchema.parse(
        await requestJson(
          `/api/vaults/${encodeURIComponent(vaultId)}/materializations`,
          csrfToken,
        ),
      );
      for (
        let attempt = 0;
        attempt < 360 && (job.status === "queued" || job.status === "running");
        attempt += 1
      ) {
        setActionState({
          kind: "working",
          label: `Building searchable library · ${job.processedNoteCount.toLocaleString()} of ${job.totalNoteCount.toLocaleString()} notes…`,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        job = materializationJobSchema.parse(
          await fetchApiJson(
            `/api/vaults/${encodeURIComponent(vaultId)}/materializations/${encodeURIComponent(job.jobId)}`,
          ),
        );
      }
      if (job.status !== "completed") {
        throw new Error(
          job.status === "failed"
            ? `The searchable library build stopped safely (${job.failureCode ?? "unknown_error"}). The previous library is unchanged.`
            : "The searchable library is still building. Refresh its status in a moment.",
        );
      }
      const generation = materializationGenerationSchema.parse(job.generation);
      if (!(await refreshLibrary(vaultId, "background", true))) {
        throw new Error(
          "The library was published but could not be loaded. Refresh it before continuing.",
        );
      }
      if (shouldAdvanceToAgents) {
        setPendingAgentAdvanceVaultId(vaultId);
      }
      requestSetupReadinessRefresh();
      setActionState({
        kind: "success",
        message: `${generation.noteCount.toLocaleString()} notes published as one generation.`,
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof ApiRequestError
            ? `${error.message} (${error.code})`
            : error instanceof Error
              ? error.message
              : "The searchable library could not be built.",
      });
    }
  }

  async function loadMoreNotes(): Promise<void> {
    if (
      libraryState.kind !== "ready" ||
      libraryState.nextCursor === null ||
      selectedVaultId === ""
    ) {
      return;
    }
    try {
      const page = materializedNotesResponseSchema.parse(
        await postApiJson(
          `/api/vaults/${encodeURIComponent(selectedVaultId)}/notes`,
          { cursor: libraryState.nextCursor },
        ),
      );
      if (
        page.generation.generationId !== libraryState.generation.generationId
      ) {
        await refreshLibrary(selectedVaultId);
        return;
      }
      setLibraryState({
        ...libraryState,
        nextCursor: page.nextCursor,
        notes: [...libraryState.notes, ...page.notes],
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "More notes could not be loaded.",
      });
    }
  }

  async function searchNotes(): Promise<void> {
    if (selectedVaultId === "" || libraryState.kind !== "ready") return;
    if (searchQuery.trim() === "") {
      setSearchState({ kind: "idle" });
      return;
    }
    setSearchState({ kind: "loading" });
    setNoteState({ kind: "idle" });

    try {
      const result = materializedSearchResponseSchema.parse(
        await postApiJson(
          `/api/vaults/${encodeURIComponent(selectedVaultId)}/search`,
          { query: searchQuery },
        ),
      );
      if (
        result.generation.generationId !== libraryState.generation.generationId
      ) {
        await refreshLibrary(selectedVaultId);
        return;
      }
      setSearchState({
        generationId: result.generation.generationId,
        kind: "ready",
        results: result.results,
      });
    } catch (error: unknown) {
      setSearchState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Search could not finish.",
      });
    }
  }

  async function openNote(note: MaterializedNoteSummary): Promise<void> {
    if (selectedVaultId === "" || libraryState.kind !== "ready") return;
    if (
      hasUnsavedDraft(noteState) &&
      !window.confirm("Discard the unsaved Markdown draft?")
    ) {
      return;
    }
    const expectedGeneration = libraryState.generation.generationId;
    setNoteState({ kind: "loading", path: note.path });

    try {
      const response = await fetch(
        `/api/vaults/${encodeURIComponent(selectedVaultId)}/note`,
        {
          body: JSON.stringify({ path: note.path }),
          headers: {
            Accept: "text/markdown",
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json();
        const parsedError = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsedError.success
            ? parsedError.data.error.message
            : "The note could not be opened.",
        );
      }
      const generationId =
        response.headers.get("X-MDevolved-Generation") ??
        response.headers.get("X-OWD-Generation");
      if (generationId !== expectedGeneration) {
        await refreshLibrary(selectedVaultId);
        throw new Error("The library changed. Choose the note again.");
      }
      setNoteState({
        content: await response.text(),
        contentVersion: note.contentSha256,
        draft: "",
        generationId,
        kind: "ready",
        mode: "view",
        path: note.path,
      });
    } catch (error: unknown) {
      setNoteState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The note could not be opened.",
        path: note.path,
      });
    }
  }

  async function loadLiveNoteForEditing(force = false): Promise<void> {
    if (selectedVaultId === "" || noteState.kind !== "ready") return;
    if (
      !force &&
      hasUnsavedDraft(noteState) &&
      !window.confirm("Replace the unsaved draft with the current live note?")
    ) {
      return;
    }

    setActionState({ kind: "working", label: "Loading the live note…" });
    try {
      const live = liveMarkdownNoteSchema.parse(
        await postApiJson(
          `/api/vaults/${encodeURIComponent(selectedVaultId)}/live-note`,
          { path: noteState.path },
        ),
      );
      setNoteState({
        content: live.content,
        contentVersion: live.contentVersion,
        draft: live.content,
        generationId: null,
        kind: "ready",
        mode: "edit",
        path: live.path,
      });
      setActionState({ kind: "idle" });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The live note could not be loaded.",
      });
    }
  }

  function beginCreateNote(): void {
    if (libraryState.kind !== "ready") return;
    if (
      hasUnsavedDraft(noteState) &&
      !window.confirm("Discard the unsaved Markdown draft?")
    ) {
      return;
    }
    setNoteState({ draft: "", kind: "creating", path: "" });
    setActionState({ kind: "idle" });
  }

  function cancelEditing(): void {
    if (
      hasUnsavedDraft(noteState) &&
      !window.confirm("Discard the unsaved Markdown draft?")
    ) {
      return;
    }
    if (noteState.kind === "creating") {
      setNoteState({ kind: "idle" });
    } else if (noteState.kind === "ready") {
      setNoteState({
        ...noteState,
        draft: noteState.content,
        mode: "view",
      });
    }
  }

  async function saveLiveNote(): Promise<void> {
    if (
      selectedVaultId === "" ||
      (noteState.kind !== "creating" &&
        !(noteState.kind === "ready" && noteState.mode === "edit"))
    ) {
      return;
    }

    const preparedPath =
      noteState.kind === "creating"
        ? prepareMarkdownNotePath(noteState.path)
        : null;
    if (preparedPath !== null && !preparedPath.ok) {
      setActionState({ kind: "error", message: preparedPath.message });
      return;
    }

    const request = {
      content: noteState.draft,
      expectedVersion:
        noteState.kind === "creating" ? null : noteState.contentVersion,
      path: preparedPath?.path ?? noteState.path,
    };
    setActionState({
      kind: "working",
      label:
        noteState.kind === "creating"
          ? "Creating the live note…"
          : "Saving to the live Source…",
    });

    try {
      const csrfToken = await loadCsrf();
      const saved = markdownNoteWriteResponseSchema.parse(
        await requestJson(
          `/api/vaults/${encodeURIComponent(selectedVaultId)}/live-note`,
          csrfToken,
          request,
          "PUT",
        ),
      );
      setNoteState({
        content: saved.note.content,
        contentVersion: saved.note.contentVersion,
        draft: saved.note.content,
        generationId: null,
        kind: "ready",
        mode: "edit",
        path: saved.note.path,
      });
      setActionState({
        kind: "success",
        message:
          "Saved durably to the live Source. Browse and search will move to a new snapshot in the background.",
      });
    } catch (error: unknown) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The live note could not be saved.",
      });
    }
  }

  const vaults = vaultState.kind === "ready" ? vaultState.vaults : [];
  const { connected: connectedVaults, disconnected: disconnectedVaults } =
    partitionVaults(vaults);
  const activeVaults = connectedVaults.filter(
    (vault) => vault.status === "active",
  );
  const visibleNotes =
    searchState.kind === "ready"
      ? searchState.results
      : libraryState.kind === "ready"
        ? libraryState.notes
        : [];
  const isWorking = actionState.kind === "working";
  const pairingExpired =
    pairingGrant !== null && pairingClock >= pairingGrant.expiresAt;
  const editorActive =
    noteState.kind === "creating" ||
    (noteState.kind === "ready" && noteState.mode === "edit");
  const selectedVault = activeVaults.find(
    (vault) => vault.id === selectedVaultId,
  );
  const selectedVaultReadiness =
    onboardingReadiness?.vaults.find((vault) => vault.id === selectedVaultId) ??
    null;
  const vaultSummary =
    vaultState.kind === "loading"
      ? "Checking Source connections…"
      : vaultState.kind === "error"
        ? "Source connections need attention"
        : vaultState.kind === "ready"
          ? `${activeVaults.length.toLocaleString()} active · ${(
              connectedVaults.length - activeVaults.length
            ).toLocaleString()} pending · ${disconnectedVaults.length.toLocaleString()} disconnected`
          : "Source connections not loaded";
  const librarySummary = !libraryHasOpened
    ? "Selected Source · open to load"
    : libraryState.kind === "ready"
      ? `${libraryState.generation.noteCount.toLocaleString()} notes · checked ${formatTimestamp(libraryState.generation.completedAt)}${
          libraryState.refreshing ? " · refreshing" : ""
        }`
      : libraryState.kind === "empty"
        ? "No checked library generation"
        : libraryState.kind === "error"
          ? "Selected library needs attention"
          : libraryState.kind === "loading"
            ? "Loading the selected library…"
            : "Selected library not loaded";
  const createPathPreparation =
    noteState.kind === "creating"
      ? prepareMarkdownNotePath(noteState.path)
      : null;
  const apiState =
    loadState.kind === "ready"
      ? loadState.setup.authenticated
        ? "Owner authenticated"
        : "Worker connected"
      : loadState.kind === "error"
        ? "Worker unavailable"
        : "Checking Worker";
  const managedPilot = setup?.claimMode === "invitation";
  const deploymentLabel = managedPilot ? "Managed pilot" : "Community";
  const managedClaimReady =
    managedPilot && ownerClaimToken !== null && setup?.claimAvailable === true;
  const agentSetupPrerequisite: AgentSetupPrerequisite =
    onboardingReadiness === null
      ? "checking"
      : onboardingReadiness.activeVaultCount === 0
        ? "vault-required"
        : !onboardingReadiness.vaults.some((vault) => vault.libraryReady)
          ? "library-required"
          : "ready";
  const setupSummary =
    onboardingReadiness === null
      ? "Checking your next action…"
      : onboardingReadiness.activeVaultCount === 0
        ? "Connect your first source"
        : onboardingReadiness.vaults.every(
              (vault) => vault.nextStep === "ready",
            )
          ? "Project-ready"
          : "One next action";
  const onboardingComplete =
    onboardingReadiness !== null &&
    onboardingReadiness.activeVaultCount > 0 &&
    onboardingReadiness.vaults.every((vault) => vault.nextStep === "ready");
  const workspaceSummaries: Partial<Record<WorkspaceSectionId, string>> = {
    agents:
      agentSetupPrerequisite === "ready"
        ? "Ready for MCP clients"
        : agentSetupPrerequisite === "library-required"
          ? "Waiting for the library"
          : agentSetupPrerequisite === "vault-required"
            ? "Pair a Source first"
            : "Checking access…",
    architecture: setupSummary,
    collaboration: "Projects and owner decisions",
    health: apiState,
    library: librarySummary,
    recovery: vaults.some((vault) => vault.status !== "pending")
      ? "Backups and recovery"
      : "Pair a Source first",
    vaults: vaultSummary,
  };

  return (
    <div
      className={`app-shell${
        setup?.authenticated === true ? " app-shell--workspace" : ""
      }`}
    >
      <header className="topbar">
        <a className="brand" href="/" aria-label="MDevolved home">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>MDevolved</span>
        </a>
        <div className="environment" aria-label={apiState}>
          <span
            className={`pulse pulse--${loadState.kind}`}
            aria-hidden="true"
          />
          <span className="environment-label">{apiState}</span>
          {loadState.kind === "ready" ? (
            <span className="build-version">
              {deploymentLabel} {loadState.health.version} ·{" "}
              {(
                loadState.health.releaseTag ?? loadState.health.releaseId
              ).slice(0, 12)}
            </span>
          ) : null}
        </div>
      </header>

      <main
        className={setup?.authenticated === true ? "workspace-main" : undefined}
        data-active-section={
          setup?.authenticated === true ? activeWorkspaceSection : undefined
        }
      >
        {setup?.authenticated !== true ? (
          <section className="hero">
            <div className="eyebrow">
              {managedPilot
                ? "Private founding pilot · isolated workspace"
                : "Your Project memory. Your infrastructure."}
            </div>
            <h1>
              {managedPilot && setup?.claimed === false ? (
                <>Your MDevolved workspace is ready.</>
              ) : (
                <>
                  Durable Project memory for
                  <br />
                  every AI and Source.
                </>
              )}
            </h1>
            <p className="hero-copy">
              {managedPilot && setup?.claimed === false
                ? `Create one passkey, then connect your first Markdown folder or Obsidian workspace. This private trial starts when you claim it and includes two active Sources with no agent-seat limit.`
                : "Sync a Markdown folder or Obsidian workspace, give agents bounded Project memory, and keep encrypted recovery under your control."}
            </p>
            {managedPilot && setup?.claimed === false ? (
              <div className="managed-claim-disclosure" role="note">
                <strong>Before you start</strong>
                <span>
                  MDevolved Sync reads only the Sources you explicitly pair.
                  Agents get only the access you approve. During this managed
                  technical pilot, the operator can technically access live
                  service data through Cloudflare administration, but MDevolved
                  has no routine content-access or owner-impersonation tool.
                  Usage limits apply during the {setup.trialDays ?? 30}-day
                  pilot.
                </span>
              </div>
            ) : null}
            {managedPilot && setup?.trialExpired ? (
              <div className="managed-claim-disclosure" role="alert">
                <strong>Managed trial ended</strong>
                <span>
                  Sign-in, inspection, and read-only export remain available.
                  New sync, Project, and authorization changes are paused for
                  this workspace.
                </span>
              </div>
            ) : null}
            <div className="hero-actions">
              <button
                className="primary-action"
                type="button"
                disabled={
                  setup === null ||
                  isWorking ||
                  !supportsPasskeys ||
                  (managedPilot &&
                    setup.claimed === false &&
                    !managedClaimReady)
                }
                onClick={() =>
                  void (setup?.claimed === true ? signIn() : claimOwner())
                }
              >
                {setup?.claimed === true
                  ? "Sign in with a passkey"
                  : managedPilot
                    ? "Start my workspace"
                    : "Claim with a passkey"}
                <span aria-hidden="true">↗</span>
              </button>
              <span className="availability" aria-live="polite">
                {actionState.kind === "working"
                  ? actionState.label
                  : actionState.kind === "success"
                    ? actionState.message
                    : managedPilot && ownerClaimToken === null
                      ? "Open the complete private invitation link"
                      : managedPilot && setup?.claimAvailable === false
                        ? "This invitation is unavailable or expired"
                        : supportsPasskeys
                          ? "No password or copied secret required"
                          : "This browser does not support passkeys"}
              </span>
            </div>
            {actionState.kind === "error" ? (
              <p className="action-error" role="alert">
                {actionState.message}
              </p>
            ) : null}
            {setup?.claimed === false ? (
              <p className="claim-note">
                {managedPilot
                  ? "Your passkey binds to this permanent workspace hostname. The private link is removed from the address bar before setup begins."
                  : "Passkeys bind to this hostname. Claim from the permanent workers.dev or custom-domain URL, not a temporary preview URL."}
              </p>
            ) : null}
          </section>
        ) : null}

        {setup?.authenticated === true ? (
          <WorkspaceNavigation
            active={activeWorkspaceSection}
            deploymentLabel={deploymentLabel}
            onNavigate={navigateWorkspace}
            onSignOut={() => {
              navigateWorkspace("architecture");
              void signOut();
            }}
            summaries={workspaceSummaries}
          />
        ) : null}

        {setup?.authenticated === true ? (
          <header className="workspace-start-intro">
            <span className="section-kicker">
              {onboardingComplete ? "Workspace guide" : "Start here"}
            </span>
            <h1>
              {onboardingComplete
                ? "How MDevolved works."
                : "Set up your workspace."}
            </h1>
            <p>
              {onboardingComplete
                ? "Your onboarding checks are complete. Keep the verified setup receipt here, then use the advanced architecture below whenever you want the deeper model."
                : "MDevolved shows one verified next action. Finish it, then return here until the selected source is Project-ready."}
            </p>
          </header>
        ) : null}

        {setup?.authenticated === true ? (
          <StateAwareSetup onReadinessChange={setOnboardingReadiness} />
        ) : null}

        {setup?.authenticated === true ? (
          <aside className="workspace-start-pointer">
            <span className="section-kicker">
              {onboardingComplete ? "Advanced guide" : "After setup"}
            </span>
            <p>
              {onboardingComplete
                ? "You are Project-ready. The deeper architecture and trust model are now available immediately below your setup receipt."
                : "Everything else lives in the folders at left: manage Sources, review Projects, connect agents, browse notes, or open recovery tools only when you need them."}
            </p>
          </aside>
        ) : null}

        {setup?.authenticated === true ? (
          <OperationalRegion
            attention={
              vaultState.kind === "error" ||
              (vaultState.kind === "ready" && vaultState.refreshError !== null)
                ? "error"
                : "none"
            }
            autoOpen={pairingGrant !== null || autoOpenVaultRegion}
            heading="Source connections"
            id="vaults"
            kicker="Folders or Obsidian"
            summary={vaultSummary}
          >
            <section className="vault-panel" aria-labelledby="vault-heading">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">Connected workspaces</span>
                  <h2 id="vault-heading">Your Sources.</h2>
                </div>
                <button
                  className="text-action"
                  type="button"
                  disabled={
                    vaultState.kind === "loading" ||
                    (vaultState.kind === "ready" && vaultState.refreshing)
                  }
                  onClick={() => void refreshVaults()}
                >
                  {vaultState.kind === "ready" && vaultState.refreshing
                    ? "Refreshing…"
                    : "Refresh status"}
                </button>
              </div>

              <PluginSetupGuide />

              {pairingGrant === null ? (
                <aside
                  className="pairing-ready-card"
                  aria-labelledby="pairing-ready-heading"
                >
                  <div>
                    <span className="pairing-label">
                      Install and enable first
                    </span>
                    <h3 id="pairing-ready-heading">
                      Ready with the exact Source you want to pair?
                    </h3>
                    <p>
                      Choose a Markdown folder in MDevolved Sync, or open an
                      Obsidian workspace and confirm MDevolved Sync for Obsidian{" "}
                      {MDEVOLVED_SYNC_REQUIRED_VERSION} is enabled. Then create
                      the private, ten-minute pairing request.
                    </p>
                    <p className="pairing-install-note">
                      Obsidian keeps one plugin installation per vault. If this
                      vault shows an older version,{" "}
                      <a href="#mdevolved-sync-installer">
                        install or update the Obsidian adapter{" "}
                        {MDEVOLVED_SYNC_REQUIRED_VERSION}
                      </a>{" "}
                      here before continuing.
                    </p>
                  </div>
                  <button
                    className="primary-action"
                    type="button"
                    disabled={isWorking}
                    onClick={() => void createPairingLink()}
                  >
                    My folder app or Obsidian adapter is ready — create request
                  </button>
                </aside>
              ) : null}

              {pairingGrant !== null ? (
                <aside
                  className="pairing-card"
                  aria-labelledby="pairing-heading"
                  ref={pairingCardRef}
                  tabIndex={-1}
                >
                  <div>
                    <span className="pairing-label">Private · single use</span>
                    <h3 id="pairing-heading">Pair the selected Source</h3>
                    <p>
                      MDevolved Sync will show the exact current folder or
                      workspace before anything changes. This request expires{" "}
                      {formatTimestamp(pairingGrant.expiresAt)}.
                    </p>
                    <ol className="pairing-steps">
                      <li>
                        Open the exact folder or Obsidian workspace you want to
                        pair in its MDevolved Sync adapter.
                      </li>
                      <li>
                        Click below. Verify the current Source name and
                        workspace, then choose{" "}
                        <strong>Pair and start sync</strong>.
                      </li>
                    </ol>
                    <p className="pairing-install-note">
                      The link never chooses a Source silently. MDevolved
                      refreshes this page automatically after the one-time
                      exchange.
                    </p>
                  </div>
                  <div className="pairing-launch-controls">
                    {pairingExpired ? (
                      <button
                        className="primary-action"
                        disabled={isWorking}
                        type="button"
                        onClick={() => void createPairingLink()}
                      >
                        Create a fresh pairing request
                      </button>
                    ) : (
                      <>
                        <a
                          className="primary-action"
                          href={pairingGrant.pairingUrl.replace(
                            /^owd-pair:/u,
                            "mdevolved:",
                          )}
                        >
                          Open MDevolved Sync <span aria-hidden="true">↗</span>
                        </a>
                        <a href={pairingGrant.obsidianUrl}>
                          Or open Obsidian and pair
                        </a>
                      </>
                    )}
                    {pairingExpired ? (
                      <p className="action-error" role="status">
                        This request expired without changing any Source. Create
                        a fresh request; MDevolved has stopped polling it.
                      </p>
                    ) : null}
                    <details>
                      <summary>Manual fallback</summary>
                      <p>
                        If Obsidian says{" "}
                        <strong>unrecognized URI action</strong>, MDevolved Sync
                        for Obsidian is not loaded at version{" "}
                        {MDEVOLVED_SYNC_REQUIRED_VERSION} in the vault Obsidian
                        opened. Install or update and enable MDevolved Sync for
                        Obsidian there, then reopen this request. If the direct
                        handoff is still blocked, copy the request, run{" "}
                        <strong>
                          MDevolved Sync: Pair this vault with MDevolved
                        </strong>
                        , and paste it. This request remains usable until its
                        expiry above.
                      </p>
                      <PairingCopyControl
                        state={pairingCopyState}
                        onCopy={() =>
                          pairingExpired
                            ? void createPairingLink()
                            : void copyPairingLink()
                        }
                      />
                    </details>
                  </div>
                </aside>
              ) : null}

              {vaultState.kind === "loading" ? (
                <p className="vault-message" aria-live="polite">
                  Loading Sources…
                </p>
              ) : vaultState.kind === "error" ? (
                <p className="action-error" role="alert">
                  {vaultState.message}
                </p>
              ) : vaultState.kind === "ready" ? (
                <>
                  {connectedVaults.length === 0 ? (
                    <div className="empty-vaults">
                      <h3>No active or pending Sources.</h3>
                      <p>
                        Create a private pairing link when you are ready.
                        Disconnected records remain available below as retained
                        history.
                      </p>
                    </div>
                  ) : (
                    <div className="vault-list">
                      {connectedVaults.map((vault) => (
                        <VaultRow
                          isWorking={isWorking}
                          key={vault.id}
                          vault={vault}
                          onEnrollDevice={createDeviceEnrollmentLink}
                          onReconnect={createReconnectLink}
                          onRevokeDevice={revokeSourceDeviceAccess}
                          onRevoke={revokeVaultAccess}
                        />
                      ))}
                    </div>
                  )}

                  {disconnectedVaults.length > 0 ? (
                    <details className="disconnected-vaults">
                      <summary>
                        <strong>Disconnected history</strong>
                        <span>
                          {disconnectedHistoryLabel(disconnectedVaults.length)}
                        </span>
                      </summary>
                      <p>
                        Revocation permanently blocks the old sync credentials.
                        These records remain only for recovery references and
                        the redacted audit trail; hiding them is not deletion.
                      </p>
                      <div className="vault-list">
                        {disconnectedVaults.map((vault) => (
                          <VaultRow
                            isWorking={isWorking}
                            key={vault.id}
                            vault={vault}
                            onRevoke={revokeVaultAccess}
                          />
                        ))}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}
              {vaultState.kind === "ready" &&
              vaultState.refreshError !== null ? (
                <p className="action-error" role="alert">
                  {vaultState.refreshError}
                </p>
              ) : null}
            </section>
          </OperationalRegion>
        ) : null}

        {setup?.authenticated === true && activeVaults.length > 0 ? (
          <OperationalRegion
            attention={libraryState.kind === "error" ? "error" : "none"}
            heading="Note library"
            id="library"
            kicker="Private browse and edit"
            lazy
            onOpenChange={noteLibraryOpened}
            summary={librarySummary}
          >
            <section
              className="library-panel"
              aria-labelledby="library-heading"
            >
              <div className="section-heading library-heading">
                <div>
                  <span className="section-kicker">Private note library</span>
                  <h2 id="library-heading">Browse the current library.</h2>
                </div>
                <div className="library-controls">
                  <label>
                    <span>Active Source</span>
                    <select
                      disabled={editorActive}
                      value={selectedVaultId}
                      onChange={(event) =>
                        setSelectedVaultId(event.target.value)
                      }
                    >
                      {activeVaults.map((vault) => (
                        <option value={vault.id} key={vault.id}>
                          {vault.displayName ?? vault.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary-action library-build"
                    type="button"
                    disabled={
                      isWorking || selectedVaultId === "" || editorActive
                    }
                    onClick={() => void buildMaterialization()}
                  >
                    {libraryState.kind === "ready" && libraryState.refreshing
                      ? "Refreshing library…"
                      : libraryState.kind === "ready"
                        ? "Refresh now"
                        : "Build now"}
                  </button>
                  <button
                    className="secondary-action library-new"
                    type="button"
                    disabled={
                      isWorking ||
                      selectedVaultId === "" ||
                      libraryState.kind !== "ready"
                    }
                    onClick={beginCreateNote}
                  >
                    New note
                  </button>
                </div>
                {actionState.kind === "working" ? (
                  <p className="availability" role="status">
                    {actionState.label}
                  </p>
                ) : actionState.kind === "success" ? (
                  <p className="availability" role="status">
                    {actionState.message}
                  </p>
                ) : actionState.kind === "error" ? (
                  <p className="action-error" role="alert">
                    {actionState.message}
                  </p>
                ) : null}
              </div>

              {libraryState.kind === "ready" &&
              selectedVaultReadiness !== null &&
              !selectedVaultReadiness.libraryReady ? (
                <div className="client-warning" role="alert">
                  <strong>
                    This displayed generation is retained history.
                  </strong>
                  <span>
                    The Source has newer or incomplete sync state, so agents and
                    Projects cannot use this generation.{" "}
                    {selectedVaultReadiness.libraryState === "building"
                      ? "Wait for the current library build to finish."
                      : selectedVaultReadiness.libraryState === "failed"
                        ? "The automatic build stopped safely. Select Build now to retry, then copy redacted diagnostics if it fails again."
                        : "MDevolved rebuilds automatically after sync settles. Keep the Source client open; Build now is only an immediate retry."}
                  </span>
                </div>
              ) : null}

              {libraryState.kind === "loading" ? (
                <p className="vault-message" aria-live="polite">
                  Loading the current generation…
                </p>
              ) : libraryState.kind === "error" ? (
                <p className="action-error" role="alert">
                  {libraryState.message}
                </p>
              ) : libraryState.kind === "empty" ? (
                <div className="empty-vaults library-empty">
                  <h3>No searchable library yet.</h3>
                  <p>
                    MDevolved builds one automatically from the Source’s durable
                    sync state. It becomes visible only after every note and
                    search row succeeds.
                  </p>
                </div>
              ) : libraryState.kind === "ready" ? (
                <>
                  <div className="generation-strip">
                    <span>
                      Generation{" "}
                      {libraryState.generation.generationId.slice(0, 8)}
                    </span>
                    <span>
                      {libraryState.generation.noteCount.toLocaleString()} notes
                      · {formatTimestamp(libraryState.generation.completedAt)}
                    </span>
                  </div>
                  <form
                    className="search-form"
                    role="search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void searchNotes();
                    }}
                  >
                    <label htmlFor="vault-search">Search this generation</label>
                    <div>
                      <input
                        disabled={editorActive}
                        id="vault-search"
                        maxLength={200}
                        placeholder="Words in titles, paths, or notes"
                        type="search"
                        value={searchQuery}
                        onChange={(event) => {
                          setSearchQuery(event.target.value);
                          if (event.target.value === "") {
                            setSearchState({ kind: "idle" });
                          }
                        }}
                      />
                      <button
                        className="secondary-action"
                        type="submit"
                        disabled={
                          searchState.kind === "loading" || editorActive
                        }
                      >
                        {searchState.kind === "loading"
                          ? "Searching…"
                          : "Search"}
                      </button>
                    </div>
                  </form>
                  {searchState.kind === "error" ? (
                    <p className="action-error" role="alert">
                      {searchState.message}
                    </p>
                  ) : null}

                  <div className="library-grid">
                    <div className="note-browser" aria-label="Library notes">
                      <div className="note-browser-heading">
                        <span>
                          {searchState.kind === "ready"
                            ? `${searchState.results.length} search results`
                            : "Notes"}
                        </span>
                        {searchState.kind === "ready" ? (
                          <button
                            className="text-action"
                            type="button"
                            onClick={() => {
                              setSearchQuery("");
                              setSearchState({ kind: "idle" });
                            }}
                          >
                            Clear search
                          </button>
                        ) : null}
                      </div>
                      {visibleNotes.length === 0 ? (
                        <p className="note-list-empty">
                          {searchState.kind === "ready"
                            ? "No notes match those words."
                            : "This generation contains no Markdown notes."}
                        </p>
                      ) : (
                        <div className="note-list">
                          {visibleNotes.map((note) => (
                            <button
                              className={`note-list-item${
                                noteState.kind !== "idle" &&
                                noteState.path === note.path
                                  ? " note-list-item--selected"
                                  : ""
                              }`}
                              type="button"
                              key={note.path}
                              onClick={() => void openNote(note)}
                            >
                              <strong>{note.title}</strong>
                              <span>{note.path}</span>
                              {"snippet" in note &&
                              typeof note.snippet === "string" &&
                              note.snippet !== "" ? (
                                <small>{note.snippet}</small>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      )}
                      {searchState.kind !== "ready" &&
                      libraryState.nextCursor !== null ? (
                        <button
                          className="text-action load-more"
                          type="button"
                          onClick={() => void loadMoreNotes()}
                        >
                          Load more notes
                        </button>
                      ) : null}
                    </div>

                    <article className="note-reader" aria-live="polite">
                      {noteState.kind === "idle" ? (
                        <div className="note-reader-empty">
                          <span>Markdown source</span>
                          <h3>Choose a note or create one.</h3>
                          <p>
                            HTML and links remain inert in this safety-first
                            source view.
                          </p>
                        </div>
                      ) : noteState.kind === "loading" ? (
                        <p className="note-reader-message">
                          Opening {noteState.path}…
                        </p>
                      ) : noteState.kind === "error" ? (
                        <div className="note-reader-empty">
                          <h3>{noteState.path}</h3>
                          <p role="alert">{noteState.message}</p>
                        </div>
                      ) : noteState.kind === "creating" ? (
                        <>
                          <header>
                            <h3>Create a Markdown note</h3>
                            <span>Live Source</span>
                          </header>
                          <form
                            className="note-editor"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void saveLiveNote();
                            }}
                          >
                            <p className="write-target">
                              Writing only to{" "}
                              <strong>
                                {selectedVault?.displayName ?? selectedVaultId}
                              </strong>
                            </p>
                            <label>
                              <span>Note name or location</span>
                              <input
                                aria-describedby="create-note-path-feedback"
                                aria-invalid={
                                  noteState.path !== "" &&
                                  createPathPreparation?.ok === false
                                }
                                autoFocus
                                maxLength={1_024}
                                placeholder="Project ideas or Projects/Project ideas"
                                value={noteState.path}
                                onChange={(event) => {
                                  setActionState({ kind: "idle" });
                                  setNoteState({
                                    ...noteState,
                                    path: event.target.value,
                                  });
                                }}
                              />
                            </label>
                            <p
                              className={`note-path-feedback${
                                createPathPreparation?.ok === false &&
                                noteState.path !== ""
                                  ? " note-path-feedback--error"
                                  : ""
                              }`}
                              id="create-note-path-feedback"
                              aria-live="polite"
                            >
                              {noteState.path === ""
                                ? "Choose a name. MDevolved adds .md automatically. Use / to place it in a folder."
                                : createPathPreparation?.ok === true
                                  ? "Will create: "
                                  : createPathPreparation?.message}
                              {noteState.path !== "" &&
                              createPathPreparation?.ok === true ? (
                                <code>{createPathPreparation.path}</code>
                              ) : null}
                            </p>
                            <label className="markdown-field">
                              <span>Markdown source</span>
                              <textarea
                                maxLength={MAX_MARKDOWN_NOTE_CHARACTERS}
                                spellCheck="true"
                                value={noteState.draft}
                                onChange={(event) =>
                                  setNoteState({
                                    ...noteState,
                                    draft: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <div className="editor-footer">
                              <span>
                                {noteState.draft.length.toLocaleString()}{" "}
                                characters
                              </span>
                              <div>
                                <button
                                  className="text-action"
                                  type="button"
                                  disabled={isWorking}
                                  onClick={cancelEditing}
                                >
                                  Cancel
                                </button>
                                <button
                                  className="primary-action"
                                  type="submit"
                                  disabled={
                                    isWorking ||
                                    createPathPreparation?.ok !== true
                                  }
                                >
                                  Create live note
                                </button>
                              </div>
                            </div>
                            {actionState.kind === "error" ? (
                              <p className="editor-status editor-status--error">
                                {actionState.message}
                              </p>
                            ) : null}
                          </form>
                        </>
                      ) : (
                        <>
                          <header>
                            <h3>{noteState.path}</h3>
                            <div className="note-reader-actions">
                              <span>
                                {noteState.generationId === null
                                  ? "Live Source"
                                  : "Generation " +
                                    noteState.generationId.slice(0, 8)}
                              </span>
                              {noteState.mode === "view" ? (
                                <button
                                  className="text-action"
                                  type="button"
                                  disabled={isWorking}
                                  onClick={() =>
                                    void loadLiveNoteForEditing(true)
                                  }
                                >
                                  Edit live note
                                </button>
                              ) : null}
                            </div>
                          </header>
                          {noteState.mode === "view" ? (
                            <pre>{noteState.content}</pre>
                          ) : (
                            <form
                              className="note-editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveLiveNote();
                              }}
                            >
                              <p className="write-target">
                                Writing only to{" "}
                                <strong>
                                  {selectedVault?.displayName ??
                                    selectedVaultId}
                                </strong>
                                . Path and Source cannot change in this editor.
                              </p>
                              <label className="markdown-field">
                                <span>Markdown source</span>
                                <textarea
                                  autoFocus
                                  maxLength={MAX_MARKDOWN_NOTE_CHARACTERS}
                                  spellCheck="true"
                                  value={noteState.draft}
                                  onChange={(event) =>
                                    setNoteState({
                                      ...noteState,
                                      draft: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <div className="editor-footer">
                                <span>
                                  {noteState.draft.length.toLocaleString()}{" "}
                                  characters · expected version{" "}
                                  {noteState.contentVersion.slice(0, 8)}
                                </span>
                                <div>
                                  <button
                                    className="text-action"
                                    type="button"
                                    disabled={isWorking}
                                    onClick={() =>
                                      void loadLiveNoteForEditing()
                                    }
                                  >
                                    Reload live
                                  </button>
                                  <button
                                    className="text-action"
                                    type="button"
                                    disabled={isWorking}
                                    onClick={cancelEditing}
                                  >
                                    Close editor
                                  </button>
                                  <button
                                    className="primary-action"
                                    type="submit"
                                    disabled={
                                      isWorking ||
                                      noteState.draft === noteState.content
                                    }
                                  >
                                    Save live note
                                  </button>
                                </div>
                              </div>
                              {actionState.kind === "success" ? (
                                <p className="editor-status">
                                  {actionState.message}
                                </p>
                              ) : actionState.kind === "error" ? (
                                <p className="editor-status editor-status--error">
                                  {actionState.message}
                                </p>
                              ) : null}
                            </form>
                          )}
                        </>
                      )}
                    </article>
                  </div>
                </>
              ) : null}
              {(libraryState.kind === "ready" ||
                libraryState.kind === "empty") &&
              libraryState.refreshError !== null ? (
                <p className="action-error" role="alert">
                  {libraryState.refreshError}
                </p>
              ) : null}
            </section>
          </OperationalRegion>
        ) : null}

        {setup?.authenticated === true ? (
          <AgentConnectionsPanel
            prerequisite={agentSetupPrerequisite}
            readiness={onboardingReadiness}
          />
        ) : null}

        {setup?.authenticated === true &&
        visitedWorkspaceSections.has("recovery") ? (
          vaults.some((vault) => vault.status !== "pending") ? (
            <Suspense
              fallback={
                <DeferredWorkspaceRegion
                  heading="Backup and recovery"
                  id="recovery"
                  kicker="Owner-controlled recovery"
                  summary="Opening private recovery tools…"
                />
              }
            >
              <BackupPanel
                activeVaults={activeVaults}
                autoOpen={activeWorkspaceSection === "recovery"}
                initialVaultId={selectedVaultId}
                onRestoreApplied={async (vaultId) => {
                  if (vaultId === selectedVaultId) {
                    await refreshLibrary(vaultId);
                  }
                }}
                vaults={vaults}
              />
            </Suspense>
          ) : (
            <EmptyRecoveryRegion />
          )
        ) : null}

        {setup?.authenticated === true &&
        visitedWorkspaceSections.has("collaboration") ? (
          <Suspense
            fallback={
              <DeferredWorkspaceRegion
                heading="Projects and owner decisions"
                id="collaboration"
                kicker="Agent-first collaboration"
                summary="Opening private Project tools…"
              />
            }
          >
            <CollaborationPanel
              activeVaults={activeVaults}
              autoOpen={activeWorkspaceSection === "collaboration"}
            />
          </Suspense>
        ) : null}

        {setup?.authenticated === true ? (
          <OperationalRegion
            attention={
              loadState.kind === "error" || vaultState.kind === "error"
                ? "error"
                : "none"
            }
            heading="System health"
            id="health"
            kicker="Owner-safe status"
            summary={`${activeVaults.length.toLocaleString()} active Source${
              activeVaults.length === 1 ? "" : "s"
            } · ${deploymentLabel} ${
              loadState.kind === "ready"
                ? loadState.health.version
                : "unavailable"
            }`}
          >
            <section
              className="foundation-health"
              aria-labelledby="foundation-health-heading"
            >
              <div className="section-heading">
                <div>
                  <span className="section-kicker">Redacted owner health</span>
                  <h2 id="foundation-health-heading">Foundation status</h2>
                </div>
                <span className="time-target">
                  Community{" "}
                  {loadState.kind === "ready"
                    ? loadState.health.version
                    : "unavailable"}
                </span>
              </div>
              <div className="foundation-health-grid">
                <article>
                  <span>Source access</span>
                  <strong>
                    {activeVaults.length.toLocaleString()} active ·{" "}
                    {(vaults.length - activeVaults.length).toLocaleString()}{" "}
                    inactive
                  </strong>
                  <p>
                    {vaultState.kind === "error"
                      ? "Source status failed to refresh. Retry before creating a recovery point."
                      : "Names, note paths, credentials, and content are excluded from this summary."}
                  </p>
                </article>
                <article>
                  <span>Selected library</span>
                  <strong>
                    {libraryState.kind === "ready"
                      ? `Checked generation ${libraryState.generation.generationId.slice(0, 8)}`
                      : libraryState.kind === "empty"
                        ? "No checked generation"
                        : libraryState.kind === "error"
                          ? "Needs attention"
                          : "Waiting for selection"}
                  </strong>
                  <p>
                    {libraryState.kind === "error"
                      ? "Refresh the selected library before snapshotting it."
                      : "A snapshot uses only a complete, verified library generation."}
                  </p>
                </article>
                <article>
                  <span>Operation budgets</span>
                  <strong>
                    {MAX_SNAPSHOT_VAULTS} Sources ·{" "}
                    {MAX_SNAPSHOT_ITEMS.toLocaleString()} items ·{" "}
                    {(
                      MAX_SNAPSHOT_LOGICAL_BYTES /
                      1024 /
                      1024
                    ).toLocaleString()}{" "}
                    MiB
                  </strong>
                  <p>
                    Snapshot cards show complete logical bytes separately from
                    newly stored encrypted bytes. See the release contract for
                    restore, MCP, and retention limits.
                  </p>
                </article>
              </div>
              <div className="health-owner-actions">
                <div>
                  <strong>Owner recovery access</strong>
                  <p>
                    Add a second passkey on another device so one lost device
                    does not lock you out of this workspace.
                  </p>
                </div>
                <button
                  className="secondary-action"
                  disabled={isWorking}
                  type="button"
                  onClick={() => void addBackupPasskey()}
                >
                  Add another passkey
                </button>
              </div>
              <div className="health-owner-actions">
                <div>
                  <strong>Safe troubleshooting receipt</strong>
                  <p>
                    Copy exact release, Source, sync, library, and Project state
                    without names, note paths, note content, credentials, or
                    Project text.
                  </p>
                </div>
                <button
                  className="secondary-action"
                  disabled={isWorking}
                  type="button"
                  onClick={() => void copyOwnerDiagnostics()}
                >
                  Copy redacted diagnostics
                </button>
              </div>
            </section>
          </OperationalRegion>
        ) : null}

        {setup?.authenticated !== true || onboardingComplete ? (
          <OperationalRegion
            autoOpen={
              setup?.authenticated === true &&
              activeWorkspaceSection === "architecture"
            }
            heading="Safety architecture"
            id="architecture"
            kicker="Advanced inspection"
            summary="Live sync · checked browse · encrypted recovery"
          >
            <section
              className="architecture"
              aria-labelledby="architecture-heading"
            >
              <div className="section-heading">
                <div>
                  <span className="section-kicker">Designed for recovery</span>
                  <h2 id="architecture-heading">
                    Sync is only one layer of safety.
                  </h2>
                </div>
              </div>

              <div className="architecture-grid">
                {architecture.map(([label, technology, description]) => (
                  <article className="architecture-card" key={label}>
                    <span>{label}</span>
                    <h3>{technology}</h3>
                    <p>{description}</p>
                  </article>
                ))}
              </div>
            </section>
          </OperationalRegion>
        ) : null}
      </main>

      <footer>
        <span>
          Self-hosted on Cloudflare
          {loadState.kind === "ready"
            ? ` · ${deploymentLabel} ${loadState.health.version}`
            : ""}
        </span>
        <span>Apache-2.0 · Private by default</span>
      </footer>
    </div>
  );
}

export function App() {
  if (window.location.pathname === "/authorize") {
    return (
      <Suspense fallback={<RouteLoading label="Opening agent approval…" />}>
        <AgentAuthorize />
      </Suspense>
    );
  }
  if (
    window.location.pathname === "/connect" ||
    window.location.pathname === "/initialize"
  ) {
    return (
      <Suspense fallback={<RouteLoading label="Opening Project approval…" />}>
        <ProjectInitialize />
      </Suspense>
    );
  }
  return <Dashboard />;
}
