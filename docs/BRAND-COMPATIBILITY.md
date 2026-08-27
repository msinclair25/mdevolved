# MDevolved brand compatibility

> **MD9 identity contract:** new installs and writes use the canonical values
> below. Former OWD values remain read-only compatibility inputs until their
> documented migration windows close. No rename, import, or restore operation
> transfers live authority.

MDevolved is the human-facing and machine-facing identity for new installs. It
was formerly called OWD. Normal user and agent workflows say MDevolved; OWD
appears only as a frozen identifier or inside an explicit legacy compatibility
explanation.

## Normal product path

- Use **MDevolved** for the product and **MDevolved Community** for the
  self-hosted distribution.
- Spell the product exactly **MDevolved**. Do not use “MD Evolved”,
  “MD evolved”, or “MDEvolved”.
- Use **Sources** for connected Markdown folders and Obsidian workspaces.
- Use **Workspace** for the selected local root and **Project** for durable AI
  memory and provenance.
- Start with either MDevolved Sync and a Markdown folder or MDevolved Sync for
  Obsidian. Obsidian is optional and first-class, not the product model.
- Keep implementation terms under **Technical details**, **Advanced**, or an
  explicit compatibility notice.
- Say **MDevolved Sync** for the folder app and **MDevolved Sync for Obsidian**
  for the companion plugin. Its new plugin ID is `mdevolved-sync`; the old
  `owd-sync` ID remains a compatibility detail.

## Frozen compatibility identities

| Surface                   | Frozen value or behavior                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| New writes and installs   | `mdevolved-*`, `@mdevolved/*`, `mdevolved://*`, `mdevolved://connect`, `.mdevolvedignore`   |
| MCP primary loop          | `mdevolved_resume`, `mdevolved_find`, `mdevolved_get_skill`, `mdevolved_checkpoint`         |
| Pairing                   | `mdevolved://connect`; Obsidian `obsidian://mdevolved-pair`                                 |
| Portable data             | `mdevolved-backup-v1`, `mdevolved-snapshot-v3`, provider-neutral restore                    |
| Obsidian plugin           | ID `mdevolved-sync`; repository and release publication pending verification                |
| Source identity           | User-facing **Source** and **Workspace**; frozen `vaultId` remains storage compatibility    |
| Repository and deployment | `msinclair25/mdevolved`; fresh Community installs use the separate canonical resource names |

### Legacy read-only compatibility

Existing cells continue to read `owd_*`, `owd://*`, `owd-pair`, `.owdignore`,
`owd-sync`, `owd-backup-v1`, and `owd-snapshot-v2`. Existing Worker, D1, R2,
Durable Object, route, bookmark, table, migration, and object-key identities
remain frozen. The private former workspace package scope remains historical
source compatibility, not a published package bridge. The `#vaults` route and
old API names stay available for existing clients, while `#sources` and the
canonical APIs are the normal path for new clients.

Existing users require no migration, data edit, re-pairing, MCP reconnect,
plugin reinstall, or updater change. New display names never expand source or
agent authority. Community remains provider-neutral, independently deployable,
and free of a managed-control-plane dependency.

## Release verification

`pnpm test:md9:identity` checks the canonical/legacy identity matrix. The
focused and full repository gates additionally exercise folder and Obsidian
onboarding, navigation, plugin packaging/update metadata, CLI/desktop
metadata, MCP compatibility, backup/snapshot/restore compatibility,
accessibility, and release/deploy link contracts. Publication of the canonical
Obsidian adapter, plugin-store listing, and any live client acceptance remain
separate release-owner gates.

The monorepo tag workflow packages and uploads a verified candidate artifact;
it does not publish that artifact into the wrong repository. After explicit
owner authorization, the reviewed files are promoted to
`msinclair25/mdevolved-sync`, and the canonical release is created there. The
old adapter remains available until that repository, release, checksums, and
installer URLs have all been independently verified.

The MD5 candidate's authoritative live check on 2026-08-26 verified the renamed
repository without another mutation. `gh repo view msinclair25/owd-platform`
resolved to API identity `mdevolved`, URL
`https://github.com/msinclair25/mdevolved`, and default branch `main`. Uncached,
redirect-following requests returned HTTP 200 at these effective URLs:

- old repository root → `https://github.com/msinclair25/mdevolved`;
- old `/tree/main/docs` →
  `https://github.com/msinclair25/mdevolved/tree/main/docs`;
- old `/blob/main/README.md` →
  `https://github.com/msinclair25/mdevolved/blob/main/README.md`.

The earlier browser/search result that appeared to show a distinct repository
was stale and is superseded by the API identity and effective-URL checks above.
The existing Deploy-to-Cloudflare URL reached Cloudflare's deploy flow with the
`mdevolved` repository preserved; no deployment was started.
