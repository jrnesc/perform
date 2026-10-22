# ADR 0011: Use webhooks for detection and earnings for reconciliation

- Status: Accepted
- Date: 2026-10-21

## Context

Perform must attribute settled paid-message purchases and later reversals to a
known experiment message and frozen fan assignment. Fanvue creator payment,
refund and dispute events require `read:creator`. Earnings reads require
`read:insights` and return an authoritative cursor-paginated ledger containing
fan UUID, transaction ID, message UUID for message sales, and reversal rows that
name the transaction they reverse.

A webhook subscription is attached to the creator/app event destination; it is
not created for each broadcast. Deliveries are at least once and unordered, so
they provide timely notification rather than exactly-once truth. Polling the
earnings API can recover missed events, but repeated full-ledger polling is
slower and more expensive.

Webhooks are therefore the better operational path for timely incremental
processing, but they are not the only way to obtain the data. The earnings API
contains the transaction evidence needed to backfill or reconstruct outcomes at
a later date.

## Decision

Use one creator/app webhook subscription for the required creator commerce
event types. Verify exact raw bytes, deduplicate stable event IDs,
retain out-of-order reversals and project an outcome only when creator, message,
assignment and arm all agree.

The subscription receives creator commerce events beyond a single experiment.
Filter them immediately against the stored creator and the two known experiment
message UUIDs. Unrelated payments do not enter experiment evidence.

Use bounded `GET /v1/insights/earnings` reads as the backfill and authoritative
reconciliation path. Read an overlapping experiment time window, page to
completion, deduplicate transaction IDs, join message rows to the two stored
message UUIDs and join reversals through `reversedTransactionOrderId`. Missing
assignments, orphan reversals, reused IDs or aggregate drift fail closed and
remain auditable. Reconciliation snapshots append; they do not overwrite prior
webhook evidence or a frozen analysis.

Run reconciliation before closing an experiment and periodically during its
observation window. Re-run after late refund/dispute evidence and mark any
frozen conclusion for re-analysis.

## Consequences

- Results can update promptly without a webhook per send.
- A temporary destination outage does not make webhooks the sole copy of truth.
- The webhook path needs `read:creator`; the reconciliation path needs
  `read:insights`. Each retains its own approval, re-consent and operations cost.
- Polling-only remains a recovery-capable alternative, proving that webhooks are
  not the sole source, but it is not the preferred production design because it
  delays results and repeatedly scans overlapping ledger windows.
- Accepting this ADR selects the architecture. Creating a live destination,
  secret, subscription, queue, cron job or deployment remains an explicit
  implementation action with its own owner-visible gate.

## Alternatives considered

- **One webhook subscription per broadcast.** Rejected; subscriptions cover
  event types for the creator/app and events carry the routing identifiers.
- **Webhook-only accounting.** Rejected because delivery is retryable and
  unordered and authoritative financial reconciliation is available.
- **Mass-message aggregates only.** Rejected because they do not identify buyers
  or pair refunds and disputes to transactions.
- **Polling only.** Viable for a bounded proof, but not preferred for timely
  product updates.

## Phase X findings (21 October 2026)

- Fanvue acknowledges only 2xx; any other status is retried and can auto-disable
  the destination, with no replay. The receiver therefore returns 200 for every
  captured delivery, including dead letters and unsupported event types, and
  answers the unsigned `fanvue.webhook.verification` probe sent when a
  subscription is created through the API.
- **Unresolved:** the documentation never states that a payment's `message_uuid`
  equals the mass-message `uuid` returned by a send. If it does not, routing by
  message UUID classifies every purchase as unrelated. The fallback is the
  per-mass-message aggregates (`purchaseCount`, `totalRevenue`) from
  `GET /v1/chats/mass-messages`. See `docs/product/phase-x-contract-verification.md`.

## Current implementation

The webhook receiver and append-only earnings reconciliation are implemented.
Reconciliation is creator-triggered rather than scheduled. ADR 0015 resolves the
unproven UUID relationship by using assignment-window attribution by default and
keeping per-message aggregates as the arm-level check.

## Sources checked

Official Fanvue webhook subscription, delivery/idempotency, creator payment,
refund/dispute and earnings documentation, checked 21 October 2026.
