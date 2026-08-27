import type { ObsidianMindRuntimeProfile } from "@mdevolved/contracts";

type VisibilityGrant = {
  pathKeyPrefixes: string[];
  runtimeProfile: ObsidianMindRuntimeProfile | null;
};

export type AgentVisibility = {
  denyAll: boolean;
  excludePrivate: boolean;
  neverExposeFileNames: string[];
  pathKeyPrefixes: string[];
  runtimeProfile: ObsidianMindRuntimeProfile | null;
};

function folderKey(value: string): string {
  return `${value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/\/+$/u, "")}/`;
}

function minimalPrefixes(values: string[]): string[] {
  const unique = [...new Set(values)].sort();
  return unique.filter(
    (candidate, index) =>
      !unique.some(
        (other, otherIndex) =>
          otherIndex !== index && candidate.startsWith(other),
      ),
  );
}

function intersectPrefixes(
  grantedPrefixes: string[],
  profileRoots: string[],
): string[] {
  const profilePrefixes = profileRoots.map(folderKey);
  if (grantedPrefixes.length === 0) return minimalPrefixes(profilePrefixes);
  const granted = grantedPrefixes.map(folderKey);
  const intersections: string[] = [];
  for (const grant of granted) {
    for (const profile of profilePrefixes) {
      if (profile.startsWith(grant)) intersections.push(profile);
      else if (grant.startsWith(profile)) intersections.push(grant);
    }
  }
  return minimalPrefixes(intersections);
}

export function agentVisibilityForGrant(
  grant: VisibilityGrant,
): AgentVisibility {
  if (grant.runtimeProfile === null) {
    return {
      denyAll: false,
      excludePrivate: false,
      neverExposeFileNames: [],
      pathKeyPrefixes: grant.pathKeyPrefixes,
      runtimeProfile: null,
    };
  }
  const pathKeyPrefixes = intersectPrefixes(
    grant.pathKeyPrefixes,
    grant.runtimeProfile.contentRoots,
  );
  return {
    denyAll: pathKeyPrefixes.length === 0,
    excludePrivate: true,
    neverExposeFileNames: grant.runtimeProfile.neverExposeFileNames.map(
      (value) => value.normalize("NFC").toLocaleLowerCase("en-US"),
    ),
    pathKeyPrefixes,
    runtimeProfile: grant.runtimeProfile,
  };
}

export function visibilityAllowsPath(
  visibility: AgentVisibility,
  pathKey: string,
): boolean {
  if (visibility.denyAll) return false;
  const normalized = pathKey.normalize("NFC").toLocaleLowerCase("en-US");
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (visibility.neverExposeFileNames.includes(fileName)) return false;
  return (
    visibility.pathKeyPrefixes.length === 0 ||
    visibility.pathKeyPrefixes.some((prefix) => normalized.startsWith(prefix))
  );
}

export function visibilityAllowsPrefix(
  visibility: AgentVisibility,
  pathKey: string,
): boolean {
  if (visibility.denyAll) return false;
  const normalized = pathKey
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/\/+$/u, "");
  if (visibility.pathKeyPrefixes.length === 0) return true;
  return visibility.pathKeyPrefixes.some((prefix) => {
    const root = prefix.replace(/\/+$/u, "");
    return normalized === root || normalized.startsWith(`${root}/`);
  });
}
