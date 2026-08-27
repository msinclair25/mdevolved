import {
  ALBATROSS_COMPATIBILITY_PROFILE,
  ALBATROSS_CONTINUITY_GUIDANCE,
  ALBATROSS_PROFILE_PROMPT,
  ALBATROSS_WORKSPACE_PROMPT,
  createAlbatrossAuthorizationCommand,
  createAlbatrossMcpMergeConfig,
  createAlbatrossSetupKit,
  type OwdAlbatrossCompatibilityProfile,
} from "./albatross";
import {
  type Canonicalized,
  canonicalizePackText,
  canonicalizePackValue,
  legacyPackCompatibilityNote,
} from "./canonical";

export type MDevolvedAlbatrossCompatibilityProfile =
  Canonicalized<OwdAlbatrossCompatibilityProfile> & {
    legacyCompatibility: Record<string, string>;
  };

export const MDEVOLVED_ALBATROSS_PROFILE_RESOURCE_URI = canonicalizePackValue(
  "owd://compatibility-profiles/albatross/v1",
);

export const MDEVOLVED_ALBATROSS_COMPATIBILITY_PROFILE = {
  ...canonicalizePackValue(ALBATROSS_COMPATIBILITY_PROFILE),
  legacyCompatibility: {
    serverName: "owd",
    receipt: ".owdignore",
    rule: "Read this legacy configuration only when no canonical MDevolved configuration exists; do not delete, rewrite, or re-authorize it.",
  },
} satisfies MDevolvedAlbatrossCompatibilityProfile;

export function createMDevolvedAlbatrossAuthorizationCommand(
  mcpUrl: string,
  participantId?: string,
): string {
  return canonicalizePackValue(
    createAlbatrossAuthorizationCommand(mcpUrl, participantId),
  );
}

export function createMDevolvedAlbatrossMcpMergeConfig(
  mcpUrl: string,
  participantId?: string,
): string {
  return canonicalizePackValue(
    createAlbatrossMcpMergeConfig(mcpUrl, participantId),
  );
}

export function createMDevolvedAlbatrossSetupKit(
  mcpUrl: string,
  participantId?: string,
): string {
  return `${canonicalizePackText(createAlbatrossSetupKit(mcpUrl, participantId))}\n\n${legacyPackCompatibilityNote()}`;
}

export function serializeMDevolvedAlbatrossCompatibilityProfile(): string {
  return `${JSON.stringify(MDEVOLVED_ALBATROSS_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const MDEVOLVED_ALBATROSS_WORKSPACE_PROMPT = `${canonicalizePackText(ALBATROSS_WORKSPACE_PROMPT)}\n\n${legacyPackCompatibilityNote()}`;
export const MDEVOLVED_ALBATROSS_CONTINUITY_GUIDANCE = `${canonicalizePackText(ALBATROSS_CONTINUITY_GUIDANCE)}\n\n- ${legacyPackCompatibilityNote()}`;
export const MDEVOLVED_ALBATROSS_PROFILE_PROMPT = `${canonicalizePackText(ALBATROSS_PROFILE_PROMPT)}\n\n${legacyPackCompatibilityNote()}`;
