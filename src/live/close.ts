import { FanvueWriteError, type FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import type { PerformRepository } from "../persistence/contracts";
import type { ReconciliationRecord } from "../persistence/live-evidence";
import type { LaunchRepository } from "./launch-repository";

export type CloseResult =
  | { status: "CLOSED"; deletedLists: number }
  | { status: "OPEN"; reasons: readonly string[] };

/** Every reason the checks found, so the creator sees all blockers at once (ADR 0020). */
export function closeBlockers(input: {
  observationEndsAt: string | null;
  latestReconciliation: ReconciliationRecord | null;
  now: string;
}): string[] {
  const reasons: string[] = [];
  const end = input.observationEndsAt;
  if (!end) reasons.push("No observation window was confirmed at launch");
  else if (Date.parse(input.now) < Date.parse(end)) reasons.push("The observation window has not ended");
  const reconciliation = input.latestReconciliation;
  if (!reconciliation) {
    reasons.push("No reconciliation has run");
    return reasons;
  }
  if (end && Date.parse(reconciliation.windowEnd) < Date.parse(end)) {
    reasons.push("The latest reconciliation does not cover the whole observation window");
  }
  if (!reconciliation.isComplete) reasons.push("The latest reconciliation is incomplete");
  if (reconciliation.discrepancy) reasons.push("The latest reconciliation has a discrepancy");
  if (!reconciliation.massMessageCheck) reasons.push("The mass-message totals check has not run");
  else if (reconciliation.massMessageCheck.mismatch) reasons.push("Mass-message totals do not match attributed totals");
  return reasons;
}

/**
 * Close is explicit and checked. Lists are deleted before the transition, each deletion is
 * journaled, and a failure leaves the experiment RUNNING, so a retry deletes only what remains.
 */
export async function closeExperimentIfReady(input: {
  experimentId: string;
  latestReconciliation: ReconciliationRecord | null;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<CloseResult> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (experiment?.state === "CLOSED") return { status: "CLOSED", deletedLists: 0 };
  if (!experiment || experiment.state !== "RUNNING") return { status: "OPEN", reasons: ["The experiment is not running"] };
  const confirmation = await input.launchRepository.getConfirmation();
  const reasons = closeBlockers({
    observationEndsAt: confirmation?.observationEndsAt ?? null,
    latestReconciliation: input.latestReconciliation,
    now: input.now(),
  });
  if (reasons.length > 0) return { status: "OPEN", reasons };

  let deletedLists = 0;
  for (const arm of ["A", "B"] as const) {
    const list = await input.launchRepository.getList(arm);
    if (!list?.externalListUuid || list.status === "DELETED") continue;
    try {
      await input.transport.deleteCustomList(list.externalListUuid);
    } catch (error) {
      // A 404 after an uncertain earlier delete means the list is already gone.
      if (!(error instanceof FanvueWriteError && error.status === 404)) throw error;
    }
    await input.launchRepository.recordListOutcome({ ...list, status: "DELETED", occurredAt: input.now() });
    deletedLists += 1;
  }
  await input.repository.transitionExperiment({
    commandId: `${experiment.id}:closed`, experimentId: experiment.id, to: "CLOSED",
    occurredAt: input.now(), evidence: { observationEnded: true, metricsFinal: true },
  });
  return { status: "CLOSED", deletedLists };
}
