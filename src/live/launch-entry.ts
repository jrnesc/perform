import type { FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import type { PerformRepository } from "../persistence/contracts";
import type { CapabilityEnvironment, CapabilityState } from "./capabilities";
import { deriveCapabilityStates } from "./capabilities";
import type { CapabilityRecordSnapshot } from "./capability-records";
import { executeConfirmedLaunch, type LaunchResult } from "./launch";
import type { LaunchRepository } from "./launch-repository";
import type { VerifiedCreatorSession } from "./capture-entry";

export type LaunchEntryResult =
  | { status: "REFUSED"; reason: "NOT_A_VERIFIED_CREATOR" | "WRITE_MODE_DISABLED" | "CAPABILITY_NOT_ACTIVE" | "EXPERIMENT_NOT_FOUND" | "NOT_REAL_PROVENANCE"; capability?: CapabilityState }
  | { status: "LAUNCHED"; result: LaunchResult };

/**
 * The only REAL entry point allowed to construct a Fanvue write transport.
 * All deployment, creator, capability, provenance and ownership gates run first.
 */
export async function runGuardedRealLaunch(input: {
  session: VerifiedCreatorSession | null;
  env: CapabilityEnvironment;
  records: CapabilityRecordSnapshot;
  experimentId: string;
  scheduledAt: string;
  confirmationHash: string;
  repositories: (creatorUuid: string) => Promise<{ repository: PerformRepository; launchRepository: LaunchRepository }>;
  transport: () => FanvueWriteTransport;
  now: () => string;
}): Promise<LaunchEntryResult> {
  const session = input.session;
  if (!session?.isCreator || !session.userUuid.trim()) return { status: "REFUSED", reason: "NOT_A_VERIFIED_CREATOR" };
  if (input.env.PERFORM_WRITE_MODE !== "enabled") return { status: "REFUSED", reason: "WRITE_MODE_DISABLED" };
  const capabilities = deriveCapabilityStates({
    env: input.env,
    grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
    verified: input.records.verified,
    activated: input.records.activated,
  });
  if (capabilities.send.state !== "active") {
    return { status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE", capability: capabilities.send.state };
  }
  const repositories = await input.repositories(session.userUuid);
  const experiment = await repositories.repository.getExperiment(input.experimentId);
  if (!experiment || experiment.creatorUuid !== session.userUuid) return { status: "REFUSED", reason: "EXPERIMENT_NOT_FOUND" };
  if (experiment.dataProvenance !== "REAL") return { status: "REFUSED", reason: "NOT_REAL_PROVENANCE" };

  const result = await executeConfirmedLaunch({
    creatorUuid: session.userUuid, experimentId: experiment.id,
    scheduledAt: input.scheduledAt, confirmationHash: input.confirmationHash,
    repository: repositories.repository, launchRepository: repositories.launchRepository,
    transport: input.transport(), now: input.now,
  });
  return { status: "LAUNCHED", result };
}
