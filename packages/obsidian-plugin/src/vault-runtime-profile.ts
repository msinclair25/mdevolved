export type ObsidianMindRuntimeProfile = {
  contentRoots: string[];
  id: "obsidian-mind";
  memoryRoot: string;
  neverExposeFileNames: string[];
  version: string;
};

type Manifest = Record<string, unknown>;

const FALLBACK_ROOTS = ["brain", "reference"];
const MAX_CONTENT_ROOTS = 32;
const MAX_NEVER_EXPOSE_FILES = 64;

function isRecord(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase("en-US");
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()];
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

/**
 * Preserve the granularity of Obsidian Mind's own exposure resolver. A final
 * file glob such as brain/*.md safely maps to its parent folder. A dynamic
 * folder glob such as perf/h*-* is dropped because widening it to perf would
 * expose more than the manifest declared.
 */
function cleanRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/^\.\//u, "");
    const endsInFolder = /[\\/]$/u.test(trimmed);
    const normalized = trimmed.replace(/^[\\/]+|[\\/]+$/gu, "");
    if (normalized === "") continue;
    const parts = normalized.split(/[\\/]/u);
    if (
      parts.some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          hasControlCharacters(part),
      )
    ) {
      continue;
    }
    const globIndex = parts.findIndex((part) => part.includes("*"));
    if (globIndex === -1) {
      roots.push(parts.join("/"));
      continue;
    }
    if (
      !endsInFolder &&
      globIndex === parts.length - 1 &&
      globIndex > 0 &&
      parts[globIndex] === "*.md"
    ) {
      roots.push(parts.slice(0, globIndex).join("/"));
    }
  }
  return uniqueCaseInsensitive(roots).slice(0, MAX_CONTENT_ROOTS);
}

function cleanNeverExposeFileNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueCaseInsensitive(
    value.flatMap((raw) => {
      if (
        typeof raw !== "string" ||
        raw.length === 0 ||
        raw.length > 255 ||
        raw.includes("/") ||
        raw.includes("\\") ||
        hasControlCharacters(raw)
      ) {
        return [];
      }
      return [raw];
    }),
  ).slice(0, MAX_NEVER_EXPOSE_FILES);
}

function cleanMemoryRoot(value: unknown): string {
  const roots = cleanRoots([value]);
  return roots[0] ?? "memories";
}

function withoutMemoryRoot(roots: string[], memoryRoot: string): string[] {
  const memoryKey = memoryRoot.toLocaleLowerCase("en-US");
  return roots.filter((root) => {
    const key = root.toLocaleLowerCase("en-US");
    return key !== memoryKey && !key.startsWith(`${memoryKey}/`);
  });
}

export function parseObsidianMindRuntimeProfile(
  manifestText: string,
): ObsidianMindRuntimeProfile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.template !== "obsidian-mind" ||
    typeof parsed.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.version)
  ) {
    return null;
  }

  const memoryRoot = cleanMemoryRoot(parsed.memory_root);
  const declaredRoots = cleanRoots(parsed.mcp_exposed_roots);
  const derivedRoots = cleanRoots(parsed.user_content_roots);
  const contentRoots = withoutMemoryRoot(
    declaredRoots.length > 0
      ? declaredRoots
      : derivedRoots.length > 0
        ? derivedRoots
        : FALLBACK_ROOTS,
    memoryRoot,
  );
  if (contentRoots.length === 0) return null;

  return {
    contentRoots,
    id: "obsidian-mind",
    memoryRoot,
    neverExposeFileNames: cleanNeverExposeFileNames(parsed.mcp_never_expose),
    version: parsed.version,
  };
}
