# ADR 0009: Limit the first live audience proof to the subscribers smart list

- Status: Accepted
- Date: 2026-10-21

> **Correction (21 October 2026):** the Fanvue reference documents contactability
> filtering only for the `subscribers` smart list. Eligibility is therefore
> limited to that list; every other smart list and every custom list fails closed
> until contactability is proven. Smart-list identifiers are a fixed set of nine.

## Context

Perform needs a complete, immutable set of fan UUIDs before deterministic A/B
allocation. Fanvue does provide the selected audience, but it does not return
the whole audience in one response. Fanvue v1 returns at most 50 members plus a
cursor for the next page. Perform must request each page until Fanvue returns no
next cursor, combine the pages, remove duplicate UUIDs and then freeze that
completed list. This is one bounded snapshot operation when the experiment is
set up, not continuous polling.

Smart- and custom-list member reads both require `read:chat` and `read:fan`.
The API may return no total, repeat a member across pages, rate limit the page
walk or return a malformed row.

The two list types do not make the same promise. Smart-list members are filtered
by contactability and the selected smart-list type. Custom-list membership only
proves that somebody placed the fan on that list. It does not by itself prove
that the fan is currently contactable or otherwise eligible.

Adding either scope requires existing installations to consent again and, for a
listed app, requires Fanvue review. The current app has neither scope and its
manifest must not change as part of this decision gate.

## Decision

Begin the first live audience proof with Fanvue's contactability-filtered
`subscribers` smart list only:

1. request the first page of at most 50 members;
2. follow each returned cursor until `nextCursor` is null;
3. discard profile fields, deduplicate stable fan UUIDs and exclude creator
   accounts;
4. fail the entire snapshot if any page cannot be read or validated; and
5. freeze the completed UUID set before allocating A/B.

Do not refresh membership after allocation. Fans joining or leaving the source
list later do not change the frozen experiment population.

Treat malformed rows as excluded and auditable. Never allocate while any page
is missing. A repeated identical member is counted and collapsed; it is not an
additional recipient.

Represent custom-list members as `REQUIRES_CONTACTABILITY_PROOF`. Do not pass
them to allocation until a separately documented eligibility intersection is
available and tested.

## Consequences

- The first live audience capability is narrow and has defensible eligibility.
- Only UUIDs enter the allocation boundary; handles and display names are not
  retained for experiment analytics.
- Rate limits stop the capture and expose `Retry-After`; a partial page walk is
  never treated as a snapshot.
- Implementation requires `read:chat` and `read:fan`, re-consent and app review.
- Accepting this ADR selects the architecture but does not itself connect an
  account, deploy, or create an external effect.

## Alternatives considered

- **Allow custom lists immediately.** Rejected for the first proof because list
  membership is not contactability evidence.
- **Use the API's optional total as the page loop.** Rejected because totals may
  be null and are not pagination truth.
- **Retain member profiles for debugging.** Rejected because stable UUIDs and
  exclusion counts are sufficient.

## Sources checked

Official Fanvue v1 conventions, smart-list member, custom-list member, OAuth
scope and rate-limit documentation, checked 21 October 2026.
