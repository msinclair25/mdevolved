# Sync control-plane request budget

OWD Sync treats authentication and control-plane calls as a bounded resource.
This contract applies to every desktop release and every Community or managed
Worker deployment.

## Client budgets

| Request path                       | Healthy behavior                                                       | Failure behavior                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /vault/:vaultId/auth/ticket` | About one refresh per connected device per five-minute ticket lifetime | HTTP 401/403 is terminal until the owner re-pairs. Other failures retry with jittered exponential backoff from 30 seconds to a 30-minute cap. Only one refresh may be in flight. |
| `GET /api/capabilities`            | Startup, foreground/network recovery, or an explicit owner action      | Degraded background polling is no more frequent than once every five minutes and stops after fatal authentication.                                                               |

Changing windows, adding a new retry path, or bypassing the fatal-auth gate is
a release-contract change. It requires unit coverage and the full public
quality gate.

## Worker containment

Socket-ticket requests pass through three independent limits before a ticket
can be issued:

- four requests per client address per minute;
- two requests per vault per minute; and
- ten requests per client address per ten minutes at the D1-backed route gate.

Client addresses and vault identifiers are hashed before use as native limiter
keys. Limit responses contain no identifier. A native limiter failure fails
closed with a retryable 503. Limit events emit only the route and exhausted
budget name; they never include an address, vault ID, credential, or error
detail. The client budget is evaluated first so a blocked client cannot consume
a target vault's remaining budget.

These budgets intentionally allow normal ticket rotation while bounding a
stale or defective client. A 429 is a transient signal and follows the same
client backoff policy.

## Release and incident check

Use only a disposable vault and redacted receipts.

1. Prove HTTP 401 and 403 cause one terminal transition and no later ticket or
   capability request until a re-pair creates a new sync runtime.
2. Prove transient responses increase retry delay and never exceed one request
   in flight or the 30-minute delay cap.
3. Prove client-address and vault budgets independently return 429 with
   `Retry-After`, and a limiter failure returns 503.
4. After deployment, compare the ticket request/error rate for 15 minutes with
   the pre-deploy baseline. Investigate any sustained authorization rejection
   or limiter event instead of raising the budget.
5. Keep a Cloudflare usage notification active. Budget notifications are a
   cost backstop, not a substitute for the request and regression controls.

Rollback the Worker to its previous version if healthy clients cannot rotate a
ticket. Keep the fixed plugin available, because rolling back the Worker alone
does not repair an already-installed defective client.
