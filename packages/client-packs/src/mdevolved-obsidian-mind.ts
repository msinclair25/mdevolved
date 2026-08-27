import {
  OBSIDIAN_MIND_COMPATIBILITY_PROFILE,
  OBSIDIAN_MIND_CONTINUITY_GUIDANCE,
  OBSIDIAN_MIND_PROFILE_PROMPT,
  createObsidianMindMcpMergeConfig,
  createObsidianMindProjectMcpCommand,
  type OwdVaultRuntimeCompatibilityProfile,
} from "./obsidian-mind";
import {
  type Canonicalized,
  canonicalizePackText,
  canonicalizePackValue,
  legacyPackCompatibilityNote,
} from "./canonical";

export type MDevolvedObsidianMindCompatibilityProfile =
  Canonicalized<OwdVaultRuntimeCompatibilityProfile> & {
    legacyCompatibility: Record<string, string>;
  };

export const MDEVOLVED_OBSIDIAN_MIND_PROFILE_RESOURCE_URI =
  canonicalizePackValue("owd://compatibility-profiles/obsidian-mind/v1");
export const MDEVOLVED_OBSIDIAN_MIND_COMPATIBILITY_PROFILE = {
  ...canonicalizePackValue(OBSIDIAN_MIND_COMPATIBILITY_PROFILE),
  legacyCompatibility: {
    serverName: "owd",
    receipt: ".owdignore",
    rule: "Read this legacy configuration only when no canonical MDevolved configuration exists; do not delete, rewrite, or re-authorize it.",
  },
} satisfies MDevolvedObsidianMindCompatibilityProfile;

export function createMDevolvedObsidianMindProjectMcpCommand(
  mcpUrl: string,
): string {
  return canonicalizePackText(createObsidianMindProjectMcpCommand(mcpUrl));
}

export function createMDevolvedObsidianMindMcpMergeConfig(
  mcpUrl: string,
): string {
  return canonicalizePackText(createObsidianMindMcpMergeConfig(mcpUrl));
}

export function serializeMDevolvedObsidianMindCompatibilityProfile(): string {
  return `${JSON.stringify(MDEVOLVED_OBSIDIAN_MIND_COMPATIBILITY_PROFILE, null, 2)}\n`;
}

export const MDEVOLVED_OBSIDIAN_MIND_CONTINUITY_GUIDANCE = `${canonicalizePackText(OBSIDIAN_MIND_CONTINUITY_GUIDANCE)}\n\n- ${legacyPackCompatibilityNote()}`;
export const MDEVOLVED_OBSIDIAN_MIND_PROFILE_PROMPT = `${canonicalizePackText(OBSIDIAN_MIND_PROFILE_PROMPT)}\n\n${legacyPackCompatibilityNote()}`;
