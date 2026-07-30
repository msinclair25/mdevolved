const OWNER_CLAIM_STORAGE_KEY = "owd.owner-claim-token";
const claimTokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;

export type ClaimBrowser = {
  history: {
    readonly state: unknown;
    replaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void;
  };
  location: {
    readonly hash: string;
    readonly pathname: string;
    readonly search: string;
  };
  sessionStorage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
};

export function captureOwnerClaimToken(
  browser: ClaimBrowser = window,
): string | null {
  const fragment = browser.location.hash;
  if (!fragment.startsWith("#claim=")) {
    return readOwnerClaimToken(browser.sessionStorage);
  }

  const params = new URLSearchParams(fragment.slice(1));
  const values = params.getAll("claim");
  const token =
    [...params.keys()].length === 1 &&
    values.length === 1 &&
    claimTokenPattern.test(values[0] ?? "")
      ? (values[0] ?? null)
      : null;

  if (token !== null) {
    browser.sessionStorage.setItem(OWNER_CLAIM_STORAGE_KEY, token);
  } else {
    browser.sessionStorage.removeItem(OWNER_CLAIM_STORAGE_KEY);
  }

  browser.history.replaceState(
    browser.history.state,
    "",
    `${browser.location.pathname}${browser.location.search}`,
  );
  return token;
}

export function readOwnerClaimToken(
  storage: Pick<Storage, "getItem"> = window.sessionStorage,
): string | null {
  const token = storage.getItem(OWNER_CLAIM_STORAGE_KEY);
  return token !== null && claimTokenPattern.test(token) ? token : null;
}

export function clearOwnerClaimToken(
  storage: Pick<Storage, "removeItem"> = window.sessionStorage,
): void {
  storage.removeItem(OWNER_CLAIM_STORAGE_KEY);
}
