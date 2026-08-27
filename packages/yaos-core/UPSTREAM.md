# Pinned YAOS core

This package contains the reviewed YAOS subset required for MDevolved's live Yjs
compatibility boundary.

- Repository: <https://github.com/kavinsood/yaos>
- Commit: `e3d73d6850349f772812fbe7758cf5f3f6b11390`
- Commit date: 2026-07-08
- Upstream license: 0BSD; see `LICENSE` in this directory
- Upstream server version: `0.3.0`
- Supported YAOS schema versions: 1 through 3

## Imported paths

The following files were copied without semantic changes except for import-path
adjustments, lint-only normalizations, and an `ArrayBuffer` normalization
required by TypeScript 7's WebCrypto types:

- `server/src/chunkedDocStore.ts`
- `server/src/hex.ts`
- `server/src/persistenceCoordinator.ts`
- `server/src/svEcho.ts`
- `server/src/svEchoProtocol.ts`
- `server/src/syncMessageClassifier.ts`
- `server/src/version.ts`
- `src/sync/fileMeta.ts`
- `src/sync/schema.ts`
- `src/sync/stateVectorAck.ts`
- `src/sync/svEchoMessage.ts`

`src/protocol.ts` and `src/index.ts` are MDevolved adapters. The protocol adapter
encodes synthetic-client updates using the same y-partyserver/y-protocol frame
as upstream.

`fixtures/schema-compatibility.json` contains synthetic, content-free schema
v1 and schema v3 Yjs updates. These fixtures are permanent compatibility gates;
future upstream pins must continue to load both.

## Update policy

Do not update this package by copying the upstream main branch. Follow
`docs/UPSTREAM-YAOS.md`: review the upstream diff, preserve old and new
fixtures, verify storage compatibility, and document rollback before changing
the pinned commit.
