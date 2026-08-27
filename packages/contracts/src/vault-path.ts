export const MAX_VAULT_PATH_BYTES = 1_024;
export const MAX_VAULT_PATH_SEGMENT_BYTES = 255;

const WINDOWS_RESERVED_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/u;
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const DRIVE_ROOT = /^[A-Za-z]:/u;

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

export type VaultPathFailureReason =
  | "absolute"
  | "backslash"
  | "control_or_format"
  | "empty"
  | "empty_segment"
  | "not_markdown"
  | "not_nfc"
  | "obsidian"
  | "path_too_long"
  | "reserved_character"
  | "reserved_name"
  | "segment_too_long"
  | "trailing_period"
  | "trailing_separator"
  | "trailing_space"
  | "unsafe_segment";

export type ValidatedVaultPath = {
  path: string;
  pathKey: string;
  title: string;
};

export type PreparedMarkdownNotePath =
  { changed: boolean; ok: true; path: string } | { message: string; ok: false };

export class VaultPathError extends Error {
  readonly reason: VaultPathFailureReason;

  constructor(reason: VaultPathFailureReason) {
    super("vault_path_invalid");
    this.name = "VaultPathError";
    this.reason = reason;
  }
}

function invalidPath(reason: VaultPathFailureReason): never {
  throw new VaultPathError(reason);
}

/**
 * Validate an Obsidian note path without repairing it. Rejecting ambiguous
 * input keeps one canonical D1/R2 identity across macOS, Windows, and Linux.
 */
export function validateMarkdownVaultPath(value: string): ValidatedVaultPath {
  if (value.length === 0) return invalidPath("empty");
  if (value !== value.normalize("NFC")) return invalidPath("not_nfc");
  if (utf8ByteLength(value) > MAX_VAULT_PATH_BYTES) {
    return invalidPath("path_too_long");
  }
  if (CONTROL_OR_FORMAT_CHARACTER.test(value)) {
    return invalidPath("control_or_format");
  }
  if (WINDOWS_RESERVED_CHARACTER.test(value)) {
    return invalidPath("reserved_character");
  }
  if (value.includes("\\")) return invalidPath("backslash");
  if (value.startsWith("/") || DRIVE_ROOT.test(value)) {
    return invalidPath("absolute");
  }
  if (value.includes("//")) return invalidPath("empty_segment");
  if (value.endsWith("/")) return invalidPath("trailing_separator");

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return invalidPath("empty_segment");
    if (segment === "." || segment === "..") {
      return invalidPath("unsafe_segment");
    }
    if (segment.endsWith(".")) return invalidPath("trailing_period");
    if (segment.endsWith(" ")) return invalidPath("trailing_space");
    if (utf8ByteLength(segment) > MAX_VAULT_PATH_SEGMENT_BYTES) {
      return invalidPath("segment_too_long");
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      return invalidPath("reserved_name");
    }
  }

  if (segments[0]?.toLowerCase() === ".obsidian") {
    return invalidPath("obsidian");
  }
  if (!value.toLowerCase().endsWith(".md")) {
    return invalidPath("not_markdown");
  }

  const filename = segments.at(-1);
  if (filename === undefined) return invalidPath("empty");

  return {
    path: value,
    pathKey: value.toLowerCase(),
    title: filename.slice(0, -3),
  };
}

function friendlyPathError(reason: VaultPathFailureReason): string {
  switch (reason) {
    case "empty":
      return "Enter a note name.";
    case "absolute":
      return "Choose a location inside this vault, such as Projects/Ideas.";
    case "backslash":
      return "Use / between folder names instead of a backslash.";
    case "control_or_format":
    case "not_nfc":
      return "Remove invisible or unsupported characters from the note name.";
    case "empty_segment":
      return "Remove repeated slashes or empty folder names.";
    case "not_markdown":
      return "Use a Markdown note name ending in .md, or omit the extension.";
    case "obsidian":
      return "MDevolved cannot create notes inside the vault's .obsidian folder.";
    case "path_too_long":
      return "Shorten the note name or folder location.";
    case "reserved_character":
      return 'Remove any of these reserved characters: < > : " | ? *';
    case "reserved_name":
      return "Choose a different note or folder name; that name is reserved by the operating system.";
    case "segment_too_long":
      return "Shorten one of the folder or note names.";
    case "trailing_period":
    case "trailing_space":
      return "Remove the period or space at the end of a folder or note name.";
    case "trailing_separator":
      return "Add a note name after the final folder.";
    case "unsafe_segment":
      return "Do not use . or .. as a folder name.";
  }
}

/**
 * Convert a friendly note name or location into the exact Markdown path that
 * the strict validator accepts. The caller should show the returned path before
 * submitting it so normalization is never hidden from the owner.
 */
export function prepareMarkdownNotePath(
  value: string,
): PreparedMarkdownNotePath {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) {
    return { message: friendlyPathError("empty"), ok: false };
  }
  if (normalized.endsWith("/")) {
    return { message: friendlyPathError("trailing_separator"), ok: false };
  }

  const candidate = normalized.toLowerCase().endsWith(".md")
    ? normalized
    : `${normalized}.md`;
  try {
    return {
      changed: candidate !== value,
      ok: true,
      path: validateMarkdownVaultPath(candidate).path,
    };
  } catch (error: unknown) {
    if (error instanceof VaultPathError) {
      return { message: friendlyPathError(error.reason), ok: false };
    }
    throw error;
  }
}
