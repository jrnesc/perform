# ADR 0001: Use an embedded creator surface

- Status: Accepted
- Date: 2026-10-20

## Context

Perform is a short creator workflow operating on Fanvue audiences, Vault media,
messages and outcomes. Both on-platform and off-platform apps can be listed,
use Fanvue billing, call the API, receive webhooks and run background work.

The differentiator is therefore the product surface, not API capability.

## Decision

Use Fanvue's on-platform `embedded` creator surface. Do not build a fan surface
for the initial product.

## Consequences

- Creators open Perform inside Fanvue without a separate login flow.
- Fanvue supplies a single-use session token and resolved light/dark theme.
- The UI must work inside a responsive sandboxed iframe.
- Native browser `alert`, `confirm` and `prompt` dialogs cannot be used. Perform
  will use ordinary in-app confirmation screens or Fanvue host dialogs instead;
  this does not remove any required product capability.
- Downloads are unavailable inside the iframe.
- The app must send Fanvue-compatible CSP and security headers.

## Alternatives considered

An off-platform app would offer unrestricted browser navigation and its own
cookie session, but would take the creator out of Fanvue and add an OAuth login
without providing additional API access needed by Perform.
