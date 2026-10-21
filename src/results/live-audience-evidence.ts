import { assignmentWindowCaveat, type AttributionStrategyId } from "../live/attribution";
import {
  countsTowardArms,
  type CommerceEventRecord,
  type AudienceEvidenceRow,
} from "../persistence/live-evidence";
import { memberEvidenceFromRow } from "./audience-evidence";
import type { AudienceMemberEvidence } from "./contracts";

export type LiveAudienceBreakdown = {
  provenance: "REAL";
  attributionStrategy: AttributionStrategyId;
  evidence: readonly AudienceMemberEvidence[];
  /** Counted payments placed by assignment and window rather than a stored message UUID. */
  assignmentWindowOnly: number;
  /** Plausible payments left uncounted by message-UUID matching. */
  unmatchedPlausible: number;
  /** Shown with the breakdown whenever any purchase was placed by assignment and window. */
  caveat: string | null;
};

type Payment = Extract<CommerceEventRecord, { kind: "PAYMENT" }>;

/**
 * Maps frozen live evidence and stored commerce events onto the same per-member contract the
 * seeded results use, so Results shows the same five cohorts with REAL provenance. Only payments
 * the strategy counted, by the fan's own arm, after assignment, contribute outcomes.
 */
export function buildLiveAudienceBreakdown(input: {
  experimentId: string;
  rows: readonly AudienceEvidenceRow[];
  events: readonly CommerceEventRecord[];
  attributionStrategy: AttributionStrategyId;
}): LiveAudienceBreakdown {
  const rowByFan = new Map(input.rows.map((row) => [row.fanUuid, row]));
  if (rowByFan.size !== input.rows.length || input.rows.some((row) => row.experimentId !== input.experimentId)) {
    throw new Error("Live audience evidence must hold one row per fan in the selected experiment");
  }
  const reversals = new Map<string, Extract<CommerceEventRecord, { kind: "REVERSAL" }>>();
  for (const event of input.events) if (event.kind === "REVERSAL") reversals.set(event.paymentId, event);

  const paymentsByFan = new Map<string, Payment[]>();
  let assignmentWindowOnly = 0;
  let unmatchedPlausible = 0;
  for (const event of input.events) {
    if (event.kind !== "PAYMENT" || event.experimentId !== input.experimentId) continue;
    if (!countsTowardArms(event)) { unmatchedPlausible += 1; continue; }
    const row = rowByFan.get(event.purchaserUuid);
    if (!row || row.arm !== event.arm || event.occurredAt < row.capturedAt) continue;
    if (!event.messageMatched) assignmentWindowOnly += 1;
    paymentsByFan.set(event.purchaserUuid, [...(paymentsByFan.get(event.purchaserUuid) ?? []), event]);
  }

  const evidence = input.rows.map((row): AudienceMemberEvidence => {
    const payments = [...(paymentsByFan.get(row.fanUuid) ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const settled = payments.filter((payment) => !reversals.has(payment.paymentId));
    const reversalTypes = payments.map((payment) => reversals.get(payment.paymentId)?.reversalType);
    return memberEvidenceFromRow(row, "REAL", {
      converted: settled.length > 0,
      grossPurchaseCount: payments.length,
      settledPurchaseCount: settled.length,
      grossRevenueMinor: payments.reduce((total, payment) => total + payment.grossMinor, 0),
      settledRevenueMinor: settled.reduce((total, payment) => total + payment.grossMinor, 0),
      fullyRefunded: reversalTypes.includes("REFUND"),
      disputed: reversalTypes.includes("DISPUTE"),
      lastOutcomeAt: payments.at(-1)?.occurredAt,
    });
  });
  return {
    provenance: "REAL",
    attributionStrategy: input.attributionStrategy,
    evidence,
    assignmentWindowOnly,
    unmatchedPlausible,
    caveat: input.attributionStrategy === "ASSIGNMENT_WINDOW" ? assignmentWindowCaveat : null,
  };
}
