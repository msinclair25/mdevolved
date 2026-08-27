export const MINIMUM_PLUGIN_VERSION = "0.1.7";
export const RECOMMENDED_PLUGIN_VERSION = "0.2.0-alpha.1";

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: match[4] !== undefined,
  };
}

export function pluginVersionSupported(value: string): boolean {
  const candidate = parseVersion(value);
  const minimum = parseVersion(MINIMUM_PLUGIN_VERSION);
  if (candidate === null || minimum === null) return false;
  for (const key of ["major", "minor", "patch"] as const) {
    if (candidate[key] > minimum[key]) return true;
    if (candidate[key] < minimum[key]) return false;
  }
  return !candidate.prerelease || minimum.prerelease;
}
