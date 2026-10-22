import type { PerformRepository } from "../persistence/contracts";
import type { LiveEvidenceRepository } from "../persistence/live-evidence";
import { buildLiveAudienceBreakdown, type LiveAudienceBreakdown } from "../results/live-audience-evidence";
import type { CapabilityEnvironment, CapabilityState, LiveCapabilityId } from "./capabilities";
import { deriveCapabilityStates } from "./capabilities";
import type { CapabilityRecordSnapshot } from "./capability-records";
import type { VerifiedCreatorSession } from "./capture-entry";

export const liveResultsCapabilities: readonly LiveCapabilityId[] = [
  "audience_discovery",
  "subscriber_state",
  "purchase_enrichment",
  "commerce_webhook",
];

export type GuardedLiveResults =
  | {
      status: "REFUSED";
      reason: "NOT_A_VERIFIED_CREATOR" | "CAPABILITY_NOT_ACTIVE" | "EXPERIMENT_NOT_FOUND" | "NOT_REAL_PROVENANCE";
      capabilities?: Readonly<Partial<Record<LiveCapabilityId, CapabilityState>>>;
    }
  | { status: "AVAILABLE"; provenance: "REAL"; experimentId: string; breakdown: LiveAudienceBreakdown };

/** Read-only REAL Results entry point. It cannot call Fanvue or mutate evidence. */
export async function runGuardedLiveResults(input: {
  session: VerifiedCreatorSession | null;
  env: CapabilityEnvironment;
  records: CapabilityRecordSnapshot;
  experimentId: string;
  repositories: (creatorUuid: string) => Promise<{
    repository: PerformRepository;
    evidenceRepository: LiveEvidenceRepository;
  }>;
}): Promise<GuardedLiveResults> {
  const session = input.session;
  if (!session?.isCreator || !session.userUuid.trim()) {
    return { status: "REFUSED", reason: "NOT_A_VERIFIED_CREATOR" };
  }
  const states = deriveCapabilityStates({
    env: input.env,
    grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
    verified: input.records.verified,
    activated: input.records.activated,
  });
  const capabilities = Object.fromEntries(liveResultsCapabilities.map((id) => [id, states[id].state]));
  if (liveResultsCapabilities.some((id) => states[id].state !== "active")) {
    return { status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE", capabilities };
  }

  const { repository, evidenceRepository } = await input.repositories(session.userUuid);
  const experiment = await repository.getExperiment(input.experimentId);
  if (!experiment || experiment.creatorUuid !== session.userUuid) {
    return { status: "REFUSED", reason: "EXPERIMENT_NOT_FOUND" };
  }
  if (experiment.dataProvenance !== "REAL") return { status: "REFUSED", reason: "NOT_REAL_PROVENANCE" };
  const [rows, events, reconciliations] = await Promise.all([
    evidenceRepository.listAudienceEvidence(experiment.id),
    evidenceRepository.listCommerceEvents(experiment.id),
    evidenceRepository.listReconciliations(experiment.id),
  ]);
  const paymentStrategies = new Set(
    events.filter((event) => event.kind === "PAYMENT").map((event) => event.attributionStrategy),
  );
  const attributionStrategy =
    reconciliations.at(-1)?.attributionStrategy ??
    (paymentStrategies.size === 1 ? [...paymentStrategies][0] : "ASSIGNMENT_WINDOW");
  return {
    status: "AVAILABLE",
    provenance: "REAL",
    experimentId: experiment.id,
    breakdown: buildLiveAudienceBreakdown({
      experimentId: experiment.id,
      rows,
      events,
      attributionStrategy,
    }),
  };
}
