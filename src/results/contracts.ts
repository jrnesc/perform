import type { Arm } from "../domain/allocation";
import type { ExperimentState, ExperimentVariable, VariantDefinition } from "../domain/experiment-state";
import type { SubscriberCohort } from "../integrations/fanvue/subscription-history";
import type { DataProvenance, MetricSource } from "../persistence/contracts";
import type { AudienceEvidenceRow } from "../persistence/live-evidence";
import type { CommerceEventRecord } from "../persistence/live-evidence";

export type ResultAssignment = { fanUuid: string; arm: Arm };

export type ResultPurchase = {
  id: string;
  fanUuid: string;
  arm: Arm;
  grossMinor: number;
  refundedMinor: number;
  disputedMinor: number;
  occurredAt: string;
};

export type PriorPurchaserStatus = "NEVER_PURCHASED" | "PRIOR_PURCHASER";

/**
 * The subscriber relationship frozen before assignment (ADR 0014). Seeded and live evidence use
 * the same five cohorts, so the demo shows what a live result would; provenance says which it is.
 */
export type SubscriberRelationship = SubscriberCohort;

/** Versioned, privacy-minimal fan evidence frozen for one experiment. */
export type AudienceMemberEvidence = {
  version: "perform-audience-evidence-v2";
  /** DEMO rows are seeded fixtures; REAL rows come from a live capture. Never mixed. */
  provenance: DataProvenance;
  experimentId: string;
  fanUuid: string;
  arm: Arm;
  assignedAt: string;
  priorPurchaserStatus: PriorPurchaserStatus;
  priorSettledPurchaseCount: number;
  priorSettledSpendMinor: number;
  subscriberRelationship: SubscriberRelationship;
  /** A paid subscription that followed a lapse; a flag, not a cohort. */
  resubscribedAfterLapse: boolean;
  hasTrial: boolean;
  /** Earliest valid paid period start; null for a fan who never subscribed. */
  earliestSubscriptionAt: string | null;
  converted: boolean;
  grossPurchaseCount: number;
  settledPurchaseCount: number;
  grossRevenueMinor: number;
  settledRevenueMinor: number;
  fullyRefunded: boolean;
  disputed: boolean;
  lastOutcomeAt?: string;
};

export type EvidenceEvent = {
  id: string;
  source: MetricSource;
  occurredAt: string;
  label: string;
  detail: string;
};

export type DemoResultFixture = {
  id: string;
  experimentId: string;
  fixtureVersion: "perform-demo-results-v1";
  title: string;
  audienceScope: string;
  sourceAudienceUuid: string;
  variable: ExperimentVariable;
  state: ExperimentState;
  variants: readonly VariantDefinition[];
  invalidReason?: string;
  assignments: readonly ResultAssignment[];
  purchases: readonly ResultPurchase[];
  /** Seeded outcomes replay the same stored event shape and projection as live Results. */
  commerceEvents?: readonly CommerceEventRecord[];
  /** Rows exactly as `audience_member_evidence` stores them, for seeded and live alike. */
  frozenAudience?: readonly AudienceEvidenceRow[];
  audienceEvidence?: readonly AudienceMemberEvidence[];
  observation: {
    startedAt: string;
    endedAt: string;
    observedAt: string;
    evaluatedAt: string;
    isComplete: boolean;
  };
  evidence: readonly EvidenceEvent[];
  comparison: {
    armALabel: string;
    armBLabel: string;
    currency: "USD";
  };
};

export type ExperimentResultSummary = {
  experimentId: string;
  status: InterpretationStatus;
  observedDirection: ObservedDirection;
  observedAt: string;
  isComplete: boolean;
};

export type InterpretationStatus =
  | "LEARNING_READY"
  | "LOW_VOLUME"
  | "ZERO_PURCHASES"
  | "STALE"
  | "INCOMPLETE"
  | "PARTIAL_LAUNCH"
  | "INVALID";

export type ArmResult = {
  arm: Arm;
  assignedRecipients: number;
  grossPurchases: number;
  settledPurchases: number;
  reversedPurchases: number;
  grossRevenueMinor: number;
  settledRevenueMinor: number;
  primaryRate: number;
};

export type UncertaintyEstimate = {
  method: "BETA_BINOMIAL" | "RECIPIENT_BOOTSTRAP";
  seed: string;
  draws: number;
  probabilityArmBBetter: number;
  armAInterval: readonly [number, number];
  armBInterval: readonly [number, number];
  differenceInterval: readonly [number, number];
};

export type ObservedDirection = {
  outcome: "A_LED" | "B_LED" | "TIED";
  metric: "SETTLED_PURCHASES_PER_ASSIGNED_RECIPIENT" | "SETTLED_REVENUE_PER_ASSIGNED_RECIPIENT";
  armAValue: number;
  armBValue: number;
  differenceArmBMinusArmA: number;
  relativeEffect: number | null;
  statement: string;
};

export type ConfidenceAssessment = {
  status: "DEPENDABLE" | "NOT_YET_DEPENDABLE" | "EVIDENCE_GATED";
  label: string;
  statement: string;
  nextStep: string | null;
  supportsLearning: boolean;
};

export type AudienceLearning = {
  id: string;
  experimentId: string;
  audienceScope: string;
  variable: ExperimentVariable;
  statement: string;
  createdAt: string;
  provenance: "DEMO";
};

export type AnalysedResult = {
  fixture: DemoResultFixture;
  status: InterpretationStatus;
  observedDirection: ObservedDirection;
  confidence: ConfidenceAssessment;
  warnings: readonly string[];
  arms: Readonly<Record<Arm, ArmResult>>;
  estimate?: UncertaintyEstimate;
  learning?: AudienceLearning;
};
