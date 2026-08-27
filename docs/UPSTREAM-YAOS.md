# Upstream YAOS Policy

MDevolved Platform reuses a reviewed and pinned subset of YAOS. Upstream is a dependency with a compatibility boundary, not an automatically merged code stream.

## Current pin

- Repository: <https://github.com/kavinsood/yaos>
- Commit: `e3d73d6850349f772812fbe7758cf5f3f6b11390`
- Commit date: 2026-07-08
- License: 0BSD
- Server/schema boundary: server `0.3.0`, schemas 1 through 3
- Server imported paths and adaptations: `packages/yaos-core/UPSTREAM.md`
- Companion plugin import and exclusions: `packages/obsidian-plugin/UPSTREAM.md`
- Permanent fixtures: `packages/yaos-core/fixtures/schema-compatibility.json`

## Import rules

- Record the exact upstream repository, commit, license, and imported paths.
- Preserve copyright and license notices in `NOTICE` and vendored directories.
- Keep adaptations small and documented.
- Separate upstream code from MDevolved-specific authentication, provisioning, UI, and backup behavior.
- Do not import examples, deployment credentials, telemetry, or unrelated tooling.

## Compatibility contract

Before the first import, capture synthetic fixtures for the required Yjs maps and snapshot envelope, including metadata, path-to-ID, ID-to-text, and path-to-blob behavior. Tests must prove that the pinned client and server agree on:

- vault identity and authorization boundary;
- document and attachment representation;
- snapshot encoding/decoding;
- reconnect and replay behavior;
- version negotiation and explicit failure for unsupported versions.

## Updating upstream

An upstream update requires:

1. A written diff of protocol, schema, dependency, and license changes.
2. Passing old and new contract fixtures.
3. Durable Object storage compatibility or an explicit migration.
4. Recovery and rollback notes.
5. Security review for parsing, authentication, and denial-of-service changes.

Never perform a blind subtree merge or floating-version update.
