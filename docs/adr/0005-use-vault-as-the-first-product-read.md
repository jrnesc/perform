# ADR 0005: Use Vault as the first product read

- Status: Accepted
- Date: 2026-10-20

## Context

Phase 2 needs one genuine, read-only Fanvue boundary behind the same
application-owned contract as seeded demonstration data. The candidates were
Lists plus member eligibility, or Vault assets. Lists are central to audience
snapshotting, but eligibility combines list kinds, membership semantics and fan
contactability that belong with the Phase 3 audience workflow.

Fanvue's current Vault contract is narrower and explicit: `GET /v0/media`, the
Builder SDK's `vault.listMedia`, 1-based offset pagination, ready-state filters,
requested thumbnail variants, and `read:media`. Signed variant URLs are
short-lived and must not be persisted.

## Decision

Use the creator's Vault as the first real product read.

- Request only `read:self` and `read:media` for this phase.
- Read ready assets in pages of 12 and request thumbnail variants explicitly.
- Map Fanvue objects into application-owned media objects with live provenance.
- Never persist signed variant URLs.
- Treat 401 as reconnect, 403 as missing permission or required age verification,
  429 as rate limiting with retry guidance, and other failures as temporarily
  unavailable.
- Serve versioned, obviously fictional assets from an in-process fixture gateway
  with the same contract. Demo access is derived from the verified creator UUID
  and `PERFORM_DEMO_CREATOR_UUIDS` on the server.
- Do not create a D1 binding for fixture reads. D1 remains accepted for
  experiment truth, but Phase 2 has no mutable persistence requirement.

## Consequences

- The real account can demonstrate a genuine empty Vault without manufactured
  Fanvue records, while an allowlisted owner can switch to clearly labelled demo
  assets.
- Demo identifiers use a `demo:` namespace and the live adapter rejects them
  before any Fanvue call.
- Lists and member eligibility remain an explicit Phase 3 integration decision.
- Existing installations must consent again after the manifest's requested
  scopes are reduced to the Phase 2 minimum.

## Current implementation

Vault remains the media boundary and signed URLs are still transient. Later
accepted ADRs expanded the deployed scope set for audience capture, commerce and
sending; the two-scope limit was specific to this first-read milestone.

## Sources checked

- Fanvue, “Work with media,” checked 20 October 2026.
- Fanvue, “Call the API with the SDK client,” checked 20 October 2026.
- Fanvue, “Scopes” and “Rate limits,” checked 20 October 2026.
