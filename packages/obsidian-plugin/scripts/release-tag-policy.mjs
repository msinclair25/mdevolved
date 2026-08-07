/**
 * Keep Community and OWD Sync releases in separate, exact tag namespaces.
 * Unknown or mismatched release tags fail before packaging.
 *
 * @param {{ coreVersion: string; manifestVersion: string; refName?: string; refType?: string }} input
 */
export function assertPluginPackagingRef({
  coreVersion,
  manifestVersion,
  refName,
  refType,
}) {
  if (refType !== "tag") {
    return;
  }

  const expectedCommunityTag = `community-v${coreVersion}`;
  if (refName === expectedCommunityTag) {
    return;
  }

  const expectedPluginTag = `owd-sync-v${manifestVersion}`;
  if (refName !== expectedPluginTag) {
    throw new Error(
      `Release tag ${String(refName)} does not match ${expectedCommunityTag} or ${expectedPluginTag}.`,
    );
  }
}
