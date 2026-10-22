# ADR 0019: Gate real sends and schedule both arms together

- Status: Accepted
- Date: 2026-10-22
- Amends: the write gate in the environment contract

## Context

Perform now has frozen assignments, immutable variant definitions, creator-scoped
REAL storage and append-only capability activation. Fanvue writes are real: there
is no sandbox and list creation has no documented idempotency key. Mass-message
sends do have a 24-hour idempotency key and may return an ambiguous 409, timeout
or server error.

## Decision

`PERFORM_WRITE_MODE` is `disabled | enabled`. It is a deployment switch, not a
recipient or creator allowlist. REAL effects require the switch to be enabled, a
verified creator session, an active owner-recorded `send` capability, a REAL
experiment owned by that creator and a confirmation hash over the exact frozen
recipients, variants and scheduled time. Seeded experiments use an in-memory
fixture gateway and never construct the Fanvue transport.

Each arm gets one durable custom-list record. List creation is journaled before
the request; an uncertain create is never repeated automatically because a new
list could duplicate the first. Member batches contain at most 100 UUIDs, are
journaled individually and may replay the identical request because Fanvue
skips existing members. Both lists are read back and must exactly equal their
frozen assignments.

Both paid messages use the same future `scheduledAt`. Their intents and payload
hashes are durable before either request. The idempotency keys are permanently
`<experimentId>:A` and `<experimentId>:B`. An uncertain outcome is resolved by
reading mass messages and, if needed within retention, retrying the identical
payload with the same key. A fresh key is never generated. If only one schedule
confirms, cancellation is attempted and the experiment moves to operator review.

Assigned recipients remain the Results denominator even when Fanvue reports a
lower delivery-time `recipientCount`. Both custom lists are deleted after a
creator cancellation or a clean close. Close requires the planned end,
complete discrepancy-free reconciliation and a mass-message totals check.

## Consequences

- Local, preview and demo deployments remain physically unable to call Fanvue
  writes with the default switch.
- An uncertain list create needs operator resolution rather than an unsafe retry.
- Scheduling gives the creator a cancellation window and keeps arm delivery
  aligned, but Fanvue still cannot provide an atomic two-message transaction.
- The first real purchase records whether its payment message UUID equals the
  confirmed mass-message UUID. `ASSIGNMENT_WINDOW` remains the default unless a
  matching proof is deliberately used to enable `MESSAGE_UUID_MATCH`.

## Current implementation

The guarded launch and cancellation paths are implemented for real and fixture
transports. ADR 0020 adds the observation window and checked close. ADR 0021
adds safe recovery for saved allocations and launch interruptions that occur
before any send intent exists.
