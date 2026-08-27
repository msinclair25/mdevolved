# MDevolved marketing site

This static site is the public front door for MDevolved. It promotes the
source-independent product without sharing a hostname, authentication boundary,
storage binding, or runtime dependency with an owner's private deployment.

The lead product promise is **Your AI should not forget your project when the
session ends.** The compact brand promise remains **Every AI. One durable
Project memory.** Public copy should sell the cross-session outcome first, then
explain source-independent onboarding, cited evidence, preferences, portable
skills, useful failures, and the exact next action. It must not collapse
MDevolved into a generic "AI team" or agent orchestration product.

Most of the site is intentionally evergreen. It describes durable product
capabilities, ownership boundaries, and the end-to-end collaboration model
without phase names, release numbers, or launch dates. A small availability
label distinguishes the public Community alpha from invitation-only managed
cells; review that label whenever the delivery model changes. Managed alpha is
not a public managed-service launch.

The site leads with the lovable resume moment, explains the one-command folder
path and one-click Community deployment, then offers invitation-only managed
alpha access. The source section links the public
[MDevolved repository](https://github.com/msinclair25/mdevolved) and the public
[Obsidian adapter compatibility repository](https://github.com/msinclair25/owd-sync). Detailed release
and installation status belongs in those GitHub READMEs.

The compatibility section must stay provider-neutral and useful to solo agents,
lead-mediated orchestrations, and portable handoffs. Eve.dev remains one
source-verified compatibility proof without implying live client acceptance has
already passed. It keeps Eve's execution runtime distinct from MDevolved's
portable Project authority and continues to describe standard MCP plus
user-scoped OAuth—not a custom transport, bundled Eve runtime, or app-scoped
shortcut.

The site does not imply team accounts, autonomous truth promotion, model
training, shared hidden sessions, a bundled agent runtime, or a required graph
workflow. Agent harnesses retain their own tools and subscriptions; MDevolved
is positioned as their durable, owner-governed record.

## Local development

From the repository root:

```sh
pnpm dev:marketing
```

That command is the fast visual-development server. To exercise the form
endpoint with Cloudflare's local Email Service simulation:

```sh
pnpm --filter @owd/marketing dev:worker
```

Local Email Service simulation records the composed email but does not deliver
it. Do not add `remote: true` to the binding for routine development.

## Alpha access requests

`POST /api/alpha-access` validates a bounded JSON body, requires a same-origin
browser request, silently drops a honeypot submission, applies a Cloudflare
Rate Limiting binding, and sends one message to `support@mdevolved.com`. The
Email Service binding also locks the only allowed destination to that address
and the only allowed sender to `alpha@mdevolved.com`, so the public endpoint
cannot be repurposed as a general email relay.

The request is delivered directly to the support inbox. The site does not
create an account, store the submission in a database, add the applicant to a
marketing list, or send application content to analytics. Operational error
logs contain a random request ID and error type only, never the applicant's
name, email, tools, or test plan.

Before the first production deployment with the form:

1. Onboard `mdevolved.com` under Cloudflare Email Service → Email Sending.
2. Confirm that the root `mdevolved.com` MX records still point to Zoho and that
   the `support@mdevolved.com` mailbox exists there. Cloudflare Email Sending
   uses isolated `cf-bounce.mdevolved.com` records; do not enable Cloudflare
   Email Routing or replace the root MX records for this form.
3. Re-run `wrangler email sending list mdevolved.com`, the focused form tests,
   and the marketing deploy dry run.

## Verification

```sh
pnpm test:marketing
pnpm build:marketing
pnpm deploy:marketing:dry-run
```

The Cloudflare configuration deploys an independent static-assets Worker with
one narrowly routed form endpoint, one fixed-destination Email Service binding,
and one Rate Limiting binding. It has no application service binding, database,
bucket, or secret. The authenticated MDevolved Worker and its personal `workers.dev`
hostname remain completely separate.
