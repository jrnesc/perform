# ADR 0015: Attribute purchases by frozen assignment and send window

- Status: Accepted
- Date: 2026-10-21
- Amends: [ADR 0011](0011-use-webhooks-for-detection-and-earnings-for-reconciliation.md) and [ADR 0013](0013-store-live-commerce-evidence-in-a-separate-inbox.md) routing

## Context

ADRs 0011 and 0013 routed a payment to an experiment arm only when its
`message_uuid` equalled a stored, confirmed experiment message. The Phase X
documentation pass (contract #15) found that Fanvue never documents that a
payment's `message_uuid`, or an earnings row's `messageUuid`, equals the `uuid`
returned for a mass message. A mass message emits no per-recipient
`creator.message.sent`, so per-recipient message UUIDs may exist and are not
exposed. If they do, every experiment purchase would be classed as unrelated
while the receiver stayed healthy.

The official v1 reference does document, on 21 October 2026:

- `creator.payment.succeeded` carries `source` and `message_type`; earnings rows
  carry `source` and `messageType` (`BROADCAST`, `GHOST_PROMOTION`,
  `SINGLE_RECIPIENT`, `AUTOMATED_*`, …).
- `GET /v1/chats/mass-messages` (`read:chat`, cursor-paginated, `size` 1–50,
  most recent first) returns per message `recipientCount`, `viewCount`,
  `purchaseCount` and `totalRevenue` in cents.

## Decision

Attribution is a strategy interface (`src/live/attribution.ts`) with two
implementations. Both first trust a stored message UUID: a match by an assigned
fan is attributed; a match by an unassigned fan is stored and flagged as a
missing assignment.

1. **`MESSAGE_UUID_MATCH`** — otherwise nothing is attributed. Valid only once a
   real send proves payment and mass-message UUIDs are equal. It is selectable
   only with a recorded proof; nothing records one yet, so it is never selected.
2. **`ASSIGNMENT_WINDOW`** (default) — otherwise a payment with
   `source = message`, `messageType = BROADCAST`, made inside an experiment's send
   window (`observation_started_at` or `launched_at` to the observation end) by a
   fan with a frozen assignment there, is attributed to the fan's assigned arm.

Visibility rules, applied under either strategy:

- A payment that meets the assignment-window rule but names no stored message is
  counted: as `assignmentWindowOnly` when strategy 2 attributes it, or as
  `unmatchedPlausible` (stored, excluded from totals) under strategy 1. The
  operator view and every reconciliation snapshot carry both counts.
- A payment plausible for two experiments' windows is never guessed; it is
  dead-lettered as `ATTRIBUTION_AMBIGUOUS` with a hash only.
- Reconciliation can compare per-arm gross purchases and revenue with Fanvue's
  own `purchaseCount` and `totalRevenue` (`mass_message_totals` capability,
  `read:chat`). This needs no join and is the authoritative per-arm total. A
  difference is recorded as `aggregate_mismatch`, not hidden.

`GHOST_PROMOTION` is excluded until a real send shows whether Perform's sends
ever carry it.

## Consequences

- If UUIDs are per-recipient, purchases are still counted, and the operator sees
  a high "assignment and window only" count with zero message matches.
- Strategy 2 adds noise from a fan's unrelated broadcast purchases inside the
  window. Because assignment is randomised, that noise is expected to be equal
  across arms: it lowers precision but does not bias the arm comparison. Results
  copy says so (`assignmentWindowCaveat`). The Fanvue totals check makes the
  size of the noise visible.
- Overlapping experiments for the same fans cannot be attributed under strategy
  2; the planner should avoid them.
- Migration 0004 stores `message_type`, `attribution_strategy` and
  `message_matched` on payments, an `ATTRIBUTION_AMBIGUOUS` dead-letter reason,
  and attribution and mass-message columns on reconciliation snapshots.
- Phase 8G records the first real payment comparison in the append-only
  `attribution_proofs` table. `MATCH` permits a later deliberate selection of
  strategy 1; `NO_MATCH` keeps `ASSIGNMENT_WINDOW`. The default does not change
  automatically, and attribution is not described as proven until that record exists.

## Alternatives considered

- **Keep message-UUID routing only.** Rejected: fails silently on the unproven
  identifier.
- **Mass-message aggregates only.** Rejected as the sole source: no purchaser
  level, so no reversals, cohorts or reconciliation by fan. Kept as the check.
- **Per-recipient message reads.** Rejected: not exposed for mass messages.
