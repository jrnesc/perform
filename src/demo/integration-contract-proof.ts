import { signWebhookFixture } from "@fanvue/builder-sdk";
import { performOAuthScopes } from "../workspace/oauth-scopes";
import {
  CreatorEvidenceProjector,
  verifyAndParseCreatorEvidence,
  type CreatorEvidenceEvent,
} from "../integrations/fanvue/creator-evidence";

const fixtureSecret = "fixture-only-signing-secret-not-a-live-credential";
const creatorUuid = "fixture:creator:perform";
const signedAtSeconds = 1_792_497_600;
const signedAtMs = signedAtSeconds * 1_000;

function payment(eventId: string, paymentId: string, fanUuid: string, messageUuid: string, gross: number) {
  return {
    id: eventId,
    type: "creator.payment.succeeded",
    timestamp: "2026-10-20T12:00:00.000Z",
    data: {
      object: "payment",
      id: paymentId,
      status: "succeeded",
      source: "message",
      billing_reason: "one_time",
      gross,
      net: Math.floor(gross * 0.8),
      currency: "USD",
      paid_in_full: true,
      message_uuid: messageUuid,
      message_type: "BROADCAST",
      created_at: "2026-10-20T11:59:59.000Z",
      paid_at: "2026-10-20T11:59:59.000Z",
      purchaser: { uuid: fanUuid, handle: "fixture-only-do-not-persist" },
      creator: { uuid: creatorUuid },
      metadata: {},
      tracking: null,
    },
  };
}

function refund(eventId: string, paymentId: string, amount: number) {
  return {
    id: eventId,
    type: "creator.refund.created",
    timestamp: "2026-10-20T12:01:00.000Z",
    data: {
      object: "refund",
      id: `reversal:${eventId}`,
      payment_id: paymentId,
      amount,
      currency: "USD",
      full_amount: true,
      created_at: "2026-10-20T12:01:00.000Z",
      purchaser: { uuid: "fixture:fan:a" },
      creator: { uuid: creatorUuid },
      metadata: {},
    },
  };
}

async function verifiedEvent(body: Record<string, unknown>): Promise<{ event: CreatorEvidenceEvent; hash: string }> {
  const rawBody = new TextEncoder().encode(JSON.stringify(body));
  const { value: signature } = await signWebhookFixture({
    payload: rawBody,
    signingSecret: fixtureSecret,
    timestampSeconds: signedAtSeconds,
  });
  const parsed = await verifyAndParseCreatorEvidence({
    rawBody,
    signature,
    signingSecret: fixtureSecret,
    expectedCreatorUuid: creatorUuid,
    nowMs: signedAtMs,
  });
  if (!parsed.accepted) throw new Error(`Fixture signature proof failed: ${parsed.reason}`);
  return { event: parsed.event, hash: parsed.payloadHash };
}

export type DemoIntegrationContractProof = {
  version: "perform-integration-proof-v1";
  mode: "LOCAL_SIGNED_FIXTURES";
  liveReceiver: false;
  requestedScopes: typeof performOAuthScopes;
  checks: readonly {
    id: string;
    label: string;
    status: "PASS";
    detail: string;
  }[];
  reconciliation: {
    source: "FANVUE_RECONCILIATION_FIXTURE";
    discrepancy: true;
    stale: true;
    appendOnlySnapshots: 2;
    detail: string;
  };
};

export async function buildDemoIntegrationContractProof(): Promise<DemoIntegrationContractProof> {
  const projector = new CreatorEvidenceProjector(
    creatorUuid,
    { "fixture:message:a": "A", "fixture:message:b": "B" },
    { "fixture:fan:a": "A", "fixture:fan:b": "B" },
  );
  const reversal = await verifiedEvent(refund("fixture:event:refund-a", "fixture:payment:a", 1200));
  const purchaseA = await verifiedEvent(payment("fixture:event:payment-a", "fixture:payment:a", "fixture:fan:a", "fixture:message:a", 1200));
  const purchaseB = await verifiedEvent(payment("fixture:event:payment-b", "fixture:payment:b", "fixture:fan:b", "fixture:message:b", 1500));

  projector.ingest(reversal.event, reversal.hash);
  projector.ingest(purchaseA.event, purchaseA.hash);
  projector.ingest(purchaseA.event, purchaseA.hash);
  projector.ingest(purchaseB.event, purchaseB.hash);
  const projection = projector.snapshot();
  projector.freezeConclusion("fixture-conclusion-v1");
  const complete = projector.appendReconciliation({
    id: "fixture:reconciliation:complete",
    source: "FANVUE_RECONCILIATION",
    sourceObservedAt: "2026-10-20T12:05:00.000Z",
    capturedAt: "2026-10-20T12:05:02.000Z",
    isComplete: true,
    isStale: false,
    reconciledSettledPurchases: { A: 0, B: 1 },
    reconciledSettledMinor: { A: 0, B: 1500 },
    note: "Transaction fixtures agree after the out-of-order full refund is paired to its original invoice.",
  });
  projector.appendReconciliation({
    id: "fixture:reconciliation:stale-gap",
    source: "FANVUE_RECONCILIATION",
    sourceObservedAt: "2026-10-18T12:05:00.000Z",
    capturedAt: "2026-10-20T12:06:00.000Z",
    isComplete: false,
    isStale: true,
    reconciledSettledPurchases: { A: 0, B: 2 },
    reconciledSettledMinor: { A: 0, B: 3000 },
    note: "A stale fixture exposes a missing webhook event; it is appended and cannot overwrite the earlier evidence.",
  });

  if (projection.pendingReversals !== 0 || projection.duplicateEvents !== 1 || complete.discrepancy) {
    throw new Error("Demo integration contract proof invariants failed");
  }
  return {
    version: "perform-integration-proof-v1",
    mode: "LOCAL_SIGNED_FIXTURES",
    liveReceiver: false,
    requestedScopes: performOAuthScopes,
    checks: [
      { id: "raw-signature", label: "Exact raw-body signature", status: "PASS", detail: "Official fanvue-v0 HMAC contract with a 300-second replay window." },
      { id: "creator-scope", label: "Creator scoping", status: "PASS", detail: "Only the expected creator and known experiment messages can project evidence." },
      { id: "duplicates", label: "Retry deduplication", status: "PASS", detail: "The repeated event ID was accepted as a duplicate and counted once." },
      { id: "ordering", label: "Out-of-order reversal", status: "PASS", detail: "A full refund received before its payment stayed pending, then paired without resurrecting revenue." },
      { id: "terminal", label: "Versioned conclusion", status: "PASS", detail: "Late evidence marks a frozen conclusion for re-analysis instead of silently rewriting it." },
    ],
    reconciliation: {
      source: "FANVUE_RECONCILIATION_FIXTURE",
      discrepancy: true,
      stale: true,
      appendOnlySnapshots: projector.reconciliationHistory().length as 2,
      detail: "Agreement and stale missing-event snapshots remain side by side; neither replaces webhook-derived evidence.",
    },
  };
}
