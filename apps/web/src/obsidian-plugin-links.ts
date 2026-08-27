/** Canonical distribution metadata for new MDevolved Sync installations. */
export const MDEVOLVED_SYNC_PLUGIN_ID = "mdevolved-sync";
export const MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY =
  "msinclair25/mdevolved-sync";
export const MDEVOLVED_SYNC_DISTRIBUTION_URL = `https://github.com/${MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}`;
export const MDEVOLVED_SYNC_REQUIRED_VERSION = "0.2.0-alpha.1";
export const MDEVOLVED_SYNC_RELEASE_TAG = `mdevolved-sync-v${MDEVOLVED_SYNC_REQUIRED_VERSION}`;
export const MDEVOLVED_SYNC_RELEASES_URL = `https://github.com/${MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}/releases/tag/${MDEVOLVED_SYNC_RELEASE_TAG}`;
export const MDEVOLVED_SYNC_ARCHIVE_URL = `https://github.com/${MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}/releases/download/${MDEVOLVED_SYNC_RELEASE_TAG}/mdevolved-sync-${MDEVOLVED_SYNC_REQUIRED_VERSION}.zip`;
export const MDEVOLVED_SYNC_CHECKSUMS_URL = `https://github.com/${MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}/releases/download/${MDEVOLVED_SYNC_RELEASE_TAG}/checksums.txt`;
export const MDEVOLVED_SYNC_COMMUNITY_INSTALL_URL = `obsidian://show-plugin?id=${MDEVOLVED_SYNC_PLUGIN_ID}`;
export const BRAT_PLUGIN_PAGE_URL = "obsidian://show-plugin?id=obsidian42-brat";
export const MDEVOLVED_SYNC_BRAT_INSTALL_URL = `obsidian://brat?plugin=${MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}&version=${MDEVOLVED_SYNC_REQUIRED_VERSION}`;

/**
 * Legacy alpha distribution. It is never used by the new installer; these
 * links document where an existing `owd-sync` installation came from so a
 * user can re-authorize it before moving to the canonical adapter.
 */
export const LEGACY_OWD_SYNC_PLUGIN_ID = "owd-sync";
export const LEGACY_OWD_SYNC_DISTRIBUTION_REPOSITORY = "msinclair25/owd-sync";
export const LEGACY_OWD_SYNC_REQUIRED_VERSION = "0.1.7";
export const LEGACY_OWD_SYNC_RELEASE_TAG = LEGACY_OWD_SYNC_REQUIRED_VERSION;
export const LEGACY_OWD_SYNC_RELEASES_URL = `https://github.com/${LEGACY_OWD_SYNC_DISTRIBUTION_REPOSITORY}/releases/tag/${LEGACY_OWD_SYNC_RELEASE_TAG}`;
export const LEGACY_OWD_SYNC_ARCHIVE_URL = `https://github.com/${LEGACY_OWD_SYNC_DISTRIBUTION_REPOSITORY}/releases/download/${LEGACY_OWD_SYNC_RELEASE_TAG}/owd-sync-${LEGACY_OWD_SYNC_REQUIRED_VERSION}.zip`;

// Source-level aliases retained while the web app and plugin consumers move
// to the canonical names. They point only to canonical metadata.
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_REQUIRED_VERSION = MDEVOLVED_SYNC_REQUIRED_VERSION;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_DISTRIBUTION_REPOSITORY =
  MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_DISTRIBUTION_URL = MDEVOLVED_SYNC_DISTRIBUTION_URL;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_RELEASE_TAG = MDEVOLVED_SYNC_RELEASE_TAG;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_RELEASES_URL = MDEVOLVED_SYNC_RELEASES_URL;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_ARCHIVE_URL = MDEVOLVED_SYNC_ARCHIVE_URL;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_CHECKSUMS_URL = MDEVOLVED_SYNC_CHECKSUMS_URL;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_COMMUNITY_INSTALL_URL =
  MDEVOLVED_SYNC_COMMUNITY_INSTALL_URL;
/** @deprecated Use MDEVOLVED_SYNC_* instead. */
export const OWD_SYNC_BRAT_INSTALL_URL = MDEVOLVED_SYNC_BRAT_INSTALL_URL;
