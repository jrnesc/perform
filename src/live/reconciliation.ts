import type { Arm } from "../domain/allocation";
import { reconcileExperimentEarnings } from "../integrations/fanvue/earnings-reconciliation";
import { readMassMessageAggregates } from "../integrations/fanvue/mass-message-aggregates";
import type { FanvueReadTransport } from "../integrations/fanvue/live-read-contracts";
import type { PerformRepository } from "../persistence/contracts";
import type { LiveEvidenceRepository, ReconciliationRecord } from "../persistence/live-evidence";
import { assignmentWindowStrategy, type PurchaseAttributionStrategy } from "./attribution";
import { projectExperimentCommerce } from "./commerce-projection";
import type { LaunchRepository } from "./launch-repository";

const hour = 3_600_000;

export type ReconciliationWindow = { startAt: string; endAt: string };

/**
 * Bounded, overlapping windows from the last completed read up to `until`. Overlap lets a late
 * refund or delayed ledger row be re-read; the size bound keeps each cursor walk finite.
 */
export function planReconciliationWindows(input: {
  observationStart: string;
  observationEnd: string;
  until: string;
  reconciledThrough: string | null;
  overlapMs?: number;
  maxWindowMs?: number;
}): readonly ReconciliationWindow[] {
  const overlapMs = input.overlapMs ?? 24 * hour;
  const maxWindowMs = input.maxWindowMs ?? 7 * 24 * hour;
  const observationStart = Date.parse(input.observationStart);
  const observationEnd = Date.parse(input.observationEnd);
  const until = Date.parse(input.until);
  const through = input.reconciledThrough === null ? null : Date.parse(input.reconciledThrough);
  if (
    [observationStart, observationEnd, until].some(Number.isNaN) ||
    (through !== null && Number.isNaN(through)) ||
    observationStart >= observationEnd ||
    maxWindowMs <= overlapMs ||
    overlapMs < 0
  ) {
    throw new Error("A valid reconciliation plan requires ordered times and a window larger than its overlap");
  }
  const end = Math.min(observationEnd, until);
  let start = through === null ? observationStart : Math.max(observationStart, through - overlapMs);
  const windows: ReconciliationWindow[] = [];
  while (start < end) {
    const windowEnd = Math.min(end, start + maxWindowMs);
    windows.push({ startAt: new Date(start).toISOString(), endAt: new Date(windowEnd).toISOString() });
    if (windowEnd >= end) break;
    start = windowEnd - overlapMs;
  }
  return windows;
}

/**
 * Compare webhook evidence with the authoritative earnings ledger for one window and append the
 * result. A read failure appends nothing and propagates, so absence of a snapshot is never
 * mistaken for agreement. Missing assignments, orphan reversals, unreadable rows or any drift
 * make the snapshot incomplete and flag a frozen conclusion for re-analysis.
 */
export async function reconcileExperimentWindow(input: {
  experimentId: string;
  creatorUuid: string;
  window: ReconciliationWindow;
  capturedAt: string;
  transport: FanvueReadTransport;
  repository: LiveEvidenceRepository;
  newId: () => string;
  /** Evidence revision recorded when a conclusion was frozen, if any. */
  frozenConclusionRevision: number | null;
  /** Defaults to assignment and send window (ADR 0015). */
  attribution?: PurchaseAttributionStrategy;
  /** Also compare with Fanvue's per-message totals; needs `read:chat`. */
  checkMassMessages?: boolean;
}): Promise<ReconciliationRecord> {
  const strategy = input.attribution ?? assignmentWindowStrategy;
  const context = await input.repository.getAttributionContext(input.experimentId);
  const events = await input.repository.listCommerceEvents(input.experimentId);
  const webhook = projectExperimentCommerce(input.creatorUuid, events, context, input.window);
  const earnings = await reconcileExperimentEarnings({
    startAt: input.window.startAt,
    endAt: input.window.endAt,
    messages: context.messages,
    assignments: context.assignments,
    transport: input.transport,
    attribution: { strategy, window: context.window },
  });
  const massMessageCheck = input.checkMassMessages
    ? await compareWithMassMessages(input.creatorUuid, events, context, input.transport)
    : null;

  const arms: readonly Arm[] = ["A", "B"];
  const discrepancy = arms.some(
    (arm) =>
      webhook.projection.settledPurchases[arm] !== earnings.settledPurchases[arm] ||
      webhook.projection.settledMinor[arm] !== earnings.settledMinor[arm],
  );
  const missingAssignmentCount = new Set([...earnings.missingAssignments, ...webhook.missingAssignmentFans]).size;
  const orphanReversalCount = earnings.orphanReversals.length;
  const isComplete = missingAssignmentCount === 0 && orphanReversalCount === 0 && earnings.ignoredRows === 0;
  const evidenceChanged =
    input.frozenConclusionRevision !== null && input.frozenConclusionRevision !== webhook.projection.revision;

  const problems = [
    discrepancy && "webhook and earnings totals differ",
    missingAssignmentCount > 0 && `${missingAssignmentCount} purchaser(s) lack a frozen assignment`,
    orphanReversalCount > 0 && `${orphanReversalCount} reversal(s) reference a transaction outside the window`,
    earnings.ignoredRows > 0 && `${earnings.ignoredRows} earnings row(s) were unreadable`,
    massMessageCheck?.mismatch && "attributed purchases differ from Fanvue's per-message totals",
  ].filter(Boolean);
  const assignmentWindowOnlyCount = Math.max(webhook.assignmentWindowOnly, earnings.assignmentWindowOnly);
  const unmatchedPlausibleCount = Math.max(webhook.unmatchedPlausible, earnings.unmatchedPlausible);
  const record: ReconciliationRecord = {
    id: input.newId(),
    experimentId: input.experimentId,
    windowStart: input.window.startAt,
    windowEnd: input.window.endAt,
    capturedAt: input.capturedAt,
    isComplete,
    discrepancy,
    needsReanalysis: discrepancy || evidenceChanged,
    webhookSettledPurchases: webhook.projection.settledPurchases,
    webhookSettledMinor: webhook.projection.settledMinor,
    reconciledSettledPurchases: earnings.settledPurchases,
    reconciledSettledMinor: earnings.settledMinor,
    missingAssignmentCount,
    orphanReversalCount,
    ignoredRowCount: earnings.ignoredRows,
    attributionStrategy: strategy.id,
    assignmentWindowOnlyCount,
    unmatchedPlausibleCount,
    massMessageCheck,
    note: problems.length
      ? `Not reconciled: ${problems.join("; ")}.`
      : "Webhook evidence agrees with the earnings ledger.",
  };
  await input.repository.appendReconciliation(record);
  return record;
}

/**
 * Fanvue's own per-message totals need no payment-to-message join, so they are the authoritative
 * per-arm count. They are lifetime totals, so they are compared with gross (pre-reversal)
 * purchases over the whole observation. Under assignment-window attribution a fan's unrelated
 * broadcast purchases make ours higher, which this surfaces as a mismatch rather than hiding.
 */
async function compareWithMassMessages(
  creatorUuid: string,
  events: Parameters<typeof projectExperimentCommerce>[1],
  context: Parameters<typeof projectExperimentCommerce>[2],
  transport: FanvueReadTransport,
): Promise<NonNullable<ReconciliationRecord["massMessageCheck"]>> {
  const read = await readMassMessageAggregates({ messageUuids: Object.keys(context.messages), transport });
  const purchases: Record<Arm, number> = { A: 0, B: 0 };
  const revenueMinor: Record<Arm, number> = { A: 0, B: 0 };
  for (const [uuid, arm] of Object.entries(context.messages)) {
    const aggregate = read.aggregates[uuid];
    if (!aggregate) continue;
    purchases[arm] += aggregate.purchaseCount;
    revenueMinor[arm] += aggregate.totalRevenueMinor;
  }
  const ours = projectExperimentCommerce(creatorUuid, events, context).projection;
  const mismatch =
    read.missing.length > 0 ||
    (["A", "B"] as const).some(
      (arm) => ours.purchases[arm] !== purchases[arm] || ours.grossMinor[arm] !== revenueMinor[arm],
    );
  return { purchases, revenueMinor, mismatch };
}

/**
 * The manual reconciliation behind the detail page (ADR 0020): one window from delivery to the
 * confirmed observation end (or now, if earlier), always with the mass-message totals check,
 * because close needs both. The bounded planner above is for the future scheduled job.
 */
export async function reconcileObservation(input: {
  experimentId: string;
  creatorUuid: string;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  evidenceRepository: LiveEvidenceRepository;
  transport: FanvueReadTransport;
  now: () => string;
  newId: () => string;
}): Promise<ReconciliationRecord> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment || experiment.state !== "RUNNING") throw new Error("Only a running experiment can be reconciled");
  const confirmation = await input.launchRepository.getConfirmation();
  if (!confirmation) throw new Error("This experiment has no confirmed launch");
  const startAt = experiment.observationStartedAt ?? experiment.launchedAt ?? confirmation.scheduledAt;
  const now = input.now();
  const endAt = Date.parse(now) < Date.parse(confirmation.observationEndsAt) ? now : confirmation.observationEndsAt;
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error("Nothing to reconcile before delivery");
  return reconcileExperimentWindow({
    experimentId: experiment.id,
    creatorUuid: input.creatorUuid,
    window: { startAt, endAt },
    capturedAt: now,
    transport: input.transport,
    repository: input.evidenceRepository,
    newId: input.newId,
    frozenConclusionRevision: null,
    checkMassMessages: true,
  });
}
