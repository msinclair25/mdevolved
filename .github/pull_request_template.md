## Outcome

Describe the user-visible or operational result.

## Scope and acceptance criteria

- [ ] Scope is focused and documented.
- [ ] Acceptance criteria are satisfied.
- [ ] Out-of-scope follow-ups are listed.

## Risk review

- [ ] Authentication, authorization, pairing, or sessions
- [ ] Cryptography, backup, or recovery
- [ ] YAOS/Yjs schema or protocol
- [ ] Durable Object identity, state, or migration
- [ ] D1 migration or R2 storage format
- [ ] Vault paths, `.obsidian`, Markdown, or attachments
- [ ] Deployment, bindings, secrets, or retention
- [ ] None of the above

Explain every checked risk and its rollback/recovery plan.

## Verification

- [ ] `pnpm check`
- [ ] Relevant tests
- [ ] `pnpm build`
- [ ] `pnpm deploy:dry-run`
- [ ] Success, failure, and authorization boundaries tested
- [ ] No secrets or personal vault data in the diff
- [ ] Documentation and migration notes updated

## Screenshots or traces

Use synthetic data and redact identifiers. Never attach real note content, tokens, assertions, or keys.
