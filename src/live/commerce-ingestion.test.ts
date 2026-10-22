import { signWebhookFixture } from "@fanvue/builder-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository, type LiveEvidenceRepository } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { captureLiveAudience, persistLiveAudienceSnapshot } from "./audience-capture";
import { projectExperimentCommerce } from "./commerce-projection";
import { receiveCreatorCommerceWebhook, type WebhookConfig } from "./commerce-ingestion";
import {
  assignmentCutoff,
  capturedAt,
  confirmSends,
  creatorUuid,
  fanvueTransport,
  seedExperiment,
  sixFans,
  sourceAudienceUuid,
} from "./test-fixtures";

const signingSecret = "fixture-signing-secret";
const timestampSeconds = 1_792_497_600;
const nowMs = timestampSeconds * 1000;
const config: WebhookConfig = { enabled: true, signingSecret };

async function sign(body: Record<string, unknown>, secret = signingSecret) {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const { value } = await signWebhookFixture({ payload: rawBody, signingSecret: secret, timestampSeconds });
  return { rawBody, signature: value };
}

const payment = (
  id: string,
  fan: string,
  message: string,
  overrides: Record<string, unknown> = {},
  creator = creatorUuid,
) => ({
  id: `event-${id}`,
  type: "creator.payment.succeeded",
  timestamp: "2026-10-20T12:00:00.000Z",
  data: {
    object: "payment",
    id,
    status: "succeeded",
    source: "message",
    gross: 1200,
    net: 960,
    currency: "USD",
    paid_in_full: true,
    message_uuid: message,
    paid_at: "2026-10-20T11:59:59.000Z",
    created_at: "2026-10-20T11:59:59.000Z",
    purchaser: { uuid: fan, handle: "must-not-persist" },
    creator: { uuid: creator },
    ...overrides,
  },
});
const refund = (id: string, paymentId: string, overrides: Record<string, unknown> = {}, creator = creatorUuid) => ({
  id: `event-${id}`,
  type: "creator.refund.created",
  timestamp: "2026-10-20T12:05:00.000Z",
  data: {
    object: "refund",
    id,
    payment_id: paymentId,
    full_amount: true,
    amount: 1200,
    currency: "USD",
    created_at: "2026-10-20T12:05:00.000Z",
    creator: { uuid: creator },
    ...overrides,
  },
});

let ids = 0;
async function setup() {
  const { sqlite, db } = createMigratedDatabase();
  const experimentId = seedExperiment(sqlite);
  const repository = new D1PerformRepository(db, creatorUuid, "REAL");
  const store = new D1LiveEvidenceRepository(db, creatorUuid, "REAL");
  const capture = await captureLiveAudience({
    experimentId,
    source: { kind: "SMART", uuid: sourceAudienceUuid },
    capturedAt,
    assignmentCutoff,
    transport: fanvueTransport(sixFans),
  });
  if (capture.status !== "READY") throw new Error("capture failed");
  await persistLiveAudienceSnapshot({
    repository,
    evidenceRepository: store,
    experimentId,
    source: { kind: "SMART", uuid: sourceAudienceUuid },
    capture,
    commandId: "allocate",
  });
  confirmSends(sqlite, experimentId);
  const armOf = (fan: string) => capture.assignments.find((a) => a.fanUuid === fan)!.arm;
  const receive = async (
    body: Record<string, unknown>,
    options: { secret?: string; repo?: LiveEvidenceRepository; cfg?: WebhookConfig } = {},
  ) => {
    const signed = await sign(body, options.secret);
    return receiveCreatorCommerceWebhook({
      rawBody: signed.rawBody,
      signature: signed.signature,
      nowMs,
      config: options.cfg ?? config,
      newId: () => `dead-${++ids}`,
      repositoryFor: (creator) => options.repo ?? new D1LiveEvidenceRepository(db, creator, "REAL"),
    });
  };
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  const project = async () =>
    projectExperimentCommerce(
      creatorUuid,
      await store.listCommerceEvents(experimentId),
      await store.getAttributionContext(experimentId),
    );
  return { sqlite, store, experimentId, armOf, receive, count, project };
}

const messageFor = (arm: string) => (arm === "A" ? "message-a" : "message-b");

describe("creator commerce webhook receiver", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("does not exist unless explicitly enabled, and reports misconfiguration", async () => {
    expect(await ctx.receive(payment("p", "fan-1", "message-a"), { cfg: { ...config, enabled: false } })).toEqual({
      status: 404,
      outcome: "DISABLED",
    });
    expect(
      await ctx.receive(payment("p", "fan-1", "message-a"), { cfg: { ...config, signingSecret: undefined } }),
    ).toEqual({ status: 503, outcome: "NOT_CONFIGURED" });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
  });

  it("rejects an invalid or missing signature before anything is stored", async () => {
    expect(await ctx.receive(payment("p", "fan-1", "message-a"), { secret: "wrong" })).toEqual({
      status: 401,
      outcome: "INVALID_SIGNATURE",
    });
    const signed = await sign(payment("p", "fan-1", "message-a"));
    expect(
      await receiveCreatorCommerceWebhook({
        rawBody: signed.rawBody,
        signature: null,
        nowMs,
        config,
        repositoryFor: () => ctx.store,
        newId: () => "x",
      }),
    ).toEqual({ status: 401, outcome: "INVALID_SIGNATURE" });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
    expect(ctx.count("SELECT count(*) AS n FROM commerce_dead_letters")).toBe(0);
  });

  it("records a payment once, absorbs a retried delivery and stores no display fields", async () => {
    const message = messageFor(ctx.armOf("fan-1"));
    expect(await ctx.receive(payment("invoice-1", "fan-1", message))).toEqual({ status: 200, outcome: "RECORDED" });
    expect(await ctx.receive(payment("invoice-1", "fan-1", message))).toEqual({ status: 200, outcome: "DUPLICATE" });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(1);
    const row = ctx.sqlite.prepare("SELECT * FROM commerce_events").get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain("must-not-persist");
    expect((await ctx.project()).projection.settledPurchases[ctx.armOf("fan-1")]).toBe(1);
    expect(ctx.sqlite.prepare("SELECT outcome FROM attribution_proofs").get()).toEqual({ outcome: "MATCH" });
    expect(await ctx.store.messageUuidEqualityProven(ctx.experimentId)).toBe(true);
  });

  it("records a first-purchase UUID mismatch and keeps assignment-window attribution", async () => {
    const arm = ctx.armOf("fan-1");
    ctx.sqlite
      .prepare(
        "UPDATE experiments SET observation_started_at = '2026-10-20T11:00:00.000Z', observation_ends_at = '2026-10-20T13:00:00.000Z' WHERE id = ?",
      )
      .run(ctx.experimentId);
    expect(
      await ctx.receive(
        payment("mismatch", "fan-1", "per-recipient-message", {
          message_type: "BROADCAST",
        }),
      ),
    ).toEqual({ status: 200, outcome: "RECORDED" });
    expect(ctx.sqlite.prepare("SELECT outcome, confirmed_message_uuid FROM attribution_proofs").get()).toEqual({
      outcome: "NO_MATCH",
      confirmed_message_uuid: messageFor(arm),
    });
    expect(await ctx.store.messageUuidEqualityProven(ctx.experimentId)).toBe(false);
  });

  it("answers the unsigned verification probe, and only that, without storing anything", async () => {
    const probe = new TextEncoder().encode(
      JSON.stringify({ type: "fanvue.webhook.verification", timestamp: "2026-10-20T12:00:00.000Z" }),
    );
    const receiveUnsigned = (rawBody: Uint8Array) =>
      receiveCreatorCommerceWebhook({
        rawBody,
        signature: null,
        nowMs,
        config,
        repositoryFor: () => ctx.store,
        newId: () => "x",
      });
    expect(await receiveUnsigned(probe)).toEqual({ status: 200, outcome: "VERIFICATION" });
    expect(await receiveUnsigned(new TextEncoder().encode(JSON.stringify(payment("p", "fan-1", "message-a"))))).toEqual(
      { status: 401, outcome: "INVALID_SIGNATURE" },
    );
    expect(await receiveUnsigned(new TextEncoder().encode("not json"))).toEqual({
      status: 401,
      outcome: "INVALID_SIGNATURE",
    });
    // Fanvue reveals the signing secret only after creating and probing the destination.
    expect(
      await receiveCreatorCommerceWebhook({
        rawBody: probe,
        signature: null,
        nowMs,
        config: { ...config, signingSecret: undefined },
        repositoryFor: () => ctx.store,
        newId: () => "x",
      }),
    ).toEqual({ status: 200, outcome: "VERIFICATION" });
    // Fanvue reveals the signing secret only after creating and probing the destination.
    expect(
      await receiveCreatorCommerceWebhook({
        rawBody: probe,
        signature: null,
        nowMs,
        config: { ...config, signingSecret: undefined },
        repositoryFor: () => ctx.store,
        newId: () => "x",
      }),
    ).toEqual({ status: 200, outcome: "VERIFICATION" });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
    expect(ctx.count("SELECT count(*) AS n FROM commerce_dead_letters")).toBe(0);
  });

  it("acknowledges event types it does not handle without keeping them", async () => {
    for (const type of ["creator.dispute.flagged", "creator.reward.created", "creator.subscription.activated"]) {
      expect(
        await ctx.receive({
          id: `event-${type}`,
          type,
          timestamp: "2026-10-20T12:00:00.000Z",
          data: { object: "x", creator: { uuid: creatorUuid } },
        }),
      ).toEqual({ status: 200, outcome: "UNRELATED" });
    }
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
    expect(ctx.count("SELECT count(*) AS n FROM commerce_dead_letters")).toBe(0);
  });

  it("records a payment whose currency is null, as the documentation allows", async () => {
    const arm = ctx.armOf("fan-2");
    expect(await ctx.receive(payment("invoice-null", "fan-2", messageFor(arm), { currency: null }))).toEqual({
      status: 200,
      outcome: "RECORDED",
    });
    expect(ctx.sqlite.prepare("SELECT currency, gross_minor FROM commerce_events").get()).toEqual({
      currency: null,
      gross_minor: 1200,
    });
  });

  it("keeps unrelated payments out of experiment evidence", async () => {
    expect(await ctx.receive(payment("other", "fan-1", "someone-elses-message"))).toEqual({
      status: 200,
      outcome: "UNRELATED",
    });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
  });

  it("nets a refund that arrives before its payment, in either order", async () => {
    const arm = ctx.armOf("fan-2");
    expect(await ctx.receive(refund("refund-1", "invoice-2"))).toEqual({ status: 200, outcome: "RECORDED" });
    expect(await ctx.store.countReversalsAwaitingPayment()).toBe(1);
    expect((await ctx.project()).projection.settledPurchases).toEqual({ A: 0, B: 0 });

    await ctx.receive(payment("invoice-2", "fan-2", messageFor(arm)));
    expect(await ctx.store.countReversalsAwaitingPayment()).toBe(0);
    const projection = (await ctx.project()).projection;
    expect(projection.purchases[arm]).toBe(1);
    expect(projection.settledPurchases[arm]).toBe(0);
    expect(projection.settledMinor[arm]).toBe(0);
  });

  it("treats a formal dispute as a reversal and refuses a partial refund shape", async () => {
    const arm = ctx.armOf("fan-3");
    await ctx.receive(payment("invoice-3", "fan-3", messageFor(arm)));
    expect(
      await ctx.receive({
        id: "event-dispute",
        type: "creator.dispute.created",
        timestamp: "2026-10-20T12:06:00.000Z",
        data: {
          object: "dispute",
          id: "dispute-1",
          status: "open",
          amount: null,
          currency: null,
          created_at: "2026-10-20T12:06:00.000Z",
          payment: { id: "invoice-3" },
          creator: { uuid: creatorUuid },
        },
      }),
    ).toEqual({ status: 200, outcome: "RECORDED" });
    expect((await ctx.project()).projection.settledPurchases[arm]).toBe(0);

    expect(await ctx.receive(refund("partial", "invoice-3", { full_amount: false, amount: 600 }))).toEqual({
      status: 200,
      outcome: "DEAD_LETTERED",
    });
    expect(ctx.sqlite.prepare("SELECT reason FROM commerce_dead_letters").get()).toEqual({ reason: "INVALID_PAYLOAD" });
  });

  it("dead-letters a reused event ID or payment ID without overwriting evidence", async () => {
    const arm = ctx.armOf("fan-4");
    const message = messageFor(arm);
    await ctx.receive(payment("invoice-4", "fan-4", message));
    // Acknowledged with 200: a retry cannot change the outcome and non-2xx can auto-disable us.
    expect(await ctx.receive(payment("invoice-4", "fan-4", message, { gross: 9999 }))).toEqual({
      status: 200,
      outcome: "DEAD_LETTERED",
    });
    const samePaymentNewEvent = { ...payment("invoice-4", "fan-4", message), id: "event-replacement" };
    expect(await ctx.receive(samePaymentNewEvent)).toEqual({ status: 200, outcome: "DEAD_LETTERED" });
    const reasons = (
      ctx.sqlite.prepare("SELECT reason FROM commerce_dead_letters ORDER BY reason").all() as { reason: string }[]
    ).map((r) => r.reason);
    expect(reasons).toEqual(["EVENT_ID_REUSED", "PAYMENT_ID_REUSED"]);
    expect(ctx.sqlite.prepare("SELECT gross_minor FROM commerce_events").get()).toEqual({ gross_minor: 1200 });
  });

  it("stores each signed event in the scope of the creator it names", async () => {
    // Another creator's purchase cannot match this creator's experiments, so nothing is kept for it.
    expect(await ctx.receive(payment("p", "fan-1", "message-a", {}, "someone-else"))).toEqual({
      status: 200,
      outcome: "UNRELATED",
    });
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events")).toBe(0);
    expect(ctx.count("SELECT count(*) AS n FROM commerce_dead_letters")).toBe(0);
    // A reversal is kept under the creator its payload names, never under this creator.
    expect(await ctx.receive(refund("r", "p", {}, "someone-else"))).toEqual({ status: 200, outcome: "RECORDED" });
    expect(ctx.sqlite.prepare("SELECT creator_uuid FROM commerce_events").all()).toEqual([
      { creator_uuid: "someone-else" },
    ]);
    expect(await ctx.store.listCommerceEvents(ctx.experimentId)).toEqual([]);
  });

  it("keeps a purchase with no frozen assignment auditable but out of the results", async () => {
    expect(await ctx.receive(payment("invoice-x", "outsider", "message-a"))).toEqual({
      status: 200,
      outcome: "RECORDED",
    });
    const { projection, missingAssignmentFans } = await ctx.project();
    expect(missingAssignmentFans).toEqual(["outsider"]);
    expect(projection.settledPurchases).toEqual({ A: 0, B: 0 });
    expect(projection.ignoredEvents).toBe(1);
  });

  it("asks Fanvue to retry when persistence fails", async () => {
    const failing = Object.create(ctx.store) as LiveEvidenceRepository;
    failing.recordCommerceEvent = async () => {
      throw new Error("D1 unavailable");
    };
    expect(await ctx.receive(payment("p", "fan-1", messageFor(ctx.armOf("fan-1"))), { repo: failing })).toEqual({
      status: 500,
      outcome: "STORE_ERROR",
    });
  });

  it("deletes a purchaser's commerce events with their fan data", async () => {
    await ctx.receive(payment("invoice-1", "fan-1", messageFor(ctx.armOf("fan-1"))));
    const repository = new D1PerformRepository((ctx.store as unknown as { db: never }).db, creatorUuid, "REAL");
    await repository.deleteFanData("fan-1");
    expect(ctx.count("SELECT count(*) AS n FROM commerce_events WHERE purchaser_uuid = 'fan-1'")).toBe(0);
    expect(ctx.count("SELECT count(*) AS n FROM audience_member_evidence WHERE fan_uuid = 'fan-1'")).toBe(0);
  });
});
