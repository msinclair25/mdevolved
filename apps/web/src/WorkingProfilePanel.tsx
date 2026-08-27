import {
  agentSkillExportResponseSchema,
  agentSkillImportResponseSchema,
  agentSkillListResponseSchema,
  apiErrorSchema,
  csrfResponseSchema,
  importAgentSkillRequestSchema,
  projectSkillAttachmentListResponseSchema,
  type AgentSkillPackageFile,
  type AgentSkillSummary,
  type WorkingPreference,
  workingPreferenceListResponseSchema,
  workingPreferenceMutationResponseSchema,
} from "@mdevolved/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { CompoundingDraftsPanel } from "./CompoundingDraftsPanel";

type Props = { projectId: string; projectLabel: string };
type Scope = "personal" | "project";

const fileKeys = new Set(["contentBase64", "path"]);

export function parseAgentSkillEnvelope(text: string): AgentSkillPackageFile[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'Choose valid JSON shaped as {"files":[{"path":"SKILL.md","contentBase64":"..."}]}.',
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.some(
      (file) =>
        typeof file !== "object" ||
        file === null ||
        Array.isArray(file) ||
        Object.keys(file).some((key) => !fileKeys.has(key)) ||
        Object.keys(file).length !== 2 ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !("contentBase64" in file) ||
        typeof file.contentBase64 !== "string",
    )
  ) {
    throw new Error(
      'Choose an exact JSON envelope shaped as {"files":[{"path":"SKILL.md","contentBase64":"..."}]}.',
    );
  }
  const parsed = importAgentSkillRequestSchema.safeParse({
    files: value.files,
    idempotencyKey: "browser-validation",
  });
  if (!parsed.success) {
    throw new Error(
      "The package file list is invalid. Check base64 content, file count, and path lengths.",
    );
  }
  return parsed.data.files;
}

export function skillAttachmentPath(attached: boolean): string {
  return `/api/working-profile/skills/${attached ? "detach" : "attach"}`;
}

export function displayedSkillSummary(
  current: AgentSkillSummary,
  attachments: ReadonlyMap<string, AgentSkillSummary>,
): AgentSkillSummary {
  return attachments.get(current.skillId) ?? current;
}

export async function applyLatestWorkingProfileLoad<T>(options: {
  apply: (value: T) => void;
  currentGeneration: () => number;
  generation: number;
  load: () => Promise<T>;
}): Promise<"applied" | "stale"> {
  const value = await options.load();
  if (options.generation !== options.currentGeneration()) return "stale";
  options.apply(value);
  return "applied";
}

export function shouldStartWorkingProfileLoad(
  open: boolean,
  loadRequested: boolean,
): boolean {
  return open && !loadRequested;
}

export function preferenceRows(
  personal: WorkingPreference[],
  effective: WorkingPreference[],
): Array<{ overridden: boolean; preference: WorkingPreference }> {
  const projectKeys = new Set(
    effective
      .filter((preference) => preference.projectId !== null)
      .map((preference) => preference.key),
  );
  return [
    ...personal.map((preference) => ({
      overridden: projectKeys.has(preference.key),
      preference,
    })),
    ...effective
      .filter((preference) => preference.projectId !== null)
      .map((preference) => ({ overridden: false, preference })),
  ];
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
        : "The working profile request could not be completed.",
    );
  }
  return payload;
}

function mutationKey(): string {
  return crypto.randomUUID();
}

export function WorkingProfilePanel({ projectId, projectLabel }: Props) {
  const [personal, setPersonal] = useState<WorkingPreference[]>([]);
  const [effective, setEffective] = useState<WorkingPreference[]>([]);
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [attachments, setAttachments] = useState<
    Map<string, AgentSkillSummary>
  >(new Map());
  const [scope, setScope] = useState<Scope>("project");
  const [preferenceId, setPreferenceId] = useState<string | undefined>();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [sourceLabel, setSourceLabel] = useState("Owner");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadRequested, setLoadRequested] = useState(false);
  const loadGeneration = useRef(0);

  const rows = useMemo(
    () => preferenceRows(personal, effective),
    [effective, personal],
  );

  async function reload(): Promise<void> {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    await applyLatestWorkingProfileLoad({
      apply: ([
        personalPayload,
        effectivePayload,
        skillsPayload,
        attachedPayload,
      ]) => {
        const nextPersonal =
          workingPreferenceListResponseSchema.parse(
            personalPayload,
          ).preferences;
        const nextEffective =
          workingPreferenceListResponseSchema.parse(
            effectivePayload,
          ).preferences;
        const nextSkills =
          agentSkillListResponseSchema.parse(skillsPayload).skills;
        const nextAttachments = new Map(
          projectSkillAttachmentListResponseSchema
            .parse(attachedPayload)
            .attachments.map((attachment) => [
              attachment.skill.skillId,
              attachment.skill,
            ]),
        );
        setPersonal(nextPersonal);
        setEffective(nextEffective);
        setSkills(nextSkills);
        setAttachments(nextAttachments);
      },
      currentGeneration: () => loadGeneration.current,
      generation,
      load: () =>
        Promise.all([
          request("/api/working-profile/preferences"),
          request(
            `/api/working-profile/preferences?projectId=${encodeURIComponent(projectId)}`,
          ),
          request("/api/working-profile/skills"),
          request(
            `/api/working-profile/skills/attachments?projectId=${encodeURIComponent(projectId)}`,
          ),
        ]),
    });
  }

  useEffect(() => {
    if (!loadRequested) return;
    let active = true;
    setBusy("Loading Memory & Skills…");
    void reload()
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Memory & Skills could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
      loadGeneration.current += 1;
    };
  }, [loadRequested, projectId]);

  async function mutate(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setStatus(null);
    try {
      await operation();
      await reload();
      setStatus(
        `${label.replace(/…$/u, "")} Changes apply on the next agent call.`,
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The working profile change could not be completed.",
      );
    } finally {
      setBusy(null);
    }
  }

  function resetPreferenceForm() {
    setPreferenceId(undefined);
    setKey("");
    setValue("");
    setSourceLabel("Owner");
  }

  function editPreference(preference: WorkingPreference) {
    setScope(preference.projectId === null ? "personal" : "project");
    setPreferenceId(preference.preferenceId);
    setKey(preference.key);
    setValue(preference.value);
    setSourceLabel(preference.sourceLabel);
  }

  async function savePreference() {
    await mutate(
      preferenceId === undefined
        ? "Adding preference…"
        : "Updating preference…",
      async () => {
        workingPreferenceMutationResponseSchema.parse(
          await request("/api/working-profile/preferences", {
            idempotencyKey: mutationKey(),
            key: key.trim(),
            ...(preferenceId === undefined ? {} : { preferenceId }),
            projectId: scope === "project" ? projectId : null,
            sourceLabel: sourceLabel.trim(),
            sourceUrl: null,
            value: value.trim(),
          }),
        );
        resetPreferenceForm();
      },
    );
  }

  async function deletePreference(preference: WorkingPreference) {
    await mutate("Deleting preference…", async () => {
      await request("/api/working-profile/preferences/delete", {
        idempotencyKey: mutationKey(),
        preferenceId: preference.preferenceId,
      });
      if (preference.preferenceId === preferenceId) resetPreferenceForm();
    });
  }

  async function importSkill() {
    let files: AgentSkillPackageFile[];
    try {
      files = parseAgentSkillEnvelope(importText);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The skill package JSON is invalid.",
      );
      return;
    }
    await mutate("Importing skill…", async () => {
      agentSkillImportResponseSchema.parse(
        await request("/api/working-profile/skills/import", {
          files,
          idempotencyKey: mutationKey(),
        }),
      );
      setImportText("");
    });
  }

  async function exportSkill(skill: AgentSkillSummary) {
    setBusy(`Exporting ${skill.name}…`);
    setError(null);
    try {
      const payload = agentSkillExportResponseSchema.parse(
        await request(
          `/api/working-profile/skills/export?skillId=${encodeURIComponent(skill.skillId)}`,
        ),
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ files: payload.files }, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.download = `${skill.name}.agent-skill.json`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
      setStatus(
        `Exported ${skill.name} as an inert regular-file-list package.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The skill could not be exported.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggleSkill(skill: AgentSkillSummary, attached: boolean) {
    await mutate(
      `${attached ? "Detaching" : "Attaching"} ${skill.name}…`,
      async () => {
        await request(skillAttachmentPath(attached), {
          idempotencyKey: mutationKey(),
          projectId,
          skillId: skill.skillId,
        });
      },
    );
  }

  async function deleteSkill(skill: AgentSkillSummary) {
    if (
      !window.confirm(
        `Delete ${skill.name} and remove its Project attachments?`,
      )
    )
      return;
    await mutate(`Deleting ${skill.name}…`, async () => {
      await request("/api/working-profile/skills/delete", {
        idempotencyKey: mutationKey(),
        skillId: skill.skillId,
      });
    });
  }

  return (
    <details
      className="working-profile"
      onToggle={(event) => {
        if (
          shouldStartWorkingProfileLoad(event.currentTarget.open, loadRequested)
        ) {
          setLoadRequested(true);
        }
      }}
    >
      <summary>Memory &amp; Skills</summary>
      <p className="working-profile-intro">
        Project preferences override personal defaults. Skills are stored and
        delivered as inert files, never executed by MDevolved. Attaching a skill
        grants no authority or tools.
      </p>

      <div className="working-profile-grid">
        <section aria-labelledby={`preferences-${projectId}`}>
          <h4 id={`preferences-${projectId}`}>Preferences</h4>
          {rows.length === 0 ? (
            <p>No preferences saved yet.</p>
          ) : (
            <ul className="working-profile-list">
              {rows.map(({ overridden, preference }) => (
                <li key={preference.preferenceId}>
                  <div>
                    <strong>{preference.key}</strong>
                    <span>{preference.value}</span>
                    <small>
                      {preference.projectId === null
                        ? "Personal default"
                        : `${projectLabel} override`}{" "}
                      · Source: {preference.sourceLabel}
                      {overridden ? " · Overridden in this Project" : ""}
                    </small>
                  </div>
                  <div className="working-profile-actions">
                    <button
                      className="text-action"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => editPreference(preference)}
                    >
                      Edit
                    </button>
                    <button
                      className="danger-action"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void deletePreference(preference)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form
            className="working-profile-form"
            onSubmit={(event) => {
              event.preventDefault();
              void savePreference();
            }}
          >
            <fieldset>
              <legend>Preference scope</legend>
              <label>
                <input
                  checked={scope === "personal"}
                  name={`scope-${projectId}`}
                  type="radio"
                  onChange={() => setScope("personal")}
                />{" "}
                Personal
              </label>
              <label>
                <input
                  checked={scope === "project"}
                  name={`scope-${projectId}`}
                  type="radio"
                  onChange={() => setScope("project")}
                />{" "}
                This Project
              </label>
            </fieldset>
            <label>
              <span>Preference key</span>
              <input
                maxLength={80}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="package-manager"
                required
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </label>
            <label>
              <span>Preference</span>
              <textarea
                maxLength={512}
                required
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <label>
              <span>Source label</span>
              <input
                maxLength={120}
                required
                value={sourceLabel}
                onChange={(event) => setSourceLabel(event.target.value)}
              />
            </label>
            <div className="working-profile-actions">
              <button
                className="primary-action"
                disabled={busy !== null}
                type="submit"
              >
                {preferenceId === undefined
                  ? "Add preference"
                  : "Update preference"}
              </button>
              {preferenceId === undefined ? null : (
                <button
                  className="text-action"
                  type="button"
                  onClick={resetPreferenceForm}
                >
                  Cancel edit
                </button>
              )}
            </div>
          </form>
        </section>

        <section aria-labelledby={`skills-${projectId}`}>
          <h4 id={`skills-${projectId}`}>Agent Skills</h4>
          {skills.length === 0 ? (
            <p>No skills imported yet.</p>
          ) : (
            <ul className="working-profile-list">
              {skills.map((skill) => {
                const attachment = attachments.get(skill.skillId);
                const attached = attachment !== undefined;
                const displayed = displayedSkillSummary(skill, attachments);
                return (
                  <li key={skill.skillId}>
                    <div>
                      <strong>{displayed.name}</strong>
                      <span>{displayed.description}</span>
                      <small>
                        Exact version {displayed.versionRecordId.slice(0, 8)} ·{" "}
                        {attached
                          ? `Pinned to ${projectLabel}`
                          : "Not attached"}
                      </small>
                    </div>
                    <div className="working-profile-actions">
                      <button
                        className="secondary-action"
                        disabled={busy !== null}
                        type="button"
                        onClick={() => void toggleSkill(skill, attached)}
                      >
                        {attached ? "Detach" : "Attach"}
                      </button>
                      <button
                        className="text-action"
                        disabled={busy !== null}
                        type="button"
                        onClick={() => void exportSkill(skill)}
                      >
                        Export
                      </button>
                      <button
                        className="danger-action"
                        disabled={busy !== null}
                        type="button"
                        onClick={() => void deleteSkill(skill)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <label className="working-profile-import">
            <span>Import regular-file-list JSON</span>
            <textarea
              aria-describedby={`skill-import-help-${projectId}`}
              placeholder={
                '{"files":[{"path":"SKILL.md","contentBase64":"..."}]}'
              }
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
            />
            <small id={`skill-import-help-${projectId}`}>
              Exact JSON only. Include SKILL.md and supporting regular files as
              base64. Unsafe paths and credentials are rejected; every stored
              file remains inert. MDevolved keeps up to 256 reusable skills and
              preferences so resume context stays bounded.
            </small>
          </label>
          <button
            className="primary-action"
            disabled={busy !== null || importText.trim() === ""}
            type="button"
            onClick={() => void importSkill()}
          >
            Validate and import skill
          </button>
        </section>
      </div>
      <CompoundingDraftsPanel
        enabled={loadRequested}
        onAccepted={() => void reload()}
        projectId={projectId}
        projectLabel={projectLabel}
      />
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
    </details>
  );
}
