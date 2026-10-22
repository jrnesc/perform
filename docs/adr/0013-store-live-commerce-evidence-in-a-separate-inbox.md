# ADR 0013: Store live commerce evidence in a separate inbox

- Status: Superseded in part by ADR 0017
- Date: 2026-10-21

## Context

ADR 0011 chose one creator/app webhook subscription for detection and earnings
reads for reconciliation. The existing `purchases` table cannot hold live
webhook evidence safely:

- its foreign key requires a confirmed `send_intents` row for the exact arm and
  message, so it cannot record a refund that arrives before its payment;
- `purchase_reversals` references a purchase by webhook *event* ID, but Fanvue
  reversals name the *payment* ID;
- it has nowhere to keep a purchase whose purchaser has no frozen assignment
  and no append-only reconciliation record.

## Decision

Migration 0004 adds tables that nothing else reads, so the seeded demo results
path is unchanged:

- `commerce_events` — verified, creator-scoped payments for a known experiment
  message, and reversals keyed by payment ID. A payment ID may appear on one
  payment event only (partial unique index); the `(source, event_id)` key plus a
  payload hash makes retries idempotent and a reused ID fail.
- `commerce_dead_letters` — verified-but-unprocessable deliveries, keeping only
  a payload hash because bodies can carry purchaser display fields.
- `reconciliation_snapshots` — append-only earnings comparisons, enforced by an
  update-blocking trigger.

Projection is a deterministic replay of stored events, so arrival order cannot
change the result. Payments the attribution strategy cannot place (ADR 0015) are never stored. Reversals are
stored before their payment is known, because the payment ID alone cannot show
whether it is ours; they carry no purchaser data, are excluded from any
experiment until their payment exists, and are reported by a pending count.
Retention of never-matched reversals follows the reconciliation window.

A purchase for a known message with no matching frozen assignment is stored and
flagged but excluded from arm totals; reconciliation marks the snapshot
incomplete.

Frozen audience evidence is stored separately, in `audience_member_evidence`
(ADR 0016). ADR 0017 moves seeded purchases onto `commerce_events` so seeded
and live commerce share one path.

## Consequences

- Live ingestion cannot weaken the shared commerce projection or the allocation
  evidence gate.
- Phase 8F adds a gated REAL Results route without changing these storage rules.
- Fan deletion removes a purchaser's `commerce_events` and cascades audience
  evidence through assignments. A stored reversal contains no fan data.
- The migrations must be applied to both D1 databases by the owner.

## Alternatives considered

- **Reuse `purchases` and `purchase_reversals`.** Rejected for the constraints
  above; relaxing them would weaken the confirmed-send invariant.
- **Store raw bodies for replay.** Rejected; they contain display fields.
