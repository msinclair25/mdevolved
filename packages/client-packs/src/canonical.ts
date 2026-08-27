/**
 * Convert a legacy client-pack value to the canonical MDevolved spelling.
 *
 * This is deliberately limited to compatibility-pack material. It must not be
 * used for persisted records, protocol identifiers, or storage names: those
 * surfaces keep their explicit aliases and migration rules elsewhere.
 */
export type Canonicalized<T> = T extends string
  ? string
  : T extends readonly (infer Item)[]
    ? readonly Canonicalized<Item>[]
    : T extends object
      ? { [Key in keyof T]: Canonicalized<T[Key]> }
      : T;

export function canonicalizePackValue<T>(value: T): Canonicalized<T> {
  if (typeof value === "string") {
    return value
      .replaceAll("OWD", "MDevolved")
      .replaceAll("owd", "mdevolved")
      .replaceAll("md-evolved", "mdevolved") as Canonicalized<T>;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizePackValue(item)) as Canonicalized<T>;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        canonicalizePackValue(item),
      ]),
    ) as Canonicalized<T>;
  }
  return value as Canonicalized<T>;
}

export function legacyPackCompatibilityNote(receipt = ".owdignore"): string {
  return `Legacy MDevolved pack aliases remain readable: the pre-MD9 \`owd\`/\`OWD\` server/tool names, \`${receipt}\`, and the phrase \`OWD resume project\` must not be deleted or re-authorized. Use the canonical MDevolved names for new configuration.`;
}

export function canonicalizePackText(value: string): string {
  return canonicalizePackValue(value)
    .replaceAll(
      "the legacy phrase `MDevolved resume project`",
      "the legacy phrase `OWD resume project`",
    )
    .replaceAll(
      "the legacy phrase **MDevolved resume project**",
      "the legacy phrase **OWD resume project**",
    )
    .replaceAll(
      'the legacy phrase "MDevolved resume project"',
      'the legacy phrase "OWD resume project"',
    )
    .replaceAll(
      "The legacy phrase `Connect this project to MDevolved.` remains equivalent.",
      "The legacy phrase `Connect this project to OWD.` remains equivalent.",
    );
}
