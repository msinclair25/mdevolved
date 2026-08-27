# MDevolved brand compatibility

MDevolved is the human-facing product name. It was formerly called OWD. MD7
completes the display-copy transition without renaming the wire protocol,
stored model, package scope, or released compatibility identities. Normal user
and agent workflows say MDevolved; OWD appears only as a frozen identifier or
inside an explicit legacy compatibility explanation.

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
  for the companion plugin. Its `owd-sync` ID remains a compatibility detail.

## Frozen compatibility identities

| Surface                 | Frozen value or behavior                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| MCP tools and resources | `owd_*`, `owd://*`, existing capability names                                                            |
| Pairing                 | `owd-pair` remains accepted; `mdevolved:` is additive                                                    |
| Stored source identity  | `vaultId`, vault tables, migrations, records, keys                                                       |
| Packages                | `@owd/*` and published `mdevolved` package names                                                         |
| Obsidian plugin         | ID `owd-sync`, settings schema, BRAT repository, release tags, archive paths, updater behavior           |
| Portable data           | `owd-backup-v1`, `owd-snapshot-v2`, exports, restore manifests, quarantine semantics                     |
| Routes and bookmarks    | Existing API/deploy routes and `#vaults`; `#sources` aliases the same panel                              |
| Repository              | `msinclair25/mdevolved`; legacy GitHub URLs must redirect before any old link is removed                 |
| Deployment              | Existing Worker names, bindings, resource identifiers, permanent hostnames, and Deploy-to-Cloudflare URL |

Existing users require no migration, data edit, re-pairing, MCP reconnect,
plugin reinstall, or updater change. New display names never expand source or
agent authority. Community remains provider-neutral, independently deployable,
and free of a managed-control-plane dependency.

## Release verification

`pnpm test:md5:acceptance` checks the display-copy boundary and the frozen
identifiers above, then exercises folder and Obsidian onboarding, navigation,
plugin packaging/update metadata, CLI/desktop metadata, MCP compatibility,
backup/snapshot/restore compatibility, accessibility/narrow-width browser
coverage, and release/deploy link contracts. Live release review separately
verifies the legacy GitHub redirect and the existing Deploy-to-Cloudflare URL
without renaming or publishing anything.

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
