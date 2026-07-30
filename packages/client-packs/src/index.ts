export {
  EVE_COMPATIBILITY_PROFILE,
  EVE_CONNECTION_DESCRIPTION,
  EVE_CONNECTION_INSTRUCTIONS,
  EVE_CONTINUITY_GUIDANCE,
  EVE_PROFILE_PROMPT,
  EVE_PROFILE_RESOURCE_URI,
  createEveConnectionSource,
  serializeEveCompatibilityProfile,
  type OwdEveCompatibilityProfile,
} from "./eve";
export {
  OBSIDIAN_MIND_COMPATIBILITY_PROFILE,
  OBSIDIAN_MIND_CONTINUITY_GUIDANCE,
  OBSIDIAN_MIND_PROFILE_PROMPT,
  OBSIDIAN_MIND_PROFILE_RESOURCE_URI,
  createObsidianMindMcpMergeConfig,
  createObsidianMindProjectMcpCommand,
  serializeObsidianMindCompatibilityProfile,
  type OwdVaultRuntimeCompatibilityProfile,
} from "./obsidian-mind";
