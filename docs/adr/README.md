# Architecture decision records

ADRs record decisions that materially constrain the implementation. They are a
decision log, not a second architecture specification: current boundaries are
summarised in [`../architecture/`](../architecture/), while each ADR preserves
the context in which its decision was made.

Statuses:

- **Proposed** — under discussion; do not treat as a committed dependency.
- **Accepted** — agreed and safe to implement against within the ADR's stated
  scope. Phase-specific ADRs remain accepted historical records after that phase.
- **Superseded** — retained for history and linked to its replacement.

Each ADR describes context, decision, consequences and alternatives. A new ADR
supersedes an old one rather than rewriting architectural history.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-use-an-embedded-creator-surface.md) | Accepted | Use Fanvue's embedded creator surface |
| [0002](0002-use-cloudflare-as-the-deployment-platform.md) | Accepted | Use Cloudflare Workers with Next.js through OpenNext |
| [0003](0003-separate-live-and-demonstration-data.md) | Accepted | Keep real integration and seeded demo data separate |
| [0004](0004-use-d1-for-relational-experiment-state.md) | Accepted | Use D1 for relational experiment state |
| [0005](0005-use-vault-as-the-first-product-read.md) | Accepted | Use Vault as the first real product read |
| [0006](0006-keep-phase-3-audiences-demo-only.md) | Accepted | Keep Phase 3 audience setup demo-only |
| [0007](0007-gate-results-before-saving-audience-learnings.md) | Accepted | Gate interpretation and store scoped learnings separately from result evidence |
| [0008](0008-prove-webhook-contracts-with-local-signed-fixtures.md) | Accepted | Keep Phase 5 webhook and reconciliation proof fixture-driven |
| [0009](0009-limit-live-audience-proof-to-smart-lists.md) | Accepted | Limit the first live audience proof to the contactability-filtered subscribers smart list |
| [0010](0010-freeze-batch-fan-insights-before-assignment.md) | Accepted | Define creator/fan relationship from frozen subscription and payment evidence |
| [0011](0011-use-webhooks-for-detection-and-earnings-for-reconciliation.md) | Accepted | Use one commerce webhook subscription for detection and earnings reads for backfill and reconciliation |
| [0012](0012-derive-subscriber-state-from-the-documented-subscriber-read.md) | Superseded | Derive subscriber state from the per-fan subscriber read (wrongly concluded no history endpoint exists; superseded by 0014) |
| [0013](0013-store-live-commerce-evidence-in-a-separate-inbox.md) | Superseded in part | Introduced the live commerce inbox; its separate seeded path is superseded by ADR 0017 |
| [0014](0014-derive-subscriber-relationship-from-subscription-history.md) | Accepted | Derive the subscriber relationship from the documented subscription history plus Fan Insights |
| [0015](0015-attribute-purchases-by-assignment-and-send-window.md) | Accepted | Attribute purchases by frozen assignment and send window by default; message-UUID matching only after a real send proves it |
| [0016](0016-seed-results-with-the-live-subscriber-cohorts.md) | Accepted | Seed Results with the five live subscriber cohorts so seeded and live evidence share one labelled contract |
| [0017](0017-use-one-commerce-evidence-path.md) | Accepted | Use one stored commerce shape and projection for seeded and live Results |
| [0018](0018-owner-written-capability-activation.md) | Accepted, amended by 0022 | Require owner-written Phase X evidence and activation decisions for live capabilities |
| [0019](0019-gate-real-sends-and-schedule-both-arms.md) | Accepted | Gate REAL writes, verify frozen lists and schedule both arms with immutable idempotency keys |
| [0020](0020-observation-window-and-manual-close.md) | Accepted | Confirm an observation window at launch; reconcile and close by hand with every blocker named |
| [0021](0021-recover-saved-and-interrupted-launches.md) | Accepted | Resume or discard saved experiments and safely abandon pre-send launch interruptions |
| [0022](0022-open-perform-to-every-installed-creator.md) | Accepted | Treat verification as global, activate creators self-service and route webhook events by payload creator |

## Reading older decisions

Several early ADRs deliberately constrained a particular delivery phase—for
example, keeping audience capture or webhooks fixture-only. Later ADRs expanded
those boundaries. Read the `Supersedes`, `Amends`, and `Current implementation`
notes before treating an older phase decision as a present limitation.
