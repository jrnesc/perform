import {
  sha256,
  verifyAndParseCreatorEvidence,
} from "../integrations/fanvue/creator-evidence";
import type { DeadLetterReason, LiveEvidenceRepository } from "../persistence/live-evidence";
import { assignmentWindowStrategy, type PurchaseAttributionStrategy } from "./attribution";

export type WebhookConfig = {
  /** Explicit activation. Absent or false means the receiver does not exist. */
  enabled: boolean;
  signingSecret: string | undefined;
  creatorUuid: string | undefined;
};

export type WebhookOutcome =
  | "DISABLED"
  | "NOT_CONFIGURED"
  | "INVALID_SIGNATURE"
  | "RECORDED"
  | "DUPLICATE"
  | "UNRELATED"
  | "VERIFICATION"
  | "DEAD_LETTERED"
  | "STORE_ERROR";

export type WebhookResult = { status: number; outcome: WebhookOutcome };

function result(status: number, outcome: WebhookOutcome): WebhookResult {
  return { status, outcome };
}

/** Fanvue probes a new API subscription with one unsigned request of this type. */
function isVerificationProbe(rawBody: Uint8Array): boolean {
  try {
    return (JSON.parse(new TextDecoder().decode(rawBody)) as { type?: unknown }).type === "fanvue.webhook.verification";
  } catch {
    return false;
  }
}

function bestEffortEventId(rawBody: Uint8Array): string | null {
  try {
    const id = (JSON.parse(new TextDecoder().decode(rawBody)) as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id : null;
  } catch {
    return null;
  }
}

/**
 * Framework-free receiver for creator payment/refund/dispute deliveries.
 *
 * Order matters: activation, the unsigned verification probe, exact-raw-byte signature,
 * creator scope, then attribution by the selected strategy (ADR 0015). Delivery is at-least-once and
 * unordered, so everything is idempotent. Fanvue treats any non-2xx as a failed delivery, retries
 * it and can auto-disable the destination, so only a bad signature and a storage failure are
 * non-2xx. Anything durably captured, including dead letters, is acknowledged with 200.
 */
export async function receiveCreatorCommerceWebhook(input: {
  rawBody: Uint8Array;
  signature: string | null;
  nowMs: number;
  config: WebhookConfig;
  repository: LiveEvidenceRepository;
  newId: () => string;
  /** Defaults to assignment and send window; message-UUID matching needs a proven real send. */
  attribution?: PurchaseAttributionStrategy;
}): Promise<WebhookResult> {
  const { config, repository } = input;
  if (!config.enabled) return result(404, "DISABLED");
  // The verification probe is the only unsigned request Fanvue sends. It carries no data, so
  // acknowledging it stores nothing, and it must be answered before the secret exists: Fanvue
  // only reveals the signing secret once the destination has been created and probed.
  if (!input.signature && isVerificationProbe(input.rawBody)) return result(200, "VERIFICATION");
  if (!config.signingSecret || !config.creatorUuid) return result(503, "NOT_CONFIGURED");
  if (!input.signature) return result(401, "INVALID_SIGNATURE");

  const receivedAt = new Date(input.nowMs).toISOString();
  const parsed = await verifyAndParseCreatorEvidence({
    rawBody: input.rawBody,
    signature: input.signature,
    signingSecret: config.signingSecret,
    expectedCreatorUuid: config.creatorUuid,
    nowMs: input.nowMs,
  });

  const deadLetter = async (reason: DeadLetterReason, eventId: string | null, payloadHash: string, status: number) => {
    await repository.recordDeadLetter({ id: input.newId(), reason, eventId, payloadHash, receivedAt });
    return result(status, "DEAD_LETTERED");
  };

  try {
    if (!parsed.accepted) {
      if (parsed.reason === "INVALID_SIGNATURE") return result(401, "INVALID_SIGNATURE");
      // An authentic event type we do not handle is acknowledged without being kept.
      if (parsed.reason === "UNSUPPORTED_EVENT") return result(200, "UNRELATED");
      // Authentic but unusable (unsupported shape, partial refund, wrong creator): acknowledge so
      // Fanvue stops retrying, and keep a hash-only audit trail.
      return deadLetter(
        parsed.reason, bestEffortEventId(input.rawBody), await sha256(input.rawBody), 200,
      );
    }
    const { event, payloadHash } = parsed;

    if (event.kind === "PAYMENT") {
      const strategy = input.attribution ?? assignmentWindowStrategy;
      const decision = strategy.decide(
        event, await repository.listAttributionCandidates(event.purchaserUuid, event.messageUuid),
      );
      if (decision.kind === "UNRELATED") return result(200, "UNRELATED");
      // Never guess between overlapping experiments; keep a hash-only record for the operator.
      if (decision.kind === "AMBIGUOUS") return deadLetter("ATTRIBUTION_AMBIGUOUS", event.eventId, payloadHash, 200);
      const context = await repository.getAttributionContext(decision.experimentId);
      const confirmedMessageUuid = Object.entries(context.messages)
        .find(([, arm]) => arm === decision.arm)?.[0];
      if (confirmedMessageUuid) {
        await repository.recordAttributionProof({
          experimentId: decision.experimentId,
          outcome: event.messageUuid === confirmedMessageUuid ? "MATCH" : "NO_MATCH",
          paymentMessageUuid: event.messageUuid,
          confirmedMessageUuid,
          observedAt: receivedAt,
        });
      }
      const outcome = await repository.recordCommerceEvent({
        source: "FANVUE_WEBHOOK",
        kind: "PAYMENT",
        eventId: event.eventId, creatorUuid: event.creatorUuid, paymentId: event.paymentId,
        purchaserUuid: event.purchaserUuid, messageUuid: event.messageUuid, messageType: event.messageType,
        attributionStrategy: strategy.id,
        // A missing assignment is stored against its message and excluded by projection.
        messageMatched: decision.kind === "ATTRIBUTED" ? decision.messageMatched : decision.kind === "MISSING_ASSIGNMENT",
        experimentId: decision.experimentId, arm: decision.arm,
        grossMinor: event.grossMinor, netMinor: event.netMinor, currency: event.currency,
        occurredAt: event.occurredAt, payloadHash, receivedAt,
      });
      return settle(outcome);
    }

    const outcome = await repository.recordCommerceEvent({
      source: "FANVUE_WEBHOOK",
      kind: "REVERSAL",
      eventId: event.eventId, creatorUuid: event.creatorUuid, paymentId: event.paymentId,
      reversalId: event.reversalId, reversalType: event.reversalType,
      amountMinor: event.amountMinor, currency: event.currency,
      occurredAt: event.occurredAt, payloadHash, receivedAt,
    });
    return settle(outcome);

    async function settle(outcome: Awaited<ReturnType<LiveEvidenceRepository["recordCommerceEvent"]>>) {
      if (outcome === "RECORDED") return result(200, "RECORDED");
      if (outcome === "DUPLICATE") return result(200, "DUPLICATE");
      // Same ID with different bytes, or one payment ID on two events: never overwrite evidence.
      // Acknowledged, because a retry cannot change the outcome.
      return deadLetter(outcome, event.eventId, payloadHash, 200);
    }
  } catch {
    // Persistence failure: let Fanvue retry rather than lose the event.
    return result(500, "STORE_ERROR");
  }
}
