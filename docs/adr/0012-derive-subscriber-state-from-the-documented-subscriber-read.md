# ADR 0012: Derive subscriber state from the documented subscriber read

- Status: Superseded by [ADR 0014](0014-derive-subscriber-relationship-from-subscription-history.md)
- Date: 2026-10-21
- Supersedes: the subscription-history parts of [ADR 0010](0010-freeze-batch-fan-insights-before-assignment.md)

> **Superseded.** This ADR concluded that Fanvue documents no per-fan subscription
> history. That was wrong: `GET /v1/subscribers/{userUuid}/history` exists. It was
> found by reading the unversioned reference pages only. Kept for the record; see
> ADR 0014 and the Phase X report.

## Context

ADR 0010 defined the creator/fan relationship from the paying subscription
relationship rather than follow status, and that direction stands. It also
assumed Fanvue exposes a per-fan, paginated subscription history containing
trials, renewals, lapses, resubscriptions, refunds and chargebacks. A check of
the official documentation on 21 October 2026 found no such endpoint:

- `GET /subscribers/{userUuid}` (`read:fan`) returns `firstSubscribedAt` (the
  earliest subscription across the fan's history) and one nullable `subscription`
  object for the current period: `status` (`active`, `cancelled`,
  `pending_confirmation`, `paused`), `price`, `amountPaid`, `intervalMonths`,
  `currentPeriodStart` (latest successful charge, not the cycle start),
  `currentPeriodEnd` and `autoRenewalEnabled`. It has no list of past periods.
- `GET /creators/{creatorUserUuid}/subscribers` returns the same per-subscriber
  fields in bulk but requires `read:creator`, a different consent boundary.
- `GET /insights/fans/{userUuid}` adds `status` (`subscriber`, `expired`,
  `follower`, `not_contactable`) and a current `subscription` object.
- `GET /insights/subscribers` is a creator-level daily series of starts and
  cancellations, not per fan.
- `GET /v1/agencies/subscribers-history` is agency-only (`read:agency`), and its
  row schema is not documented.

The ADR 0010 and Phase 8D handoff wording was therefore based on a contract that
does not exist, and the first adapter built from it (route and event vocabulary)
was invented. It has been removed.

## Decision

Freeze, per fan and no later than the assignment cutoff, only what the
documented per-fan read provides: `firstSubscribedAt`, current subscription
status, `autoRenewalEnabled` and `currentPeriodEnd`. Derive these cohorts:

- never subscribed (no first date and no subscription);
- active and renewing;
- active but not renewing;
- lapsed (a first date with no current subscription, or `cancelled`); and
- paused or pending confirmation.

Do not derive "resubscribed after a lapse", trial status or paid-period counts.
`firstSubscribedAt` cannot distinguish a first subscriber from a returning one
and `currentPeriodStart` is not a cycle start. Tenure, if kept, is measured from
`firstSubscribedAt`. Prior-purchaser status remains separate and comes from Fan
Insights. Follow and unfollow state is never used.

Reads are current, not historical, so they are valid only when taken at or
before the cutoff and are never re-read later as pre-experiment history. A
timestamp later than the capture time, a status outside the documented set, a
subscription without a first date, a UUID that differs from the request, a
404 (ambiguous between never subscribed and unconnected) or a 403 is an explicit
per-fan failure. A 401, 429 or outage aborts the whole snapshot. An audience with
any failure does not allocate.

Use the per-fan read under `read:fan` (already part of the audience boundary).
Do not use the creator-wide list to save requests: it needs `read:creator`, which
ADR 0011 keeps as a separate consent decision.

If the product later needs resubscription or trial cohorts, record the
`creator.subscription.activated`, `.renewed` and `.deactivated` webhook events
going forward under a new ADR; that history cannot be reconstructed
retroactively from the documented reads.

## Consequences

- The relationship breakdown has fewer cohorts than previously described; the
  seeded demo cohorts remain fixtures and must not be presented as derivable
  live.
- Enrichment makes one request per fan, so concurrency and rate limits matter
  for large audiences. The adapter bounds concurrency (default 4, maximum 10).
- Paths use the repository's `/v1` convention, but the docs show unprefixed
  paths with an `X-Fanvue-API-Version` header. This and the behaviour above are
  verified in Phase X.
- No scope, subscription or connection is authorised.

## Alternatives considered

- **Keep the invented history contract.** Rejected; it does not exist.
- **Reconstruct history from the earnings ledger.** Rejected for cohorts; it
  records purchases, not subscription periods, and needs `read:insights`.
- **Creator-wide subscriber list.** Rejected for consent reasons above.
- **Agency subscribers-history.** Rejected; agency-only and its schema is
  undocumented.

## Sources checked

Official Fanvue documentation for subscriber by user UUID, creator subscribers,
fan insights, subscribers insights and the v1 overview, checked 21 October 2026.
