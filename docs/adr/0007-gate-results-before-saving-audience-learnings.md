# ADR 0007: Gate results before saving audience learnings

- Status: Accepted
- Date: 2026-10-20
- Clarified: 2026-10-20, after the Phase 5 owner check

## Context

Phase 4 must make representative copy and price results useful without turning a
small, stale, partial or invalid experiment into a winner claim. Raw result
evidence and a reusable audience learning have different lifecycles: evidence
must remain inspectable even when interpretation is blocked, while a learning is
only valid after integrity, completeness, freshness and volume checks pass.

Fanvue's current mass-message read returns recipient, view, purchase and gross
revenue aggregates. Settled native message purchases arrive separately on
`creator.payment.succeeded`; full refunds and formal disputes are separate
events. Those creator event families require `read:creator`. Phase 4 does not
need that scope because it renders versioned demo evidence only.

## Decision

Use one deterministic analysis boundary for both display and persistence.

- Copy tests use a Beta(1,1) prior and beta-binomial posterior simulation with a
  fixed, versioned seed. The primary outcome is settled purchases divided by all
  assigned recipients.
- Price tests use a fixed-seed, recipient-level non-parametric bootstrap. Each
  assigned recipient contributes settled revenue or zero; the primary outcome
  is settled revenue divided by all assigned recipients.
- Present 90% uncertainty intervals and a rounded probability that arm B is
  better. Never present the probability alone as a winner declaration.
- Report the observed primary-metric direction separately from confidence. Name
  Arm A, Arm B or a tie and quantify the observed effect before explaining
  whether it is dependable beyond this test.
- A learning requires `CLOSED`, complete evidence no more than 24 hours old, at
  least 10 assigned recipients in each arm and at least four settled purchases
  overall. These are transparent Phase 4 product defaults, not universal
  statistical guarantees.
- `LOW_VOLUME`, `ZERO_PURCHASES`, `STALE`, `INCOMPLETE`, `PARTIAL_LAUNCH` and
  `INVALID` results retain raw evidence but cannot emit a learning.
- Passing the integrity, completeness, freshness and volume gate is necessary
  but not sufficient for a learning. A learning also requires a dependable
  direction: at least 90% fixed-seed probability for the arm that led in the
  observed primary metric. An inconclusive result remains useful as observed
  evidence but is not persisted as an audience learning.
- Full refunds and disputes reduce settled purchases and revenue. Gross counts
  and revenue remain visible so reversals do not silently rewrite history.
- Saved learnings are scoped to a declared audience and experiment variable.
  They contain no individual-fan causal claim and cannot recommend personalised
  pricing.
- Store immutable analysed result snapshots separately from learning history in
  migration 0002. Scope both tables by creator and real/demo provenance. Phase 4
  writes only `DEMO` rows to `PERFORM_DEMO_DB`.

## Consequences

- UI, API and persistence share one interpretation gate, so a blocked result
  cannot become a learning through a second code path.
- Fixed seeds make the interview fixtures and tests reproducible, while the
  displayed uncertainty remains honest about small samples.
- The initial thresholds are intentionally conservative and easy to revise by a
  later ADR after product evidence; changing them can change saved conclusions.
- A future live adapter must verify webhooks, reconcile aggregate reads and
  justify `read:creator` before it can create non-demo evidence.

## Sources checked

Official Fanvue documentation, checked 20 October 2026:

- “Send a mass message”
- “Insights metrics: payment sources, gross vs net, reversals”
- “Creator payment events”
- “Creator refund and dispute events”
- “Scopes”
