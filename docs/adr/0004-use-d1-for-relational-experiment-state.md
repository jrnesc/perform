# ADR 0004: Use D1 for relational experiment state

- Status: Accepted
- Date: 2026-10-20

## Context

Perform needs relational constraints for exactly two variants, one assignment per
experiment/fan, immutable external-action intents, duplicate-event rejection and
append-only metric evidence. The application already runs on Cloudflare Workers,
but ADR 0002 deliberately did not choose a persistence product.

The important consistency boundaries are short and local. Large audiences do
not need one giant transaction: their assignments may be staged in retryable
chunks while an experiment remains `SNAPSHOTTING`, then atomically checked and
finalised. Fanvue API calls cannot share a transaction with any database.

D1 executes the statements in `batch()` as a transaction and rolls back the
batch if one fails. A D1 database processes queries serially. Current documented
limits include 100 bound parameters per query, 1,000 queries per paid Worker
invocation or 50 on free plans, a 30-second maximum query duration, and a 10 GB
paid database limit. These constraints favour short indexed work and bounded
chunks, which fit Perform's expected interview and early-product scale.

## Decision

Use D1 as Perform's relational store behind application-owned repository
contracts. Domain modules import neither Cloudflare nor Fanvue SDK types.

- Scope repository instances to one creator and one data provenance.
- Use separate repository/binding configuration for real and demonstration
  workspaces in Phase 2; the provenance column is defence in depth.
- Keep read replication disabled initially. If enabled later, use D1 Sessions
  and a primary-first constraint for integrity-sensitive reads.
- Limit assignment writes to 40 rows per database batch. Identical chunks are
  no-ops; a conflicting assignment hits the `(experiment_id, fan_uuid)` key and
  rolls back that chunk.
- Finalise allocation in a separate transaction only when persisted total, A/B
  counts and allocation algorithm version match the frozen snapshot.
- Persist both `(experiment_id, arm)` and `(creator_uuid, idempotency_key)` as
  unique send-intent identities. Store the immutable payload and its hash before
  invoking Fanvue.
- Treat a Fanvue call and its database outcome as two operations. A timeout or
  crash after the call leaves the intent `UNKNOWN`; the same external
  idempotency key is retried only within its supported window. A confirmed
  one-sided send enters `PARTIAL_LAUNCH`, never `RUNNING`.
- Insert a verified webhook identifier and its purchase projection in one
  transaction. Duplicate `(source, event_id)` values cannot create purchases.
- Store metric snapshots append-only with an explicit source. Reconciliation
  adds evidence rather than overwriting webhook-derived evidence.
- Do not add Queues, pub/sub, cron, Durable Objects or Workflows in this phase.
  A later queue adapter may carry slow Fanvue work, but at-least-once delivery
  will still depend on these database idempotency rules.

The current schema is split across four migrations: experiment/lifecycle truth,
result snapshots and learnings, immutable audience evidence, and shared commerce
evidence with reconciliation and capability records. Creator-token storage,
background-job tables and queue state remain out of scope.

## Retention and deletion target

Engineering defaults are 90 days for identifiable fan-level rows after an
experiment becomes terminal and 24 months for non-identifying aggregate metric
snapshots. These durations are configurable policy placeholders, not legal
advice or evidence of completed legal review.

A future fan-level deletion workflow should remove assignments, audience
evidence and attributable commerce rows for that fan while preserving genuinely
non-identifying arm-level snapshots. A deletion before launch invalidates the
frozen snapshot; after launch it cannot recall a message. This workflow and its
automation are not implemented yet.

## Consequences

ADR 0017 superseded the initial commerce design with one `commerce_events` path
and append-only reconciliation snapshots before release.

- Relational constraints protect the integrity failures that matter most to the
  product story.
- There is no false claim of exactly-once delivery across D1 and Fanvue.
- Large audience ingestion is recoverable, but only finalisation is atomic over
  the complete snapshot.
- A single D1 database is single-threaded and capped in size. Sharding by creator
  or moving the repository adapter remains possible if measured scale requires it.
- Fan deletion can reduce the available raw audit detail while preserving
  appropriately anonymous aggregate learning.

## Alternatives considered

- **Managed Postgres:** stronger scaling and transaction tooling, but introduces
  another platform and network boundary without a current product requirement.
- **Durable Objects with SQLite:** useful for per-entity coordination, but adds
  routing/lifecycle complexity and does not improve the current relational model.
- **One D1 database per creator:** attractive for isolation and deletion at
  scale, but premature for the POC and more complex to provision and migrate.
- **Queues/pub-sub now:** useful for later rate-limited Fanvue list population,
  but unnecessary for domain and persistence work and not a substitute for
  idempotency.

## References

- [D1 `batch()` transaction behaviour](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 read replication and Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/)
