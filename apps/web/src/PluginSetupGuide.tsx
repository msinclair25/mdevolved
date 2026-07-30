import { ObsidianPluginInstaller } from "./ObsidianPluginInstaller";
import {
  BRAT_PLUGIN_PAGE_URL,
  OWD_SYNC_ARCHIVE_URL,
  OWD_SYNC_BRAT_INSTALL_URL,
  OWD_SYNC_CHECKSUMS_URL,
  OWD_SYNC_DISTRIBUTION_REPOSITORY,
  OWD_SYNC_REQUIRED_VERSION,
  OWD_SYNC_RELEASES_URL,
} from "./obsidian-plugin-links";

export function PluginSetupGuide() {
  return (
    <section
      className="plugin-setup-guide"
      id="owd-sync-installer"
      aria-labelledby="owd-sync-installer-heading"
    >
      <div className="plugin-setup-heading">
        <span className="pairing-label">
          Private trial · direct local install
        </span>
        <h3 id="owd-sync-installer-heading">Install OWD Sync in this vault</h3>
        <p>
          This temporary installer puts the pinned OWD Sync{" "}
          {OWD_SYNC_REQUIRED_VERSION} release into the vault you choose. The
          Community Plugins listing will replace it as the permanent path.
        </p>
      </div>

      <div className="plugin-setup-body">
        <ObsidianPluginInstaller />
        <p className="plugin-path-note">
          The browser reads only existing OWD Sync files and{" "}
          <code>.obsidian/community-plugins.json</code> so it can restore them
          if needed. It does not enumerate notes, upload vault data, retain the
          folder, change Obsidian&apos;s general settings, or install an
          updater.
        </p>

        <details className="plugin-manual-fallback">
          <summary>
            Fallback for Safari, Firefox, or a blocked folder picker
          </summary>
          <p>
            Install and enable{" "}
            <a href={BRAT_PLUGIN_PAGE_URL}>BRAT in Obsidian</a>, then{" "}
            <a href={OWD_SYNC_BRAT_INSTALL_URL}>
              install OWD Sync {OWD_SYNC_REQUIRED_VERSION}
            </a>{" "}
            from <code>{OWD_SYNC_DISTRIBUTION_REPOSITORY}</code>. Confirm
            Obsidian shows version <strong>{OWD_SYNC_REQUIRED_VERSION}</strong>.
            This two-stage path is a technical fallback, not the final Community
            Plugins experience.
          </p>
          <p>
            Maintainers can inspect the{" "}
            <a href={OWD_SYNC_RELEASES_URL} rel="noreferrer" target="_blank">
              pinned release
            </a>
            , its{" "}
            <a href={OWD_SYNC_CHECKSUMS_URL} rel="noreferrer" target="_blank">
              SHA-256 checksums
            </a>
            , or the{" "}
            <a href={OWD_SYNC_ARCHIVE_URL} rel="noreferrer" target="_blank">
              exact diagnostic ZIP
            </a>
            . The ZIP is not a normal tester installation path.
          </p>
        </details>
      </div>
    </section>
  );
}
