import {
  apiErrorSchema,
  projectOutcomeResponseSchema,
  type ProjectOutcome,
} from "@mdevolved/contracts";
import { useEffect, useState } from "react";

type Props = { projectId: string };

export function projectOutcomePath(projectId: string): string {
  return `/api/project-outcomes?projectId=${encodeURIComponent(projectId)}`;
}

export function projectOutcomeDate(value: number | null): string {
  return value === null
    ? "No checkpoint yet"
    : new Date(value * 1_000).toLocaleString();
}

async function requestOutcome(projectId: string): Promise<ProjectOutcome> {
  const response = await fetch(projectOutcomePath(projectId), {
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "Project outcome evidence could not be loaded.",
    );
  }
  return projectOutcomeResponseSchema.parse(payload).outcome;
}

function readinessLabel(outcome: ProjectOutcome): string {
  switch (outcome.readiness) {
    case "not_started":
      return "Not started";
    case "building":
      return "Building continuity";
    case "ready":
      return "Ready for another client slot";
  }
}

function attentionLabel(outcome: ProjectOutcome): string {
  switch (outcome.attention) {
    case "checkpoint_again":
      return "Checkpoint from another client when useful";
    case "review_suggestions":
      return "Review suggested memory when useful";
    case "none":
      return "No attention needed";
  }
}

export function ProjectOutcomePanel({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ProjectOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOutcome(null);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void requestOutcome(projectId)
      .then((next) => {
        if (active) setOutcome(next);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Project outcome evidence could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, projectId]);

  return (
    <details
      className="project-outcome"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Project outcome evidence</summary>
      <p className="project-outcome-note">
        Local-only signals for this Project. This is not a success score;
        MDevolved does not send telemetry or identify providers.
      </p>
      {loading ? <p role="status">Loading local evidence…</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {outcome !== null ? (
        <dl className="project-outcome-facts">
          <div>
            <dt>Readiness</dt>
            <dd>{readinessLabel(outcome)}</dd>
          </div>
          <div>
            <dt>Attention</dt>
            <dd>{attentionLabel(outcome)}</dd>
          </div>
          <div>
            <dt>Client slots checkpointed</dt>
            <dd>{outcome.checkpointedByMultipleClients ? "Yes" : "Not yet"}</dd>
          </div>
          <div>
            <dt>Latest checkpoint</dt>
            <dd>{projectOutcomeDate(outcome.latestCheckpointAt)}</dd>
          </div>
          <div>
            <dt>Owner-reviewed memory</dt>
            <dd>{outcome.acceptedMemoryCount}</dd>
          </div>
          <div>
            <dt>Pending suggestions</dt>
            <dd>{outcome.pendingSuggestionCount}</dd>
          </div>
        </dl>
      ) : null}
    </details>
  );
}
