import type { FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import type { PerformRepository } from "../persistence/contracts";
import type { ReconciliationRecord } from "../persistence/live-evidence";
import type { LaunchRepository } from "./launch-repository";

export type CloseResult =
  | { status: "CLOSED"; deletedLists: number }
  | { status: "OPEN"; reasons: readonly string[] };

/** Close is deliberately explicit; callers supply the latest durable reconciliation. */
export async function closeExperimentIfReady(input: {
  experimentId: string;
  plannedEndAt: string;
  latestReconciliation: ReconciliationRecord | null;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<CloseResult> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment || experiment.state !== "RUNNING") return { status: "OPEN", reasons: ["Experiment is not running"] };
  const reasons: string[] = [];
  if (Date.parse(input.now()) < Date.parse(input.plannedEndAt)) reasons.push("Planned observation end has not arrived");
  const reconciliation = input.latestReconciliation;
  if (!reconciliation?.isComplete) reasons.push("Reconciliation is incomplete");
  if (reconciliation?.discrepancy) reasons.push("Reconciliation still has a discrepancy");
  if (!reconciliation?.massMessageCheck) reasons.push("Mass-message totals check has not run");
  if (reconciliation?.massMessageCheck?.mismatch) reasons.push("Mass-message totals do not match attributed totals");
  if (reasons.length > 0) return { status: "OPEN", reasons };

  let deletedLists = 0;
  for (const arm of ["A", "B"] as const) {
    const list = await input.launchRepository.getList(arm);
    if (!list?.externalListUuid || list.status === "DELETED") continue;
    await input.transport.deleteCustomList(list.externalListUuid);
    await input.launchRepository.recordListOutcome({ ...list, status: "DELETED", occurredAt: input.now() });
    deletedLists += 1;
  }
  await input.repository.transitionExperiment({
    commandId: `${experiment.id}:closed`, experimentId: experiment.id, to: "CLOSED",
    occurredAt: input.now(), evidence: { observationEnded: true, metricsFinal: true },
  });
  return { status: "CLOSED", deletedLists };
}
