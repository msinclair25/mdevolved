import {
  apiErrorSchema,
  compoundingDraftActionResponseSchema,
  compoundingDraftListResponseSchema,
  csrfResponseSchema,
  type CompoundingCandidate,
  type CompoundingDraft,
} from "@mdevolved/contracts";
import { useEffect, useRef, useState } from "react";

type Props = {
  enabled: boolean;
  onAccepted: () => void;
  projectId: string;
  projectLabel: string;
};

type EditableCandidate = CompoundingCandidate;

export function compoundingDraftDate(value: number): string {
  return new Date(value * 1_000).toLocaleDateString();
}

export function draftCandidateLabel(candidate: CompoundingCandidate): string {
  return candidate.kind === "preference"
    ? candidate.key + ": " + candidate.value
    : candidate.name + ": " + candidate.description;
}

export function draftScopeLabel(draft: CompoundingDraft): string {
  return draft.scope === "project" ? "This Project" : "Personal";
}

export function compoundingDraftActionPath(
  operation: "accept" | "ignore" | "delete",
  projectId: string,
): string {
  return (
    "/api/compounding/drafts/" +
    operation +
    "?projectId=" +
    encodeURIComponent(projectId)
  );
}

async function request(path: string, body?: unknown): Promise<unknown> {
  let csrf: string | undefined;
  if (body !== undefined) {
    const response = await fetch("/api/auth/csrf", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Could not start a secure request.");
    csrf = csrfResponseSchema.parse(await response.json()).csrfToken;
  }
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(csrf === undefined ? {} : { "X-MDevolved-CSRF": csrf }),
    },
    method: body === undefined ? "GET" : "POST",
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "The suggestion request could not be completed.",
    );
  }
  return payload;
}

function CandidateEditor({
  candidate,
  onChange,
}: {
  candidate: EditableCandidate;
  onChange: (candidate: EditableCandidate) => void;
}) {
  if (candidate.kind === "preference") {
    return (
      <div className="compounding-edit-fields">
        <label>
          <span>Preference key</span>
          <input
            maxLength={80}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
            value={candidate.key}
            onChange={(event) =>
              onChange({ ...candidate, key: event.target.value })
            }
          />
        </label>
        <label>
          <span>Preference</span>
          <textarea
            maxLength={512}
            required
            value={candidate.value}
            onChange={(event) =>
              onChange({ ...candidate, value: event.target.value })
            }
          />
        </label>
      </div>
    );
  }
  return (
    <div className="compounding-edit-fields">
      <label>
        <span>Skill name</span>
        <input
          maxLength={64}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          required
          value={candidate.name}
          onChange={(event) =>
            onChange({ ...candidate, name: event.target.value })
          }
        />
      </label>
      <label>
        <span>Skill description</span>
        <input
          maxLength={1_024}
          required
          value={candidate.description}
          onChange={(event) =>
            onChange({ ...candidate, description: event.target.value })
          }
        />
      </label>
      <label>
        <span>Skill instruction</span>
        <textarea
          maxLength={8_192}
          required
          value={candidate.instruction}
          onChange={(event) =>
            onChange({ ...candidate, instruction: event.target.value })
          }
        />
      </label>
    </div>
  );
}

export function CompoundingDraftsPanel({
  enabled,
  onAccepted,
  projectId,
  projectLabel,
}: Props) {
  const [drafts, setDrafts] = useState<CompoundingDraft[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editedCandidate, setEditedCandidate] = useState<EditableCandidate>();
  const [attachProjectSkillDraftId, setAttachProjectSkillDraftId] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutationKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!enabled) return;
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    let active = true;
    setBusy("Loading suggested memory…");
    setError(null);
    void request(
      "/api/compounding/drafts?projectId=" + encodeURIComponent(projectId),
    )
      .then((payload) => {
        if (!active || requestGeneration !== generation.current) return;
        setDrafts(
          compoundingDraftListResponseSchema
            .parse(payload)
            .drafts.filter((draft) => draft.status === "pending"),
        );
      })
      .catch((reason: unknown) => {
        if (!active || requestGeneration !== generation.current) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Suggested memory could not be loaded.",
        );
      })
      .finally(() => {
        if (active && requestGeneration === generation.current) setBusy(null);
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [enabled, projectId]);

  function beginEdit(draft: CompoundingDraft) {
    setEditingDraftId(draft.draftId);
    setEditedCandidate({ ...draft.candidate });
    setAttachProjectSkillDraftId(
      draft.candidate.kind === "skill" && draft.scope === "project"
        ? draft.draftId
        : null,
    );
    setError(null);
    setStatus(null);
  }

  function endEdit() {
    setEditingDraftId(null);
    setEditedCandidate(undefined);
    setAttachProjectSkillDraftId(null);
  }

  async function act(
    draft: CompoundingDraft,
    operation: "accept" | "ignore" | "delete",
    candidate?: CompoundingCandidate,
  ) {
    const actionLabel =
      operation === "accept"
        ? "Accepting suggestion…"
        : operation === "ignore"
          ? "Ignoring suggestion…"
          : "Deleting suggestion…";
    setBusy(actionLabel);
    setError(null);
    setStatus(null);
    const actionGeneration = generation.current;
    const actionIdentity = JSON.stringify({
      attachProjectSkill: attachProjectSkillDraftId === draft.draftId,
      candidate: candidate ?? null,
      draftId: draft.draftId,
      operation,
    });
    const idempotencyKey =
      mutationKeys.current.get(actionIdentity) ?? crypto.randomUUID();
    mutationKeys.current.set(actionIdentity, idempotencyKey);
    try {
      const payload =
        operation === "accept"
          ? await request(compoundingDraftActionPath("accept", projectId), {
              attachProjectSkill: attachProjectSkillDraftId === draft.draftId,
              draftId: draft.draftId,
              ...(candidate === undefined
                ? {}
                : { editedCandidate: candidate }),
              idempotencyKey,
              sourceLabel: "Owner",
              sourceUrl: null,
            })
          : await request(compoundingDraftActionPath(operation, projectId), {
              draftId: draft.draftId,
              idempotencyKey,
            });
      if (actionGeneration !== generation.current) return;
      mutationKeys.current.delete(actionIdentity);
      if (operation === "accept") {
        const response = compoundingDraftActionResponseSchema.parse(payload);
        setDrafts((current) =>
          current.filter((item) => item.draftId !== response.draft.draftId),
        );
        endEdit();
        onAccepted();
        setStatus(
          "Suggestion accepted. Live memory reloaded for the next agent call.",
        );
      } else {
        setDrafts((current) =>
          current.filter((item) => item.draftId !== draft.draftId),
        );
        if (editingDraftId === draft.draftId) endEdit();
        setStatus(
          operation === "ignore"
            ? "Suggestion ignored. Existing live memory was not changed."
            : "Suggestion deleted. Existing live memory was not changed.",
        );
      }
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The suggestion change could not be completed.",
      );
    } finally {
      if (actionGeneration === generation.current) setBusy(null);
    }
  }

  if (!enabled && drafts.length === 0 && busy === null && error === null)
    return null;

  return (
    <section
      className="compounding-drafts"
      aria-labelledby={"suggested-memory-" + projectId}
    >
      <div className="compounding-heading">
        <div>
          <h4 id={"suggested-memory-" + projectId}>Suggested memory</h4>
          <p>
            Pending patterns from completed work. Nothing is saved until you
            choose.
          </p>
        </div>
      </div>
      {drafts.length === 0 && busy === null && error === null ? (
        <p>No pending suggestions.</p>
      ) : null}
      <ul className="compounding-draft-list">
        {drafts.map((draft) => {
          const editing = editingDraftId === draft.draftId;
          const candidate = editing ? editedCandidate : undefined;
          return (
            <li key={draft.draftId} className="compounding-draft">
              <div className="compounding-draft-content">
                <strong>
                  {draft.candidate.kind === "preference"
                    ? "Preference suggestion"
                    : "Skill suggestion"}
                </strong>
                <span>
                  {draftScopeLabel(draft)} ·{" "}
                  {draftCandidateLabel(draft.candidate)}
                </span>
                <small>
                  Evidence: {draft.evidence.length} observations ·{" "}
                  {compoundingDraftDate(draft.firstObservedAt)}–
                  {compoundingDraftDate(draft.lastObservedAt)} ·{" "}
                  {draft.evidence
                    .map((evidence) => evidence.producerClientId)
                    .join(", ")}
                </small>
                {draft.conflict ? (
                  <small className="compounding-conflict" role="status">
                    Conflicts with another pending suggestion in this scope;
                    review before accepting.
                  </small>
                ) : null}
                <small>{draft.correlationNote}</small>
              </div>
              {editing && candidate !== undefined ? (
                <>
                  <CandidateEditor
                    candidate={candidate}
                    onChange={setEditedCandidate}
                  />
                  {candidate.kind === "skill" && draft.scope === "project" ? (
                    <label className="compounding-attach-choice">
                      <input
                        checked={attachProjectSkillDraftId === draft.draftId}
                        type="checkbox"
                        onChange={(event) =>
                          setAttachProjectSkillDraftId(
                            event.target.checked ? draft.draftId : null,
                          )
                        }
                      />{" "}
                      Attach this skill to {projectLabel} after accepting
                    </label>
                  ) : null}
                  <div className="working-profile-actions">
                    <button
                      className="primary-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={() => void act(draft, "accept", editedCandidate)}
                    >
                      Accept edited suggestion
                    </button>
                    <button
                      className="text-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={endEdit}
                    >
                      Cancel edit
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {draft.candidate.kind === "skill" &&
                  draft.scope === "project" ? (
                    <label className="compounding-attach-choice">
                      <input
                        checked={attachProjectSkillDraftId === draft.draftId}
                        type="checkbox"
                        onChange={(event) =>
                          setAttachProjectSkillDraftId(
                            event.target.checked ? draft.draftId : null,
                          )
                        }
                      />{" "}
                      Attach this skill to {projectLabel} after accepting
                    </label>
                  ) : null}
                  <div className="working-profile-actions">
                    <button
                      className="primary-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={() => void act(draft, "accept")}
                    >
                      Accept
                    </button>
                    <button
                      className="secondary-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={() => beginEdit(draft)}
                    >
                      Edit &amp; accept
                    </button>
                    <button
                      className="text-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={() => void act(draft, "ignore")}
                    >
                      Ignore
                    </button>
                    <button
                      className="danger-action"
                      disabled={busy !== null}
                      type="button"
                      onClick={() => void act(draft, "delete")}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {busy === null ? null : (
        <p aria-live="polite" className="vault-message">
          {busy}
        </p>
      )}
      {error === null ? null : (
        <p className="action-error" role="alert">
          {error}
        </p>
      )}
      {status === null ? null : (
        <p aria-live="polite" className="backup-message">
          {status}
        </p>
      )}
    </section>
  );
}
