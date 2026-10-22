# Live-data operations

This document separates the live behavior implemented in the application from
the operational automation that still does not exist.

## Implemented live paths

| Path | Trigger | Fanvue interaction | Persistence |
| --- | --- | --- | --- |
| Audience capture | Creator prepares a REAL experiment | Subscribers list, subscription history, Fan Insights | Assignments and immutable audience evidence |
| Launch | Creator confirms schedule and window | Create/verify two lists; schedule two messages | Confirmation, list/batch journal, send intents and outcomes |
| Commerce ingestion | Fanvue webhook delivery | None during handling | Deduplicated events or hash-only dead letters |
| Results | Creator opens a REAL result | None | Deterministic projection from stored evidence |
| Reconciliation | Creator clicks **Run reconciliation** | Earnings ledger and mass-message totals | Append-only reconciliation snapshot |
| Close | Creator clicks **Close experiment** | Delete both custom lists | Journal deletions and close transition |
| Abandon | Creator abandons a safe interrupted launch | Delete known custom lists | Journal deletions and invalidation |

All REAL entry points verify creator ownership and provenance. Reads and writes
also require their capabilities at `active`; writes require
`PERFORM_WRITE_MODE=enabled`.

## Audience capture

Capture uses only the contactability-filtered `subscribers` smart list. It walks
every cursor, deduplicates UUIDs and excludes creator accounts before enrichment.
Each fan then receives:

- subscription lineage from paginated subscriber history;
- current subscription/renewal state and reversal-adjusted purchase facts from
  Fan Insights; and
- a frozen subscriber cohort and prior-purchaser status.

The read transport pins API version `2025-06-26`, allows at most six concurrent
requests and budgets 200 starts per rolling minute. Any missing page, looping
cursor, forbidden key, malformed response or incomplete enrichment aborts the
snapshot. Partial audiences never allocate.

## Launch journal and recovery

List creation, member batches and send intents are recorded before or around
each external effect so retries preserve identity:

- uncertain list creation is not repeated automatically;
- identical member batches may replay;
- lists must read back with the exact frozen membership;
- send retries reuse the persisted key and payload;
- one confirmed send triggers cancellation and operator review;
- two confirmed sends are required for `RUNNING`.

A creator can resume a saved `ALLOCATED` experiment. A safe interruption in
`PROVISIONING` or `VERIFIED` can be abandoned only when no send intent exists
and every created list has a known ID. Otherwise the record remains visible for
operator review.

## Webhook handling

The webhook receiver verifies the signature over exact raw bytes before parsing.
Fanvue delivery is at least once and unordered, so the receiver deduplicates by
source/event ID and payload hash. It stores supported creator payments and
reversals, or a hash-only dead letter for unusable input.

Out-of-order reversals remain pending until their payment arrives. Events for
other creators or payments that cannot be attributed never increase experiment
revenue. The receiver acknowledges captured deliveries according to the Fanvue
retry contract so malformed-but-recorded events do not create an endless retry
loop.

## Attribution and reconciliation

The default attribution strategy counts an assigned fan's broadcast purchase
inside that experiment's observation window. Direct message-UUID attribution is
available only after an append-only proof records that Fanvue's payment UUID
matches the stored mass-message UUID.

Potential matches for multiple experiments are dead-lettered as ambiguous.
Assignment-window-only and plausible-but-unmatched counts remain visible to the
operator.

Manual reconciliation:

1. reads the bounded delivery-to-observation window;
2. walks the earnings ledger to completion;
3. joins payments and reversals;
4. compares attributed arm totals with Fanvue's per-message totals; and
5. appends a snapshot or appends nothing if a required read fails.

Close checks the latest snapshot. It refuses an unended window, incomplete
coverage, missing totals check, discrepancy or aggregate mismatch.

## Capability and secret ownership

Capability evidence and activation decisions are owner-written, append-only D1
records. The application cannot approve itself. The webhook signing secret and
OAuth/session secrets live in Worker secret storage.

Webhook destination creation, subscription lifecycle and secret rotation are
currently manual owner operations. The repository does not contain a durable
subscription registry or rotation workflow.

## Operator visibility

`/embedded/operator` and `GET /api/operator/live-evidence` expose counts and
identifiers for the configured live creator only. They show dead letters,
pending reversals, attribution counts and reconciliation history without raw
payloads, tokens or profile data. The route returns 404 when the live creator is
not configured.

## Missing automation

The following remain unimplemented:

- webhook destination/subscription provisioning and repair;
- signing-secret rotation;
- queue-backed ingestion or launch work;
- dead-letter and webhook-silence alerting;
- scheduled reconciliation;
- automatic experiment close;
- automated retention/deletion jobs; and
- a full operator workflow for resolving uncertain list creation or send state.

Zero sales is not evidence of webhook silence. Until monitoring exists,
operators must separately inspect destination health, dead-letter growth and
reconciliation freshness.

## Privacy and retention

Persist only stable UUIDs and financial/event identifiers required for
assignment, attribution and audit. Do not persist handles, names, email
addresses, avatars or raw webhook bodies. Intended retention defaults are
documented in [domain-and-persistence.md](domain-and-persistence.md), but no
automated deletion job currently enforces them.

