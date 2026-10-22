# ADR 0002: Use Cloudflare as the deployment platform

- Status: Accepted
- Date: 2026-10-20

## Context

The project owner already uses Cloudflare. Perform needs an HTTPS application,
API routes, webhook ingestion, relational state and eventually rate-aware
background processing. Fanvue's Builder SDK has first-class Next.js App Router
integration. Cloudflare's current guidance prefers vinext for new Next.js-style
Workers applications, while OpenNext remains its compatibility path for Next.js.

## Decision

Use Cloudflare Workers as the deployment target, with Next.js deployed through
OpenNext. The Phase 0 spike proved the application bundle and dynamic routes in
both local `workerd` and the remote Workers runtime. Retain this pairing while
the Fanvue Builder SDK's first-class Next.js App Router integration remains
useful.

This decision does not select D1, Queues, KV, R2, Durable Objects or Workflows.
Persistence requires its own Phase 1 decision. Background work starts behind an
inline adapter; add Queues only when real paging or provisioning demonstrates
the need.

## Validation evidence

On 20 October 2026:

- Next.js 16.4.2 built successfully with `@opennextjs/cloudflare` 1.20.12.
- `/embedded`, `/api/health` and the fail-closed embedded-session route ran in
  local Workers preview.
- Worker `perform-fanvue` deployed successfully to
  `https://perform-fanvue.augur-2f4.workers.dev`.
- the remote `/api/health` route returned HTTP 200, `x-opennext: 1`, dry-run
  mode, and the required Fanvue `frame-ancestors` policy.
- Fanvue OAuth values were stored as Worker secrets, the draft app was
  installed, and the one-time embedded session exchange completed successfully
  inside Fanvue.
- no product-level Fanvue read path or live-write capability was enabled.

## Consequences

- One operational platform can host UI, APIs, webhooks and scheduled work.
- D1 and Queues provide a coherent production story if they solve demonstrated
  needs.
- Next.js-to-Workers compatibility is an explicit early risk and time-boxed
  dependency to re-check during framework upgrades.
- Next.js 16.4.2 is the current minimum proven version for this repository.
- KV, R2, Durable Objects, Workflows and Supabase remain out of scope unless an
  ADR identifies a concrete requirement.

## Alternatives considered

- Vercel for the Next.js app plus a separate relational database.
- React/Vite with a small Hono Worker, using the Builder SDK's lower-level
  embedded primitives instead of its Next.js helpers.
