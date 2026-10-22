# ADR 0020: Confirm an observation window at launch and close manually

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR 0019 (close conditions)

## Context

The first real launch reached `RUNNING`, but nothing could end it: the close
checks needed a planned end that nothing stored, and the latest reconciliation
that nothing produced. The owner decided (22 October 2026) that the creator
chooses the window at launch and closes by hand; scheduling, alerting and
automatic close belong to the unplanned operations phase.

## Decision

**Window.** The review step asks for an observation window in whole days after
delivery: default 7, allowed 1–90. The end time (`delivery + days`) is sent with
the launch, included in the confirmation hash, stored in
`launch_confirmations.observation_ends_at` and copied to
`experiments.observation_ends_at`, which attribution and reconciliation already
read as the window end. A retry with a different window is refused like a
different delivery time. List and detail pages show "Running · ends <date>".

**Reconciliation, until the operations phase.** The detail page has a **Run
reconciliation** button (`POST /api/experiments/reconcile`). It reads the
earnings ledger and Fanvue's per-message totals over one window, from delivery to
the observation end or now if earlier, and appends a snapshot. It is read-only
against Fanvue but REAL runs need `earnings_reconciliation` and
`mass_message_totals` at `active`. Those are not yet verified, so the owner must
record Phase X evidence and activation for both before a real experiment can
close. A failed read appends nothing. The bounded window planner stays for the
future scheduled job; there is no scheduler.

**Close.** **Close experiment** (`POST /api/experiments/close`) runs every check
and returns all blockers: window not ended, no reconciliation, latest
reconciliation not covering the whole window, incomplete, with a discrepancy,
totals check unrun or mismatched. On success it deletes both custom lists, then
moves `RUNNING → CLOSED`. A REAL close needs `PERFORM_WRITE_MODE=enabled` and
`send` at `active`, because list deletion is a write. Each deletion is journaled;
a failure leaves the experiment `RUNNING` and a retry deletes only what remains;
a 404 on retry counts as already deleted; closing a closed experiment returns
`CLOSED` with nothing deleted.

**Seeded.** Seeded experiments in the demo database use the same routes and
panel with the fixture write gateway and a fixture read ledger (no earnings,
zero per-message totals), so they launch, reconcile and close with zero Fanvue
requests. The REAL entry points refuse DEMO provenance. Static fixture
experiments have no lifecycle panel.

## Consequences

- No experiment closes on its own; the creator must return after the window.
- A real experiment cannot close until the two totals capabilities are verified
  and activated, which also tests the reconciliation path against real data.
- Assignment-window attribution can count a fan's unrelated broadcast purchases,
  which the totals check reports as a mismatch (ADR 0015); such an experiment
  stays open until that is resolved rather than closing on disputed numbers.
- The 300-cent minimum price stays: free mass messages cannot produce purchases.

## Current implementation

Launch, manual reconciliation and manual close use this contract in both real
and demo database workspaces. ADR 0021 separately governs continuing or cleaning
up experiments that have not reached `RUNNING`.
