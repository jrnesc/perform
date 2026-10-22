# ADR 0010: Define relationship from subscription and payment history

- Status: Accepted; contract details in [ADR 0014](0014-derive-subscriber-relationship-from-subscription-history.md)
- Date: 2026-10-21

> **Correction history (21 October 2026):** an adapter written for this ADR used an
> invented history route, and ADR 0012 then wrongly concluded no history endpoint
> exists. `GET /v1/subscribers/{userUuid}/history` is documented, so this ADR's
> design stands. ADR 0014 records the real contract, including that checkout-link
> periods need `read:creator`, and that a paused or pending state is not
> available from any documented read.

## Context

The product needs a useful definition of the relationship between a fan and a
creator. Follow/unfollow history is not reliable relationship evidence: a fan
can unfollow and follow again, and the API does not provide a durable history of
that earlier state.

The paying relationship is durable and relevant to the experiment. Fanvue's
subscriber and subscription-history contracts expose the initial subscription,
trials, renewals, paid periods, lapses, resubscriptions, refunds and chargebacks.
Former subscribers retain billing history. Fan Insights separately exposes
reversal-adjusted purchase counts and spend for up to 100 UUIDs per batch.

These reads require `read:fan`; Fan Insights additionally requires
`read:insights`. They report current data, so Perform must derive and freeze the
pre-experiment facts before assignment.

## Decision

Define “relationship” as the fan's subscription/payment relationship with the
creator, not their follower relationship.

Read subscription history and batch Fan Insights immediately before assignment
and freeze only:

- stable fan UUID;
- capture time;
- earliest valid subscription start;
- current subscription state and renewal state;
- whether the fan has lapsed and later resubscribed;
- valid paid/trial/renewal periods needed to support that classification;
- reversal-adjusted purchase count and spend from fan-to-creator payment
  sources.

Use subscription evidence to derive product cohorts such as:

- never subscribed;
- first subscription period;
- active and renewing;
- active but not renewing;
- resubscribed after a lapse; and
- former or lapsed subscriber.

If the product still needs a tenure band, calculate it from the earliest valid
subscription period, not from follow status. Keep prior-purchaser status
separate: a fan may have bought a message or tipped without ever subscribing.

Exclude creator rewards and App Store purchases from prior-purchaser facts.
Treat every per-key forbidden, missing, internal or malformed result as an
explicit enrichment failure. Do not allocate a partly enriched audience unless
a later ADR defines a product-visible degraded mode.

Never re-read current fan or subscription data later and present it as
pre-experiment history. All classifications use evidence whose relevant event
time is no later than the assignment cutoff.

## Consequences

- “Never purchased” and “prior purchaser” can be reproducibly frozen from
  reversal-adjusted counts before assignment.
- Paying-relationship cohorts have an auditable event history and do not depend
  on unreliable follow/unfollow history.
- Subscription history is a per-fan paginated contract, so the implementation
  must bound concurrency, respect rate limits and fail a partial snapshot closed.
- Implementation requires `read:insights` in addition to `read:fan`, causing a
  distinct consent/review decision from audience discovery.
- Accepting this ADR selects the architecture but does not itself connect an
  account, deploy, or create an external effect.

## Alternatives considered

- **Reconstruct history from chat messages.** Rejected; messages are not the
  authoritative commerce ledger.
- **Use the latest fan-insights value when rendering results.** Rejected because
  post-assignment purchases would leak into a pre-experiment feature.
- **Use current subscription creation alone.** Rejected because it can miss
  earlier periods and resubscriptions; use subscription history instead.

## Sources checked

Official Fanvue fan-insights batch, single-fan insights, subscriber and
subscriber-history documentation, checked 21 October 2026.
