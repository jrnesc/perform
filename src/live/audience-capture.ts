import {
  allocateAudience,
  allocationAlgorithmVersion,
  hashAudienceSnapshot,
  type Arm,
  type Assignment,
} from "../domain/allocation";
import { readAudienceSnapshot, type AudienceSource } from "../integrations/fanvue/audience-read";
import { readFanEnrichment } from "../integrations/fanvue/fan-enrichment";
import { LiveReadError, type FanvueReadTransport } from "../integrations/fanvue/live-read-contracts";
import { deriveSubscriberCohort, readSubscriptionHistories, type SubscriberCohort } from "../integrations/fanvue/subscription-history";
import { assignmentChunkLimit } from "../persistence/d1-perform-repository";
import type { PerformRepository } from "../persistence/contracts";
import {
  audienceEvidenceRowVersion,
  audienceEvidenceChunkLimit,
  type AudienceEvidenceRow,
  type LiveEvidenceRepository,
} from "../persistence/live-evidence";

export type IncompleteReason =
  | "SOURCE_NOT_ELIGIBLE"
  | "AUDIENCE_EMPTY"
  | "AUDIENCE_MALFORMED_MEMBERS"
  | "PURCHASE_ENRICHMENT_FAILED"
  | "SUBSCRIPTION_HISTORY_FAILED"
  | "STATE_CONFLICT"
  | "READ_ABORTED";

export type LiveAudienceCapture =
  | {
      status: "READY";
      assignments: readonly Assignment[];
      evidence: readonly AudienceEvidenceRow[];
      snapshotHash: string;
      armCounts: Readonly<Record<Arm, number>>;
      capturedAt: string;
    }
  | {
      status: "INCOMPLETE";
      reasons: readonly IncompleteReason[];
      /** Stable UUIDs only; enough to audit why an audience could not allocate. */
      failedFanUuids: readonly string[];
      abort?: { code: LiveReadError["code"]; retryAfterSeconds?: number };
    };

function incomplete(reasons: IncompleteReason[], failedFanUuids: string[] = []): LiveAudienceCapture {
  return { status: "INCOMPLETE", reasons: [...new Set(reasons)], failedFanUuids };
}

/**
 * Reads one complete audience and its pre-assignment evidence, in order: full smart-list walk,
 * purchase enrichment, subscriber state, then cross-checks. It never persists and never
 * returns a partial audience; any gap yields INCOMPLETE so nothing can allocate.
 */
export async function captureLiveAudience(input: {
  experimentId: string;
  source: AudienceSource;
  capturedAt: string;
  assignmentCutoff: string;
  transport: FanvueReadTransport;
}): Promise<LiveAudienceCapture> {
  if (input.source.kind !== "SMART") return incomplete(["SOURCE_NOT_ELIGIBLE"]);
  try {
    const audience = await readAudienceSnapshot({ source: input.source, transport: input.transport });
    if (audience.malformedMembers > 0) return incomplete(["AUDIENCE_MALFORMED_MEMBERS"]);
    if (audience.members.length === 0) return incomplete(["AUDIENCE_EMPTY"]);
    if (audience.members.some((member) => member.eligibility !== "ELIGIBLE")) {
      return incomplete(["SOURCE_NOT_ELIGIBLE"]);
    }
    const fanUuids = audience.members.map((member) => member.fanUuid);

    const purchases = await readFanEnrichment({
      fanUuids, capturedAt: input.capturedAt, assignmentCutoff: input.assignmentCutoff, transport: input.transport,
    });
    const histories = await readSubscriptionHistories({
      fanUuids, capturedAt: input.capturedAt, assignmentCutoff: input.assignmentCutoff, transport: input.transport,
    });

    const purchaseByFan = new Map(purchases.snapshots.map((row) => [row.fanUuid, row]));
    const historyByFan = new Map(histories.snapshots.map((row) => [row.fanUuid, row]));
    const cohortByFan = new Map<string, SubscriberCohort>();
    const reasons: IncompleteReason[] = [];
    const failed = new Set<string>();
    for (const fanUuid of fanUuids) {
      const purchase = purchaseByFan.get(fanUuid);
      const history = historyByFan.get(fanUuid);
      if (!purchase) { reasons.push("PURCHASE_ENRICHMENT_FAILED"); failed.add(fanUuid); }
      if (!history) { reasons.push("SUBSCRIPTION_HISTORY_FAILED"); failed.add(fanUuid); }
      if (purchase && history) {
        const cohort = deriveSubscriberCohort(history, purchase);
        if (cohort === "CONFLICT") { reasons.push("STATE_CONFLICT"); failed.add(fanUuid); }
        else cohortByFan.set(fanUuid, cohort);
      }
    }
    if (reasons.length > 0) return incomplete(reasons, [...failed]);

    const members = fanUuids.map((fanUuid) => ({ fanUuid, stratum: cohortByFan.get(fanUuid)! }));
    const assignments = allocateAudience(input.experimentId, members);
    const armCounts: Record<Arm, number> = { A: 0, B: 0 };
    for (const assignment of assignments) armCounts[assignment.arm] += 1;
    const armByFan = new Map(assignments.map((assignment) => [assignment.fanUuid, assignment.arm]));

    const evidence = fanUuids.map((fanUuid): AudienceEvidenceRow => {
      const purchase = purchaseByFan.get(fanUuid)!;
      const history = historyByFan.get(fanUuid)!;
      return {
        experimentId: input.experimentId, fanUuid, arm: armByFan.get(fanUuid)!,
        version: audienceEvidenceRowVersion, capturedAt: input.capturedAt,
        subscriberCohort: cohortByFan.get(fanUuid)!,
        earliestSubscriptionAt: history.earliestSubscriptionAt,
        validPeriodCount: history.validPeriodCount, hasTrial: history.hasTrial,
        resubscribedAfterLapse: history.resubscribedAfterLapse,
        autoRenewalEnabled: purchase.autoRenewalEnabled, renewsAt: purchase.renewsAt,
        priorSettledPurchaseCount: purchase.priorSettledPurchaseCount,
        priorSettledSpendMinor: purchase.priorSettledSpendMinor,
      };
    });
    return {
      status: "READY", assignments, evidence, armCounts, capturedAt: input.capturedAt,
      snapshotHash: await hashAudienceSnapshot(members),
    };
  } catch (error) {
    if (error instanceof LiveReadError) {
      return {
        status: "INCOMPLETE", reasons: ["READ_ABORTED"], failedFanUuids: [],
        abort: { code: error.code, retryAfterSeconds: error.retryAfterSeconds },
      };
    }
    throw error;
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/**
 * Persists a READY capture in the only safe order: assignment staging, immutable evidence,
 * a completeness check, then allocation finalisation. Finalisation is never reached with
 * partial evidence, and a demo or foreign-audience experiment is refused.
 */
export async function persistLiveAudienceSnapshot(input: {
  repository: PerformRepository;
  evidenceRepository: LiveEvidenceRepository;
  experimentId: string;
  source: AudienceSource;
  capture: Extract<LiveAudienceCapture, { status: "READY" }>;
  commandId: string;
}): Promise<void> {
  const experiment = await input.repository.getExperiment(input.experimentId);
  if (!experiment) throw new Error("Experiment was not found in this workspace");
  if (experiment.dataProvenance !== "REAL") throw new Error("Live audience evidence is only for REAL experiments");
  if (experiment.sourceAudienceUuid !== input.source.uuid) {
    throw new Error("The captured audience is not the experiment's declared source audience");
  }
  const { capture } = input;
  if (capture.evidence.length !== capture.assignments.length) {
    throw new Error("Live audience evidence is incomplete; allocation was not finalised");
  }

  for (const part of chunk(capture.assignments, assignmentChunkLimit)) {
    await input.repository.saveAssignmentChunk(input.experimentId, part, capture.capturedAt);
  }
  for (const part of chunk(capture.evidence, audienceEvidenceChunkLimit)) {
    await input.evidenceRepository.saveAudienceEvidence(input.experimentId, part);
  }
  const stored = await input.evidenceRepository.countAudienceEvidence(input.experimentId);
  if (stored !== capture.assignments.length) {
    throw new Error("Live audience evidence is incomplete; allocation was not finalised");
  }
  await input.repository.finalizeAllocation({
    commandId: input.commandId,
    experimentId: input.experimentId,
    snapshotHash: capture.snapshotHash,
    snapshotCount: capture.assignments.length,
    armCounts: capture.armCounts,
    algorithmVersion: allocationAlgorithmVersion,
    snapshotAt: capture.capturedAt,
  });
}
