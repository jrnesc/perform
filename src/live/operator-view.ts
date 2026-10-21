import type { Arm } from "../domain/allocation";
import type {
  DeadLetterReason,
  DeadLetterSummary,
  ExperimentAttributionCounts,
  LiveEvidenceOperatorReads,
  PendingReversalSummary,
} from "../persistence/live-evidence";
import type { AttributionStrategyId } from "./attribution";

export const operatorListLimit = 50;

export type OperatorReconciliationRow = {
  experimentId: string;
  snapshotId: string;
  capturedAt: string;
  windowStart: string;
  windowEnd: string;
  isComplete: boolean;
  discrepancy: boolean;
  needsReanalysis: boolean;
  attributionStrategy: AttributionStrategyId;
  webhookSettledPurchases: Readonly<Record<Arm, number>>;
  reconciledSettledPurchases: Readonly<Record<Arm, number>>;
  fanvuePurchases: Readonly<Record<Arm, number>> | null;
  massMessageMismatch: boolean | null;
  missingAssignmentCount: number;
  orphanReversalCount: number;
  ignoredRowCount: number;
  assignmentWindowOnlyCount: number;
  unmatchedPlausibleCount: number;
};

/**
 * What an operator sees about live evidence: identifiers and counts only. No purchaser UUIDs,
 * payload hashes, amounts, notes or profile fields, so the view cannot leak a fan's spend.
 */
export type OperatorEvidenceView = {
  provenance: "REAL";
  deadLetters: {
    total: number;
    byReason: Readonly<Partial<Record<DeadLetterReason, number>>>;
    recent: readonly DeadLetterSummary[];
  };
  pendingReversals: { total: number; oldest: readonly PendingReversalSummary[] };
  reconciliation: readonly OperatorReconciliationRow[];
  attribution: readonly ExperimentAttributionCounts[];
};

export async function buildOperatorEvidenceView(reads: LiveEvidenceOperatorReads): Promise<OperatorEvidenceView> {
  const [recent, byReason, oldest, pendingTotal, latest, attribution] = await Promise.all([
    reads.listDeadLetters(operatorListLimit),
    reads.countDeadLettersByReason(),
    reads.listReversalsAwaitingPayment(operatorListLimit),
    reads.countReversalsAwaitingPayment(),
    reads.latestReconciliations(),
    reads.attributionCounts(),
  ]);
  return {
    provenance: "REAL",
    deadLetters: {
      total: Object.values(byReason).reduce((total, count) => total + (count ?? 0), 0),
      byReason,
      recent,
    },
    pendingReversals: { total: pendingTotal, oldest },
    reconciliation: latest.map((record) => ({
      experimentId: record.experimentId,
      snapshotId: record.id,
      capturedAt: record.capturedAt,
      windowStart: record.windowStart,
      windowEnd: record.windowEnd,
      isComplete: record.isComplete,
      discrepancy: record.discrepancy,
      needsReanalysis: record.needsReanalysis,
      attributionStrategy: record.attributionStrategy,
      webhookSettledPurchases: record.webhookSettledPurchases,
      reconciledSettledPurchases: record.reconciledSettledPurchases,
      fanvuePurchases: record.massMessageCheck?.purchases ?? null,
      massMessageMismatch: record.massMessageCheck?.mismatch ?? null,
      missingAssignmentCount: record.missingAssignmentCount,
      orphanReversalCount: record.orphanReversalCount,
      ignoredRowCount: record.ignoredRowCount,
      assignmentWindowOnlyCount: record.assignmentWindowOnlyCount,
      unmatchedPlausibleCount: record.unmatchedPlausibleCount,
    })),
    attribution,
  };
}
