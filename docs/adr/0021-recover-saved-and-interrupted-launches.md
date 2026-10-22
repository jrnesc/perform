# ADR 0021: Recover saved and interrupted launches explicitly

- Status: Accepted
- Date: 2026-10-22
- Extends: [ADR 0019](0019-gate-real-sends-and-schedule-both-arms.md)

## Context

An experiment becomes durable before it sends anything. That creates two
different recovery cases which must not be treated as the same operation:

1. an `ALLOCATED` experiment has a frozen audience and variants but no Fanvue
   effects; and
2. a launch interrupted in `PROVISIONING` or `VERIFIED` may already have custom
   lists in Fanvue, although no message intent exists yet.

Starting over silently would leave duplicate experiments or orphaned lists.
Blindly retrying list creation is unsafe because Fanvue does not provide a list
creation idempotency key. Conversely, forcing every saved allocation through an
operator flow would make an ordinary “continue later” case unnecessarily hard.

## Decision

Treat recovery as three explicit creator actions with different safety rules.

### Continue an allocated experiment

Only `ALLOCATED` experiments may reopen at the launch review. Reconstruct the
review from stored experiment, variants, assignments, audience and asset. The
deterministic allocator must reproduce every stored arm and the stored snapshot
hash; otherwise refuse the resume and require a new experiment.

The saved audience, variants and asset remain frozen. The creator chooses only
the future delivery time and observation window before confirming launch.

### Discard before external effects

`DRAFT`, `SNAPSHOTTING` and `ALLOCATED` experiments may be discarded by moving
them to `INVALID` with the reason `Discarded by creator`. Discard is idempotent,
makes no Fanvue request and hides the record from normal history without
deleting its audit trail.

### Abandon a safe pre-send interruption

Automated abandonment is limited to `PROVISIONING` and `VERIFIED`. It is allowed
only when:

- no send intent exists;
- no list remains in `CREATING` or `UNKNOWN`; and
- every list that may need deletion has a confirmed external UUID.

Delete each known custom list first and journal the deletion. A 404 on retry
counts as already deleted. Only after cleanup succeeds may the experiment move
to `INVALID` with the reason `Abandoned before sending`.

If a send intent exists or list creation is uncertain, refuse abandonment and
leave the experiment visible for operator review. REAL abandonment uses the
same verified-session, active `send` capability and write-mode gates as other
list deletion paths. Demo abandonment uses the fixture transport.

## Consequences

- Creators can continue a valid saved experiment without recapturing or
  reallocating its audience.
- Discard remains a database-only action because no external effect exists.
- Abandonment cleans up known lists without pretending an uncertain external
  state is safe.
- Invalid records remain available for audit but are excluded from the normal
  experiment list.
- Recovery does not add a path from partial launch or operator review back to a
  valid result.

## Alternatives considered

- **Always create a new experiment.** Rejected because it duplicates a valid
  frozen snapshot and leaves the original record unresolved.
- **Retry list creation during resume.** Rejected because an uncertain first
  request may already have created a list.
- **Delete interrupted experiments from D1.** Rejected because it removes the
  transition and external-effect audit trail.
- **Allow abandonment after send intents exist.** Rejected because a message may
  already exist and requires cancellation or operator review instead.
