import { assignmentWindowCaveat, type AttributionStrategyId } from "../live/attribution";
import { projectResultPurchases } from "../live/commerce-projection";
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
  const projected = projectResultPurchases({
    experimentId: input.experimentId,
    events: input.events,
    assignments: Object.fromEntries(input.rows.map((row) => [row.fanUuid, row.arm])),
  });
  const purchasesByFan = new Map<string, typeof projected>();
  let assignmentWindowOnly = 0;
  let unmatchedPlausible = 0;
  for (const event of input.events) {
    if (event.kind !== "PAYMENT" || event.experimentId !== input.experimentId) continue;
    if (!countsTowardArms(event)) { unmatchedPlausible += 1; continue; }
    const row = rowByFan.get(event.purchaserUuid);
    if (!row || row.arm !== event.arm || event.occurredAt < row.capturedAt) continue;
    if (!event.messageMatched) assignmentWindowOnly += 1;
    // Per-member outcomes below come from the shared invoice projection.
  }

  for (const purchase of projected) {
    const row = rowByFan.get(purchase.fanUuid);
    if (!row || purchase.occurredAt < row.capturedAt) continue;
    purchasesByFan.set(purchase.fanUuid, [...(purchasesByFan.get(purchase.fanUuid) ?? []), purchase]);
  }

  const evidence = input.rows.map((row): AudienceMemberEvidence => {
    const payments = [...(purchasesByFan.get(row.fanUuid) ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const settled = payments.filter((payment) => payment.refundedMinor + payment.disputedMinor < payment.grossMinor);
    return memberEvidenceFromRow(row, "REAL", {
      converted: settled.length > 0,
      grossPurchaseCount: payments.length,
      settledPurchaseCount: settled.length,
      grossRevenueMinor: payments.reduce((total, payment) => total + payment.grossMinor, 0),
      settledRevenueMinor: settled.reduce((total, payment) => total + payment.grossMinor - payment.refundedMinor - payment.disputedMinor, 0),
      fullyRefunded: payments.some((payment) => payment.refundedMinor === payment.grossMinor),
      disputed: payments.some((payment) => payment.disputedMinor > 0),
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
