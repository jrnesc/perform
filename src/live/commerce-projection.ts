import type { Arm } from "../domain/allocation";
import type { EvidenceProjection } from "../integrations/fanvue/creator-evidence";
import {
  countsTowardArms,
  type AttributionContext,
  type CommerceEventRecord,
} from "../persistence/live-evidence";

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
  const reversed = new Set(ours.filter((e) => e.kind === "REVERSAL" && paymentIds.has(e.paymentId)).map((e) => e.paymentId));
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
      purchases, grossMinor, settledPurchases, settledMinor,
      duplicateEvents: 0, ignoredEvents, pendingReversals,
      revision: counted + reversed.size,
    },
    missingAssignmentFans: [...missing],
    assignmentWindowOnly,
    unmatchedPlausible,
  };
}
