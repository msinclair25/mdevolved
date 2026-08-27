import {
  EVE_COMPATIBILITY_PROFILE,
  EVE_CONNECTION_DESCRIPTION,
  EVE_CONNECTION_INSTRUCTIONS,
  EVE_CONTINUITY_GUIDANCE,
  EVE_PROFILE_PROMPT,
  createEveConnectionSource,
  type OwdEveCompatibilityProfile,
} from "./eve";
import {
  type Canonicalized,
  canonicalizePackText,
  canonicalizePackValue,
  legacyPackCompatibilityNote,
} from "./canonical";

export type MDevolvedEveCompatibilityProfile =
  Canonicalized<OwdEveCompatibilityProfile> & {
    legacyCompatibility: Record<string, string>;
  };

export const MDEVOLVED_EVE_PROFILE_RESOURCE_URI = canonicalizePackValue(
  "owd://compatibility-profiles/eve/v1",
);
export const MDEVOLVED_EVE_COMPATIBILITY_PROFILE = {
  ...canonicalizePackValue(EVE_COMPATIBILITY_PROFILE),
  legacyCompatibility: {
    connectionName: "owd",
    receipt: ".owdignore",
    rule: "Read this legacy configuration only when no canonical MDevolved configuration exists; do not delete, rewrite, or re-authorize it.",
  },
} satisfies MDevolvedEveCompatibilityProfile;
export const MDEVOLVED_EVE_CONNECTION_DESCRIPTION = canonicalizePackValue(
  EVE_CONNECTION_DESCRIPTION,
);
export const MDEVOLVED_EVE_CONNECTION_INSTRUCTIONS = canonicalizePackValue(
  EVE_CONNECTION_INSTRUCTIONS,
);

export function createMDevolvedEveConnectionSource(
  mcpUrl: string,
  connectorUid?: string,
): string {
  return `${canonicalizePackText(createEveConnectionSource(mcpUrl, connectorUid))}\n// ${legacyPackCompatibilityNote()}`;
}

export function serializeMDevolvedEveCompatibilityProfile(): string {
  return `${JSON.stringify(MDEVOLVED_EVE_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const MDEVOLVED_EVE_CONTINUITY_GUIDANCE = `${canonicalizePackText(EVE_CONTINUITY_GUIDANCE)}\n\n- ${legacyPackCompatibilityNote()}`;
export const MDEVOLVED_EVE_PROFILE_PROMPT = `${canonicalizePackText(EVE_PROFILE_PROMPT)}\n\n${legacyPackCompatibilityNote()}`;
