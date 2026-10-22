import { FanvueWriteError, type FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import type { ExperimentRecord, PerformRepository } from "../persistence/contracts";
import type { LaunchRepository } from "./launch-repository";

/** Recorded as the invalid reason, and how the history list recognises an abandoned launch. */
export const abandonedReason = "Abandoned before sending";

/** A launch can stop here before any message exists: lists may exist in Fanvue, sends do not. */
export const interruptedStates: readonly ExperimentRecord["state"][] = ["PROVISIONING", "VERIFIED"];

export type AbandonResult =
  | { status: "ABANDONED"; deletedLists: number }
  | { status: "REFUSED"; reasons: readonly string[] };

/**
 * Clean up a launch that stopped before scheduling: delete its confirmed custom lists, then
 * mark it INVALID. It refuses anything a person must look at first: an uncertain list create
 * (a list may exist that Perform cannot name) or any send intent (a message may exist).
 * Deletions are journaled, so a failure leaves the experiment as it was and a retry is safe.
 */
export async function abandonInterruptedLaunch(input: {
  experimentId: string;
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  transport: FanvueWriteTransport;
  now: () => string;
}): Promise<AbandonResult> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment) return { status: "REFUSED", reasons: ["That experiment is not in this workspace"] };
  if (experiment.state === "INVALID") return { status: "ABANDONED", deletedLists: 0 };
  if (!interruptedStates.includes(experiment.state)) {
    return { status: "REFUSED", reasons: ["Only a launch that stopped before scheduling can be abandoned"] };
  }
  const reasons: string[] = [];
  if ((await input.repository.listSendIntents(experiment.id)).length > 0) {
    reasons.push("Message intents exist, so a message may have been scheduled; this needs operator review");
  }
  const lists = await Promise.all((["A", "B"] as const).map((arm) => input.launchRepository.getList(arm)));
  for (const list of lists) {
    if (list && (list.status === "CREATING" || list.status === "UNKNOWN")) {
      reasons.push(`Arm ${list.arm} list creation is uncertain, so a list may exist that Perform cannot delete; this needs operator review`);
    }
  }
  if (reasons.length > 0) return { status: "REFUSED", reasons };

  let deletedLists = 0;
  for (const list of lists) {
    if (!list?.externalListUuid || list.status === "DELETED") continue;
    try {
      await input.transport.deleteCustomList(list.externalListUuid);
    } catch (error) {
      if (!(error instanceof FanvueWriteError && error.status === 404)) throw error;
    }
    await input.launchRepository.recordListOutcome({ ...list, status: "DELETED", occurredAt: input.now() });
    deletedLists += 1;
  }
  await input.repository.transitionExperiment({
    commandId: `${experiment.id}:abandoned`, experimentId: experiment.id, to: "INVALID",
    occurredAt: input.now(), evidence: { invalidReason: abandonedReason },
  });
  return { status: "ABANDONED", deletedLists };
}
