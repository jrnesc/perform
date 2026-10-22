import { signWebhookFixture } from "@fanvue/builder-sdk";
import { describe, expect, it } from "vitest";
import { CreatorEvidenceProjector, verifyAndParseCreatorEvidence, type CreatorEvidenceEvent } from "./creator-evidence";
import { buildDemoIntegrationContractProof } from "../../demo/integration-contract-proof";

const signingSecret = "fixture-signing-secret";
const creatorUuid = "creator-fixture";
const timestampSeconds = 1_792_497_600;

function paymentBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-payment-1",
    type: "creator.payment.succeeded",
    timestamp: "2026-10-20T12:00:00.000Z",
    data: {
      object: "payment",
      id: "invoice-1",
      status: "succeeded",
      source: "message",
      billing_reason: "one_time",
      gross: 1200,
      net: 960,
      currency: "USD",
      paid_in_full: true,
      message_uuid: "message-a",
      message_type: "BROADCAST",
      created_at: "2026-10-20T11:59:59.000Z",
      paid_at: "2026-10-20T11:59:59.000Z",
      purchaser: { uuid: "fan-a", handle: "must-not-persist" },
      creator: { uuid: creatorUuid },
      metadata: {},
      tracking: null,
      ...overrides,
    },
  };
}

async function signed(body: Record<string, unknown>, signedAt = timestampSeconds) {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const { value: signature } = await signWebhookFixture({
    payload: rawBody,
    signingSecret,
    timestampSeconds: signedAt,
  });
  return { rawBody, signature };
}

function payment(
  overrides: Partial<Extract<CreatorEvidenceEvent, { kind: "PAYMENT" }>> = {},
): Extract<CreatorEvidenceEvent, { kind: "PAYMENT" }> {
  return {
    kind: "PAYMENT",
    eventId: "event-payment-1",
    creatorUuid,
    occurredAt: "2026-10-20T12:00:00.000Z",
    paymentId: "invoice-1",
    purchaserUuid: "fan-a",
    messageUuid: "message-a",
    messageType: "BROADCAST",
    grossMinor: 1200,
    netMinor: 960,
    currency: "USD",
    ...overrides,
  };
}

function reversal(
  overrides: Partial<Extract<CreatorEvidenceEvent, { kind: "REVERSAL" }>> = {},
): Extract<CreatorEvidenceEvent, { kind: "REVERSAL" }> {
  return {
    kind: "REVERSAL",
    eventId: "event-reversal-1",
    creatorUuid,
    occurredAt: "2026-10-20T12:01:00.000Z",
    reversalId: "refund-1",
    paymentId: "invoice-1",
    reversalType: "REFUND",
    amountMinor: 1200,
    currency: "USD",
    ...overrides,
  };
}

function projector() {
  return new CreatorEvidenceProjector(
    creatorUuid,
    { "message-a": "A", "message-b": "B" },
    { "fan-a": "A", "fan-b": "B" },
  );
}

describe("Fanvue creator evidence contract", () => {
  it("verifies exact raw bytes and strips undocumented purchaser fields", async () => {
    const body = paymentBody();
    const fixture = await signed(body);
    const result = await verifyAndParseCreatorEvidence({
      rawBody: fixture.rawBody,
      signature: fixture.signature,
      signingSecret,
      expectedCreatorUuid: creatorUuid,
      nowMs: timestampSeconds * 1000,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event).toMatchObject({ kind: "PAYMENT", paymentId: "invoice-1", purchaserUuid: "fan-a" });
    expect(JSON.stringify(result.event)).not.toContain("must-not-persist");

    const reserialized = new TextEncoder().encode(JSON.stringify(body, null, 2));
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: reserialized,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toEqual({ accepted: false, reason: "INVALID_SIGNATURE" });
  });

  it("rejects stale signatures and a creator mismatch", async () => {
    const fixture = await signed(paymentBody());
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: (timestampSeconds + 301) * 1000,
      }),
    ).resolves.toEqual({ accepted: false, reason: "INVALID_SIGNATURE" });
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: "another-creator",
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toEqual({ accepted: false, reason: "WRONG_CREATOR" });
  });

  it("parses a signed formal dispute and ignores an early warning shape", async () => {
    const formal = {
      id: "event-dispute-1",
      type: "creator.dispute.created",
      timestamp: "2026-10-20T12:01:00.000Z",
      data: {
        object: "dispute",
        id: "dispute-1",
        status: "open",
        amount: null,
        currency: null,
        created_at: "2026-10-20T12:01:00.000Z",
        payment: { id: "invoice-1", purchaser: { uuid: "fan-a" } },
        creator: { uuid: creatorUuid },
        metadata: {},
      },
    };
    const fixture = await signed(formal);
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      event: { kind: "REVERSAL", reversalType: "DISPUTE", paymentId: "invoice-1" },
    });

    const warning = await signed({
      ...formal,
      type: "creator.dispute.flagged",
      data: { ...formal.data, status: "warning" },
    });
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: warning.rawBody,
        signature: warning.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toEqual({ accepted: false, reason: "UNSUPPORTED_EVENT" });
  });

  it("accepts a payment whose currency is null, as the documentation allows", async () => {
    const fixture = await signed(paymentBody({ currency: null }));
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toMatchObject({ accepted: true, event: { kind: "PAYMENT", currency: null, grossMinor: 1200 } });
  });

  it("fails closed on a partial-refund shape outside the supported Fanvue contract", async () => {
    const fixture = await signed({
      id: "event-refund-partial",
      type: "creator.refund.created",
      timestamp: "2026-10-20T12:01:00.000Z",
      data: {
        object: "refund",
        id: "refund-partial",
        payment_id: "invoice-1",
        full_amount: false,
        amount: 600,
        currency: "USD",
        created_at: "2026-10-20T12:01:00.000Z",
        creator: { uuid: creatorUuid },
      },
    });
    await expect(
      verifyAndParseCreatorEvidence({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        signingSecret,
        expectedCreatorUuid: creatorUuid,
        nowMs: timestampSeconds * 1000,
      }),
    ).resolves.toEqual({ accepted: false, reason: "INVALID_PAYLOAD" });
  });

  it("deduplicates retries and refuses event IDs reused with different content", () => {
    const evidence = projector();
    expect(evidence.ingest(payment(), "hash-1")).toBe("RECORDED");
    expect(evidence.ingest(payment(), "hash-1")).toBe("DUPLICATE");
    expect(evidence.snapshot()).toMatchObject({ purchases: { A: 1, B: 0 }, duplicateEvents: 1 });
    expect(() => evidence.ingest(payment(), "different-hash")).toThrow(/reused with different content/);
  });

  it("ignores purchases outside the known message and frozen assignment boundary", () => {
    const evidence = projector();
    expect(evidence.ingest(payment({ messageUuid: "unknown-message" }), "hash-unknown")).toBe("IGNORED");
    expect(evidence.ingest(payment({ eventId: "event-payment-2", purchaserUuid: "fan-b" }), "hash-wrong-arm")).toBe(
      "IGNORED",
    );
    expect(evidence.snapshot()).toMatchObject({ purchases: { A: 0, B: 0 }, ignoredEvents: 2 });
  });

  it("handles refunds and disputes before payments without double-counting or resurrection", () => {
    for (const reversalType of ["REFUND", "DISPUTE"] as const) {
      const evidence = projector();
      evidence.ingest(reversal({ reversalType }), `hash-${reversalType}`);
      expect(evidence.snapshot()).toMatchObject({ pendingReversals: 1, settledPurchases: { A: 0, B: 0 } });
      evidence.ingest(payment(), "hash-payment");
      expect(evidence.snapshot()).toMatchObject({
        purchases: { A: 1, B: 0 },
        settledPurchases: { A: 0, B: 0 },
        settledMinor: { A: 0, B: 0 },
        pendingReversals: 0,
      });
    }
  });

  it("keeps reconciliation append-only for missing and stale evidence", () => {
    const evidence = projector();
    evidence.ingest(payment(), "hash-payment");
    const first = evidence.appendReconciliation({
      id: "recon-1",
      source: "FANVUE_RECONCILIATION",
      sourceObservedAt: "2026-10-20T12:05:00.000Z",
      capturedAt: "2026-10-20T12:05:01.000Z",
      isComplete: true,
      isStale: false,
      reconciledSettledPurchases: { A: 1, B: 0 },
      reconciledSettledMinor: { A: 1200, B: 0 },
      note: "Agrees",
    });
    const second = evidence.appendReconciliation({
      id: "recon-2",
      source: "FANVUE_RECONCILIATION",
      sourceObservedAt: "2026-10-18T12:05:00.000Z",
      capturedAt: "2026-10-20T12:06:00.000Z",
      isComplete: false,
      isStale: true,
      reconciledSettledPurchases: { A: 1, B: 1 },
      reconciledSettledMinor: { A: 1200, B: 1500 },
      note: "Missing webhook",
    });
    expect(first.discrepancy).toBe(false);
    expect(second).toMatchObject({ discrepancy: true, isStale: true });
    expect(evidence.reconciliationHistory().map(({ id }) => id)).toEqual(["recon-1", "recon-2"]);
  });

  it("versions a terminal conclusion when late evidence arrives", () => {
    const evidence = projector();
    evidence.ingest(payment(), "hash-payment");
    const frozen = evidence.freezeConclusion("analysis-v1");
    evidence.ingest(reversal(), "hash-reversal");
    expect(frozen.settledPurchases).toEqual({ A: 1, B: 0 });
    expect(evidence.snapshot().settledPurchases).toEqual({ A: 0, B: 0 });
    expect(evidence.conclusionState()).toMatchObject({ conclusion: { version: "analysis-v1" }, needsReanalysis: true });
  });

  it("runs the complete signed fixture proof", async () => {
    await expect(buildDemoIntegrationContractProof()).resolves.toMatchObject({
      version: "perform-integration-proof-v1",
      liveReceiver: false,
      reconciliation: { discrepancy: true, stale: true, appendOnlySnapshots: 2 },
    });
  });
});
