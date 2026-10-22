# ADR 0016: Seed results with the live subscriber cohorts

- Status: Accepted
- Date: 2026-10-21
- Amends: the Phase 8C seeded relationship bands; follows [ADR 0014](0014-derive-subscriber-relationship-from-subscription-history.md)

## Context

Phase 8C seeded Results with invented NEWER/ESTABLISHED/LOYAL relationship bands
and a tenure band. ADR 0014 later defined the live relationship as five cohorts
derived from subscription history and Fan Insights. Showing two vocabularies
would make the demo describe something the product cannot measure, and would
need a lossy mapping (lapsed and trialing have no honest band).

The owner's direction: the seed data should reflect what the live product
produces.

## Decision

- One contract for both sources. `AudienceMemberEvidence` v2
  (`perform-audience-evidence-v2`) carries `subscriberRelationship` (never
  subscribed, trialing, active renewing, active not renewing, lapsed), the
  `resubscribedAfterLapse` and `hasTrial` flags and `earliestSubscriptionAt`.
  The old bands and tenure band are retired.
- Every row carries `provenance` (`DEMO` or `REAL`). A breakdown refuses mixed
  provenance, seeded results refuse REAL rows, and the panel labels the source
  ("Seeded demo · not live" or "Live Fanvue evidence").
- Seeded members are drawn only from cohorts a `subscribers` smart-list capture
  can contain (active renewing, active not renewing, trialing). The UI says why
  never-subscribed and lapsed fans are absent.
- `buildLiveAudienceBreakdown` maps frozen `audience_member_evidence` rows and
  counted commerce events onto the same contract with REAL provenance, and
  carries the ADR 0015 attribution caveat.
- One table for both. Seeded and live members are stored as the same row in
  `audience_member_evidence` (migration 0003), under the same immutability and snapshot-order
  rules; the database and `experiments.data_provenance` say which is which.
  Seeded fixtures generate those rows, and `memberEvidenceFromRow` is the single
  mapping from a stored row to what Results shows, for both sources.
- Older v1 evidence in a stored result snapshot is not rendered as current.

## Consequences

- Preview stays deterministic, D1-free and zero-write; it uses static fixtures.
- Phase 8F adds a REAL Results route that still refuses below active.
- ADR 0017 extends the same decision to commerce: seeded and live outcomes share
  `commerce_events` and one deterministic projection.
- The migrations must be applied to both D1 databases.

## Alternatives considered

- **Separate live dimension beside the seeded bands.** Rejected by the owner:
  the demo would not show the real product.
- **Labelled mapping onto the old bands.** Rejected: lossy and confusing.
- **Two tables with one cohort vocabulary.** Rejected: the seeded path would not
  exercise the live constraints, and nothing wrote the seeded table.
