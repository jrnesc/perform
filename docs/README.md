# Perform documentation

The documents are separated by purpose so research evidence does not silently
turn into an architecture decision.

## Product

- [`product/implementation-plan.md`](product/implementation-plan.md) — current
  product scope, workflow, constraints and open questions.
- [`product/delivery-process.md`](product/delivery-process.md) — phase boundaries
  and the required end-of-session plan/handoff protocol.
- [`product/component-library-audit.md`](product/component-library-audit.md) —
  verified Fanvue UI primitives, integration contract and application-level gaps.

## Architecture

- [`architecture/overview.md`](architecture/overview.md) — current system
  boundaries, execution flow and implemented versus missing operations.
- [`architecture/domain-and-persistence.md`](architecture/domain-and-persistence.md)
  — lifecycle, allocation, recovery, effect and evidence invariants.
- [`architecture/environment-contract.md`](architecture/environment-contract.md)
  — real/demo/preview modes, capability activation and fail-closed gates.
- [`architecture/live-data-operations.md`](architecture/live-data-operations.md)
  — implemented live paths, manual operations and automation gaps.
- [`adr/`](adr/) — decisions, their status and consequences.

## Research archive

- [`research/independent-review.md`](research/independent-review.md)
- [`research/product-research.md`](research/product-research.md)
- [`research/research-handoff.md`](research/research-handoff.md)
- [`research/new-session-implementation-prompt.md`](research/new-session-implementation-prompt.md)

Research documents are evidence and history. They are not automatically current
requirements or accepted decisions.

## Session handoffs

`handoffs/` contains the prompt for continuing in a fresh chat. A new handoff is
written at the end of every implementation phase; the latest one is the entry
point for the next session.
