import type { Arm } from "../domain/allocation";
import type { AudienceSource } from "../integrations/fanvue/audience-read";
import type { FanvueReadTransport } from "../integrations/fanvue/live-read-contracts";
import type { PerformRepository } from "../persistence/contracts";
import type { LiveEvidenceRepository } from "../persistence/live-evidence";
import { captureLiveAudience, persistLiveAudienceSnapshot, type IncompleteReason } from "./audience-capture";
import {
  deriveCapabilityStates,
  type CapabilityEnvironment,
  type CapabilityState,
  type LiveCapabilityId,
} from "./capabilities";

/** Capture reads the smart list, purchase enrichment and subscription history, so needs all three. */
export const captureCapabilities: readonly LiveCapabilityId[] = [
  "audience_discovery",
  "subscriber_state",
  "purchase_enrichment",
];

export type VerifiedCreatorSession = { userUuid: string; isCreator: boolean; scope: string | null };

export type CaptureRefusalReason =
  | "NOT_A_VERIFIED_CREATOR"
  | "CAPABILITY_NOT_ACTIVE"
  | "EXPERIMENT_NOT_FOUND"
  | "NOT_REAL_PROVENANCE"
  | "SOURCE_AUDIENCE_MISMATCH";

export type GuardedCaptureResult =
  | {
      status: "REFUSED";
      reason: CaptureRefusalReason;
      capabilities?: Readonly<Partial<Record<LiveCapabilityId, CapabilityState>>>;
    }
  | { status: "INCOMPLETE"; reasons: readonly IncompleteReason[]; failedFanCount: number }
  | { status: "ALLOCATED"; snapshotCount: number; armCounts: Readonly<Record<Arm, number>> };

/**
 * The only entry point that may trigger a live audience capture. Every gate runs before the
 * repositories are opened or the Fanvue transport is created: a verified creator session, all
 * three capture capabilities `active`, then a REAL experiment owned by that creator whose
 * declared source is the requested audience. Below `active` it refuses with no Fanvue request.
 */
export async function runGuardedLiveAudienceCapture(input: {
  session: VerifiedCreatorSession | null;
  env: CapabilityEnvironment;
  /** From append-only Phase X results written out of band by the owner. */
  verified: readonly LiveCapabilityId[];
  /** From append-only owner activation decisions written out of band. */
  activated: readonly LiveCapabilityId[];
  experimentId: string;
  source: AudienceSource;
  repositories: (
    creatorUuid: string,
  ) => Promise<{ repository: PerformRepository; evidenceRepository: LiveEvidenceRepository }>;
  transport: () => FanvueReadTransport;
  now: () => string;
  commandId: string;
}): Promise<GuardedCaptureResult> {
  const session = input.session;
  if (!session?.isCreator || !session.userUuid.trim()) return { status: "REFUSED", reason: "NOT_A_VERIFIED_CREATOR" };

  const states = deriveCapabilityStates({
    env: input.env,
    grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
    verified: input.verified,
    activated: input.activated,
  });
  const capabilities = Object.fromEntries(captureCapabilities.map((id) => [id, states[id].state]));
  if (captureCapabilities.some((id) => states[id].state !== "active")) {
    return { status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE", capabilities };
  }

  // Repositories are scoped to the verified creator, so another creator's experiment is not found.
  const { repository, evidenceRepository } = await input.repositories(session.userUuid);
  const experiment = await repository.getExperiment(input.experimentId);
  if (!experiment || experiment.creatorUuid !== session.userUuid)
    return { status: "REFUSED", reason: "EXPERIMENT_NOT_FOUND" };
  if (experiment.dataProvenance !== "REAL") return { status: "REFUSED", reason: "NOT_REAL_PROVENANCE" };
  if (experiment.sourceAudienceUuid !== input.source.uuid)
    return { status: "REFUSED", reason: "SOURCE_AUDIENCE_MISMATCH" };

  const capturedAt = input.now();
  const capture = await captureLiveAudience({
    experimentId: experiment.id,
    source: input.source,
    capturedAt,
    assignmentCutoff: capturedAt,
    transport: input.transport(),
  });
  if (capture.status === "INCOMPLETE") {
    return { status: "INCOMPLETE", reasons: capture.reasons, failedFanCount: capture.failedFanUuids.length };
  }
  await persistLiveAudienceSnapshot({
    repository,
    evidenceRepository,
    experimentId: experiment.id,
    source: input.source,
    capture,
    commandId: input.commandId,
  });
  return { status: "ALLOCATED", snapshotCount: capture.assignments.length, armCounts: capture.armCounts };
}
