# MDevolved marketing site

This static site is the public front door for MDevolved. It promotes the
source-independent product without sharing a hostname, authentication boundary,
storage binding, or runtime dependency with an owner's private deployment.

The canonical product promise is **Every AI. One durable Project memory.**
Public copy should explain source-independent onboarding, deliberate cited
handoffs, and durable Project continuity. It must not collapse MDevolved into a generic "AI team" or agent
orchestration product.

Most of the site is intentionally evergreen. It describes durable product
capabilities, ownership boundaries, and the end-to-end collaboration model
without phase names, release numbers, or launch dates. A small availability
label may distinguish private acceptance cells from the future public managed
Cloud service and Community release; review that label whenever the delivery
model changes. Private acceptance is not a public managed-service launch.

The site explains the guided setup path before asking a visitor to request
private-alpha access. The source section links the invited
[MDevolved repository](https://github.com/msinclair25/mdevolved) with an
explicit availability label and the public
[Obsidian adapter compatibility repository](https://github.com/msinclair25/owd-sync). Detailed release
and installation status belongs in those GitHub READMEs.

The Eve.dev integration section markets the source-verified Eve `0.29.4`
profile without implying live client acceptance has already passed. It keeps
Eve's execution runtime distinct from OWD's portable Project authority and
must continue to describe standard MCP plus user-scoped OAuth—not a custom
transport, bundled Eve runtime, or app-scoped shortcut.

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
bucket, or secret. The authenticated OWD Worker and its personal `workers.dev`
hostname remain completely separate.
