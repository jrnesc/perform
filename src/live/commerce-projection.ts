import type { Arm } from "../domain/allocation";
import type { EvidenceProjection } from "../integrations/fanvue/creator-evidence";
import type { ResultPurchase } from "../results/contracts";
import { countsTowardArms, type AttributionContext, type CommerceEventRecord } from "../persistence/live-evidence";

export type ExperimentCommerceProjection = {
  projection: EvidenceProjection;
  /** Purchasers of a known experiment message with no matching frozen assignment. Fail closed. */
  missingAssignmentFans: readonly string[];
  /** Counted payments placed by assignment and window, not by a stored message UUID. */
  assignmentWindowOnly: number;
  /** Assigned, in-window BROADCAST payments that message-UUID matching left uncounted. */
  unmatchedPlausible: number;
};

type Payment = Extract<CommerceEventRecord, { kind: "PAYMENT" }>;

/**
 * The single invoice-level projection used by seeded and live Results. Stored events are replayed
 * by payment ID, so delivery order is irrelevant and a reversal received first still settles the
 * same purchase. Only payments accepted by the attribution strategy and matching the frozen
 * assignment are returned.
 */
export function projectResultPurchases(input: {
  experimentId: string;
  events: readonly CommerceEventRecord[];
  assignments: Readonly<Record<string, Arm>>;
}): readonly ResultPurchase[] {
  const reversals = new Map<string, Extract<CommerceEventRecord, { kind: "REVERSAL" }>[]>();
  for (const event of input.events) {
    if (event.kind === "REVERSAL") {
      reversals.set(event.paymentId, [...(reversals.get(event.paymentId) ?? []), event]);
    }
  }
  return input.events
    .filter((event): event is Payment => event.kind === "PAYMENT")
    .filter((event) => event.experimentId === input.experimentId && countsTowardArms(event))
    .filter((event) => input.assignments[event.purchaserUuid] === event.arm)
    .map((event) => {
      const related = reversals.get(event.paymentId) ?? [];
      const amount = (kind: "REFUND" | "DISPUTE") =>
        related
          .filter((reversal) => reversal.reversalType === kind)
          .reduce((total, reversal) => total + (reversal.amountMinor ?? event.grossMinor), 0);
      return {
        id: event.paymentId,
        fanUuid: event.purchaserUuid,
        arm: event.arm,
        grossMinor: event.grossMinor,
        refundedMinor: Math.min(event.grossMinor, amount("REFUND")),
        disputedMinor: Math.min(event.grossMinor, amount("DISPUTE")),
        occurredAt: event.occurredAt,
      };
    })
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

/**
 * Deterministic replay of stored events. Order of arrival cannot matter: reversals are joined to
 * payments by payment ID after both are read, so a refund received first still nets its payment.
 */
export function projectExperimentCommerce(
  creatorUuid: string,
  events: readonly CommerceEventRecord[],
  context: AttributionContext,
  window?: { startAt: string; endAt: string },
): ExperimentCommerceProjection {
  const inWindow = (record: CommerceEventRecord) =>
    !window || (record.occurredAt >= window.startAt && record.occurredAt < window.endAt);
  const ours = events.filter((event) => event.creatorUuid === creatorUuid);
  const payments = ours.filter((e): e is Payment => e.kind === "PAYMENT" && inWindow(e));
  const paymentIds = new Set(payments.map((payment) => payment.paymentId));
  const reversed = new Set(
    ours.filter((e) => e.kind === "REVERSAL" && paymentIds.has(e.paymentId)).map((e) => e.paymentId),
  );
  const storedPaymentIds = new Set(ours.filter((e) => e.kind === "PAYMENT").map((e) => e.paymentId));

  const purchases: Record<Arm, number> = { A: 0, B: 0 };
  const grossMinor: Record<Arm, number> = { A: 0, B: 0 };
  const settledPurchases: Record<Arm, number> = { A: 0, B: 0 };
  const settledMinor: Record<Arm, number> = { A: 0, B: 0 };
  const missing = new Set<string>();
  let ignoredEvents = 0;
  let counted = 0;
  let assignmentWindowOnly = 0;
  let unmatchedPlausible = 0;
  for (const payment of payments) {
    if (!countsTowardArms(payment)) {
      unmatchedPlausible += 1;
      ignoredEvents += 1;
      continue;
    }
    if (context.assignments[payment.purchaserUuid] !== payment.arm) {
      missing.add(payment.purchaserUuid);
      ignoredEvents += 1;
      continue;
    }
    counted += 1;
    if (!payment.messageMatched) assignmentWindowOnly += 1;
    purchases[payment.arm] += 1;
    grossMinor[payment.arm] += payment.grossMinor;
    if (!reversed.has(payment.paymentId)) {
      settledPurchases[payment.arm] += 1;
      settledMinor[payment.arm] += payment.grossMinor;
    }
  }
  const pendingReversals = ours.filter((e) => e.kind === "REVERSAL" && !storedPaymentIds.has(e.paymentId)).length;
  return {
    projection: {
      purchases,
      grossMinor,
      settledPurchases,
      settledMinor,
      duplicateEvents: 0,
      ignoredEvents,
      pendingReversals,
      revision: counted + reversed.size,
    },
    missingAssignmentFans: [...missing],
    assignmentWindowOnly,
    unmatchedPlausible,
  };
}
