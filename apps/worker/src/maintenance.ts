import { expireInitializations } from "./project-initialization-store";
import { runCollaborationGarbageCollection } from "./collaboration-retention";
import {
  queueObsoleteMaterializations,
  runMaterializationGarbageCollection,
} from "./materialization-retention";
import { cleanupExpiredRestores } from "./restore-store";
import {
  queueFailedSnapshotCleanup,
  runSnapshotGarbageCollection,
} from "./snapshot-retention";

export async function runScheduledMaintenance(
  env: Env,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const results = await Promise.allSettled([
    cleanupExpiredRestores(env.DB, env.VAULT_STORAGE, now),
    expireInitializations(env.DB, now),
    runCollaborationGarbageCollection(env.DB, env.VAULT_STORAGE, now),
    queueObsoleteMaterializations(env.DB, now).then(() =>
      runMaterializationGarbageCollection(env.DB, env.VAULT_STORAGE, now),
    ),
    queueFailedSnapshotCleanup(env.DB, now).then(() =>
      runSnapshotGarbageCollection(env.DB, env.VAULT_STORAGE, { now }),
    ),
  ]);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          error:
            result.reason instanceof Error
              ? result.reason.name
              : "UnknownError",
          event: [
            "restore.cleanup.failed",
            "project.initialization_cleanup.failed",
            "collaboration.cleanup.failed",
            "materialization.cleanup.failed",
            "snapshot.cleanup.failed",
          ][index],
          level: "error",
        }),
      );
    }
  }
}
