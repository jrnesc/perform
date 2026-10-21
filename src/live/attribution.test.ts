import { signWebhookFixture } from "@fanvue/builder-sdk";
import { describe, expect, it } from "vitest";
import { reconcileExperimentEarnings } from "../integrations/fanvue/earnings-reconciliation";
import { readMassMessageAggregates } from "../integrations/fanvue/mass-message-aggregates";
import {
  assignmentWindowStrategy,
  messageUuidMatchStrategy,
  selectAttributionStrategy,
  type AttributionCandidate,
  type PurchaseAttributionStrategy,
} from "./attribution";
import { projectExperimentCommerce } from "./commerce-projection";
import { receiveCreatorCommerceWebhook } from "./commerce-ingestion";
import { reconcileExperimentWindow } from "./reconciliation";
import { allocatedExperiment, creatorUuid } from "./test-fixtures";

const signingSecret = "fixture-signing-secret";
const timestampSeconds = 1_792_497_600;
const window = { startAt: "2026-10-20T00:00:00.000Z", endAt: "2026-10-27T00:00:00.000Z" };
const inWindow = "2026-10-20T11:59:59.000Z";

const broadcast = { purchaserUuid: "fan-1", messageUuid: "per-recipient-1", messageType: "BROADCAST", occurredAt: inWindow };
const assigned = (overrides: Partial<AttributionCandidate> = {}): AttributionCandidate => ({
  experimentId: "experiment-1", assignedArm: "B", messageArm: null, window: { startAt: window.startAt, endAt: null }, ...overrides,
});

describe("attribution strategies", () => {
  it("both strategies trust a stored message UUID and flag a missing assignment", () => {
    for (const strategy of [messageUuidMatchStrategy, assignmentWindowStrategy]) {
      expect(strategy.decide(broadcast, [assigned({ messageArm: "B" })]))
        .toEqual({ kind: "ATTRIBUTED", experimentId: "experiment-1", arm: "B", messageMatched: true });
      expect(strategy.decide(broadcast, [assigned({ assignedArm: null, messageArm: "A" })]))
        .toEqual({ kind: "MISSING_ASSIGNMENT", experimentId: "experiment-1", arm: "A" });
    }
  });

  it("places an unknown-message broadcast by assignment and window, or counts it as unmatched", () => {
    expect(assignmentWindowStrategy.decide(broadcast, [assigned()]))
      .toEqual({ kind: "ATTRIBUTED", experimentId: "experiment-1", arm: "B", messageMatched: false });
    expect(messageUuidMatchStrategy.decide(broadcast, [assigned()]))
      .toEqual({ kind: "UNMATCHED_PLAUSIBLE", experimentId: "experiment-1", arm: "B" });
  });

  it("needs BROADCAST, the send window and an assignment", () => {
    for (const strategy of [messageUuidMatchStrategy, assignmentWindowStrategy]) {
      expect(strategy.decide({ ...broadcast, messageType: "SINGLE_RECIPIENT" }, [assigned()])).toEqual({ kind: "UNRELATED" });
      expect(strategy.decide({ ...broadcast, messageType: null }, [assigned()])).toEqual({ kind: "UNRELATED" });
      expect(strategy.decide({ ...broadcast, occurredAt: "2026-10-19T23:59:59.000Z" }, [assigned()])).toEqual({ kind: "UNRELATED" });
      expect(strategy.decide(broadcast, [assigned({ window: { startAt: window.startAt, endAt: "2026-10-20T11:00:00.000Z" } })]))
        .toEqual({ kind: "UNRELATED" });
      expect(strategy.decide(broadcast, [assigned({ window: null })])).toEqual({ kind: "UNRELATED" });
      expect(strategy.decide(broadcast, [])).toEqual({ kind: "UNRELATED" });
    }
  });

  it("never guesses between overlapping experiments", () => {
    const both = [assigned(), assigned({ experimentId: "experiment-2", assignedArm: "A" })];
    for (const strategy of [messageUuidMatchStrategy, assignmentWindowStrategy]) {
      expect(strategy.decide(broadcast, both)).toEqual({ kind: "AMBIGUOUS", experimentIds: ["experiment-1", "experiment-2"] });
    }
  });

  it("selects message-UUID matching only with a recorded proof", () => {
    expect(selectAttributionStrategy({ messageUuidEqualityProven: false }).id).toBe("ASSIGNMENT_WINDOW");
    expect(selectAttributionStrategy({ requested: "MESSAGE_UUID_MATCH", messageUuidEqualityProven: false }).id).toBe("ASSIGNMENT_WINDOW");
    expect(selectAttributionStrategy({ requested: "MESSAGE_UUID_MATCH", messageUuidEqualityProven: true }).id).toBe("MESSAGE_UUID_MATCH");
  });
});

async function launched() {
  const ctx = await allocatedExperiment();
  ctx.sqlite.prepare("UPDATE experiments SET observation_started_at = ? WHERE id = ?").run(window.startAt, ctx.experimentId);
  let ids = 0;
  const receive = async (id: string, fan: string, message: string, strategy?: PurchaseAttributionStrategy, overrides: Record<string, unknown> = {}) => {
    const body = {
      id: `event-${id}`, type: "creator.payment.succeeded", timestamp: "2026-10-20T12:00:00.000Z",
      data: {
        object: "payment", id, status: "succeeded", source: "message", gross: 1200, net: 960, currency: "USD",
        paid_in_full: true, message_uuid: message, message_type: "BROADCAST", paid_at: inWindow,
        purchaser: { uuid: fan }, creator: { uuid: creatorUuid }, ...overrides,
      },
    };
    const rawBody = new TextEncoder().encode(JSON.stringify(body));
    const { value } = await signWebhookFixture({ payload: rawBody, signingSecret, timestampSeconds });
    return receiveCreatorCommerceWebhook({
      rawBody, signature: value, nowMs: timestampSeconds * 1000,
      config: { enabled: true, signingSecret, creatorUuid }, repository: ctx.store,
      newId: () => `dead-${++ids}`, attribution: strategy,
    });
  };
  const project = async () => projectExperimentCommerce(
    creatorUuid, await ctx.store.listCommerceEvents(ctx.experimentId), await ctx.store.getAttributionContext(ctx.experimentId),
  );
  return { ...ctx, receive, project };
}

describe("attribution in the webhook receiver", () => {
  it("counts a purchase with a per-recipient message UUID by the buyer's assignment", async () => {
    const ctx = await launched();
    const arm = ctx.armOf("fan-1");
    expect(await ctx.receive("invoice-1", "fan-1", "per-recipient-uuid")).toEqual({ status: 200, outcome: "RECORDED" });
    const { projection, assignmentWindowOnly, unmatchedPlausible } = await ctx.project();
    expect(projection.settledPurchases[arm]).toBe(1);
    expect([assignmentWindowOnly, unmatchedPlausible]).toEqual([1, 0]);
    expect(await ctx.store.attributionCounts()).toEqual([
      { experimentId: ctx.experimentId, messageMatched: 0, assignmentWindowOnly: 1, unmatchedPlausible: 0 },
    ]);
  });

  it("makes a UUID mismatch visible instead of silent under message-UUID matching", async () => {
    const ctx = await launched();
    expect(await ctx.receive("invoice-1", "fan-1", "per-recipient-uuid", messageUuidMatchStrategy))
      .toEqual({ status: 200, outcome: "RECORDED" });
    const { projection, unmatchedPlausible } = await ctx.project();
    expect(projection.settledPurchases).toEqual({ A: 0, B: 0 });
    expect(unmatchedPlausible).toBe(1);
    expect((await ctx.store.attributionCounts())[0]).toMatchObject({ unmatchedPlausible: 1, assignmentWindowOnly: 0 });
  });

  it("ignores direct-message and out-of-window purchases by assigned fans", async () => {
    const ctx = await launched();
    expect(await ctx.receive("dm", "fan-1", "x", undefined, { message_type: "SINGLE_RECIPIENT" }))
      .toEqual({ status: 200, outcome: "UNRELATED" });
    expect(await ctx.receive("early", "fan-1", "x", undefined, { paid_at: "2026-10-19T00:00:00.000Z" }))
      .toEqual({ status: 200, outcome: "UNRELATED" });
    expect(ctx.sqlite.prepare("SELECT count(*) AS n FROM commerce_events").get()).toEqual({ n: 0 });
  });
});

const page = (data: unknown[], nextCursor: string | null = null) => new Response(JSON.stringify({ data, nextCursor }));
const aggregate = (uuid: string, purchaseCount: number, totalRevenue: number) => ({
  uuid, status: "SENT", text: null, price: 1200, recipientCount: 3, viewCount: 2, purchaseCount, totalRevenue,
});

describe("per-arm check against Fanvue's mass-message totals", () => {
  it("walks pages until every requested message is found", async () => {
    const paths: string[] = [];
    const read = await readMassMessageAggregates({
      messageUuids: ["message-a", "message-b"],
      transport: async (path) => {
        paths.push(path);
        return path.includes("cursor=") ? page([aggregate("message-b", 0, 0)], "more") : page([aggregate("other", 9, 9), aggregate("message-a", 1, 1200)], "p2");
      },
    });
    expect(read.missing).toEqual([]);
    expect(read.aggregates["message-a"]).toMatchObject({ purchaseCount: 1, totalRevenueMinor: 1200, recipientCount: 3 });
    expect(paths).toEqual(["/v1/chats/mass-messages?size=50", "/v1/chats/mass-messages?size=50&cursor=p2"]);
  });

  it("reports a message that is not listed and fails on a malformed or looping read", async () => {
    expect((await readMassMessageAggregates({ messageUuids: ["gone"], transport: async () => page([]) })).missing).toEqual(["gone"]);
    await expect(readMassMessageAggregates({
      messageUuids: ["message-a"], transport: async () => page([{ uuid: "message-a", status: "SENT", purchaseCount: -1 }]),
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(readMassMessageAggregates({
      messageUuids: ["message-a"], transport: async () => page([], "same"),
    })).rejects.toMatchObject({ code: "PAGINATION_LOOP" });
  });

  it("records agreement, and a mismatch when assignment-window noise exceeds Fanvue's count", async () => {
    const ctx = await launched();
    const armA = ["fan-1", "fan-2", "fan-3", "fan-4", "fan-5", "fan-6"].filter((fan) => ctx.armOf(fan) === "A");
    await ctx.receive("invoice-1", armA[0], "message-a");
    const run = (aggregates: unknown[], capturedAt: string) => reconcileExperimentWindow({
      experimentId: ctx.experimentId, creatorUuid, window, capturedAt,
      repository: ctx.store, newId: () => crypto.randomUUID(), frozenConclusionRevision: null, checkMassMessages: true,
      transport: async (path) => path.startsWith("/v1/chats/mass-messages") ? page(aggregates) : page([]),
    });
    const agreed = await run([aggregate("message-a", 1, 1200), aggregate("message-b", 0, 0)], "2026-10-27T00:00:00.000Z");
    expect(agreed.massMessageCheck).toEqual({ purchases: { A: 1, B: 0 }, revenueMinor: { A: 1200, B: 0 }, mismatch: false });

    await ctx.receive("invoice-2", armA[1], "some-other-broadcast");
    const noisy = await run([aggregate("message-a", 1, 1200), aggregate("message-b", 0, 0)], "2026-10-27T01:00:00.000Z");
    expect(noisy.massMessageCheck?.mismatch).toBe(true);
    expect(noisy.assignmentWindowOnlyCount).toBe(1);
    expect(noisy.note).toContain("Fanvue's per-message totals");
    const stored = await ctx.store.listReconciliations(ctx.experimentId);
    expect(stored.at(-1)).toMatchObject({ attributionStrategy: "ASSIGNMENT_WINDOW", massMessageCheck: { mismatch: true } });
  });
});

describe("attribution in earnings reconciliation", () => {
  const row = { date: inWindow, gross: 1200, net: 1000, currency: "USD", source: "message", transactionOrderId: "t-1", messageUuid: "per-recipient", messageType: "BROADCAST", user: { uuid: "fan-a" } };
  const base = { startAt: window.startAt, endAt: window.endAt, messages: { "message-a": "A" as const }, assignments: { "fan-a": "A" as const }, transport: async () => page([row]) };

  it("counts an unknown-message broadcast by assignment by default", async () => {
    expect(await reconcileExperimentEarnings(base)).toMatchObject({ settledPurchases: { A: 1, B: 0 }, assignmentWindowOnly: 1, unmatchedPlausible: 0 });
  });

  it("counts it as unmatched under message-UUID matching", async () => {
    expect(await reconcileExperimentEarnings({ ...base, attribution: { strategy: messageUuidMatchStrategy, window } }))
      .toMatchObject({ settledPurchases: { A: 0, B: 0 }, assignmentWindowOnly: 0, unmatchedPlausible: 1 });
  });
});
