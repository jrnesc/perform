# ADR 0003: Separate live integration and demonstration data

- Status: Accepted
- Date: 2026-10-20

## Context

The available Fanvue creator account is real but currently has no audience or
campaign history. Fabricating live activity or sending to uncontrolled users is
unsafe, while an empty account cannot demonstrate the complete product value.

## Decision

Use the real account for embedded authentication, creator identity, supported
reads and a polished empty state. Use an explicit demonstration workspace for
seeded audiences, experiments, failures and results. Both modes share the same
domain interfaces; fixtures do not live inside presentation components.

Fanvue has no sandbox: all API calls reach production and paid tests use real
money. The demonstration workspace is therefore an internal Perform capability,
not a Fanvue environment.

Access to the demonstration workspace is authorised server-side from the
verified embedded session. A configured allowlist of creator UUIDs may receive
the capability; initially it contains only the project owner's creator UUID.
The UI may show an **Open demo workspace** button only when the server returns
that capability. Client-side hiding is not an access control.

External writes remain dry-run by default. Any future live test must use an
explicitly controlled audience.

## Current implementation

The separation remains in force. Real and demo records use separate D1 bindings
as well as provenance-scoped repositories. Live reads and sends now exist behind
the capability ladder and write gate introduced by ADRs 0018 and 0019; demo
transports still make no Fanvue calls.

## Consequences

- The interview can show a rich end-to-end workflow without misrepresenting
  seeded results as Fanvue data.
- Real integration remains visible and independently verifiable.
- Every screen must make its data source clear.
- Demo records use a separate namespace/repository and cannot be joined into
  live creator metrics.
- Gateway contract tests must ensure fixtures and live adapters produce the same
  application-level shapes.
