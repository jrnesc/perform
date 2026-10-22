# ADR 0006: Keep Phase 3 audience setup demo-only

- Status: Accepted
- Date: 2026-10-20

## Context

Phase 3 needs a complete audience snapshot for deterministic allocation. Fanvue's
current v1 list contracts provide useful pieces, but adopting them would expand
the already-verified Phase 2 read boundary:

- smart, custom and dynamic-list reads require both `read:chat` and `read:fan`;
- adding either scope requires existing users to consent again;
- smart-list members are explicitly filtered by contactability and selected list
  type, but the custom-list member contract promises membership only;
- v1 member reads are cursor-paginated, have a maximum page size of 50 and do
  not compute a total;
- dynamic lists are account-gated and can answer `403` when unavailable;
- mass-message recipients are resolved from lists at send time, so a source list
  cannot itself represent a frozen experiment assignment.

The interview slice can demonstrate the integrity-sensitive workflow with the
already-authorised, versioned demo workspace. It does not need another real read
merely to make the product appear more integrated.

## Decision

Keep Phase 3 audience selection and eligibility fixture-only. Do not add
`read:chat`, `read:fan` or `write:chat` to the app manifest.

- Serve versioned fictional audience snapshots only after the same verified
  creator allowlist check used by the demo Vault.
- Keep the real workspace's Vault read available, but explain that live audience
  setup is unavailable rather than mixing live assets with demo recipients.
- Preserve provenance on the audience, asset, review and dry-run plan. A demo
  identifier or object cannot cross into a live adapter.
- Treat Fanvue v1 smart-list members as the preferred future source boundary
  because the contract explicitly applies contactability filtering. A future
  live snapshot must walk every opaque cursor with a fixed page size, retain only
  stable fan UUIDs and any declared balancing bucket, reject creator accounts,
  deduplicate before hashing and record exclusions.
- Do not treat custom-list membership alone as eligibility. If custom lists are
  offered later, intersect them with a documented contactable boundary or perform
  a separately documented fresh eligibility check.
- Describe the future output effects using the current v1 contracts: create two
  custom lists, add at most 100 UUIDs per member batch, then prepare two mass
  messages that differ only in the declared variant field. No executor exists in
  Phase 3 and `PERFORM_WRITE_MODE=disabled` remains closed.

## Persistence decision

Provision D1 in Phase 3 now that the setup creates a durable experiment record,
frozen assignments and immutable dry-run intents. Keeping those integrity facts
only in browser state would make refreshes produce an apparently new rehearsal
and would leave Phase 4 learning history without an authoritative experiment.

Use separate `PERFORM_REAL_DB` and `PERFORM_DEMO_DB` bindings so seeded fan UUIDs
cannot share storage with real creator state. Apply ADR 0004's
`0001_domain_and_persistence.sql` independently to both. The Phase 3 route writes
only to the demo binding, reconstructs audiences and assets from server-owned
fixtures, advances through `DRAFT` and `SNAPSHOTTING` to `ALLOCATED`, then stores
the two immutable dry-run message intents. It performs no Fanvue effect.

## Consequences

- A demo-capable verified creator can complete the full setup and inspect exact
  intended Fanvue payloads without a new consent prompt.
- A completed review survives refreshes as creator-scoped experiment truth in
  the isolated demo database; the real binding is provisioned but unused.
- The live workspace tells the truth about its incomplete audience boundary.
- Phase 3 does not prove the live list contract against the owner's account.
- Future live setup has an explicit two-scope review and cannot infer eligibility
  from a custom-list count.

## Current implementation

This decision is historical in scope: Phase 3 remained demo-only as intended.
ADRs 0009, 0010, 0014 and 0018 later authorised and gated the implemented live
capture path. The rule that custom-list membership alone is not eligibility
evidence still applies.

## Sources checked

Official Fanvue documentation, checked 20 October 2026:

- “Send a mass message”
- “Build dynamic lists”
- “Scopes”
- v1 “Get smart list members (cursor-paginated)”
- v1 “Get custom list members (cursor-paginated)”
- v1 “Add members to a custom list”
- v1 “Send a mass message”

