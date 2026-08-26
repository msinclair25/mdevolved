import { describe, expect, it } from "vitest";
import { toDerSignature } from "./webauthn-fixture";

describe("synthetic WebAuthn signatures", () => {
  it("converts a raw signature whose first random byte resembles a DER sequence", () => {
    const rawSignature = new Uint8Array(64).fill(1);
    rawSignature[0] = 0x30;

    const derSignature = toDerSignature(rawSignature);

    expect(derSignature).not.toEqual(rawSignature);
    expect(Array.from(derSignature.slice(0, 4))).toEqual([0x30, 68, 0x02, 32]);
    expect(derSignature).toHaveLength(70);
  });
});
