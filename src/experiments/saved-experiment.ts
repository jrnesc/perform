import type { Assignment } from "../domain/allocation";
import type { VariantDefinition } from "../domain/experiment-state";
import type { ExperimentRecord, PerformRepository } from "../persistence/contracts";
import type { MediaAsset } from "../workspace/contracts";
import type { AudienceSnapshot, DryRunPlan, ExperimentReview } from "./contracts";
import { buildDryRunPlan } from "./dry-run-plan";
import { buildExperimentReview } from "./review";

/** Recorded as the invalid reason, and how the history list recognises a discarded experiment. */
export const discardedReason = "Discarded by creator";

/** States with no Fanvue effects yet, so discarding needs no cleanup. */
const discardable: readonly ExperimentRecord["state"][] = ["DRAFT", "SNAPSHOTTING", "ALLOCATED"];

export async function discardExperiment(input: {
  repository: PerformRepository;
  experimentId: string;
  now: () => string;
}): Promise<void> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment) throw new Error("That experiment is not in this workspace");
  if (experiment.state === "INVALID") return;
  if (!discardable.includes(experiment.state)) {
    throw new Error("Only an experiment that has not been launched can be discarded");
  }
  await input.repository.transitionExperiment({
    commandId: `${experiment.id}:discarded`,
    experimentId: experiment.id,
    to: "INVALID",
    occurredAt: input.now(),
    evidence: { invalidReason: discardedReason },
  });
}

/** The live subscribers audience as frozen at allocation. */
export function liveSubscribersAudience(
  assignments: readonly Pick<Assignment, "fanUuid" | "stratum">[],
  capturedAt: string,
): AudienceSnapshot {
  return {
    id: "subscribers",
    name: "Active subscribers",
    description: "Contactable subscribers read from Fanvue and frozen before launch.",
    sourceKind: "FANVUE_SMART_LIST",
    capturedAt,
    members: assignments.map(({ fanUuid, stratum }) => ({ fanUuid, stratum })),
    sourceCount: assignments.length,
    exclusions: [],
    provenance: { kind: "FANVUE", label: "Live Fanvue audience" },
  };
}

/**
 * Rebuild the launch review of a saved, allocated experiment from what was persisted, so the
 * creator can launch it later. The frozen split is the source of truth: if recomputing it from
 * the stored members does not reproduce the stored arms and snapshot hash, resuming is refused.
 */
export async function rebuildSavedReview(input: {
  experiment: ExperimentRecord;
  variants: readonly VariantDefinition[];
  assignments: readonly Assignment[];
  audience: AudienceSnapshot;
  asset: MediaAsset;
  liveLaunch: boolean;
}): Promise<{ review: ExperimentReview; plan: DryRunPlan }> {
  const { experiment } = input;
  if (experiment.state !== "ALLOCATED") throw new Error("Only an allocated experiment can continue to launch");
  if (input.variants.some((variant) => variant.mediaUuid !== input.asset.id)) {
    throw new Error("The saved variants do not use this asset");
  }
  const review = await buildExperimentReview({
    id: experiment.id,
    name: experiment.name,
    audience: input.audience,
    asset: input.asset,
    variable: experiment.variable,
    hypothesis: experiment.hypothesis,
    variants: input.variants,
  });
  const stored = new Map(input.assignments.map(({ fanUuid, arm }) => [fanUuid, arm]));
  const sameSplit =
    review.assignments.length === stored.size &&
    review.assignments.every(({ fanUuid, arm }) => stored.get(fanUuid) === arm);
  if (!sameSplit || review.snapshotHash !== experiment.snapshotHash) {
    throw new Error("The saved audience split could not be reproduced; start a new experiment");
  }
  return { review, plan: buildDryRunPlan(review, { liveLaunch: input.liveLaunch }) };
}
