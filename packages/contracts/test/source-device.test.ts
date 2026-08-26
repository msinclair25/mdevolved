import fixture from "../fixtures/owd-source-device-v1.json";
import {
  portableSourceDeviceSchema,
  sourceBoundarySchema,
  sourceDeviceEnrollmentSchema,
} from "../src";
import { describe, expect, it } from "vitest";

describe("MD4 source device contracts", () => {
  it("freezes an exact provider-neutral source boundary", () => {
    const boundary = sourceBoundarySchema.parse(fixture.boundary);
    expect(boundary.root).toBe(".");
    expect(boundary.pathPolicy).toBe("mdevolved-markdown-v1");
    expect(
      sourceBoundarySchema.safeParse({ ...boundary, root: "/Users/example" })
        .success,
    ).toBe(false);
  });

  it("requires a unique device, local-root proof, credential hash, and replay key", () => {
    const enrollment = sourceDeviceEnrollmentSchema.parse({
      contractVersion: 1,
      deviceId: crypto.randomUUID(),
      displayName: "Disposable device A",
      rootFingerprintSha256: "c".repeat(64),
      boundary: fixture.boundary,
      credentialSha256: "d".repeat(64),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(enrollment.credentialSha256).toHaveLength(64);
    expect(
      sourceDeviceEnrollmentSchema.safeParse({
        ...enrollment,
        credential: "raw-secret-must-not-cross-the-contract",
      }).success,
    ).toBe(false);
  });

  it("restores device history only as inert quarantine", () => {
    const portable = portableSourceDeviceSchema.parse(fixture);
    expect(portable.authorityRestored).toBe(false);
    expect(portable.credentialRestored).toBe(false);
    expect(portable.connectionRestored).toBe(false);
    expect(
      portableSourceDeviceSchema.safeParse({
        ...portable,
        credentialRestored: true,
      }).success,
    ).toBe(false);
  });
});
