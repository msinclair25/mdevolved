import type { MaterializationJob } from "@mdevolved/contracts";

export async function createBackupWithPreparedSource<T>(input: {
  create: () => Promise<T>;
  prepare: () => Promise<void>;
  sourceReady: boolean;
}): Promise<T> {
  if (!input.sourceReady) await input.prepare();
  return input.create();
}

export async function settleMaterializationJob(input: {
  initialJob: MaterializationJob;
  maxAttempts: number;
  onProgress?: (job: MaterializationJob) => void;
  poll: (job: MaterializationJob) => Promise<MaterializationJob>;
  wait: () => Promise<void>;
}): Promise<MaterializationJob> {
  let job = input.initialJob;
  for (
    let attempt = 0;
    attempt < input.maxAttempts &&
    (job.status === "queued" || job.status === "running");
    attempt += 1
  ) {
    input.onProgress?.(job);
    await input.wait();
    job = await input.poll(job);
  }
  return job;
}
