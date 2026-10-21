import type { Arm } from "../domain/allocation";
import { estimateCopyResult, estimatePriceResult } from "./inference";
import { assertAudienceEvidence } from "./audience-evidence";
import type {
  AnalysedResult,
  ArmResult,
  AudienceLearning,
  ConfidenceAssessment,
  DemoResultFixture,
  InterpretationStatus,
  ObservedDirection,
  UncertaintyEstimate,
} from "./contracts";

const minimumAssignedPerArm = 10;
const minimumSettledPurchases = 4;
const maximumFreshnessHours = 24;

function armResult(fixture: DemoResultFixture, arm: Arm): ArmResult {
  const assigned = fixture.assignments.filter((item) => item.arm === arm);
  const purchases = fixture.purchases.filter((item) => item.arm === arm);
  const settled = purchases.filter((item) => item.grossMinor - item.refundedMinor - item.disputedMinor > 0);
  const revenue = settled.reduce((sum, item) => sum + item.grossMinor - item.refundedMinor - item.disputedMinor, 0);
  return {
    arm,
    assignedRecipients: assigned.length,
    grossPurchases: purchases.length,
    settledPurchases: settled.length,
    reversedPurchases: purchases.length - settled.length,
    grossRevenueMinor: purchases.reduce((sum, item) => sum + item.grossMinor, 0),
    settledRevenueMinor: revenue,
    primaryRate: fixture.variable === "COPY" ? settled.length / assigned.length : revenue / assigned.length,
  };
}

function hasIntegrityFailure(fixture: DemoResultFixture): boolean {
  const assignmentKeys = fixture.assignments.map((item) => item.fanUuid);
  if (new Set(assignmentKeys).size !== assignmentKeys.length) return true;
  const assignmentByFan = new Map(fixture.assignments.map((item) => [item.fanUuid, item.arm]));
  const purchaseIds = fixture.purchases.map((item) => item.id);
  if (new Set(purchaseIds).size !== purchaseIds.length) return true;
  return fixture.purchases.some((purchase) =>
    assignmentByFan.get(purchase.fanUuid) !== purchase.arm ||
    purchase.grossMinor < 0 ||
    purchase.refundedMinor < 0 ||
    purchase.disputedMinor < 0 ||
    purchase.refundedMinor + purchase.disputedMinor > purchase.grossMinor,
  );
}

function gate(fixture: DemoResultFixture, arms: Readonly<Record<Arm, ArmResult>>, audienceIntegrityFailure: boolean): InterpretationStatus {
  if (fixture.state === "INVALID" || hasIntegrityFailure(fixture) || audienceIntegrityFailure) return "INVALID";
  if (fixture.state === "PARTIAL_LAUNCH" || fixture.state === "OPERATOR_REVIEW") return "PARTIAL_LAUNCH";
  if (fixture.state !== "CLOSED" || !fixture.observation.isComplete) return "INCOMPLETE";
  const ageHours = (Date.parse(fixture.observation.evaluatedAt) - Date.parse(fixture.observation.observedAt)) / 3_600_000;
  if (ageHours > maximumFreshnessHours) return "STALE";
  if (arms.A.assignedRecipients < minimumAssignedPerArm || arms.B.assignedRecipients < minimumAssignedPerArm) return "LOW_VOLUME";
  if (arms.A.settledPurchases + arms.B.settledPurchases === 0) return "ZERO_PURCHASES";
  if (arms.A.settledPurchases + arms.B.settledPurchases < minimumSettledPurchases) return "LOW_VOLUME";
  return "LEARNING_READY";
}

const gatedConfidence: Record<Exclude<InterpretationStatus, "LEARNING_READY">, Omit<ConfidenceAssessment, "status" | "supportsLearning">> = {
  LOW_VOLUME: { label: "Too little evidence to generalise", statement: "The observed result is real for this test, but the sample is too small for a dependable general conclusion.", nextStep: "Extend the observation window or repeat the test with more assigned recipients." },
  ZERO_PURCHASES: { label: "No response signal yet", statement: "Neither arm recorded a settled purchase, so there is no commercial difference to generalise from.", nextStep: "Extend or repeat the test until settled purchases provide a response signal." },
  STALE: { label: "Evidence must be refreshed", statement: "The observed result is older than the 24-hour freshness limit and cannot support a saved learning.", nextStep: "Reconcile the latest evidence, then analyse the test again." },
  INCOMPLETE: { label: "Evidence is still incomplete", statement: "The observation window or metric evidence is incomplete, so the result cannot yet support a general conclusion.", nextStep: "Finish the observation window and reconciliation before analysing again." },
  PARTIAL_LAUNCH: { label: "Comparison is not dependable", statement: "Only one arm launched cleanly. Raw outcomes remain visible, but they cannot support a fair general comparison.", nextStep: "Resolve the launch failure and repeat the test with both arms." },
  INVALID: { label: "Comparison is invalid", statement: "An integrity failure prevents a general conclusion. Raw evidence remains visible for audit only.", nextStep: "Correct the integrity issue and run a new controlled test." },
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

function observedDirection(fixture: DemoResultFixture, arms: Readonly<Record<Arm, ArmResult>>): ObservedDirection {
  const armAValue = arms.A.primaryRate;
  const armBValue = arms.B.primaryRate;
  const differenceArmBMinusArmA = armBValue - armAValue;
  const outcome = differenceArmBMinusArmA > 0 ? "B_LED" : differenceArmBMinusArmA < 0 ? "A_LED" : "TIED";
  const lowerValue = Math.min(armAValue, armBValue);
  const relativeEffect = outcome === "TIED" || lowerValue === 0
    ? null
    : Math.abs(differenceArmBMinusArmA) / lowerValue;
  const metric = fixture.variable === "COPY"
    ? "SETTLED_PURCHASES_PER_ASSIGNED_RECIPIENT"
    : "SETTLED_REVENUE_PER_ASSIGNED_RECIPIENT";
  const format = fixture.variable === "COPY" ? percent : money;
  const metricName = fixture.variable === "COPY"
    ? "settled purchases per assigned recipient"
    : "settled revenue per assigned recipient";
  const statement = outcome === "TIED"
    ? `Arms A and B produced the same ${metricName} in this test (${format(armAValue)}).`
    : `Arm ${outcome === "B_LED" ? "B" : "A"} produced ${format(Math.abs(differenceArmBMinusArmA))} more ${metricName} in this test (Arm A ${format(armAValue)} vs Arm B ${format(armBValue)}${relativeEffect === null ? "" : `; ${percent(relativeEffect)} higher`}).`;
  return { outcome, metric, armAValue, armBValue, differenceArmBMinusArmA, relativeEffect, statement };
}

function estimateConfidence(estimate: UncertaintyEstimate, direction: ObservedDirection): ConfidenceAssessment {
  const dependableArm = estimate.probabilityArmBBetter >= 0.9
    ? "B"
    : estimate.probabilityArmBBetter <= 0.1
      ? "A"
      : null;
  const supportsLearning = dependableArm !== null && direction.outcome === `${dependableArm}_LED`;
  if (!supportsLearning) {
    return {
      status: "NOT_YET_DEPENDABLE",
      label: "Not yet dependable beyond this test",
      statement: "The uncertainty still includes plausible outcomes in both directions, so this observed lead is not yet a dependable general result.",
      nextStep: "Extend the observation window or repeat the test before saving an audience learning.",
      supportsLearning: false,
    };
  }
  const probability = dependableArm === "B" ? estimate.probabilityArmBBetter : 1 - estimate.probabilityArmBBetter;
  return {
    status: "DEPENDABLE",
    label: "Evidence supports a dependable direction",
    statement: `Arm ${dependableArm} was better in ${Math.round(probability * 100)}% of fixed-seed estimates. This supports a scoped audience learning, not a guarantee.`,
    nextStep: null,
    supportsLearning: true,
  };
}

function recipientRevenues(fixture: DemoResultFixture, arm: Arm): number[] {
  const byFan = new Map<string, number>();
  for (const purchase of fixture.purchases.filter((item) => item.arm === arm)) {
    byFan.set(purchase.fanUuid, purchase.grossMinor - purchase.refundedMinor - purchase.disputedMinor);
  }
  return fixture.assignments.filter((item) => item.arm === arm).map((item) => byFan.get(item.fanUuid) ?? 0);
}

export function analyseResult(fixture: DemoResultFixture): AnalysedResult {
  let audienceIntegrityFailure = false;
  try { assertAudienceEvidence(fixture); } catch { audienceIntegrityFailure = true; }
  const arms = { A: armResult(fixture, "A"), B: armResult(fixture, "B") } as const;
  const status = gate(fixture, arms, audienceIntegrityFailure);
  const direction = observedDirection(fixture, arms);
  const warnings = arms.A.reversedPurchases + arms.B.reversedPurchases > 0
    ? ["Full refunds and disputes are removed from settled outcomes."]
    : [];
  if (status !== "LEARNING_READY") {
    const detail = gatedConfidence[status];
    const confidence: ConfidenceAssessment = { status: "EVIDENCE_GATED", ...detail, supportsLearning: false };
    return { fixture, status, observedDirection: direction, confidence, warnings, arms };
  }
  const estimate = fixture.variable === "COPY"
    ? estimateCopyResult({ assignedA: arms.A.assignedRecipients, purchasesA: arms.A.settledPurchases, assignedB: arms.B.assignedRecipients, purchasesB: arms.B.settledPurchases }, `${fixture.id}:beta-v1`)
    : estimatePriceResult(recipientRevenues(fixture, "A"), recipientRevenues(fixture, "B"), `${fixture.id}:bootstrap-v1`);
  const confidence = estimateConfidence(estimate, direction);
  const learning: AudienceLearning | undefined = confidence.supportsLearning ? {
      id: `learning:${fixture.id}`,
      experimentId: fixture.experimentId,
      audienceScope: fixture.audienceScope,
      variable: fixture.variable,
      statement: `For ${fixture.audienceScope.toLowerCase()}, ${direction.statement.replace(" in this test", "")}`,
      createdAt: fixture.observation.evaluatedAt,
      provenance: "DEMO",
    } : undefined;
  return {
    fixture,
    status,
    observedDirection: direction,
    confidence,
    warnings,
    arms,
    estimate,
    learning,
  };
}
