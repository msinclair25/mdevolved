import { describe, expect, it } from "vitest";
import {
  readOperationalRegionPreference,
  writeOperationalRegionPreference,
} from "../src/OperationalRegion";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    value: () => value,
  };
}

describe("operational region presentation preferences", () => {
  it("remembers independent disclosure choices without treating them as workflow state", () => {
    const storage = memoryStorage();

    writeOperationalRegionPreference(storage, "agents", true);
    writeOperationalRegionPreference(storage, "library", false);

    expect(readOperationalRegionPreference(storage, "agents")).toBe(true);
    expect(readOperationalRegionPreference(storage, "library")).toBe(false);
    expect(
      readOperationalRegionPreference(storage, "recovery"),
    ).toBeUndefined();
  });

  it("ignores malformed and non-boolean stored values", () => {
    const malformed = memoryStorage("{");
    const mixed = memoryStorage(
      JSON.stringify({ agents: "open", library: true, recovery: null }),
    );

    expect(
      readOperationalRegionPreference(malformed, "agents"),
    ).toBeUndefined();
    expect(readOperationalRegionPreference(mixed, "agents")).toBeUndefined();
    expect(readOperationalRegionPreference(mixed, "library")).toBe(true);
    expect(readOperationalRegionPreference(mixed, "recovery")).toBeUndefined();
  });

  it("does not let unavailable device storage block an owner action", () => {
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };

    expect(() =>
      writeOperationalRegionPreference(unavailable, "collaboration", true),
    ).not.toThrow();
  });
});
