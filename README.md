# Perform

**Perform helps Fanvue creators split one audience into two fair cohorts, test one change, and learn which offer performs better.**

It is an embedded Fanvue app for A/B testing paid (PPV) mass messages. A creator picks an audience and a Vault asset, writes two variants that differ in exactly one thing (copy or price), and Perform:

1. **Freezes the audience** and splits it deterministically into arms A and B.
2. **Provisions** one Fanvue custom list per arm and verifies its membership exactly.
3. **Schedules** both paid messages for the same delivery time.
4. **Observes** purchases, refunds and disputes through signed webhooks for a confirmed window (default 7 days).
5. **Reconciles** that evidence against Fanvue's earnings ledger and per-message totals.
6. **Closes** the experiment once the numbers agree, deletes the lists and freezes the result.

Every real effect sits behind server-side gates. A seeded workspace runs the same flow against fixtures and makes zero Fanvue requests.

## Architecture

```mermaid
flowchart TB
    subgraph Fanvue["Fanvue platform"]
        Launcher["App launcher<br/>(iframe + one-time token)"]
        API["Fanvue REST API<br/>lists · mass messages · earnings · insights"]
        Hooks["Webhooks<br/>payment · refund · dispute"]
    end

    subgraph CF["Cloudflare"]
        subgraph Worker["Worker: Next.js 16 via OpenNext"]
            UI["Embedded UI<br/>setup · review · history · detail"]
            Session["Session exchange<br/>(signed creator session)"]
            Routes["API routes<br/>prepare · launch · reconcile · close · results"]
            Gates{{"Gates<br/>creator · provenance · capability · write switch"}}
            Domain["Domain<br/>allocation · state machine · analysis"]
            WriteGW["Write gateway<br/>(only path that mutates Fanvue)"]
            ReadGW["Read transport<br/>(bounded, rate-limited)"]
            Fixtures["Fixture gateways<br/>(seeded, zero requests)"]
            Receiver["Webhook receiver<br/>signature · dedupe · dead letters"]
        end
        Assets[("Static assets<br/>ASSETS binding")]
        RealDB[("D1: perform-real")]
        DemoDB[("D1: perform-demo")]
        Obs["Workers observability"]
    end

    Creator(("Creator")) --> Launcher --> UI
    UI --> Session
    UI --> Routes --> Gates --> Domain
    Domain --> WriteGW --> API
    Domain --> ReadGW --> API
    Domain --> Fixtures
    Domain --> RealDB
    Domain --> DemoDB
    Hooks --> Receiver --> RealDB
    Worker -.-> Assets
    Worker -.-> Obs
```

The REAL and DEMO workspaces are separate D1 databases, and every repository is scoped by creator and provenance, so seeded data cannot leak into real results and a seeded experiment can never reach the real gateway.

### Experiment lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> SNAPSHOTTING: freeze audience
    SNAPSHOTTING --> ALLOCATED: assign arms
    ALLOCATED --> PROVISIONING: confirmed launch
    PROVISIONING --> VERIFIED: lists match exactly
    VERIFIED --> ARMED: durable send intents
    ARMED --> SENDING
    SENDING --> RUNNING: both sends confirmed
    SENDING --> PARTIAL_LAUNCH: only one confirmed
    PARTIAL_LAUNCH --> OPERATOR_REVIEW
    RUNNING --> CLOSED: window ended + clean reconciliation
    CLOSED --> [*]
```

Any non-terminal state can also move to `INVALID` (for example, a creator cancelling before delivery). Each transition needs typed evidence, such as the snapshot hash, list counts, intents or reconciliation, and the state machine rejects transitions without it.

## Keeping the data correct

| Concern | How Perform handles it |
| --- | --- |
| Fair, reproducible split | Stratified, hash-based allocation (FNV-1a, versioned algorithm) over a frozen, hashed audience snapshot. The same input always gives the same arms. |
| No duplicate side effects | List creation and member batches (≤100) are journaled before each request; an uncertain list create is never blindly retried. Sends use permanent idempotency keys (`<experimentId>:A` / `:B`) and are resolved by reading back before any retry. |
| Recipients are exactly the assignment | Both custom lists are read back and must equal the frozen arms before anything is scheduled. |
| Both arms or neither | Both messages share one `scheduledAt`. If only one schedule confirms, it is cancelled and the experiment goes to operator review. |
| Trustworthy purchase events | Webhooks are verified on the exact raw bytes, deduplicated by event ID, and anything unattributable is dead-lettered rather than dropped. |
| Attribution | Purchases are attributed by frozen assignment and send window by default; message-UUID matching is only enabled after a real purchase proves it. |
| Numbers that agree | Reconciliation compares webhook totals with Fanvue's earnings ledger and its own per-message purchase totals, flags missing assignments, orphan refunds and unreadable rows, and appends an immutable snapshot. |
| Honest close | Close lists every blocker (window still open, reconciliation missing, incomplete or mismatched). Only then does it delete both lists and freeze metrics; list deletions are journaled, so a retry is safe. |
| Nothing goes live by accident | `PERFORM_WRITE_MODE` must be `enabled`, and each live capability climbs a ladder (configured → scope granted → verified → owner-activated) recorded in append-only tables. |
| Honest results | Results use exact assigned denominators, settled revenue net of refunds, fixed-seed Bayesian estimates, and suppress small cohorts. |

## Stack

- **Runtime:** Cloudflare Workers, Next.js 16 (App Router) through OpenNext, React 19
- **Storage:** Cloudflare D1 (SQLite), two databases, SQL migrations in `migrations/`
- **Fanvue:** `@fanvue/builder-sdk` for the embedded session; REST API version `2025-06-26`
- **Tests:** Vitest with a migrated in-memory SQLite stand-in for D1

## Repository layout

```text
src/
  app/            Next.js routes: embedded UI, /preview harness, /api/*
  domain/         allocation, experiment state machine, observation window
  experiments/    setup contracts, review, dry-run plan, seeded audiences
  integrations/   Fanvue read/write transports and response parsers
  live/           gated entry points: capture, launch, ingestion, reconcile, close
  persistence/    D1 repositories (creator- and provenance-scoped)
  results/        analysis and audience evidence
migrations/       D1 schema
```

## Running it

```bash
pnpm install
pnpm dev
```

- `http://localhost:3000/preview` is a seeded design harness. It needs no Fanvue session, D1 binding or `.env.local`.
- `/embedded` is the real app. It only works when opened from Fanvue, with the values from `.env.example` set.

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
pnpm cf:deploy
```

Migrations: `pnpm exec wrangler d1 migrations apply perform-real --remote` (and `perform-demo`).

## Status

Deployed at `https://perform-fanvue.augur-2f4.workers.dev`. The first real experiment launched on 22 October 2026 (both arms scheduled and delivered). Launch, observation window, reconciliation and close are built; live results on the detail page and scheduled operations (automatic reconciliation, alerting, per-creator webhook secrets) are next.
