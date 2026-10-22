# ADR 0014: Derive subscriber relationship from subscription history

- Status: Accepted
- Date: 2026-10-21
- Supersedes: [ADR 0012](0012-derive-subscriber-state-from-the-documented-subscriber-read.md)
- Restores: the subscription-history decision in [ADR 0010](0010-freeze-batch-fan-insights-before-assignment.md)

## Context

ADR 0010 defined the relationship from subscription and payment evidence and
named a per-fan paginated subscription history. A first adapter then used an
invented route and event names. ADR 0012 over-corrected by concluding that no
history endpoint exists, after reading only the unversioned pages. The v1
reference documents it: `GET /v1/subscribers/{userUuid}/history` (`read:fan`).

Each item is a paid period, newest first by `paidAt`, cursor-paginated with
`size` 1–50: `source` (`profile` or `checkout_link`, more may appear), `type`
(`subscribe`, `trial`, `renew`), `paidAt`, `periodStart`, `periodEnd`,
`amountPaid`, `intervalMonths`, `followsLapse`, `refunded`, `chargedBack`.
Refunded and charged-back periods stay in the list with flags. Checkout-link
periods appear only if the token also holds `read:creator`. Auto-renew state and
current status are not in history; Fan Insights supplies `status`,
`subscription.autoRenewalEnabled` and `renewsAt`.

## Decision

Freeze, per fan and no later than the assignment cutoff:

- lineage from history: earliest valid `periodStart`, valid period count,
  whether a trial occurred, whether a paid `subscribe` followed a lapse
  (`followsLapse`), and the latest valid period type;
- current state from the batch Fan Insights read taken at the same capture:
  `status`, `autoRenewalEnabled`, `renewsAt`.

A period is valid when it is a `profile` period, was paid at or before the
cutoff, and is neither refunded nor charged back. Periods paid after the cutoff
are never used, which restores true cutoff-immutable lineage. Unrecognised
sources are ignored; an unrecognised `type` or malformed field fails the fan.

Cohorts: never subscribed; trialing (latest valid period is a trial while
subscribed); active renewing; active not renewing; lapsed (history exists but
Fan Insights no longer reports `subscriber`). Resubscription after a lapse is a
separate flag, not a cohort. Tenure, if kept, comes from the earliest valid
`periodStart`. A current subscriber with no profile history is a conflict and the
audience fails closed. Prior-purchaser status stays separate.

Do not request `read:creator` for this boundary, so checkout-link subscriptions
remain out of scope and history reads stay within `read:fan`.

Respect Fanvue's limits: 200 points per minute and six concurrent requests per
OAuth client and user. The reader caps concurrency at six, collapses repeated
periods across pages, bounds pages per fan and aborts the whole snapshot on a
401, 403, 410, 429 or outage. A fan with a 404, malformed row or looping cursor is
an explicit failure and the audience does not allocate.

## Consequences

- The ADR 0010 cohorts return, minus a "paused or pending" state that no
  documented read supplies.
- Enrichment costs at least one request per fan; a large audience takes minutes.
- `audience_member_evidence` (migration 0003) stores the new fields.
- Whether history is empty or 404 for a non-subscriber, and whether it can lag
  Fan Insights, are live-only questions recorded in the Phase X report.

## Alternatives considered

- **Single subscriber read** (ADR 0012): rejected; no lineage or resubscription.
- **Creator-wide subscriber list:** rejected; needs `read:creator`.
- **Agency subscribers-history:** rejected; agency-only and aggregate.

## Sources checked

Official Fanvue v1 reference for subscriber history, subscriber by UUID, Fan
Insights batch, and the rate-limit and versioning guides, 21 October 2026.
