import { describe, expect, it, vi } from "vitest";
import {
  captureOwnerClaimToken,
  clearOwnerClaimToken,
  readOwnerClaimToken,
  type ClaimBrowser,
} from "../src/owner-claim-token";

const TOKEN = "a".repeat(43);

function browserWithFragment(hash: string): {
  browser: ClaimBrowser;
  replaceState: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  const replaceState = vi.fn();
  return {
    browser: {
      history: { replaceState, state: { retained: true } },
      location: {
        hash,
        pathname: "/",
        search: "?source=pilot",
      },
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        removeItem: (key) => {
          values.delete(key);
        },
        setItem: (key, value) => {
          values.set(key, value);
        },
      },
    },
    replaceState,
    values,
  };
}

describe("managed owner invitation capture", () => {
  it("moves an exact claim fragment into tab-only storage and strips the URL", () => {
    const fixture = browserWithFragment(`#claim=${TOKEN}`);

    expect(captureOwnerClaimToken(fixture.browser)).toBe(TOKEN);
    expect(readOwnerClaimToken(fixture.browser.sessionStorage)).toBe(TOKEN);
    expect(fixture.replaceState).toHaveBeenCalledWith(
      { retained: true },
      "",
      "/?source=pilot",
    );
  });

  it("strips malformed or ambiguous claim fragments without retaining them", () => {
    for (const fragment of [
      "#claim=short",
      `#claim=${TOKEN}&claim=${TOKEN}`,
      `#claim=${TOKEN}&extra=value`,
    ]) {
      const fixture = browserWithFragment(fragment);
      expect(captureOwnerClaimToken(fixture.browser)).toBeNull();
      expect(readOwnerClaimToken(fixture.browser.sessionStorage)).toBeNull();
      expect(fixture.replaceState).toHaveBeenCalledOnce();
    }
  });

  it("leaves unrelated fragments alone and clears a consumed token", () => {
    const fixture = browserWithFragment("#vaults");
    fixture.browser.sessionStorage.setItem("owd.owner-claim-token", TOKEN);

    expect(captureOwnerClaimToken(fixture.browser)).toBe(TOKEN);
    expect(fixture.replaceState).not.toHaveBeenCalled();

    clearOwnerClaimToken(fixture.browser.sessionStorage);
    expect(readOwnerClaimToken(fixture.browser.sessionStorage)).toBeNull();
  });
});
