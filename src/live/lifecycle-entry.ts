import type { FanvueReadTransport } from "../integrations/fanvue/live-read-contracts";
import type { FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import type { PerformRepository } from "../persistence/contracts";
import type { LiveEvidenceRepository, ReconciliationRecord } from "../persistence/live-evidence";
import {
  deriveCapabilityStates,
  type CapabilityEnvironment,
  type CapabilityState,
  type LiveCapabilityId,
} from "./capabilities";
import type { CapabilityRecordSnapshot } from "./capability-records";
import type { VerifiedCreatorSession } from "./capture-entry";
import { closeExperimentIfReady, type CloseResult } from "./close";
import type { LaunchRepository } from "./launch-repository";
import { reconcileObservation } from "./reconciliation";

/** Close needs both Fanvue totals in the reconciliation it checks. */
export const reconcileCapabilities: readonly LiveCapabilityId[] = ["earnings_reconciliation", "mass_message_totals"];
/** Deleting the two custom lists is a write under the same capability that created them. */
export const closeCapabilities: readonly LiveCapabilityId[] = ["send"];

export type LifecycleRefusal = {
  status: "REFUSED";
  reason: "NOT_A_VERIFIED_CREATOR" | "WRITE_MODE_DISABLED" | "CAPABILITY_NOT_ACTIVE" | "EXPERIMENT_NOT_FOUND" | "NOT_REAL_PROVENANCE";
  capabilities?: Readonly<Partial<Record<LiveCapabilityId, CapabilityState>>>;
};

type Repositories = {
  repository: PerformRepository;
  launchRepository: LaunchRepository;
  evidenceRepository: LiveEvidenceRepository;
};

type GuardInput = {
  session: VerifiedCreatorSession | null;
  env: CapabilityEnvironment;
  records: CapabilityRecordSnapshot;
  experimentId: string;
  repositories: (creatorUuid: string) => Promise<Repositories>;
};

/** Every gate runs before a transport exists; a refusal makes no Fanvue request. */
async function guard(
  input: GuardInput,
  required: readonly LiveCapabilityId[],
  writes: boolean,
): Promise<LifecycleRefusal | { creatorUuid: string; repositories: Repositories }> {
  const session = input.session;
  if (!session?.isCreator || !session.userUuid.trim()) return { status: "REFUSED", reason: "NOT_A_VERIFIED_CREATOR" };
  if (writes && input.env.PERFORM_WRITE_MODE !== "enabled") return { status: "REFUSED", reason: "WRITE_MODE_DISABLED" };
  const states = deriveCapabilityStates({
    env: input.env,
    grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
    verified: input.records.verified,
    activated: input.records.activated,
  });
  if (required.some((id) => states[id].state !== "active")) {
    return {
      status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE",
      capabilities: Object.fromEntries(required.map((id) => [id, states[id].state])),
    };
  }
  const repositories = await input.repositories(session.userUuid);
  const experiment = await repositories.repository.getExperiment(input.experimentId);
  if (!experiment || experiment.creatorUuid !== session.userUuid) return { status: "REFUSED", reason: "EXPERIMENT_NOT_FOUND" };
  if (experiment.dataProvenance !== "REAL") return { status: "REFUSED", reason: "NOT_REAL_PROVENANCE" };
  return { creatorUuid: session.userUuid, repositories };
}

/** The only REAL entry point for a manual reconciliation: reads earnings and mass-message totals. */
export async function runGuardedReconciliation(input: GuardInput & {
  transport: () => FanvueReadTransport;
  now: () => string;
  newId: () => string;
}): Promise<LifecycleRefusal | { status: "RECONCILED"; record: ReconciliationRecord }> {
  const gate = await guard(input, reconcileCapabilities, false);
  if ("status" in gate) return gate;
  const record = await reconcileObservation({
    experimentId: input.experimentId, creatorUuid: gate.creatorUuid, ...gate.repositories,
    transport: input.transport(), now: input.now, newId: input.newId,
  });
  return { status: "RECONCILED", record };
}

/** The only REAL entry point for close: it deletes both custom lists in Fanvue. */
export async function runGuardedClose(input: GuardInput & {
  transport: () => FanvueWriteTransport;
  now: () => string;
}): Promise<LifecycleRefusal | { status: "CHECKED"; result: CloseResult }> {
  const gate = await guard(input, closeCapabilities, true);
  if ("status" in gate) return gate;
  const { repository, launchRepository, evidenceRepository } = gate.repositories;
  const latestReconciliation = (await evidenceRepository.listReconciliations(input.experimentId)).at(-1) ?? null;
  const result = await closeExperimentIfReady({
    experimentId: input.experimentId, latestReconciliation, repository, launchRepository,
    transport: input.transport(), now: input.now,
  });
  return { status: "CHECKED", result };
}
