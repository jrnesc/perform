# ADR 0022: Open Perform to every creator who installs it

- Status: Accepted
- Date: 2026-10-22
- Amends: ADR 0018 (activation), ADR 0009 (webhook creator boundary)

## Context

Every table and query is already scoped by the signed-in creator's Fanvue UUID,
but two test-phase choices limited real use to the owner's account:

- Capability verification and activation rows were written per creator, by
  hand, so any other creator saw every live capability refused.
- The webhook receiver filed every payment under the single
  `PERFORM_LIVE_CREATOR_UUID` and dead-lettered events naming any other
  creator, although the destination is app-wide and each signed payload names
  its creator.

## Decision

**Verification is global; activation is self-service.** A Phase X verification
records a fact about Fanvue's contract, not about one account. The latest
verification of a capability, for any creator, applies to every creator, and a
later `FAIL` switches the capability off for all of them. A verified capability
is active for a creator unless that creator's latest activation decision is
`DEACTIVATE`. Rows stay append-only and owner-written; the application still
has no write path to them.

**The webhook routes by payload.** After the signature check, each event is
stored in the scope of the creator its signed payload names. A payment that
matches none of that creator's experiments is acknowledged and not kept, as
before. Dead letters for an unparseable event are filed under the creator the
body names, or `unknown`. `PERFORM_LIVE_CREATOR_UUID` is no longer part of the
webhook gate; only the operator evidence route still reads it.

## Consequences

- Any creator who installs Perform and grants the scopes can capture, launch,
  read live results, reconcile and close, still behind `PERFORM_WRITE_MODE`,
  `PERFORM_LIVE_CAPABILITIES` and the per-launch exact confirmation.
- Switching one creator off is one `DEACTIVATE` row for that creator; its
  `verification_id` is optional (migration 0004 was edited in place and the
  real database reset). A `FAIL` verification, recorded for any creator,
  switches the capability off for everyone.
- Unverified until a real payment arrives: that the app-wide destination
  delivers every installed creator's events with the one signing secret.
- Still operations-phase work: scheduled reconciliation, alerting, secret
  rotation and an owner tool for switching creators off.
