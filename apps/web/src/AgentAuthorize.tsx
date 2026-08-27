import {
  agentConsentContextSchema,
  apiErrorSchema,
  authenticationOptionsSchema,
  authenticationResultSchema,
  csrfResponseSchema,
  oauthRedirectResponseSchema,
  registrationOptionsSchema,
  setupStatusSchema,
  type AgentConsentContext,
  type SetupStatus,
} from "@mdevolved/contracts";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import {
  captureOwnerClaimToken,
  clearOwnerClaimToken,
} from "./owner-claim-token";

type PageState =
  | { kind: "loading" }
  | { kind: "authenticate"; setup: SetupStatus }
  | { context: AgentConsentContext; kind: "consent" }
  | { code: string | null; kind: "error"; message: string };

class AuthorizationContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function authorizationErrorCopy(code: string | null): {
  guidance: string;
  title: string;
} {
  switch (code) {
    case "vault_setup_required":
      return {
        guidance:
          "Return to MDevolved, finish Connect Source, then come back to your agent and choose Authenticate again.",
        title: "Connect a Markdown source first.",
      };
    case "vault_protection_required":
      return {
        guidance:
          "Keep the folder app or Obsidian adapter open until first sync and the searchable library finish, then return to your agent and retry Authenticate.",
        title: "Finish this source's first sync first.",
      };
    case "project_authorization_required":
      return {
        guidance:
          "Return to MDevolved and approve the exact pending Project request. Then continue the same authentication from your agent; do not create another Project.",
        title: "Approve the exact Project request first.",
      };
    case "authorization_request_invalid":
      return {
        guidance:
          "No access was granted. Return to your agent and start Authenticate again. If this came from an older open tab, close that tab and use a fresh authentication request.",
        title: "This authentication request cannot continue.",
      };
    default:
      return {
        guidance:
          "No access was granted. Return to MDevolved to check setup, then retry Authenticate from the same agent connection.",
        title: "MDevolved stopped this connection before approval.",
      };
  }
}

function vaultPermission(scopes: readonly string[]): string {
  const canCreate = scopes.includes("project.initialize.request");
  const canConnect = scopes.includes("project.connect.request");
  if (canCreate && canConnect) {
    return "Read one selected Source, discover compatible Projects, and request owner-confirmed new or existing Project access";
  }
  if (canConnect) {
    return "Read one selected Source, discover compatible Projects, and request owner-confirmed access to one";
  }
  if (canCreate) {
    return "Read one selected Source and request owner-confirmed new Project initialization";
  }
  return "Read notes from one selected Source";
}

async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not start a secure request.");
  return csrfResponseSchema.parse(await response.json()).csrfToken;
}

async function postJson(path: string, csrf: string, body?: unknown) {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-MDevolved-CSRF": csrf,
    },
    method: "POST",
  });
  const payload: unknown =
    response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : "The request could not be completed.",
    );
  }
  return payload;
}

async function setupStatus(): Promise<SetupStatus> {
  const response = await fetch("/api/setup/status", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("MDevolved setup status is unavailable.");
  return setupStatusSchema.parse(await response.json());
}

async function consentContext(): Promise<AgentConsentContext> {
  const response = await fetch(
    `/api/agent/oauth/context${window.location.search}`,
    { headers: { Accept: "application/json" } },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new AuthorizationContextError(
        parsed.data.error.code,
        parsed.data.error.message,
      );
    }
    throw new Error("The authorization request is invalid.");
  }
  return agentConsentContextSchema.parse(payload);
}

export function AgentAuthorize() {
  const [page, setPage] = useState<PageState>({ kind: "loading" });
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [approvedRestoreIds, setApprovedRestoreIds] = useState<string[]>([]);
  const [folders, setFolders] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerClaimToken] = useState(() => captureOwnerClaimToken());
  const supportsPasskeys = browserSupportsWebAuthn();

  async function load(): Promise<void> {
    setPage({ kind: "loading" });
    setError(null);
    try {
      const setup = await setupStatus();
      if (!setup.authenticated) {
        setPage({ kind: "authenticate", setup });
        return;
      }
      const context = await consentContext();
      setSelectedVaultId("");
      setApprovedRestoreIds([]);
      setPage({ context, kind: "consent" });
    } catch (loadError: unknown) {
      setPage({
        code:
          loadError instanceof AuthorizationContextError
            ? loadError.code
            : null,
        kind: "error",
        message:
          loadError instanceof Error
            ? loadError.message
            : "The authorization request could not be loaded.",
      });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function authenticate(setup: SetupStatus): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      const csrf = await csrfToken();
      if (setup.claimed) {
        const options = authenticationOptionsSchema.parse(
          await postJson("/api/auth/login/options", csrf),
        );
        const credential = await startAuthentication({ optionsJSON: options });
        authenticationResultSchema.parse(
          await postJson("/api/auth/login/verify", csrf, credential),
        );
      } else {
        const options = registrationOptionsSchema.parse(
          await postJson(
            "/api/auth/register/options",
            csrf,
            setup.claimMode === "invitation"
              ? { claimToken: ownerClaimToken }
              : undefined,
          ),
        );
        const credential = await startRegistration({ optionsJSON: options });
        authenticationResultSchema.parse(
          await postJson("/api/auth/register/verify", csrf, credential),
        );
        clearOwnerClaimToken();
      }
      await load();
    } catch (authError: unknown) {
      setError(
        authError instanceof Error
          ? authError.message
          : "The passkey could not be verified.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function decide(approved: boolean): Promise<void> {
    if (page.kind !== "consent") return;
    const boundProject =
      page.context.authorizationKind === "collaboration" &&
      page.context.projects.length === 1
        ? (page.context.projects[0] ?? null)
        : null;
    if (approved) {
      if (
        page.context.authorizationKind === "vault" &&
        selectedVaultId === ""
      ) {
        setError("Pair an active Source before approving this connection.");
        return;
      }
      if (
        page.context.authorizationKind === "collaboration" &&
        boundProject === null
      ) {
        setError(
          "This authorization request is not bound to one exact active Project.",
        );
        return;
      }
    }
    setWorking(true);
    setError(null);
    try {
      const csrf = await csrfToken();
      const payload = approved
        ? page.context.authorizationKind === "vault"
          ? {
              authorizationKind: "vault" as const,
              approvedRestoreIds,
              flowToken: page.context.flowToken,
              pathPrefixes: folders
                .split("\n")
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
              vaultId: selectedVaultId,
            }
          : {
              authorizationKind: "collaboration" as const,
              flowToken: page.context.flowToken,
              projectId: boundProject?.projectId ?? "",
            }
        : { flowToken: page.context.flowToken };
      const response = oauthRedirectResponseSchema.parse(
        await postJson(
          approved ? "/api/agent/oauth/approve" : "/api/agent/oauth/deny",
          csrf,
          payload,
        ),
      );
      window.location.assign(response.redirectTo);
    } catch (decisionError: unknown) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "The authorization decision could not be completed.",
      );
      setWorking(false);
    }
  }

  const boundProject =
    page.kind === "consent" &&
    page.context.authorizationKind === "collaboration" &&
    page.context.projects.length === 1
      ? (page.context.projects[0] ?? null)
      : null;
  const vaults =
    page.kind === "consent" && page.context.authorizationKind === "vault"
      ? page.context.vaults
      : [];
  const selectedVault =
    vaults.find((vault) => vault.id === selectedVaultId) ?? null;
  const authorizationFailure =
    page.kind === "error" ? authorizationErrorCopy(page.code) : null;

  return (
    <div className="consent-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="MDevolved home">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>MDevolved</span>
        </a>
        <span className="consent-readonly">Scoped authorization</span>
      </header>

      <main className="consent-main">
        {page.kind === "loading" ? (
          <p className="vault-message">Checking the connection request…</p>
        ) : page.kind === "error" ? (
          <section className="consent-card">
            <span className="section-kicker">Connection stopped</span>
            <h1>{authorizationFailure?.title}</h1>
            <p>{page.message}</p>
            <p>{authorizationFailure?.guidance}</p>
            <a className="secondary-action consent-link" href="/">
              Check MDevolved setup
            </a>
          </section>
        ) : page.kind === "authenticate" ? (
          <section className="consent-card">
            <span className="section-kicker">Owner verification</span>
            <h1>Use your passkey to continue this connection.</h1>
            <p>
              MDevolved will show the requesting client and its exact access
              boundary before anything is approved.
            </p>
            <button
              className="primary-action"
              type="button"
              disabled={
                working ||
                !supportsPasskeys ||
                (!page.setup.claimed &&
                  page.setup.claimMode === "invitation" &&
                  (ownerClaimToken === null || !page.setup.claimAvailable))
              }
              onClick={() => void authenticate(page.setup)}
            >
              {page.setup.claimed
                ? "Sign in with your passkey"
                : "Claim MDevolved with a passkey"}
              <span aria-hidden="true">↗</span>
            </button>
            {!supportsPasskeys ? (
              <p className="action-error">
                This browser does not support passkeys.
              </p>
            ) : null}
          </section>
        ) : (
          <section className="consent-card">
            <span className="section-kicker">Agent connection request</span>
            <h1>
              {page.context.authorizationKind === "vault"
                ? "Choose exactly what this client can access."
                : "Finish this exact Project connection."}
            </h1>

            <div className="client-warning" role="note">
              <strong>Unverified OAuth client</strong>
              <span>
                Confirm you started this connection from the client shown below.
                MDevolved never trusts its display name as identity.
              </span>
            </div>

            <dl className="consent-details">
              <div>
                <dt>Client</dt>
                <dd>{page.context.client.name}</dd>
              </div>
              <div>
                <dt>Callback origin</dt>
                <dd>{page.context.client.origin}</dd>
              </div>
              <div>
                <dt>Permission</dt>
                <dd>
                  {page.context.authorizationKind === "vault"
                    ? vaultPermission(page.context.scopes)
                    : `One selected Project · ${page.context.scopes.join(", ")}`}
                </dd>
              </div>
              <div>
                <dt>MCP resource</dt>
                <dd>{page.context.resource}</dd>
              </div>
            </dl>

            {page.context.authorizationKind === "vault" ? (
              <>
                <label className="consent-field">
                  <span>Source workspace</span>
                  <select
                    value={selectedVaultId}
                    onChange={(event) => {
                      const vaultId = event.target.value;
                      const runtimeProfile = vaults.find(
                        (vault) => vault.id === vaultId,
                      )?.runtimeProfile;
                      setSelectedVaultId(vaultId);
                      setApprovedRestoreIds([]);
                      setFolders(
                        runtimeProfile?.id === "obsidian-mind"
                          ? runtimeProfile.contentRoots.join("\n")
                          : "",
                      );
                    }}
                  >
                    <option value="" disabled>
                      Choose the Source for this Project…
                    </option>
                    {vaults.length === 0 ? (
                      <option value="">No active Sources</option>
                    ) : null}
                    {vaults.map((vault) => (
                      <option value={vault.id} key={vault.id}>
                        {vault.displayName ?? vault.id}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedVault?.runtimeProfile?.id === "obsidian-mind" ? (
                  <div className="client-warning" role="note">
                    <strong>
                      Obsidian Mind {selectedVault.runtimeProfile.version}{" "}
                      detected
                    </strong>
                    <span>
                      MDevolved prefilled Mind&apos;s ordinary content roots.
                      Its{" "}
                      <code>{selectedVault.runtimeProfile.memoryRoot}/</code>,
                      private notes, and never-expose filenames remain blocked
                      even if this list is broadened.
                    </span>
                  </div>
                ) : null}

                {selectedVaultId !== "" &&
                page.context.restoredSources.some(
                  (source) => source.targetVaultId === selectedVaultId,
                ) ? (
                  <fieldset className="consent-field">
                    <legend>Restored content · blocked by default</legend>
                    <small>
                      This Source contains notes copied from a recovery restore.
                      Select a named source only if this agent may read that
                      restored content. Leaving every source unchecked keeps it
                      outside search, recent changes, note reads, and Project
                      initialization.
                    </small>
                    {page.context.restoredSources
                      .filter(
                        (source) => source.targetVaultId === selectedVaultId,
                      )
                      .map((source) => (
                        <label key={source.restoreId}>
                          <input
                            type="checkbox"
                            checked={approvedRestoreIds.includes(
                              source.restoreId,
                            )}
                            onChange={(event) =>
                              setApprovedRestoreIds((current) =>
                                event.target.checked
                                  ? [...current, source.restoreId]
                                  : current.filter(
                                      (value) => value !== source.restoreId,
                                    ),
                              )
                            }
                          />
                          <span>
                            {source.sourceVaultName} · {source.noteCount} notes
                          </span>
                        </label>
                      ))}
                  </fieldset>
                ) : null}

                <label className="consent-field">
                  <span>
                    {selectedVault?.runtimeProfile?.id === "obsidian-mind"
                      ? "Obsidian Mind content folders"
                      : "Allowed folders · optional"}
                  </span>
                  <textarea
                    maxLength={8_192}
                    placeholder={
                      "Leave empty for the entire Source\nOr enter one folder per line, such as Projects/Active"
                    }
                    value={folders}
                    onChange={(event) => setFolders(event.target.value)}
                  />
                  <small>
                    {selectedVault?.runtimeProfile?.id === "obsidian-mind"
                      ? "You may narrow this list. The runtime profile is a server-enforced ceiling, not new authority: it cannot expose memory, private, or never-expose notes."
                      : "Folder limits are enforced inside database queries and on every note read. Project discovery returns only compatible Projects, and no Project grant is issued without exact owner confirmation—either the single-use first Project prepared during onboarding or a separate exact review."}
                  </small>
                </label>
              </>
            ) : (
              <div
                aria-labelledby="bound-project-label"
                className="consent-field consent-bound-project"
                role="group"
              >
                <span id="bound-project-label">Project</span>
                {boundProject === null ? (
                  <strong>Exact Project unavailable</strong>
                ) : (
                  <>
                    <strong>{boundProject.label}</strong>
                    <span className="consent-bound-project-id">
                      {boundProject.projectId}
                    </span>
                  </>
                )}
                <small>
                  The server bound this authorization to the Project you already
                  approved. It cannot be changed here or grant owner authority.
                </small>
              </div>
            )}

            {error !== null ? (
              <p className="action-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="consent-actions">
              <button
                className="secondary-action"
                type="button"
                disabled={working}
                onClick={() => void decide(false)}
              >
                Deny
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={
                  working ||
                  (page.context.authorizationKind === "vault"
                    ? selectedVaultId === ""
                    : boundProject === null)
                }
                onClick={() => void decide(true)}
              >
                {page.context.authorizationKind === "vault"
                  ? "Approve scoped access"
                  : "Finish connection"}{" "}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </section>
        )}

        {error !== null && page.kind !== "consent" ? (
          <p className="action-error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}
