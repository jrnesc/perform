# ADR 0008: Prove webhook contracts with local signed fixtures

- Status: Accepted
- Date: 2026-10-20

## Context

Phase 5 must either add a verified live Fanvue webhook receiver or keep the
integration proof unambiguously fixture-driven. Native creator payment, refund
and dispute events require `read:creator`. Adding that scope makes existing
installations authorise again and affects app review. Authoritative invoice
reconciliation through `GET /insights/earnings` separately requires
`read:insights`.

Fanvue has no sandbox. Developer Area test events are synthetic but still need
the app owner to authorise the event's scope and an active destination. The
interview build already proves a real embedded session and a real read-only
Vault path with `read:self` and `read:media`; representative live purchase data
is not needed to prove the integrity rules.

Current official contracts checked on 20 October 2026 establish that:

- Fanvue signs `t=<unix>,v0=<hex>` over `<t>.<exact raw body>` with HMAC-SHA256
  and a default 300-second tolerance;
- deliveries are at least once and unordered, and retries keep the same event
  id while changing the delivery timestamp;
- `creator.payment.succeeded` identifies message purchases with `data.id`,
  `message_uuid`, purchaser UUID, creator UUID, gross/net minor units and
  currency;
- full refunds and formal disputes point back to the original payment;
- earnings reconciliation is transaction-level and append-only: reversals are
  separate negative rows naming `reversedTransactionOrderId`; the original is
  not rewritten;
- mass-message `purchaseCount` and `totalRevenue` are useful gross engagement
  aggregates, but do not establish settled net revenue or reversal pairing.

## Decision

Keep Phase 5 fixture-driven. Do not add `read:creator`, `read:insights`, a
webhook destination, subscription lifecycle, signing secret, or live receiver.

Implement `perform-integration-proof-v1` as a local contract harness:

- use the official Builder SDK `fanvue-v0` signer/verifier against exact raw
  bytes and its 300-second replay window;
- parse only the native creator payment, full refund and formal dispute fields
  Perform needs, dropping handles and other personal fields;
- require the expected creator, a known experiment message UUID and the
  purchaser's frozen assignment before projecting a purchase;
- deduplicate by stable event id plus payload hash and reject an id reused with
  different content;
- retain unmatched reversals until their original payment arrives, so delivery
  order cannot resurrect settled revenue;
- freeze conclusions by analysis version. Later evidence marks that version for
  re-analysis and never silently mutates it;
- append reconciliation snapshots side by side with webhook projections.
  Missing-event, incomplete and stale discrepancies remain visible.

The embedded Results surface labels this as a local signed-fixture proof and
explicitly says there is no live receiver. `WEBHOOK_DERIVED` and
`FANVUE_RECONCILIATION` remain future live provenance values, not claims about
the seeded demo.

## Consequences

- The interview demonstrates the hard security and ordering behavior without a
  consent expansion, live financial data or ambiguous half-live route.
- The manifest stays at `read:self` and `read:media`; existing installations do
  not need to re-authorise for Phase 5.
- There is no production webhook availability, subscription storage, async
  processing, dead-letter recovery or live reconciliation in this build.
- A future live phase requires a new accepted decision covering re-consent, app
  review, encrypted per-subscription secrets, active-destination monitoring,
  `read:creator`, `read:insights`, a controlled migration and operational
  ownership.

## Current implementation

This ADR governed the Phase 5 proof and remains an accurate historical record.
ADRs 0011, 0013, 0017 and 0018 later introduced the gated live receiver, shared
commerce store and manual reconciliation path. The local signed-fixture harness
continues to test signature and ordering behavior without claiming live evidence.

## Sources checked

Official Fanvue documentation, checked 20 October 2026:

- “Fanvue webhooks”
- “Verify webhook signatures”
- “Delivery, retries and idempotency”
- “Subscribe to webhooks”
- “Creator payment events”
- “Creator refund and dispute events”
- “Test your app before you submit”
- “Send a mass message”
- “Get earnings data”
- “Insights metrics: payment sources, gross vs net, reversals”

## Alternatives considered

- **Add `read:creator` plus a live receiver.** Rejected for this interview
  phase because it forces re-consent/review and provides no sandbox or safe
  representative sales evidence.
- **Use mass-message aggregates as final results.** Rejected because their
  purchase and revenue totals cannot prove invoice-level reversal attribution
  or settled net revenue.
- **Add `read:insights` for live reconciliation only.** Rejected because it is
  another consent expansion without a live-send requirement; the transaction
  contract is adequately demonstrated by versioned local fixtures.
