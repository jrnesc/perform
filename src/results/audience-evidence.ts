import type { Arm } from "../domain/allocation";
import type { DataProvenance } from "../persistence/contracts";
import type { AudienceEvidenceRow } from "../persistence/live-evidence";
import type {
  AudienceMemberEvidence,
  DemoResultFixture,
  PriorPurchaserStatus,
  SubscriberRelationship,
} from "./contracts";

export const AUDIENCE_EVIDENCE_VERSION = "perform-audience-evidence-v2" as const;
export const minimumDescriptiveSegmentSize = 5;

export type AudienceBreakdownDimension = "PRIOR_PURCHASER" | "RELATIONSHIP";

export const subscriberRelationships: readonly SubscriberRelationship[] = [
  "never_subscribed", "trialing", "active_renewing", "active_not_renewing", "lapsed",
];

export type AudienceSegment = {
  key: PriorPurchaserStatus | SubscriberRelationship;
  label: string;
  members: readonly AudienceMemberEvidence[];
  arms: Readonly<Record<Arm, {
    assigned: number;
    converted: number;
    settledPurchases: number;
    settledRevenueMinor: number;
    reversedPurchases: number;
  }>>;
  isSmall: boolean;
};

const labels: Record<AudienceSegment["key"], string> = {
  NEVER_PURCHASED: "Never purchased before",
  PRIOR_PURCHASER: "Prior purchaser",
  never_subscribed: "Never subscribed",
  trialing: "Trialing",
  active_renewing: "Active · renewing",
  active_not_renewing: "Active · not renewing",
  lapsed: "Lapsed",
};

export function relationshipLabel(key: SubscriberRelationship): string {
  return labels[key];
}

/** Evidence written before the five live cohorts (v1 bands) is not shown as if it were current. */
export function isCurrentAudienceEvidence(evidence: readonly AudienceMemberEvidence[]): boolean {
  return evidence.length > 0 && evidence.every((row) => row.version === AUDIENCE_EVIDENCE_VERSION) &&
    new Set(evidence.map((row) => row.provenance)).size === 1;
}

export function assertAudienceEvidence(fixture: DemoResultFixture): void {
  if (!fixture.audienceEvidence) return;
  const assignments = new Map(fixture.assignments.map((row) => [row.fanUuid, row.arm]));
  const evidenceIds = fixture.audienceEvidence.map((row) => row.fanUuid);
  if (evidenceIds.length !== assignments.size || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error("Audience evidence must contain exactly one row per assignment");
  }
  for (const row of fixture.audienceEvidence) {
    if (row.version !== AUDIENCE_EVIDENCE_VERSION || row.provenance !== "DEMO") {
      throw new Error("Seeded results may only carry current, DEMO-provenance audience evidence");
    }
    if (row.experimentId !== fixture.experimentId || assignments.get(row.fanUuid) !== row.arm) {
      throw new Error("Audience evidence must belong to a frozen assignment in the selected experiment");
    }
    if (Date.parse(row.assignedAt) !== Date.parse(fixture.observation.startedAt)) {
      throw new Error("Audience evidence assignment time must match the frozen experiment start");
    }
    if (row.priorSettledPurchaseCount < 0 || row.priorSettledSpendMinor < 0 || row.settledRevenueMinor < 0) {
      throw new Error("Audience evidence counts and settled value cannot be negative");
    }
    if ((row.priorSettledPurchaseCount > 0) !== (row.priorPurchaserStatus === "PRIOR_PURCHASER")) {
      throw new Error("Prior-purchaser status must be derived from pre-experiment settled purchases");
    }
    if ((row.subscriberRelationship === "never_subscribed") !== (row.earliestSubscriptionAt === null)) {
      throw new Error("Only a fan who never subscribed may lack a subscription start");
    }
  }
  for (const purchase of fixture.purchases) {
    const row = fixture.audienceEvidence.find((item) => item.fanUuid === purchase.fanUuid);
    if (!row || row.arm !== purchase.arm || Date.parse(purchase.occurredAt) < Date.parse(row.assignedAt)) {
      throw new Error("Attributed outcomes must follow assignment and belong to its arm");
    }
  }
  for (const arm of ["A", "B"] as const) {
    const rows = fixture.audienceEvidence.filter((row) => row.arm === arm);
    const purchases = fixture.purchases.filter((row) => row.arm === arm);
    const settled = purchases.filter((row) => row.grossMinor - row.refundedMinor - row.disputedMinor > 0);
    const sum = (field: "grossRevenueMinor" | "settledRevenueMinor") => rows.reduce((total, row) => total + row[field], 0);
    if (rows.length !== fixture.assignments.filter((row) => row.arm === arm).length ||
        rows.reduce((total, row) => total + row.grossPurchaseCount, 0) !== purchases.length ||
        rows.reduce((total, row) => total + row.settledPurchaseCount, 0) !== settled.length ||
        sum("grossRevenueMinor") !== purchases.reduce((total, row) => total + row.grossMinor, 0) ||
        sum("settledRevenueMinor") !== settled.reduce((total, row) => total + row.grossMinor - row.refundedMinor - row.disputedMinor, 0)) {
      throw new Error("Audience evidence does not reconcile to aggregate arm totals");
    }
  }
}

export function audienceSegments(
  evidence: readonly AudienceMemberEvidence[],
  dimension: AudienceBreakdownDimension,
): readonly AudienceSegment[] {
  if (new Set(evidence.map((row) => row.provenance)).size > 1) {
    throw new Error("Seeded and live audience evidence cannot be combined in one breakdown");
  }
  const keys: readonly AudienceSegment["key"][] = dimension === "PRIOR_PURCHASER"
    ? ["NEVER_PURCHASED", "PRIOR_PURCHASER"]
    : subscriberRelationships;
  return keys.map((key) => {
    const members = evidence.filter((row) => dimension === "PRIOR_PURCHASER"
      ? row.priorPurchaserStatus === key
      : row.subscriberRelationship === key);
    const armSummary = (arm: Arm) => {
      const rows = members.filter((row) => row.arm === arm);
      return {
        assigned: rows.length,
        converted: rows.filter((row) => row.converted).length,
        settledPurchases: rows.reduce((total, row) => total + row.settledPurchaseCount, 0),
        settledRevenueMinor: rows.reduce((total, row) => total + row.settledRevenueMinor, 0),
        reversedPurchases: rows.reduce((total, row) => total + row.grossPurchaseCount - row.settledPurchaseCount, 0),
      };
    };
    return { key, label: labels[key], members, arms: { A: armSummary("A"), B: armSummary("B") }, isSmall: members.length < minimumDescriptiveSegmentSize };
  });
}

export type MemberOutcomes = Pick<AudienceMemberEvidence,
  "converted" | "grossPurchaseCount" | "settledPurchaseCount" | "grossRevenueMinor" |
  "settledRevenueMinor" | "fullyRefunded" | "disputed" | "lastOutcomeAt">;

/**
 * The single mapping from a stored `audience_member_evidence` row to what Results shows. Seeded
 * and live members both pass through it, so they cannot drift apart.
 */
export function memberEvidenceFromRow(
  row: AudienceEvidenceRow,
  provenance: DataProvenance,
  outcomes: MemberOutcomes,
): AudienceMemberEvidence {
  return {
    version: AUDIENCE_EVIDENCE_VERSION,
    provenance,
    experimentId: row.experimentId,
    fanUuid: row.fanUuid,
    arm: row.arm,
    assignedAt: row.capturedAt,
    priorPurchaserStatus: row.priorSettledPurchaseCount > 0 ? "PRIOR_PURCHASER" : "NEVER_PURCHASED",
    priorSettledPurchaseCount: row.priorSettledPurchaseCount,
    priorSettledSpendMinor: row.priorSettledSpendMinor,
    subscriberRelationship: row.subscriberCohort,
    resubscribedAfterLapse: row.resubscribedAfterLapse,
    hasTrial: row.hasTrial,
    earliestSubscriptionAt: row.earliestSubscriptionAt,
    ...outcomes,
  };
}
