# Environment and execution-mode contract

Deployment environment, data provenance and authority to make external changes
are independent. A production Worker can show seeded data; a local environment
can perform real reads; neither fact grants write permission.

## Execution surfaces

| Surface | Data | Persistence | External effects |
| --- | --- | --- | --- |
| Real workspace | Verified Fanvue creator | `PERFORM_REAL_DB` | Reads and explicitly gated writes |
| Demo workspace | Server-owned fixtures | `PERFORM_DEMO_DB` | Fixture transports only |
| Preview | Static fixtures | None | None |
| Dry run | Real or demo definition | May persist experiment truth | Returns a plan; executes nothing |

The server chooses the database from a validated workspace value and verified
session. Repository instances are also creator- and provenance-scoped.

## Session and demo authorization

- Creator identity comes from the Fanvue embedded session, never request JSON.
- Demo access requires the verified creator UUID in
  `PERFORM_DEMO_CREATOR_UUIDS` or normalized handle in
  `PERFORM_DEMO_CREATOR_HANDLES`.
- Client-side switches expose authorised choices; they are not access controls.
- Demo IDs and `DEMO` repository records cannot enter a real Fanvue adapter.

## Capability ladder

Every live capability is derived from four independent facts:

1. it is named in `PERFORM_LIVE_CAPABILITIES` and its required scopes are in
   `OAUTH_SCOPES`;
2. those scopes are present on the verified session grant;
3. the latest append-only Phase X verification of the capability, recorded for
   any creator, is `PASS` (verification describes Fanvue's contract); and
4. the creator's own latest activation decision is not `DEACTIVATE`
   (activation is self-service, ADR 0022).

The resulting states are:

```text
fixture_backed → configured → connected → verified → active
```

The application reads verification and activation records but exposes no route
that creates, changes or deletes them. Database triggers enforce append-only
history.

| Capability | Required scopes | Purpose |
| --- | --- | --- |
| `audience_discovery` | `read:chat read:fan` | Capture the contactable subscribers smart list |
| `subscriber_state` | `read:fan` | Read per-fan subscription history |
| `purchase_enrichment` | `read:fan read:insights` | Freeze prior purchase facts |
| `commerce_webhook` | `read:creator` | Receive creator payment and reversal events |
| `earnings_reconciliation` | `read:insights` | Reconcile the earnings ledger |
| `mass_message_totals` | `read:chat` | Compare Fanvue's per-message aggregates |
| `send` | `write:chat read:fan` | Create/verify lists and schedule messages |

## Write gate

`PERFORM_WRITE_MODE` accepts only `disabled` or `enabled`.

`enabled` is necessary but never sufficient. A real write additionally requires:

- a verified creator session;
- the relevant capability at `active`;
- a REAL experiment owned by that creator;
- state-specific integrity checks; and
- for launch, a confirmation hash over the frozen audience, variants, delivery
  time and observation end.

Transport construction happens after these checks. A refusal therefore makes no
Fanvue request. Demo lifecycle actions use fixture transports regardless of the
write switch.

## Webhook gate

`POST /api/webhooks/fanvue` is available only when:

- `PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED` is exactly `true`; and
- `FANVUE_WEBHOOK_SIGNING_SECRET` is present as a Worker secret.

The receiver uses only `PERFORM_REAL_DB` and stores each signed event in the
scope of the creator its payload names (ADR 0022). `PERFORM_LIVE_CREATOR_UUID`
now only scopes the operator evidence route. It verifies exact raw bytes before
parsing and never reports secrets from health or operator routes.

## Configuration

The implemented configuration surface includes:

```text
SESSION_SECRET=<Worker secret>
OAUTH_SCOPES=<space-separated scopes>

PERFORM_REAL_DB=<D1 binding>
PERFORM_DEMO_DB=<D1 binding>

PERFORM_DEMO_CREATOR_UUIDS=<comma-separated UUIDs>
PERFORM_DEMO_CREATOR_HANDLES=<comma-separated handles>

PERFORM_LIVE_CAPABILITIES=<comma-separated capability IDs>
PERFORM_WRITE_MODE=disabled|enabled
PERFORM_LIVE_CREATOR_UUID=<creator UUID>
PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED=true|false
FANVUE_WEBHOOK_SIGNING_SECRET=<Worker secret>
```

OAuth client credentials, session secrets and webhook signing secrets must stay
in environment-specific secret storage. They must not be committed, logged or
returned to the browser. Creator UUIDs are identifiers rather than credentials,
but should still be kept out of reusable documentation and fixtures unless a
specific operational need justifies them.

## Current deployment shape

The repository is configured for one Cloudflare Worker built by OpenNext, with
separate real and demo D1 bindings. The deployed OAuth scope set includes all
seven scopes required by the current capabilities. Deployment configuration may
enable writes for the controlled owner account; local and preview safety still
comes from session, provenance and capability gates, not an assumption that a
particular environment is harmless.

## Operational rules

- Logs may include environment, provenance, experiment IDs and failure classes,
  but not access tokens, signing secrets or unnecessary fan data.
- Signed media URLs are transient and are not persisted.
- Preview and demo content must remain explicitly labelled.
- Health reports capability configuration, not proof of a live session grant.
- A capability must not be described as operating merely because its code or
  environment variable exists.

