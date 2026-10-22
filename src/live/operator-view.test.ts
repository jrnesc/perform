import { describe, expect, it } from "vitest";
import { buildOperatorEvidenceView } from "./operator-view";
import { reconcileExperimentWindow } from "./reconciliation";
import { allocatedExperiment, creatorUuid } from "./test-fixtures";

describe("operator evidence view", () => {
  it("shows dead letters, pending reversals and the latest reconciliation per experiment with IDs and counts only", async () => {
    const ctx = await allocatedExperiment();
    await ctx.store.recordDeadLetter({
      id: "dead-1",
      reason: "WRONG_CREATOR",
      eventId: "event-x",
      payloadHash: "secret-hash",
      receivedAt: "2026-10-21T11:00:00.000Z",
    });
    await ctx.store.recordDeadLetter({
      id: "dead-2",
      reason: "ATTRIBUTION_AMBIGUOUS",
      eventId: "event-y",
      payloadHash: "secret-hash",
      receivedAt: "2026-10-21T12:00:00.000Z",
    });
    await ctx.store.recordCommerceEvent({
      source: "FANVUE_WEBHOOK",
      kind: "REVERSAL",
      eventId: "event-r",
      creatorUuid,
      paymentId: "payment-unknown",
      reversalId: "refund-1",
      reversalType: "REFUND",
      amountMinor: 1200,
      currency: "USD",
      occurredAt: "2026-10-21T12:00:00.000Z",
      payloadHash: "h",
      receivedAt: "2026-10-21T12:00:01.000Z",
    });
    await ctx.store.recordCommerceEvent({
      source: "FANVUE_WEBHOOK",
      kind: "PAYMENT",
      eventId: "event-p",
      creatorUuid,
      paymentId: "payment-1",
      purchaserUuid: "fan-1",
      messageUuid: "message-a",
      messageType: "BROADCAST",
      attributionStrategy: "ASSIGNMENT_WINDOW",
      messageMatched: true,
      experimentId: ctx.experimentId,
      arm: ctx.armOf("fan-1"),
      grossMinor: 4321,
      netMinor: 3000,
      currency: "USD",
      occurredAt: "2026-10-21T11:00:00.000Z",
      payloadHash: "h2",
      receivedAt: "2026-10-21T11:00:01.000Z",
    });
    const reconcile = (capturedAt: string) =>
      reconcileExperimentWindow({
        experimentId: ctx.experimentId,
        creatorUuid,
        capturedAt,
        repository: ctx.store,
        window: { startAt: "2026-10-21T00:00:00.000Z", endAt: "2026-10-22T00:00:00.000Z" },
        transport: async () => new Response(JSON.stringify({ data: [], nextCursor: null })),
        newId: () => `snapshot-${capturedAt}`,
        frozenConclusionRevision: null,
      });
    await reconcile("2026-10-22T01:00:00.000Z");
    await reconcile("2026-10-22T02:00:00.000Z");

    const view = await buildOperatorEvidenceView(ctx.store);
    expect(view.deadLetters).toMatchObject({ total: 2, byReason: { WRONG_CREATOR: 1, ATTRIBUTION_AMBIGUOUS: 1 } });
    expect(view.deadLetters.recent.map((row) => row.eventId)).toEqual(["event-y", "event-x"]);
    expect(view.pendingReversals).toMatchObject({
      total: 1,
      oldest: [{ paymentId: "payment-unknown", reversalId: "refund-1" }],
    });
    expect(view.reconciliation).toHaveLength(1);
    expect(view.reconciliation[0]).toMatchObject({
      snapshotId: "snapshot-2026-10-22T02:00:00.000Z",
      discrepancy: true,
      fanvuePurchases: null,
      massMessageMismatch: null,
    });
    expect(view.attribution).toEqual([
      { experimentId: ctx.experimentId, messageMatched: 1, assignmentWindowOnly: 0, unmatchedPlausible: 0 },
    ]);

    const serialised = JSON.stringify(view);
    for (const forbidden of ["fan-1", "secret-hash", "4321", "Not reconciled"])
      expect(serialised).not.toContain(forbidden);
  });
});
