import { useState } from "react";
import { ObsidianPluginInstaller } from "./ObsidianPluginInstaller";
import { browserSupportsMdevolvedSyncInstall } from "./obsidian-plugin-installer";
import {
  BRAT_PLUGIN_PAGE_URL,
  MDEVOLVED_SYNC_ARCHIVE_URL,
  MDEVOLVED_SYNC_BRAT_INSTALL_URL,
  MDEVOLVED_SYNC_CHECKSUMS_URL,
  MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY,
  MDEVOLVED_SYNC_DISTRIBUTION_URL,
  MDEVOLVED_SYNC_REQUIRED_VERSION,
  MDEVOLVED_SYNC_RELEASES_URL,
} from "./obsidian-plugin-links";

export function PluginSetupGuide() {
  const [fallbackOpen, setFallbackOpen] = useState(
    () => !browserSupportsMdevolvedSyncInstall(),
  );

  return (
    <section
      className="plugin-setup-guide"
      id="mdevolved-sync-installer"
      aria-labelledby="mdevolved-sync-installer-heading"
    >
      <span id="mdevolved-sync-installer" aria-hidden="true" />
      <span id="owd-sync-installer" aria-hidden="true" />
      <div className="plugin-setup-heading">
        <span className="pairing-label">
          Private trial · direct local install
        </span>
        <h3 id="mdevolved-sync-installer-heading">
          Install MDevolved Sync for Obsidian
        </h3>
        <p>
          Already use Obsidian? This optional adapter installs the pinned,
          canonical MDevolved Sync for Obsidian{" "}
          {MDEVOLVED_SYNC_REQUIRED_VERSION} package into the vault you choose.
          Existing <code>owd-sync</code> installations remain available as a
          legacy compatibility path; moving to this adapter requires a new
          explicit pairing approval.
        </p>
      </div>

      <div className="plugin-setup-body">
        <ObsidianPluginInstaller
          onFallbackNeeded={() => setFallbackOpen(true)}
        />
        <p className="plugin-path-note">
          The browser reads only existing MDevolved Sync for Obsidian files and{" "}
          <code>.obsidian/community-plugins.json</code> so it can restore them
          if needed. It does not enumerate notes, upload vault data, retain the
          folder, change Obsidian&apos;s general settings, or install an
          updater.
        </p>

        <details className="plugin-manual-fallback" open={fallbackOpen}>
          <summary>
            Manual BRAT fallback—only if direct install reports an error
          </summary>
          <ol>
            <li>
              Reopen the exact vault where you want MDevolved Sync installed.
            </li>
            <li>
              <a href={BRAT_PLUGIN_PAGE_URL}>Open BRAT in Obsidian</a>, install
              and enable it, then wait until BRAT appears in the Command
              Palette.
            </li>
            <li>
              <a href={MDEVOLVED_SYNC_BRAT_INSTALL_URL}>
                Open the prefilled MDevolved Sync for Obsidian{" "}
                {MDEVOLVED_SYNC_REQUIRED_VERSION} form
              </a>
              . This link opens BRAT&apos;s form; it does not finish the
              install. Verify{" "}
              <code>{MDEVOLVED_SYNC_DISTRIBUTION_REPOSITORY}</code> and version{" "}
              <strong>{MDEVOLVED_SYNC_REQUIRED_VERSION}</strong>, choose{" "}
              <strong>Add Plugin</strong>, and wait for BRAT to finish.
            </li>
            <li>
              In <strong>Settings → Community plugins</strong>, enable MDevolved
              Sync for Obsidian {MDEVOLVED_SYNC_REQUIRED_VERSION}.
            </li>
          </ol>
          <p>
            If the prefilled link does nothing, open Obsidian&apos;s Command
            Palette and run{" "}
            <strong>
              BRAT: Plugins: Add a beta plugin for testing (with or without
              version)
            </strong>
            . Paste <code>{MDEVOLVED_SYNC_DISTRIBUTION_URL}</code>, select
            version <strong>{MDEVOLVED_SYNC_REQUIRED_VERSION}</strong>, and
            choose <strong>Add Plugin</strong>.
          </p>
          <p>
            Use either the direct installer or BRAT, not both. BRAT is a
            technical alpha fallback, not the final Community Plugins
            experience.
          </p>
          <p>
            Maintainers can inspect the{" "}
            <a
              href={MDEVOLVED_SYNC_RELEASES_URL}
              rel="noreferrer"
              target="_blank"
            >
              pinned release
            </a>
            , its{" "}
            <a
              href={MDEVOLVED_SYNC_CHECKSUMS_URL}
              rel="noreferrer"
              target="_blank"
            >
              SHA-256 checksums
            </a>
            , or the{" "}
            <a
              href={MDEVOLVED_SYNC_ARCHIVE_URL}
              rel="noreferrer"
              target="_blank"
            >
              exact diagnostic ZIP
            </a>
            . The ZIP is not a normal tester installation path.
          </p>
        </details>
      </div>
    </section>
  );
}
