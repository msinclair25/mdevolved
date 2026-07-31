import {
  apiErrorSchema,
  authenticationOptionsSchema,
  authenticationResultSchema,
  csrfResponseSchema,
  projectInitializationConsentContextSchema,
  projectInitializationDecisionResponseSchema,
  registrationOptionsSchema,
  setupStatusSchema,
  type ProjectInitializationConsentContext,
  type SetupStatus,
} from "@owd/contracts";
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
  | { context: ProjectInitializationConsentContext; kind: "consent" }
  | {
      kind: "rejected";
      reopenedWorkItem: boolean;
      requestKind: ProjectInitializationConsentContext["requestKind"];
    }
  | {
      kind: "approved";
      projectId: string;
      reopenedWorkItem: boolean;
      requestKind: ProjectInitializationConsentContext["requestKind"];
    }
  | { kind: "error"; message: string };

async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not start a secure request.");
  return csrfResponseSchema.parse(await response.json()).csrfToken;
}

async function postJson(
  path: string,
  csrf: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-OWD-CSRF": csrf,
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
  if (!response.ok) throw new Error("OWD setup status is unavailable.");
  return setupStatusSchema.parse(await response.json());
}

async function consentContext(): Promise<ProjectInitializationConsentContext> {
  const response = await fetch(
    `/api/project-initializations/context${window.location.search}`,
    { headers: { Accept: "application/json" } },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    throw new Error(
      parsed.success
        ? parsed.data.error.message
        : "The Project request is invalid.",
    );
  }
  return projectInitializationConsentContextSchema.parse(payload);
}

function projectScopeLabel(
  scope: ProjectInitializationConsentContext["requestedScopes"][number],
): string {
  switch (scope) {
    case "project.read":
      return "read this Project";
    case "collaboration.submit":
      return "add contributions";
    case "review.submit":
      return "add reviews";
    case "proposal.status":
      return "check request status";
  }
}

export function ProjectInitialize() {
  const [page, setPage] = useState<PageState>({ kind: "loading" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includePaths, setIncludePaths] = useState("");
  const [excludePaths, setExcludePaths] = useState("");
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
      setIncludePaths(
        context.contextPolicy.includePaths
          .map((path) => (path === "" ? "/" : path))
          .join("\n"),
      );
      setExcludePaths(context.contextPolicy.excludePaths.join("\n"));
      setPage({ context, kind: "consent" });
    } catch (reason: unknown) {
      setPage({
        kind: "error",
        message:
          reason instanceof Error
            ? reason.message
            : "The Project request could not be loaded.",
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
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The passkey could not be verified.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function decide(approved: boolean): Promise<void> {
    if (page.kind !== "consent") return;
    setWorking(true);
    setError(null);
    try {
      const csrf = await csrfToken();
      const payload = await postJson(
        approved
          ? "/api/project-initializations/approve"
          : "/api/project-initializations/deny",
        csrf,
        approved
          ? {
              contextPolicy:
                page.context.requestKind === "join"
                  ? page.context.contextPolicy
                  : {
                      excludePaths: excludePaths
                        .split("\n")
                        .map((path) => path.trim())
                        .filter((path) => path.length > 0),
                      format: page.context.contextPolicy.format,
                      includePaths: includePaths
                        .split("\n")
                        .map((path) => path.trim())
                        .filter((path) => path.length > 0)
                        .map((path) => (path === "/" ? "" : path)),
                    },
              initializationToken: page.context.initializationToken,
            }
          : { initializationToken: page.context.initializationToken },
      );
      if (!approved) {
        setPage({
          kind: "rejected",
          reopenedWorkItem: page.context.ownerAction !== null,
          requestKind: page.context.requestKind,
        });
        return;
      }
      const result = projectInitializationDecisionResponseSchema.parse(payload);
      setPage({
        kind: "approved",
        projectId: result.projectId,
        reopenedWorkItem: page.context.ownerAction !== null,
        requestKind: page.context.requestKind,
      });
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The Project decision could not be completed.",
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="consent-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="OWD Platform home">
          <span className="brand-mark" aria-hidden="true">
            O
          </span>
          <span>OWD Platform</span>
        </a>
        <span className="consent-readonly">Exact Project consent</span>
      </header>
      <main className="consent-main">
        {page.kind === "loading" ? (
          <p className="vault-message">Checking the Project request…</p>
        ) : page.kind === "error" ? (
          <section className="consent-card">
            <span className="section-kicker">Project stopped</span>
            <h1>This request cannot be approved.</h1>
            <p>{page.message}</p>
            <a className="secondary-action consent-link" href="/">
              Return to OWD
            </a>
          </section>
        ) : page.kind === "rejected" ? (
          <section className="consent-card">
            <span className="section-kicker">Request denied</span>
            <h1>No Project access grant was created.</h1>
            <p>
              {page.reopenedWorkItem
                ? "The exact Work Item stayed closed and the existing Project was not changed. Return to your agent to choose again or continue without this connection."
                : page.requestKind === "join"
                  ? "The existing Project was not changed. Return to your agent to choose again or continue without this connection."
                  : "Return to your agent to revise this request draft or continue without OWD collaboration."}
            </p>
            <a className="secondary-action consent-link" href="/">
              Return to OWD
            </a>
          </section>
        ) : page.kind === "approved" ? (
          <section className="consent-card">
            <span className="section-kicker">Project approved</span>
            <h1>
              {page.reopenedWorkItem
                ? "The Work Item is open and the exact connection is ready."
                : "The exact connection is ready."}
            </h1>
            <p>
              {page.requestKind === "join"
                ? "This agent is approved for the selected Project."
                : "Your Project is created for this approved agent."}{" "}
              Continue in your agent—nothing to copy.
            </p>
            <div className="client-warning" role="note">
              <strong>You remain the vault owner</strong>
              <span>
                OWD will tell this agent whether it is the Project&apos;s
                primary vault writer or a read-only collaborator. That warning
                coordinates local Obsidian and filesystem tools; it does not
                give an agent owner authority or create a filesystem lock.
              </span>
            </div>
            <div className="client-warning" role="note">
              <strong>No MCP reconnect is required</strong>
              <span>
                Keep using the current agent connection. OWD will finish this
                exact approved Project flow without another owner selection.
              </span>
            </div>
            <div className="client-warning" role="note">
              <strong>Later sessions resume the same Project</strong>
              <span>
                OWD should resume from the local <code>.owdignore</code> receipt
                automatically. If a fresh session misses that step, say{" "}
                <q>OWD resume project</q>. No reconnect or new approval is
                required.
              </span>
            </div>
            <details className="consent-advanced">
              <summary>Technical receipt</summary>
              <dl className="consent-details">
                <div>
                  <dt>Project ID</dt>
                  <dd>{page.projectId}</dd>
                </div>
              </dl>
            </details>
            <a className="secondary-action consent-link" href="/">
              Return to OWD
            </a>
          </section>
        ) : page.kind === "authenticate" ? (
          <section className="consent-card">
            <span className="section-kicker">Owner verification</span>
            <h1>Use your passkey before OWD grants Project access.</h1>
            <p>
              The exact client, vault, Project choice, context, and capabilities
              appear after owner verification.
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
                : "Claim OWD with a passkey"}
              <span aria-hidden="true">↗</span>
            </button>
          </section>
        ) : (
          <section className="consent-card">
            <span className="section-kicker">
              {page.context.ownerAction !== null
                ? "Repair and connect"
                : page.context.requestKind === "join"
                  ? "Connect from another agent"
                  : "Initialize from your agent"}
            </span>
            <h1>
              {page.context.ownerAction !== null
                ? "Reopen this Work Item and connect this agent?"
                : page.context.requestKind === "join"
                  ? "Connect this agent to this Project?"
                  : "Create this Project?"}
            </h1>
            {page.context.ownerAction !== null ? (
              <div className="client-warning" role="note">
                <strong>One approval performs two exact actions</strong>
                <span>
                  Reopen “{page.context.workItemTitle}” in “
                  {page.context.projectLabel}”, then connect{" "}
                  {page.context.client.name} with only the capabilities shown
                  below. No other Work Item or Project will change.
                </span>
              </div>
            ) : (
              <div className="client-warning" role="note">
                <strong>Confirm this request came from your agent</strong>
                <span>
                  OWD will use only the vault and Project context shown below.
                  The agent cannot approve this for you.
                </span>
              </div>
            )}
            <div className="client-warning" role="note">
              <strong>You stay the owner; one agent coordinates writes</strong>
              <span>
                The first agent that establishes an OWD Project for this vault
                becomes its primary writer across Projects. Later agents are
                warned to treat local Obsidian, CLI, shell, and filesystem
                access as read-only unless you explicitly hand off one bounded
                task after the prior writer stops. OWD warns compliant agents
                but does not block local filesystem access.
              </span>
            </div>
            <dl className="consent-details">
              <div>
                <dt>Vault</dt>
                <dd>{page.context.vault.name}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{page.context.projectLabel}</dd>
              </div>
              {page.context.ownerAction !== null ? (
                <div>
                  <dt>Work Item to reopen</dt>
                  <dd>{page.context.workItemTitle}</dd>
                </div>
              ) : null}
              <div>
                <dt>Objective</dt>
                <dd>{page.context.objective}</dd>
              </div>
              <div>
                <dt>Vault access</dt>
                <dd>
                  {page.context.requestKind === "join"
                    ? page.context.vaultPathPrefixes.length === 0
                      ? "Entire selected vault"
                      : page.context.vaultPathPrefixes.join(", ")
                    : page.context.folderBoundary || "Entire selected vault"}
                </dd>
              </div>
              <div>
                <dt>Project knowledge</dt>
                <dd>
                  {page.context.contextPolicy.includePaths
                    .map((path) => path || "Entire vault")
                    .join(", ")}
                  {page.context.contextPolicy.excludePaths.length === 0
                    ? ""
                    : `, except ${page.context.contextPolicy.excludePaths.join(", ")}`}
                </dd>
              </div>
              <div>
                <dt>This agent may</dt>
                <dd>
                  {page.context.requestedScopes
                    .map(projectScopeLabel)
                    .join(", ")}
                </dd>
              </div>
            </dl>
            <details className="consent-advanced">
              <summary>Review access boundary and setup details</summary>
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
                  <dt>Vault</dt>
                  <dd>{page.context.vault.name}</dd>
                </div>
                <div>
                  <dt>
                    {page.context.requestKind === "join"
                      ? "Authorized vault folders"
                      : "Project folder boundary"}
                  </dt>
                  <dd>
                    {page.context.requestKind === "join"
                      ? page.context.vaultPathPrefixes.length === 0
                        ? "Entire selected vault"
                        : page.context.vaultPathPrefixes.join(", ")
                      : page.context.folderBoundary || "Entire selected vault"}
                  </dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>{page.context.projectLabel}</dd>
                </div>
                {page.context.projectId !== null ? (
                  <div>
                    <dt>Exact Project ID</dt>
                    <dd>{page.context.projectId}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Objective</dt>
                  <dd>{page.context.objective}</dd>
                </div>
                <div>
                  <dt>
                    {page.context.requestKind === "join"
                      ? "Current work item"
                      : "First work item"}
                  </dt>
                  <dd>{page.context.workItemTitle}</dd>
                </div>
                <div>
                  <dt>Project capabilities</dt>
                  <dd>{page.context.requestedScopes.join(", ")}</dd>
                </div>
                <div>
                  <dt>Source notes</dt>
                  <dd>
                    {page.context.sourceNotePaths.length === 0
                      ? "No source notes"
                      : page.context.sourceNotePaths.join(", ")}
                  </dd>
                </div>
                <div>
                  <dt>Local root Markdown</dt>
                  <dd>
                    {page.context.documentationPlan.rootMarkdownPaths.length ===
                    0
                      ? "No root Markdown reported"
                      : page.context.documentationPlan.rootMarkdownPaths.join(
                          ", ",
                        )}
                  </dd>
                </div>
                <div>
                  <dt>Keep at repository root</dt>
                  <dd>
                    {page.context.documentationPlan.retainedRootPaths.length ===
                    0
                      ? "None"
                      : page.context.documentationPlan.retainedRootPaths.join(
                          ", ",
                        )}
                  </dd>
                </div>
                <div>
                  <dt>Approved moves into docs/</dt>
                  <dd>
                    {page.context.documentationPlan.proposedMoves.length === 0
                      ? "No file moves"
                      : page.context.documentationPlan.proposedMoves
                          .map((move) => `${move.from} → ${move.to}`)
                          .join(", ")}
                  </dd>
                </div>
              </dl>
              <div className="client-warning" role="note">
                <strong>OWD does not move local repository files</strong>
                <span>
                  This records the plan you already approved with the agent.
                  After this browser approval, the agent must apply only these
                  exact moves, update relative links, and verify the resulting
                  paths before using them as Project documentation.
                </span>
              </div>
              <div
                className="context-policy"
                role="group"
                aria-labelledby="context-policy-title"
              >
                {page.context.requestKind === "join" ? (
                  <>
                    <h2 id="context-policy-title">
                      Confirm the existing Project context
                    </h2>
                    <p>
                      This context is already part of the Project contract and
                      cannot be edited while connecting another agent. A changed
                      contract requires a fresh Project choice and confirmation.
                    </p>
                    <dl className="consent-details">
                      <div>
                        <dt>Included paths</dt>
                        <dd>
                          {page.context.contextPolicy.includePaths
                            .map((path) => path || "/")
                            .join(", ")}
                        </dd>
                      </div>
                      <div>
                        <dt>Excluded paths</dt>
                        <dd>
                          {page.context.contextPolicy.excludePaths.length === 0
                            ? "None"
                            : page.context.contextPolicy.excludePaths.join(
                                ", ",
                              )}
                        </dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <>
                    <h2 id="context-policy-title">
                      Choose legitimate Project context
                    </h2>
                    <p>
                      OWD does not guess which Markdown belongs to this Project.
                      Include only the note or folder paths agents may use.
                      Exclusions win, including for future notes created under
                      an included folder.
                    </p>
                    <label className="consent-field">
                      <span>Included note or folder paths · one per line</span>
                      <textarea
                        aria-label="Included Project context paths"
                        disabled={working}
                        value={includePaths}
                        onChange={(event) =>
                          setIncludePaths(event.target.value)
                        }
                      />
                      <small>
                        Use / only when the entire selected vault is
                        intentional. Every path must stay inside the folder
                        boundary above.
                      </small>
                    </label>
                    <label className="consent-field">
                      <span>Excluded note or folder paths · one per line</span>
                      <textarea
                        aria-label="Excluded Project context paths"
                        disabled={working}
                        value={excludePaths}
                        onChange={(event) =>
                          setExcludePaths(event.target.value)
                        }
                      />
                      <small>
                        Use this for personal notes, drafts, archives, or other
                        Markdown mixed into an included folder. This policy
                        becomes the Project&apos;s .owdignore file.
                      </small>
                    </label>
                  </>
                )}
              </div>
              <p>
                OWD will preserve the cited packet, durable contributions, owner
                actions, and provenance. It will not preserve private agent
                conversations, chain-of-thought, tokens, or model identity.
              </p>
            </details>
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
                {page.context.ownerAction !== null
                  ? "Keep closed and deny"
                  : "Deny"}
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={working}
                onClick={() => void decide(true)}
              >
                {page.context.ownerAction !== null
                  ? "Reopen Work Item and approve connection"
                  : page.context.requestKind === "join"
                    ? "Approve connection"
                    : "Create Project"}
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
