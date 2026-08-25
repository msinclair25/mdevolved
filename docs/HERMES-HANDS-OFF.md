# Hermes hands-off lead adapter

**Format:** `owd-hermes-hands-off-adapter-v1`

**Status:** inert, script-free guidance over the generic OWD MCP services

The same guidance is discoverable as the MCP resource
`owd://adapters/hermes/hands-off/v1`.

This adapter gives Hermes no executable code, credentials, provider state, or
additional authority. It describes how an already authorized Project lead can
map Hermes delegation onto OWD's provider-neutral R2 services. Other harnesses
use the same tools and durable contracts.

This is a compatibility recipe, not an OWD runtime. OWD never schedules,
launches, retries, supervises, or stops Hermes workers; Hermes owns that
execution loop. OWD only persists the bounded Project, Run, Actor, evidence,
review, exception, and checkpoint records submitted by an authorized client.

## Preconditions

- Resume the exact Project and claim its fenced lead lease.
- Read `owd://collaboration/lead-operation-capabilities/v1`; stop if the client
  does not understand every required format or tool.
- Treat the standing Project policy as a ceiling. It cannot widen the Project,
  vault, folder, grant, or local filesystem boundary.

## Lead sequence

1. Call `create_work_item` with the bounded brief from the owner's instruction.
2. Call `start_run` for one `research` or `coding` Run.
3. Call `register_actor` for each Hermes worker. Actor names, harnesses, and
   models are claims, not verified identity. Delegate only the smallest listed
   Actor scopes and keep every Actor inside the returned Run and Work Item.
4. Call `get_run_context` with that worker's `actorId`, then give the worker the
   returned context. Do not send raw transcripts,
   hidden reasoning, terminal history, credentials, OAuth state, or runtime
   caches to OWD.
5. Call `submit_bundle` for bounded provisional results. Use
   `run-shared-unvetted`; it is visible only inside the exact Run and is never
   an owner Decision.
6. Route review with a `review.requested` event to a different Actor, then
   submit that Actor's `review.completed` result. An Actor cannot review its own
   bundle.
7. Call `checkpoint_project` at meaningful work boundaries using the current
   lease and fencing token and the exact Work Packet pinned when the Run
   started. A newer packet does not retarget that Run.
8. Call `complete_work_item` only after an independent passing review and when
   `list_project_exceptions` has no blocking result.

For a fresh Hermes task, call `owd_resume` first and continue from that bounded
brief. Do not paste the prior Hermes prompt or session. If Hermes is operating
in independent mode, the context intentionally omits peer conclusions; a later
owner-authorized synthesis can compare separately attributable results.

## Exception boundary

Requests for expanded authority, destructive action, or protected paths are
recorded as Exceptions and are not executed. Budget exhaustion and conflicting
evidence also block completion. Surface the Exception to the owner; do not
retry it as authority, weaken the policy, create a replacement Project, or ask
workers to bypass OWD.

Explicit grant or lease revocation, Actor expiry, stale fencing, cross-Run or
cross-Project identifiers, malformed bundles, and incompatible formats fail
closed on the next call.
