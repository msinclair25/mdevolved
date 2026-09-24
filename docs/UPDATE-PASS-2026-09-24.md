# September 24 compatibility update

## Outcome

Local update candidate for the existing agent integrations. No schema, migration,
sync protocol, authorization, setup command, or plugin archive layout changed.

- Eve's installed compatibility target advances from `0.63.0` to `0.65.0`,
  with `@vercel/connect` from `2.0.4` to `2.3.2`. The generated connection
  fixture, exposed profile, release checks, and documentation advance together.
- Tagged-source reviews advance Hermes to `0.21.5` / `v2026.9.24`, OpenClaw to
  `v2026.9.6`, and Gemini CLI to `v0.61.0`.
- Copilot CLI's release/documentation review advances to `v1.0.88`; its
  implementation is proprietary, and no live certification is claimed.
- OpenCode, Obsidian Mind, Albatross, mcp-remote, and LangChain still match
  their existing reviewed releases.
- Corrected the Eve dashboard and documentation to use the existing canonical
  generator and `mdevolved.ts` filename for new connections. Existing `owd`
  connections remain supported and must not be duplicated or re-authorized.

The GitHub comparison endpoint truncated Eve's changed-file list at 300 files.
The review therefore compared complete recursive Git trees: connection
definitions, runtime, and documentation retain identical blob identities
between the old pin and the selected release. Connect's published implementation
retains explicit user principals, token scopes/resources, and opt-in connector
provisioning. The source references are in the individual compatibility docs.

## Validation

- Focused Vitest: **103/103**, covering client profiles, native setup commands,
  inert plugin archives, and MCP access/authorization behavior.
- Focused Playwright: **2/2**, exercising agent setup including canonical Eve
  output on desktop and narrow viewports after the review repair.
- `pnpm typecheck`, `pnpm upstream:config:check`, `pnpm release:check`,
  `pnpm lint`, and `pnpm build:web`: passed.
- Changed-file formatting and `git diff --check`: passed.
- `pnpm audit --json`: zero known vulnerabilities after installation.
- GitHub: no open Dependabot security alerts; the latest CI, desktop/CLI,
  and compatibility-monitor runs inspected were successful.

The full repository/browser/deployment gate was not repeated for this local
profile update. A release still requires the repository's applicable release
gate. No real client OAuth sessions or paid model runs were exercised.

An independent upstream source audit supported the selected client pins. The
final diff critic identified a real mismatch: the dashboard still generated
legacy Eve connection names while the docs described canonical names. Rework
reused the existing canonical generator, corrected the displayed filename,
removed the stale version badge, and added desktop/narrow browser assertions.
The legacy generator and its compatibility fixtures remain supported.

## Deferred updates and delivery

Eve `0.66.2` was observed but is not the installed target of this pass; the
upstream monitor intentionally continues to report that release drift.
Newer framework/toolchain packages and the pinned YAOS/Yjs synchronization stack
remain separate upgrade work. No known security advisory requires their
immediate replacement. Existing Dependabot PRs #26, #29, and #71 remain open
and were not changed or merged.

The owner subsequently authorized commit, GitHub delivery, README updates, and
deployment. The README now describes the available setup paths and links to
dated compatibility evidence without claiming live certification. Release
delivery requires the complete gate on the candidate commit, successful PR CI,
and health verification of the existing production Worker. The PR and task
delivery receipt record the resulting commit and deployment identifiers.

No schema migration, npm publication, new cloud resource, or paid service is
required. Existing alpha deployments retain their original resource identities
through `wrangler.legacy.jsonc`; rollback uses the preceding Worker version.
