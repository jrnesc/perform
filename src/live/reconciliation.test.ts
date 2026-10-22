import { beforeEach, describe, expect, it } from "vitest";
import type { CommerceEventRecord } from "../persistence/live-evidence";
import { planReconciliationWindows, reconcileExperimentWindow } from "./reconciliation";
import { allocatedExperiment, creatorUuid } from "./test-fixtures";

const window = { startAt: "2026-10-20T00:00:00.000Z", endAt: "2026-10-21T00:00:00.000Z" };
const day = 86_400_000;

const earning = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-10-20T11:00:00.000Z",
  gross: 1200,
  net: 1000,
  currency: "USD",
  source: "message",
  transactionOrderId: "payment-1",
  messageUuid: "message-a",
  user: { uuid: "fan-1" },
  ...overrides,
});
const ledger =
  (...rows: unknown[]) =>
  async () =>
    new Response(JSON.stringify({ data: rows, nextCursor: null }));

const paymentEvent = (id: string, fan: string, arm: "A" | "B", experimentId: string): CommerceEventRecord => ({
  source: "FANVUE_WEBHOOK",
  kind: "PAYMENT",
  eventId: `event-${id}`,
  creatorUuid,
  paymentId: id,
  purchaserUuid: fan,
  messageUuid: arm === "A" ? "message-a" : "message-b",
  messageType: "BROADCAST",
  attributionStrategy: "ASSIGNMENT_WINDOW",
  messageMatched: true,
  experimentId,
  arm,
  grossMinor: 1200,
  netMinor: 960,
  currency: "USD",
  occurredAt: "2026-10-20T11:00:00.000Z",
  payloadHash: `hash-${id}`,
  receivedAt: "2026-10-20T11:00:01.000Z",
});
const reversalEvent = (id: string, paymentId: string): CommerceEventRecord => ({
  source: "FANVUE_WEBHOOK",
  kind: "REVERSAL",
  eventId: `event-${id}`,
  creatorUuid,
  paymentId,
  reversalId: id,
  reversalType: "REFUND",
  amountMinor: 1200,
  currency: "USD",
  occurredAt: "2026-10-20T12:00:00.000Z",
  payloadHash: `hash-${id}`,
  receivedAt: "2026-10-20T12:00:01.000Z",
});

describe("reconciliation windows", () => {
  const base = {
    observationStart: "2026-10-01T00:00:00.000Z",
    observationEnd: "2026-10-30T00:00:00.000Z",
    until: "2026-10-30T00:00:00.000Z",
    reconciledThrough: null,
  };

  it("splits a long observation into bounded, overlapping windows", () => {
    const windows = planReconciliationWindows(base);
    expect(windows).toHaveLength(5);
    for (const w of windows) expect(Date.parse(w.endAt) - Date.parse(w.startAt)).toBeLessThanOrEqual(7 * day);
    for (let i = 1; i < windows.length; i += 1) {
      expect(Date.parse(windows[i - 1].endAt) - Date.parse(windows[i].startAt)).toBe(day);
    }
    expect(windows[0].startAt).toBe(base.observationStart);
    expect(windows.at(-1)?.endAt).toBe(base.observationEnd);
  });

  it("resumes with an overlap and never reads past the observation window", () => {
    const [only] = planReconciliationWindows({
      ...base,
      reconciledThrough: "2026-10-29T00:00:00.000Z",
      until: "2026-11-15T00:00:00.000Z",
    });
    expect(only).toEqual({ startAt: "2026-10-28T00:00:00.000Z", endAt: "2026-10-30T00:00:00.000Z" });
    expect(
      planReconciliationWindows({
        ...base,
        reconciledThrough: "2026-10-30T00:00:00.000Z",
        until: "2026-10-30T00:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(planReconciliationWindows({ ...base, until: "2026-09-01T00:00:00.000Z" })).toEqual([]);
  });

  it("rejects impossible plans", () => {
    expect(() => planReconciliationWindows({ ...base, overlapMs: 8 * day })).toThrow();
    expect(() => planReconciliationWindows({ ...base, observationEnd: base.observationStart })).toThrow();
  });
});

describe("experiment reconciliation", () => {
  let ctx: Awaited<ReturnType<typeof allocatedExperiment>>;
  let nextId = 0;
  const run = (transport: () => Promise<Response>, frozenConclusionRevision: number | null = null) =>
    reconcileExperimentWindow({
      experimentId: ctx.experimentId,
      creatorUuid,
      window,
      capturedAt: "2026-10-21T01:00:00.000Z",
      transport,
      repository: ctx.store,
      newId: () => `snapshot-${++nextId}`,
      frozenConclusionRevision,
    });
  beforeEach(async () => {
    ctx = await allocatedExperiment();
  });

  it("records agreement between webhook evidence and the earnings ledger", async () => {
    const arm = ctx.armOf("fan-1");
    await ctx.store.recordCommerceEvent(paymentEvent("payment-1", "fan-1", arm, ctx.experimentId));
    const record = await run(ledger(earning({ messageUuid: arm === "A" ? "message-a" : "message-b" })));
    expect(record).toMatchObject({ isComplete: true, discrepancy: false, needsReanalysis: false });
    expect(record.reconciledSettledPurchases[arm]).toBe(1);
    expect(await ctx.store.listReconciliations(ctx.experimentId)).toEqual([record]);
  });

  it("recovers a purchase whose webhook never arrived and flags the drift", async () => {
    const arm = ctx.armOf("fan-1");
    const record = await run(ledger(earning({ messageUuid: arm === "A" ? "message-a" : "message-b" })), 0);
    expect(record.discrepancy).toBe(true);
    expect(record.needsReanalysis).toBe(true);
    expect(record.webhookSettledPurchases).toEqual({ A: 0, B: 0 });
    expect(record.reconciledSettledPurchases[arm]).toBe(1);
    expect(record.note).toMatch(/differ/);
  });

  it("flags a refund the ledger does not show", async () => {
    const arm = ctx.armOf("fan-1");
    const message = arm === "A" ? "message-a" : "message-b";
    await ctx.store.recordCommerceEvent(paymentEvent("payment-1", "fan-1", arm, ctx.experimentId));
    await ctx.store.recordCommerceEvent(reversalEvent("refund-1", "payment-1"));
    const record = await run(ledger(earning({ messageUuid: message })));
    expect(record).toMatchObject({ discrepancy: true, needsReanalysis: true });
    expect(record.webhookSettledPurchases[arm]).toBe(0);
    expect(record.reconciledSettledPurchases[arm]).toBe(1);
  });

  it("fails closed on a purchaser with no frozen assignment", async () => {
    const record = await run(ledger(earning({ user: { uuid: "outsider" } })));
    expect(record).toMatchObject({ isComplete: false, missingAssignmentCount: 1 });
    expect(record.reconciledSettledPurchases).toEqual({ A: 0, B: 0 });
    expect(record.note).toMatch(/lack a frozen assignment/);
  });

  it("fails closed on a reversal that points outside the window and on unreadable rows", async () => {
    const orphan = await run(
      ledger(
        earning({
          source: "refund",
          transactionOrderId: "refund-9",
          reversedTransactionOrderId: "payment-outside",
          messageUuid: null,
          gross: -1200,
        }),
      ),
    );
    expect(orphan).toMatchObject({ isComplete: false, orphanReversalCount: 1 });
    const unreadable = await run(ledger({ nonsense: true }));
    expect(unreadable).toMatchObject({ isComplete: false, ignoredRowCount: 1 });
  });

  it("flags a frozen conclusion when evidence has since changed, without a discrepancy", async () => {
    const arm = ctx.armOf("fan-1");
    await ctx.store.recordCommerceEvent(paymentEvent("payment-1", "fan-1", arm, ctx.experimentId));
    const message = arm === "A" ? "message-a" : "message-b";
    expect(await run(ledger(earning({ messageUuid: message })), 0)).toMatchObject({
      discrepancy: false,
      needsReanalysis: true,
    });
    expect(await run(ledger(earning({ messageUuid: message })), 1)).toMatchObject({ needsReanalysis: false });
  });

  it("appends nothing when the ledger cannot be read", async () => {
    await expect(
      run(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 30 });
    expect(await ctx.store.listReconciliations(ctx.experimentId)).toEqual([]);
  });

  it("keeps every snapshot and refuses to rewrite one", async () => {
    await run(ledger());
    await run(ledger());
    expect(await ctx.store.listReconciliations(ctx.experimentId)).toHaveLength(2);
    expect(() => ctx.sqlite.prepare("UPDATE reconciliation_snapshots SET discrepancy = 1").run()).toThrow(
      /append-only/,
    );
  });
});
