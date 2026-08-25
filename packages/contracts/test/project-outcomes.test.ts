import {
  projectOutcomeResponseSchema,
  projectOutcomeSchema,
} from "../src/project-outcomes";
import { describe, expect, it } from "vitest";

describe("Project outcome contract", () => {
  it("accepts the privacy-safe zero state", () => {
    expect(
      projectOutcomeResponseSchema.parse({
        ok: true,
        outcome: {
          acceptedMemoryCount: 0,
          attention: "checkpoint_again",
          checkpointedByMultipleClients: false,
          latestCheckpointAt: null,
          pendingSuggestionCount: 0,
          readiness: "not_started",
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects identifiers and unbounded/private fields", () => {
    expect(() =>
      projectOutcomeSchema.parse({
        acceptedMemoryCount: 1,
        attention: "none",
        checkpointedByMultipleClients: true,
        latestCheckpointAt: 10,
        pendingSuggestionCount: 0,
        projectId: crypto.randomUUID(),
        readiness: "ready",
      }),
    ).toThrow();
  });
});
