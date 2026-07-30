import {
  apiErrorSchema,
  csrfResponseSchema,
  materializationJobSchema,
  snapshotEstimateSchema,
  snapshotListResponseSchema,
  snapshotRepairResponseSchema,
  snapshotRetentionPolicySchema,
  snapshotRetentionRunSchema,
  snapshotSummarySchema,
  type SnapshotEstimate,
  type SnapshotRetentionPolicy,
  type SnapshotSummary,
  type VaultSummary,
} from "@owd/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { SnapshotRestorePanel } from "./SnapshotRestorePanel";
import { requestSetupReadinessRefresh } from "./setup-readiness-events";

type Props = {
  activeVaults: VaultSummary[];
  disabled: boolean;
  onRestoreApplied: (vaultId: string) => Promise<void> | void;
  recoveryKeyVerified: boolean;
};

type CaptureScope = "all-active" | "selected";
type IntelligenceSelection = "approved" | "approved-and-unvetted" | "none";

function formatTimestamp(value: number | null): string {
  if (value === null) return "In progress";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function snapshotDownloadFilename(snapshotId: string): string {
  return `owd-snapshot-${snapshotId}.owdsnapshot`;
}

export function snapshotDownloadRequestedMessage(
  snapshot: Pick<SnapshotSummary, "snapshotId" | "verifiedAt">,
  verifiedAtLabel = formatTimestamp(snapshot.verifiedAt),
): string {
  return `Download requested for ${snapshotDownloadFilename(snapshot.snapshotId)}. Snapshot created and checked at ${verifiedAtLabel}. Snapshot record reference: ${snapshot.snapshotId.slice(0, 8)}.`;
}

export function snapshotScopeSummary(
  scope: CaptureScope,
  activeVaultCount: number,
  selectedVaultCount: number,
): { label: string; vaultCount: number } {
  return scope === "all-active"
    ? { label: "All active vaults", vaultCount: activeVaultCount }
    : { label: "Only selected vaults", vaultCount: selectedVaultCount };
}

export function splitSnapshotHistory(snapshots: SnapshotSummary[]): {
  archived: SnapshotSummary[];
  current: SnapshotSummary[];
} {
  return snapshots.reduce<{
    archived: SnapshotSummary[];
    current: SnapshotSummary[];
  }>(
    (history, snapshot) => {
      (snapshot.archivedAt === null ? history.current : history.archived).push(
        snapshot,
      );
      return history;
    },
    { archived: [], current: [] },
  );
}

async function loadCsrf(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Could not start a secure request.");
  return csrfResponseSchema.parse(await response.json()).csrfToken;
}

async function apiJson(
  path: string,
  options: {
    body?: unknown;
    csrf?: string;
    method?: "POST" | "PUT";
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.csrf === undefined ? {} : { "X-OWD-CSRF": options.csrf }),
    },
    method: options.method ?? "GET",
    signal: options.signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const problem = apiErrorSchema.safeParse(payload);
    throw new Error(
      problem.success
        ? problem.data.error.message
        : "The request could not be completed.",
    );
  }
  return payload;
}

function captureBody(
  scope: CaptureScope,
  selectedVaultIds: string[],
  intelligenceSelection: IntelligenceSelection,
): { intelligenceSelection: IntelligenceSelection; vaultIds?: string[] } {
  return scope === "all-active"
    ? { intelligenceSelection }
    : { intelligenceSelection, vaultIds: selectedVaultIds };
}

export function SnapshotPanel({
  activeVaults,
  disabled,
  onRestoreApplied,
  recoveryKeyVerified,
}: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [scope, setScope] = useState<CaptureScope>("all-active");
  const [intelligenceSelection, setIntelligenceSelection] =
    useState<IntelligenceSelection>("approved");
  const [selectedVaultIds, setSelectedVaultIds] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<SnapshotEstimate | null>(null);
  const [estimateMessage, setEstimateMessage] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewedSnapshotId, setViewedSnapshotId] = useState<string | null>(null);
  const [restoreSnapshotId, setRestoreSnapshotId] = useState<string | null>(
    null,
  );
  const [portableRestoreOpen, setPortableRestoreOpen] = useState(false);
  const [downloadRequestedSnapshotId, setDownloadRequestedSnapshotId] =
    useState<string | null>(null);
  const [retention, setRetention] = useState<SnapshotRetentionPolicy | null>(
    null,
  );
  const [retentionEnabled, setRetentionEnabled] = useState(false);
  const [retentionKeepCount, setRetentionKeepCount] = useState(5);
  const [focusCurrentTimeline, setFocusCurrentTimeline] = useState(false);
  const currentTimelineHeadingRef = useRef<HTMLHeadingElement>(null);

  const selectedSnapshot = useMemo(
    () =>
      snapshots.find((snapshot) => snapshot.snapshotId === restoreSnapshotId) ??
      null,
    [restoreSnapshotId, snapshots],
  );
  const scopeSummary = snapshotScopeSummary(
    scope,
    activeVaults.length,
    selectedVaultIds.length,
  );
  const snapshotHistory = useMemo(
    () => splitSnapshotHistory(snapshots),
    [snapshots],
  );

  useEffect(() => {
    if (!focusCurrentTimeline) return;
    const timer = window.setTimeout(() => {
      currentTimelineHeadingRef.current?.focus();
      setFocusCurrentTimeline(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusCurrentTimeline]);

  async function refreshTimeline(signal?: AbortSignal): Promise<void> {
    const response = snapshotListResponseSchema.parse(
      await apiJson("/api/snapshots", { signal }),
    );
    setSnapshots(response.snapshots);
  }

  async function refreshRetention(signal?: AbortSignal): Promise<void> {
    const policy = snapshotRetentionPolicySchema.parse(
      await apiJson("/api/snapshots/retention", { signal }),
    );
    setRetention(policy);
    setRetentionEnabled(policy.enabled);
    setRetentionKeepCount(policy.keepReadyCount);
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      refreshTimeline(controller.signal),
      refreshRetention(controller.signal),
    ]).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The snapshot timeline could not be loaded.",
      );
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setSelectedVaultIds((current) => {
      const activeIds = new Set(activeVaults.map((vault) => vault.id));
      const retained = current.filter((vaultId) => activeIds.has(vaultId));
      return retained.length > 0 || scope === "selected"
        ? retained
        : activeVaults.map((vault) => vault.id);
    });
  }, [activeVaults, scope]);

  async function refreshEstimate(): Promise<void> {
    if (
      activeVaults.length === 0 ||
      (scope === "selected" && selectedVaultIds.length === 0)
    ) {
      setEstimate(null);
      return;
    }
    setEstimateMessage("Calculating logical and newly stored data…");
    try {
      const value = snapshotEstimateSchema.parse(
        await apiJson("/api/snapshots/estimate", {
          body: captureBody(scope, selectedVaultIds, intelligenceSelection),
          csrf: await loadCsrf(),
          method: "POST",
        }),
      );
      setEstimate(value);
      setEstimateMessage(null);
    } catch (reason: unknown) {
      setEstimate(null);
      setEstimateMessage(
        reason instanceof Error
          ? reason.message
          : "The storage estimate is not available yet.",
      );
    }
  }

  useEffect(() => {
    if (!recoveryKeyVerified) {
      setEstimate(null);
      setEstimateMessage(null);
      return;
    }
    void refreshEstimate();
  }, [
    recoveryKeyVerified,
    scope,
    selectedVaultIds.join(":"),
    activeVaults.length,
    intelligenceSelection,
  ]);

  async function continueCapture(
    initial: SnapshotSummary,
    csrf: string,
  ): Promise<SnapshotSummary> {
    let snapshot = initial;
    const remaining = Math.max(
      0,
      snapshot.totalObjectCount - snapshot.processedObjectCount,
    );
    const intelligenceItemCount =
      (snapshot.intelligence.approved?.recordCount ?? 0) +
      (snapshot.intelligence.approved?.evidenceObjectCount ?? 0) +
      (snapshot.intelligence.unvetted?.recordCount ?? 0) +
      (snapshot.intelligence.unvetted?.evidenceObjectCount ?? 0);
    const maximumSteps =
      Math.max(
        Math.ceil(remaining / 20),
        Math.ceil(intelligenceItemCount / 20),
      ) + 4;
    for (
      let step = 0;
      step < maximumSteps && snapshot.status === "creating";
      step += 1
    ) {
      setWorking(
        `Encrypting and checking ${snapshot.processedObjectCount.toLocaleString()} of ${snapshot.totalObjectCount.toLocaleString()} new content objects…`,
      );
      snapshot = snapshotSummarySchema.parse(
        await apiJson(
          `/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/continue`,
          { csrf, method: "POST" },
        ),
      );
    }
    if (snapshot.status !== "ready") {
      throw new Error(
        "Snapshot capture paused before publication. Continue it from the timeline.",
      );
    }
    return snapshot;
  }

  async function createSnapshot(): Promise<void> {
    if (
      !recoveryKeyVerified ||
      activeVaults.length === 0 ||
      (scope === "selected" && selectedVaultIds.length === 0)
    ) {
      return;
    }
    setWorking("Refreshing every selected vault library…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      const captureVaultIds =
        scope === "all-active"
          ? activeVaults.map((vault) => vault.id)
          : selectedVaultIds;
      const jobs = await Promise.all(
        captureVaultIds.map(async (vaultId) =>
          materializationJobSchema.parse(
            await apiJson(
              `/api/vaults/${encodeURIComponent(vaultId)}/materializations`,
              { csrf, method: "POST" },
            ),
          ),
        ),
      );
      for (let attempt = 0; attempt < 360; attempt += 1) {
        const active = jobs.filter(
          (job) => job.status === "queued" || job.status === "running",
        );
        if (active.length === 0) break;
        setWorking(
          `Refreshing ${active.length.toLocaleString()} selected vault ${active.length === 1 ? "library" : "libraries"}…`,
        );
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        for (const job of active) {
          const refreshed = materializationJobSchema.parse(
            await apiJson(
              `/api/vaults/${encodeURIComponent(job.vaultId)}/materializations/${encodeURIComponent(job.jobId)}`,
            ),
          );
          jobs[jobs.indexOf(job)] = refreshed;
        }
      }
      if (jobs.some((job) => job.status !== "completed")) {
        throw new Error(
          jobs.some((job) => job.status === "failed")
            ? "A selected vault library could not be refreshed. The prior snapshot history is unchanged."
            : "The selected vault libraries are still refreshing. Try the snapshot again in a moment.",
        );
      }
      const started = snapshotSummarySchema.parse(
        await apiJson("/api/snapshots", {
          body: captureBody(scope, selectedVaultIds, intelligenceSelection),
          csrf,
          method: "POST",
        }),
      );
      const snapshot = await continueCapture(started, csrf);
      await refreshTimeline();
      await refreshEstimate();
      requestSetupReadinessRefresh();
      setMessage(
        `Snapshot created and checked at ${formatTimestamp(snapshot.verifiedAt)}. Reference: ${snapshot.snapshotId.slice(0, 8)}.`,
      );
    } catch (reason: unknown) {
      await refreshTimeline().catch(() => undefined);
      setError(
        reason instanceof Error
          ? reason.message
          : "The coordinated snapshot could not be created.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function resumeSnapshot(snapshot: SnapshotSummary): Promise<void> {
    setWorking("Continuing the paused snapshot…");
    setError(null);
    setMessage(null);
    try {
      const completed = await continueCapture(snapshot, await loadCsrf());
      await refreshTimeline();
      await refreshEstimate();
      requestSetupReadinessRefresh();
      setMessage(
        `Snapshot created and checked at ${formatTimestamp(completed.verifiedAt)}. Reference: ${completed.snapshotId.slice(0, 8)}.`,
      );
    } catch (reason: unknown) {
      await refreshTimeline().catch(() => undefined);
      setError(
        reason instanceof Error
          ? reason.message
          : "The paused snapshot could not be continued.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function cancelSnapshot(snapshot: SnapshotSummary): Promise<void> {
    if (
      !window.confirm(
        "Cancel this incomplete snapshot? Ready recovery points are unchanged.",
      )
    ) {
      return;
    }
    setWorking("Cancelling the incomplete snapshot…");
    setError(null);
    setMessage(null);
    try {
      const cancelled = snapshotSummarySchema.parse(
        await apiJson(
          `/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/cancel`,
          { csrf: await loadCsrf(), method: "POST" },
        ),
      );
      setSnapshots((current) =>
        current.map((item) =>
          item.snapshotId === cancelled.snapshotId ? cancelled : item,
        ),
      );
      setMessage(
        "Incomplete snapshot cancelled. Ready recovery points remain unchanged.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The incomplete snapshot could not be cancelled.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function setPinned(snapshot: SnapshotSummary): Promise<void> {
    setWorking(
      snapshot.pinned
        ? "Removing snapshot protection…"
        : "Protecting snapshot…",
    );
    setError(null);
    try {
      const updated = snapshotSummarySchema.parse(
        await apiJson(
          `/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/pin`,
          {
            body: { pinned: !snapshot.pinned },
            csrf: await loadCsrf(),
            method: "PUT",
          },
        ),
      );
      setSnapshots((current) =>
        current.map((item) =>
          item.snapshotId === updated.snapshotId ? updated : item,
        ),
      );
      setMessage(updated.pinned ? "Snapshot protected." : "Snapshot unpinned.");
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The snapshot protection setting could not be changed.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function setArchived(snapshot: SnapshotSummary): Promise<void> {
    const archived = snapshot.archivedAt === null;
    setWorking(
      archived
        ? "Moving snapshot to archived history…"
        : "Returning snapshot to current history…",
    );
    setError(null);
    setMessage(null);
    try {
      const updated = snapshotSummarySchema.parse(
        await apiJson(
          `/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/archive`,
          {
            body: { archived },
            csrf: await loadCsrf(),
            method: "PUT",
          },
        ),
      );
      setFocusCurrentTimeline(true);
      setSnapshots((current) =>
        current.map((item) =>
          item.snapshotId === updated.snapshotId ? updated : item,
        ),
      );
      setMessage(
        archived
          ? "Snapshot archived. Its encrypted recovery data was not deleted."
          : "Snapshot returned to current history.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The snapshot archive setting could not be changed.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function repairSnapshot(snapshot: SnapshotSummary): Promise<void> {
    setWorking(
      "Checking encrypted snapshot objects and repairing from the retained library…",
    );
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      let after: string | null = null;
      let result;
      do {
        const suffix =
          after === null ? "" : `?after=${encodeURIComponent(after)}`;
        result = snapshotRepairResponseSchema.parse(
          await apiJson(
            `/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/repair${suffix}`,
            { csrf, method: "POST" },
          ),
        );
        after = result.nextPortableObjectId;
      } while (after !== null);
      setSnapshots((current) =>
        current.map((item) =>
          item.snapshotId === result.summary.snapshotId ? result.summary : item,
        ),
      );
      requestSetupReadinessRefresh();
      setMessage("Snapshot integrity checked and repaired.");
    } catch (reason: unknown) {
      await refreshTimeline().catch(() => undefined);
      setError(
        reason instanceof Error
          ? reason.message
          : "The snapshot could not be repaired from retained canonical data.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function saveRetention(): Promise<void> {
    if (estimate === null && retentionEnabled) return;
    setWorking("Saving the snapshot retention policy…");
    setError(null);
    setMessage(null);
    try {
      const csrf = await loadCsrf();
      let policy = snapshotRetentionPolicySchema.parse(
        await apiJson("/api/snapshots/retention", {
          body: {
            enabled: retentionEnabled,
            keepReadyCount: retentionKeepCount,
            maxRetainedCiphertextBytes: null,
          },
          csrf,
          method: "PUT",
        }),
      );
      if (policy.enabled) {
        const result = snapshotRetentionRunSchema.parse(
          await apiJson("/api/snapshots/retention/run", {
            csrf,
            method: "POST",
          }),
        );
        policy = result.policy;
        await refreshTimeline();
      }
      setRetention(policy);
      setMessage(
        policy.enabled
          ? `Automatic retention is on. OWD keeps ${policy.keepReadyCount} recent snapshots and always protects pinned snapshots plus the newest known-good point.`
          : "Automatic retention is off. Snapshots remain until you enable it.",
      );
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The retention policy could not be saved.",
      );
    } finally {
      setWorking(null);
    }
  }

  function renderSnapshotCard(snapshot: SnapshotSummary) {
    const captureEnd = snapshot.captureCompletedAt;
    const archived = snapshot.archivedAt !== null;
    return (
      <article key={snapshot.snapshotId}>
        <div className="snapshot-timeline-main">
          <div>
            <strong>
              {snapshot.failureCode === "snapshot_cancelled"
                ? "Capture cancelled"
                : snapshot.status === "failed"
                  ? "Capture failed"
                  : formatTimestamp(snapshot.verifiedAt)}
            </strong>
            <span>
              {snapshot.scope === "all-active"
                ? "All active vaults"
                : snapshot.scope === "selected"
                  ? "Selected vaults"
                  : "Imported copy"}
              {" · "}
              {snapshot.itemCount.toLocaleString()} items
            </span>
          </div>
          <div className="snapshot-badges">
            <span>{snapshot.encryption}</span>
            <span className={`snapshot-integrity--${snapshot.integrityStatus}`}>
              {snapshot.integrityStatus}
            </span>
            {snapshot.pinned ? <span>protected</span> : null}
            {archived ? <span>archived</span> : null}
          </div>
        </div>
        <dl className="snapshot-metrics">
          <div>
            <dt>Capture window</dt>
            <dd>
              {formatTimestamp(snapshot.captureStartedAt)} →{" "}
              {formatTimestamp(captureEnd)}
            </dd>
          </div>
          <div>
            <dt>Changed items</dt>
            <dd>{snapshot.changedItemCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Logical size</dt>
            <dd>{formatBytes(snapshot.logicalBytes)}</dd>
          </div>
          <div>
            <dt>New encrypted storage</dt>
            <dd>{formatBytes(snapshot.newlyStoredBytes)}</dd>
          </div>
        </dl>
        {viewedSnapshotId === snapshot.snapshotId ? (
          <div className="snapshot-view">
            <strong>Included vault generations</strong>
            <ul>
              {snapshot.vaults.map((vault) => (
                <li key={vault.snapshotVaultId}>
                  {vault.vaultName} · {vault.itemCount.toLocaleString()} items ·
                  generation {vault.generationId?.slice(0, 8) ?? "portable"}
                </li>
              ))}
            </ul>
            <p>
              Included: {snapshot.includedSections.join(", ")}. Unavailable:{" "}
              {snapshot.unavailableSections.length === 0
                ? "none"
                : snapshot.unavailableSections.join(", ")}
              .
            </p>
            <code>
              Snapshot record reference {snapshot.snapshotId.slice(0, 8)}
            </code>
          </div>
        ) : null}
        <div className="snapshot-actions">
          <button
            className="text-action"
            type="button"
            onClick={() =>
              setViewedSnapshotId((current) =>
                current === snapshot.snapshotId ? null : snapshot.snapshotId,
              )
            }
          >
            {viewedSnapshotId === snapshot.snapshotId ? "Close" : "View"}
          </button>
          <button
            className="text-action"
            disabled={
              working !== null || snapshot.integrityStatus !== "verified"
            }
            type="button"
            onClick={() => void setPinned(snapshot)}
          >
            {snapshot.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            className="text-action"
            disabled={
              working !== null ||
              (snapshot.status !== "ready" && snapshot.status !== "failed")
            }
            type="button"
            onClick={() => void setArchived(snapshot)}
          >
            {archived ? "Return to current" : "Archive"}
          </button>
          {snapshot.status === "creating" ? (
            <button
              className="secondary-action"
              disabled={working !== null}
              type="button"
              onClick={() => void resumeSnapshot(snapshot)}
            >
              Continue capture
            </button>
          ) : null}
          {snapshot.status === "creating" || snapshot.status === "importing" ? (
            <button
              className="danger-action"
              disabled={working !== null}
              type="button"
              onClick={() => void cancelSnapshot(snapshot)}
            >
              Cancel incomplete snapshot
            </button>
          ) : null}
          {snapshot.status === "ready" ? (
            <button
              className="secondary-action"
              disabled={working !== null}
              type="button"
              onClick={() => void repairSnapshot(snapshot)}
            >
              {snapshot.integrityStatus === "verified"
                ? "Check integrity"
                : "Repair"}
            </button>
          ) : null}
          <button
            className="primary-action"
            disabled={
              working !== null ||
              snapshot.status !== "ready" ||
              snapshot.integrityStatus !== "verified"
            }
            type="button"
            onClick={() => {
              setPortableRestoreOpen(false);
              setRestoreSnapshotId(snapshot.snapshotId);
            }}
          >
            Restore
          </button>
          {snapshot.status === "ready" &&
          snapshot.integrityStatus === "verified" ? (
            <a
              className="secondary-action"
              download={snapshotDownloadFilename(snapshot.snapshotId)}
              href={`/api/snapshots/${encodeURIComponent(snapshot.snapshotId)}/download`}
              onClick={() =>
                setDownloadRequestedSnapshotId(snapshot.snapshotId)
              }
            >
              Download encrypted copy
            </a>
          ) : (
            <button className="secondary-action" disabled type="button">
              Download encrypted copy
            </button>
          )}
        </div>
        {downloadRequestedSnapshotId === snapshot.snapshotId ? (
          <p
            className="snapshot-download-receipt"
            aria-live="polite"
            role="status"
          >
            {snapshotDownloadRequestedMessage(snapshot)}
          </p>
        ) : null}
      </article>
    );
  }

  return (
    <div className="snapshot-recovery">
      <div className="snapshot-create-heading">
        <div>
          <span className="backup-step">02 · Recovery point</span>
          <h3>Create a workspace snapshot</h3>
          <p>
            The default includes every active vault in one coordinated,
            encrypted recovery point. No vault is silently omitted.
          </p>
        </div>
        <button
          className="primary-action"
          disabled={
            disabled ||
            working !== null ||
            !recoveryKeyVerified ||
            activeVaults.length === 0 ||
            (scope === "selected" && selectedVaultIds.length === 0)
          }
          type="button"
          onClick={() => void createSnapshot()}
        >
          Create snapshot
        </button>
      </div>

      <div className="snapshot-scope-card">
        <div>
          <strong>{scopeSummary.label}</strong>
          <span>
            {scopeSummary.vaultCount.toLocaleString()} vault
            {scopeSummary.vaultCount === 1 ? "" : "s"} selected at capture start
          </span>
        </div>
        <details>
          <summary>Advanced: choose a narrower scope</summary>
          <div className="snapshot-scope-options">
            <label>
              <input
                checked={scope === "all-active"}
                name="snapshot-scope"
                type="radio"
                onChange={() => setScope("all-active")}
              />
              <span>All active vaults (recommended)</span>
            </label>
            <label>
              <input
                checked={scope === "selected"}
                name="snapshot-scope"
                type="radio"
                onChange={() => {
                  setSelectedVaultIds([]);
                  setScope("selected");
                }}
              />
              <span>Only selected vaults</span>
            </label>
            {scope === "selected" ? (
              <div className="snapshot-vault-choices">
                {activeVaults.map((vault) => (
                  <label key={vault.id}>
                    <input
                      checked={selectedVaultIds.includes(vault.id)}
                      type="checkbox"
                      onChange={(event) =>
                        setSelectedVaultIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, vault.id])]
                            : current.filter((vaultId) => vaultId !== vault.id),
                        )
                      }
                    />
                    <span>{vault.displayName ?? vault.id}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      </div>

      <div className="snapshot-scope-card">
        <div>
          <strong>Portable intelligence</strong>
          <span>
            {intelligenceSelection === "none"
              ? "Excluded from this recovery point"
              : intelligenceSelection === "approved"
                ? "Approved records and dependency closure"
                : "Approved plus quarantined Unvetted recovery"}
          </span>
        </div>
        <div className="snapshot-scope-options">
          <label>
            <input
              checked={intelligenceSelection !== "none"}
              type="checkbox"
              onChange={(event) =>
                setIntelligenceSelection(
                  event.target.checked ? "approved" : "none",
                )
              }
            />
            <span>Include Approved Intelligence (recommended)</span>
          </label>
          <label>
            <input
              checked={intelligenceSelection === "approved-and-unvetted"}
              disabled={intelligenceSelection === "none"}
              type="checkbox"
              onChange={(event) =>
                setIntelligenceSelection(
                  event.target.checked ? "approved-and-unvetted" : "approved",
                )
              }
            />
            <span>
              Also include Unvetted records for owner-only quarantined recovery
            </span>
          </label>
        </div>
      </div>

      {estimate !== null ? (
        <dl
          className="snapshot-estimate"
          aria-label="Snapshot storage estimate"
        >
          <div>
            <dt>Logical snapshot</dt>
            <dd>{formatBytes(estimate.logicalBytes)}</dd>
          </div>
          <div>
            <dt>Likely new content</dt>
            <dd>{formatBytes(estimate.projectedNewPlaintextBytes)}</dd>
          </div>
          <div>
            <dt>Reusable objects</dt>
            <dd>{estimate.reusableObjectCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Currently retained encrypted data</dt>
            <dd>{formatBytes(estimate.currentRetainedCiphertextBytes)}</dd>
          </div>
          <div>
            <dt>Approved Intelligence</dt>
            <dd>
              {estimate.intelligence.approved === null
                ? "Not included"
                : `${estimate.intelligence.approved.recordCount.toLocaleString()} records · ${formatBytes(estimate.intelligence.approved.logicalBytes)}`}
            </dd>
          </div>
          <div>
            <dt>Unvetted recovery</dt>
            <dd>
              {estimate.intelligence.unvetted === null
                ? "Not included"
                : `${estimate.intelligence.unvetted.recordCount.toLocaleString()} quarantined records · ${formatBytes(estimate.intelligence.unvetted.logicalBytes)}`}
            </dd>
          </div>
        </dl>
      ) : estimateMessage !== null ? (
        <p className="snapshot-estimate-message">{estimateMessage}</p>
      ) : null}

      <details className="snapshot-retention">
        <summary>Retention and storage controls</summary>
        <p>
          Scheduled capture remains off. If enabled, retention runs only after a
          manual snapshot and removes unpinned older points conservatively.
        </p>
        <div className="snapshot-retention-controls">
          <label>
            <input
              checked={retentionEnabled}
              type="checkbox"
              onChange={(event) => setRetentionEnabled(event.target.checked)}
            />
            <span>Automatically retain a bounded recent history</span>
          </label>
          <label>
            <span>Recent snapshots to keep</span>
            <input
              max={100}
              min={2}
              type="number"
              value={retentionKeepCount}
              onChange={(event) =>
                setRetentionKeepCount(Number(event.target.value))
              }
            />
          </label>
          <button
            className="secondary-action"
            disabled={
              working !== null ||
              retentionKeepCount < 2 ||
              retentionKeepCount > 100 ||
              (retentionEnabled && estimate === null)
            }
            type="button"
            onClick={() => void saveRetention()}
          >
            Save retention policy
          </button>
        </div>
        {retentionEnabled && estimate === null ? (
          <small>
            A current logical/new-storage estimate must be visible before
            automatic retention can be enabled.
          </small>
        ) : retention !== null ? (
          <small>
            {retention.readySnapshotCount.toLocaleString()} ready snapshots ·{" "}
            {formatBytes(retention.currentRetainedCiphertextBytes)} retained
            encrypted data · {retention.protectedSnapshotCount.toLocaleString()}{" "}
            protected
          </small>
        ) : null}
      </details>

      {!recoveryKeyVerified ? (
        <p className="recovery-task-guidance">
          Complete recovery-key step 1 above before creating a snapshot.
        </p>
      ) : null}
      {working !== null ? (
        <p className="vault-message" aria-live="polite">
          {working}
        </p>
      ) : error !== null ? (
        <p className="action-error" role="alert">
          {error}
        </p>
      ) : message !== null ? (
        <p className="backup-message" aria-live="polite">
          {message}
        </p>
      ) : null}

      <div className="snapshot-timeline-heading">
        <div>
          <h3 ref={currentTimelineHeadingRef} tabIndex={-1}>
            Your snapshots
          </h3>
          <p>Timestamped, independently restorable recovery points.</p>
        </div>
        <div>
          <button
            className="text-action"
            disabled={working !== null}
            type="button"
            onClick={() => void refreshTimeline()}
          >
            Refresh
          </button>
          <button
            aria-controls="portable-snapshot-restore"
            aria-expanded={portableRestoreOpen}
            className="secondary-action"
            disabled={working !== null}
            type="button"
            onClick={() => {
              setPortableRestoreOpen(true);
              setRestoreSnapshotId(null);
            }}
          >
            Open encrypted copy to restore
          </button>
        </div>
      </div>

      {snapshots.length === 0 ? (
        <p>No workspace snapshots yet.</p>
      ) : snapshotHistory.current.length === 0 ? (
        <p>No snapshots in current history.</p>
      ) : (
        <div className="snapshot-timeline">
          {snapshotHistory.current.map(renderSnapshotCard)}
        </div>
      )}

      {snapshotHistory.archived.length > 0 ? (
        <details className="snapshot-archive">
          <summary>
            <strong>
              {snapshotHistory.archived.length.toLocaleString()} archived
              snapshot{snapshotHistory.archived.length === 1 ? "" : "s"}
            </strong>
            <span>Hidden from current history · recovery data retained</span>
          </summary>
          <p>
            Archive is reversible presentation, not deletion. Restore, download,
            integrity, and pin controls remain available. Unpinned archived
            points remain eligible for the retention policy.
          </p>
          <div className="snapshot-timeline">
            {snapshotHistory.archived.map(renderSnapshotCard)}
          </div>
        </details>
      ) : null}

      {selectedSnapshot !== null || portableRestoreOpen ? (
        <SnapshotRestorePanel
          activeVaults={activeVaults}
          initialSnapshot={selectedSnapshot}
          onApplied={onRestoreApplied}
          onClose={() => {
            setRestoreSnapshotId(null);
            setPortableRestoreOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
