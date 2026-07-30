# Contributing

OWD Platform handles private notes, credentials, and recovery data. Contributions are welcome, but data safety takes priority over delivery speed.

## Before coding

Read `AGENTS.md`, the relevant architecture and security sections, and the
[public quality gates](docs/QUALITY-GATES.md). Open a design discussion before
changing authentication, encryption, upstream YAOS schemas, Durable Object
identity, storage formats, or recovery behavior.

## Development workflow

OWD uses the risk-proportional Build, Checkpoint, and Release modes defined in
`AGENTS.md`.

1. Continue the current phase or vertical-slice branch when the change belongs
   to it; create a branch only when no suitable slice exists.
2. Add or update acceptance criteria.
3. Implement coherent behavior and add tests at the boundary where a failure
   would occur.
4. During Build mode, run focused checks for the affected package and keep
   related polish, documentation, and small fixes together.
5. At a meaningful recovery point, review the accumulated diff and create a
   local checkpoint commit.
6. When the cohesive slice is ready for remote review, run the complete
   applicable gate, push once, and submit one pull request using the repository
   template.

Low-risk edits do not each require a branch, commit, pull request, or
deployment. High-risk authentication, authorization, encryption, recovery,
migration, Durable Object, destructive, and production changes retain their
dedicated review and rollback requirements.

Keep checkpoint commits reviewable. Do not mix generated formatting,
dependency upgrades, schema migrations, and feature work unless they are
inseparable.

## Security

Do not open a public issue for a vulnerability. Follow `SECURITY.md`. Never attach real vaults, production configuration, authentication material, or decrypted backups to an issue or pull request.

## Compatibility

Document user-visible breaking changes. Storage and protocol changes require versioning, fixtures from the prior version, migration tests, and recovery notes.
