import { describe, expect, it, vi } from "vitest";
import {
  createBackupWithPreparedSource,
  settleMaterializationJob,
} from "../src/backup-workflow";

describe("one-click backup preparation", () => {
  it("prepares a first-time vault before creating its backup", async () => {
    const calls: string[] = [];

    await expect(
      createBackupWithPreparedSource({
        create: async () => {
          calls.push("create");
          return "backup";
        },
        prepare: async () => {
          calls.push("prepare");
        },
        sourceReady: false,
      }),
    ).resolves.toBe("backup");
    expect(calls).toEqual(["prepare", "create"]);
  });

  it("uses an existing prepared source without creating another one", async () => {
    const prepare = vi.fn(async () => undefined);
    const create = vi.fn(async () => "backup");

    await createBackupWithPreparedSource({
      create,
      prepare,
      sourceReady: true,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it("stops safely when first-time preparation fails", async () => {
    const create = vi.fn(async () => "backup");

    await expect(
      createBackupWithPreparedSource({
        create,
        prepare: async () => {
          throw new Error("preparation failed");
        },
        sourceReady: false,
      }),
    ).rejects.toThrow("preparation failed");
    expect(create).not.toHaveBeenCalled();
  });

  it("waits on the read-only status contract until preparation completes", async () => {
    const waits: string[] = [];
    const poll = vi
      .fn()
      .mockResolvedValueOnce({
        failureCode: null,
        generation: null,
        jobId: "11111111-1111-4111-8111-111111111111",
        processedNoteCount: 16,
        status: "running",
        totalNoteCount: 20,
        vaultId: "22222222-2222-4222-8222-222222222222",
      })
      .mockResolvedValueOnce({
        failureCode: null,
        generation: {
          completedAt: 3,
          createdAt: 1,
          generationId: "33333333-3333-4333-8333-333333333333",
          noteCount: 20,
          sourceStateVectorSha256: "a".repeat(64),
          totalBytes: 200,
          vaultId: "22222222-2222-4222-8222-222222222222",
        },
        jobId: "11111111-1111-4111-8111-111111111111",
        processedNoteCount: 20,
        status: "completed",
        totalNoteCount: 20,
        vaultId: "22222222-2222-4222-8222-222222222222",
      });

    const settled = await settleMaterializationJob({
      initialJob: {
        failureCode: null,
        generation: null,
        jobId: "11111111-1111-4111-8111-111111111111",
        processedNoteCount: 0,
        status: "queued",
        totalNoteCount: 20,
        vaultId: "22222222-2222-4222-8222-222222222222",
      },
      maxAttempts: 3,
      onProgress: (job) => waits.push(job.status),
      poll,
      wait: async () => undefined,
    });

    expect(settled.status).toBe("completed");
    expect(waits).toEqual(["queued", "running"]);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});
