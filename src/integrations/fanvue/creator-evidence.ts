import { fanvueSignatureContract, verifyWebhookHmac } from "@fanvue/builder-sdk";
import type { Arm } from "../../domain/allocation";

export type CreatorEvidenceEvent =
  | {
      kind: "PAYMENT";
      eventId: string;
      creatorUuid: string;
      occurredAt: string;
      paymentId: string;
      purchaserUuid: string;
      messageUuid: string;
      /** `message_type`, e.g. BROADCAST for a mass message; null when absent. */
      messageType: string | null;
      grossMinor: number;
      netMinor: number | null;
      /** Informational: amounts are USD cents and Fanvue documents `currency` as nullable. */
      currency: string | null;
    }
  | {
      kind: "REVERSAL";
      eventId: string;
      creatorUuid: string;
      occurredAt: string;
      reversalId: string;
      paymentId: string;
      reversalType: "REFUND" | "DISPUTE";
      amountMinor: number | null;
      currency: string | null;
    };

export type CreatorEvidenceParseResult =
  | { accepted: true; event: CreatorEvidenceEvent; payloadHash: string }
  | {
      accepted: false;
      reason: "INVALID_SIGNATURE" | "INVALID_PAYLOAD" | "WRONG_CREATOR" | "UNSUPPORTED_EVENT";
    };

export type EvidenceProjection = {
  purchases: Readonly<Record<Arm, number>>;
  grossMinor: Readonly<Record<Arm, number>>;
  settledPurchases: Readonly<Record<Arm, number>>;
  settledMinor: Readonly<Record<Arm, number>>;
  duplicateEvents: number;
  ignoredEvents: number;
  pendingReversals: number;
  revision: number;
};

export type ReconciliationSnapshot = {
  id: string;
  source: "FANVUE_RECONCILIATION";
  sourceObservedAt: string;
  capturedAt: string;
  isComplete: boolean;
  isStale: boolean;
  webhookSettledPurchases: Readonly<Record<Arm, number>>;
  reconciledSettledPurchases: Readonly<Record<Arm, number>>;
  webhookSettledMinor: Readonly<Record<Arm, number>>;
  reconciledSettledMinor: Readonly<Record<Arm, number>>;
  discrepancy: boolean;
  note: string;
};

type PaymentRecord = Extract<CreatorEvidenceEvent, { kind: "PAYMENT" }> & {
  arm: Arm;
};

type ReversalRecord = Extract<CreatorEvidenceEvent, { kind: "REVERSAL" }>;

type FrozenConclusion = {
  version: string;
  revision: number;
  settledPurchases: Readonly<Record<Arm, number>>;
  settledMinor: Readonly<Record<Arm, number>>;
};

const supportedEventTypes = new Set(["creator.payment.succeeded", "creator.refund.created", "creator.dispute.created"]);

type Envelope = {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isoTimestamp(value: unknown): string | null {
  const timestamp = nonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : null;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseEnvelope(raw: unknown): Envelope | null {
  const envelope = object(raw);
  const data = object(envelope?.data);
  const id = nonEmptyString(envelope?.id);
  const type = nonEmptyString(envelope?.type);
  const timestamp = isoTimestamp(envelope?.timestamp);
  return id && type && timestamp && data ? { id, type, timestamp, data } : null;
}

function parseCreatorUuid(data: Record<string, unknown>): string | null {
  return nonEmptyString(object(data.creator)?.uuid);
}

function parsePayment(envelope: Envelope): CreatorEvidenceEvent | null {
  const data = envelope.data;
  const purchaser = object(data.purchaser);
  const creatorUuid = parseCreatorUuid(data);
  const paymentId = nonEmptyString(data.id);
  const purchaserUuid = nonEmptyString(purchaser?.uuid);
  const messageUuid = nonEmptyString(data.message_uuid);
  const messageType =
    data.message_type === undefined || data.message_type === null ? null : nonEmptyString(data.message_type);
  const grossMinor = nonNegativeInteger(data.gross);
  const netMinor = data.net === null ? null : nonNegativeInteger(data.net);
  const currency = data.currency === null ? null : nonEmptyString(data.currency);
  const occurredAt = isoTimestamp(data.paid_at) ?? isoTimestamp(data.created_at) ?? envelope.timestamp;
  if (
    data.object !== "payment" ||
    data.status !== "succeeded" ||
    data.source !== "message" ||
    data.paid_in_full !== true ||
    !creatorUuid ||
    !paymentId ||
    !purchaserUuid ||
    !messageUuid ||
    (data.message_type != null && !messageType) ||
    grossMinor === null ||
    (data.net !== null && netMinor === null) ||
    (data.currency !== null && !currency) ||
    !occurredAt
  )
    return null;
  return {
    kind: "PAYMENT",
    eventId: envelope.id,
    creatorUuid,
    occurredAt,
    paymentId,
    purchaserUuid,
    messageUuid,
    messageType,
    grossMinor,
    netMinor,
    currency,
  };
}

function parseReversal(envelope: Envelope): CreatorEvidenceEvent | null {
  const data = envelope.data;
  const creatorUuid = parseCreatorUuid(data);
  const reversalId = nonEmptyString(data.id);
  const currency = data.currency === null ? null : nonEmptyString(data.currency);
  const amountMinor = data.amount === null ? null : nonNegativeInteger(data.amount);
  const occurredAt = isoTimestamp(data.created_at) ?? envelope.timestamp;
  if (
    !creatorUuid ||
    !reversalId ||
    (data.currency !== null && !currency) ||
    (data.amount !== null && amountMinor === null) ||
    !occurredAt
  )
    return null;

  if (envelope.type === "creator.refund.created") {
    const paymentId = nonEmptyString(data.payment_id);
    if (data.object !== "refund" || data.full_amount !== true || !paymentId) return null;
    return {
      kind: "REVERSAL",
      eventId: envelope.id,
      creatorUuid,
      occurredAt,
      reversalId,
      paymentId,
      reversalType: "REFUND",
      amountMinor,
      currency,
    };
  }

  if (envelope.type === "creator.dispute.created") {
    const payment = object(data.payment);
    const paymentId = nonEmptyString(payment?.id);
    if (data.object !== "dispute" || data.status !== "open" || !paymentId) return null;
    return {
      kind: "REVERSAL",
      eventId: envelope.id,
      creatorUuid,
      occurredAt,
      reversalId,
      paymentId,
      reversalType: "DISPUTE",
      amountMinor,
      currency,
    };
  }
  return null;
}

/** Verify exact raw bytes before parsing or creator scoping. */
export async function verifyAndParseCreatorEvidence(input: {
  rawBody: Uint8Array;
  signature: string;
  signingSecret: string;
  /** When set, a signed event for any other creator is refused; when absent, each event names its creator. */
  expectedCreatorUuid?: string;
  nowMs: number;
}): Promise<CreatorEvidenceParseResult> {
  const verified = await verifyWebhookHmac({
    rawBody: input.rawBody,
    headers: { "X-Fanvue-Signature": input.signature },
    secret: input.signingSecret,
    contract: fanvueSignatureContract(),
    nowMs: input.nowMs,
  });
  if (!verified) return { accepted: false, reason: "INVALID_SIGNATURE" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input.rawBody));
  } catch {
    return { accepted: false, reason: "INVALID_PAYLOAD" };
  }
  const envelope = parseEnvelope(parsed);
  if (!envelope) return { accepted: false, reason: "INVALID_PAYLOAD" };
  // Fanvue asks receivers to acknowledge event types they do not handle, so those are
  // distinguished from a supported type whose payload is malformed.
  if (!supportedEventTypes.has(envelope.type)) return { accepted: false, reason: "UNSUPPORTED_EVENT" };
  const event = envelope.type === "creator.payment.succeeded" ? parsePayment(envelope) : parseReversal(envelope);
  if (!event) return { accepted: false, reason: "INVALID_PAYLOAD" };
  if (input.expectedCreatorUuid !== undefined && event.creatorUuid !== input.expectedCreatorUuid) {
    return { accepted: false, reason: "WRONG_CREATOR" };
  }
  return { accepted: true, event, payloadHash: await sha256(input.rawBody) };
}

/**
 * Deterministic projection used by the demo integration contract fixtures. It contains no
 * network client and cannot subscribe to or receive live Fanvue events.
 */
export class CreatorEvidenceProjector {
  private readonly eventHashes = new Map<string, string>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly reversals = new Map<string, ReversalRecord>();
  private duplicateEvents = 0;
  private ignoredEvents = 0;
  private revision = 0;
  private frozenConclusion: FrozenConclusion | null = null;
  private readonly reconciliationSnapshots: ReconciliationSnapshot[] = [];

  constructor(
    private readonly creatorUuid: string,
    private readonly messages: Readonly<Record<string, Arm>>,
    private readonly assignments: Readonly<Record<string, Arm>>,
  ) {}

  ingest(event: CreatorEvidenceEvent, payloadHash: string): "RECORDED" | "DUPLICATE" | "IGNORED" {
    const existingHash = this.eventHashes.get(event.eventId);
    if (existingHash) {
      if (existingHash !== payloadHash) throw new Error("A webhook event ID was reused with different content");
      this.duplicateEvents += 1;
      return "DUPLICATE";
    }
    this.eventHashes.set(event.eventId, payloadHash);

    if (event.creatorUuid !== this.creatorUuid) {
      this.ignoredEvents += 1;
      return "IGNORED";
    }
    if (event.kind === "PAYMENT") {
      const arm = this.messages[event.messageUuid];
      if (!arm || this.assignments[event.purchaserUuid] !== arm) {
        this.ignoredEvents += 1;
        return "IGNORED";
      }
      const existing = this.payments.get(event.paymentId);
      if (existing && existing.eventId !== event.eventId) {
        throw new Error("A Fanvue payment ID was reused by a different event");
      }
      this.payments.set(event.paymentId, { ...event, arm });
    } else {
      this.reversals.set(event.paymentId, event);
    }
    this.revision += 1;
    return "RECORDED";
  }

  snapshot(): EvidenceProjection {
    const purchases: Record<Arm, number> = { A: 0, B: 0 };
    const grossMinor: Record<Arm, number> = { A: 0, B: 0 };
    const settledPurchases: Record<Arm, number> = { A: 0, B: 0 };
    const settledMinor: Record<Arm, number> = { A: 0, B: 0 };
    for (const payment of this.payments.values()) {
      purchases[payment.arm] += 1;
      grossMinor[payment.arm] += payment.grossMinor;
      const reversal = this.reversals.get(payment.paymentId);
      if (!reversal) {
        settledPurchases[payment.arm] += 1;
        settledMinor[payment.arm] += payment.grossMinor;
      }
    }
    const pendingReversals = [...this.reversals.keys()].filter((paymentId) => !this.payments.has(paymentId)).length;
    return {
      purchases,
      grossMinor,
      settledPurchases,
      settledMinor,
      duplicateEvents: this.duplicateEvents,
      ignoredEvents: this.ignoredEvents,
      pendingReversals,
      revision: this.revision,
    };
  }

  freezeConclusion(version: string): FrozenConclusion {
    if (!version.trim()) throw new Error("A conclusion version is required");
    const projection = this.snapshot();
    this.frozenConclusion = {
      version,
      revision: projection.revision,
      settledPurchases: projection.settledPurchases,
      settledMinor: projection.settledMinor,
    };
    return this.frozenConclusion;
  }

  conclusionState(): { conclusion: FrozenConclusion | null; needsReanalysis: boolean } {
    return {
      conclusion: this.frozenConclusion,
      needsReanalysis: this.frozenConclusion !== null && this.frozenConclusion.revision !== this.revision,
    };
  }

  appendReconciliation(
    input: Omit<ReconciliationSnapshot, "webhookSettledPurchases" | "webhookSettledMinor" | "discrepancy">,
  ): ReconciliationSnapshot {
    const projection = this.snapshot();
    const discrepancy = (["A", "B"] as const).some(
      (arm) =>
        projection.settledPurchases[arm] !== input.reconciledSettledPurchases[arm] ||
        projection.settledMinor[arm] !== input.reconciledSettledMinor[arm],
    );
    const snapshot: ReconciliationSnapshot = {
      ...input,
      webhookSettledPurchases: projection.settledPurchases,
      webhookSettledMinor: projection.settledMinor,
      discrepancy,
    };
    this.reconciliationSnapshots.push(snapshot);
    return snapshot;
  }

  reconciliationHistory(): readonly ReconciliationSnapshot[] {
    return [...this.reconciliationSnapshots];
  }
}
