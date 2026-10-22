# ADR 0018: Activate live capabilities only from owner-written evidence

- Status: Accepted
- Date: 2026-10-21

## Context

Environment configuration and OAuth grants can show that a capability could be
used, but cannot prove Fanvue's live behavior or express the owner's decision to
activate it. Inferring either would collapse the `connected`, `verified` and
`active` states into one unsafe switch.

## Decision

Store append-only Phase X verification outcomes and activation/deactivation
decisions per creator and capability. The application exposes only a read port;
it has no method or route that inserts, updates or deletes these records.
Database triggers reject mutation. `/api/health`, audience capture and REAL
Results read the latest records alongside configuration and the verified
session grant.

A creator-scoped Fanvue read transport pins API version `2025-06-26`, adds the
verified session access token, limits concurrency to six and budgets 200 starts
per rolling minute. `Retry-After` remains visible to the shared error mapper.

Reconciliation remains an explicit operator action in this phase. Before the
commerce capability is activated, operations must choose a schedule and create
alerts for dead-letter growth, webhook health/silence and missed reconciliation
windows. Zero sales alone is never treated as webhook silence.

## Consequences

- Shipping code or setting an environment flag cannot activate live reads.
- A failed later verification or explicit deactivation removes the corresponding
  rung without deleting history.
- REAL Results requires active audience, enrichment and commerce capabilities,
  is labelled `REAL`, and carries the assignment-window caveat.
- Implementing the decision alone did not connect an account, insert records or
  create a schedule; those remained separate owner actions.

## Current implementation

The capability ledger and guards are active in the application. Controlled
owner verification and activation records may now exist in deployed D1. Health
reports configuration only; request-time guards combine configuration with the
verified session grant and the append-only records.

## Alternatives considered

- **Environment variables as verification.** Rejected because deploy access is
  not evidence of live contract behavior.
- **Application-managed verification writes.** Rejected because the application
  must not approve its own activation.
- **Schedule reconciliation immediately.** Deferred until the owner selects the
  cadence and alert ownership with a real account.
