# ADR 0017: Use one commerce evidence path for seeded and live Results

- Status: Accepted
- Date: 2026-10-21
- Supersedes: the separate seeded-purchase path in ADR 0013

## Context

Seeded Results used `purchases`, `purchase_reversals` and hand-built
`ResultPurchase` rows while live evidence used `commerce_events` and deterministic
replay. The seeded path therefore demonstrated weaker ordering and attribution
rules than the product intended to run.

## Decision

Seeded and live outcomes use `CommerceEventRecord`, `commerce_events` and the
same invoice projection. `source` is explicit per row: `SEEDED_FIXTURE` or
`FANVUE_WEBHOOK`. Real and demo databases remain separate, and experiment
provenance still scopes every repository.

The pre-release schema removes `purchases`, `purchase_reversals`,
`webhook_events` and the unused `metric_snapshots`. Seed fixtures first build
payment and reversal records, then derive `ResultPurchase` and member outcomes
through the shared projection. The in-memory signed-contract proof remains a
separate parser/signature harness; it does not claim persisted live evidence.

## Consequences

- Arrival order, full reversals, assignment checks and attribution have one
  implementation for demo and live Results.
- Seeded totals remain unchanged and are tested through the shared projection.
- The four pre-release migrations must be reapplied from scratch; no retirement
  migration is added.
- `SEEDED_FIXTURE` cannot be mistaken for a Fanvue delivery.

## Alternatives considered

- **Keep the lightweight demo objects.** Rejected because the demo would no
  longer exercise the product's actual evidence rules.
- **Add a fifth cleanup migration.** Rejected because no schema has shipped and
  the owner chose four clean pre-release migrations.
