import type { Arm } from "../domain/allocation";
import { projectResultPurchases } from "../live/commerce-projection";
import {
  audienceEvidenceRowVersion,
  type AudienceEvidenceRow,
  type CommerceEventRecord,
} from "../persistence/live-evidence";
import { memberEvidenceFromRow } from "./audience-evidence";
import type { AudienceMemberEvidence, DemoResultFixture, ResultAssignment, ResultPurchase } from "./contracts";

export const DEMO_RESULTS_FIXTURE_VERSION = "perform-demo-results-v1" as const;

function assignments(perArm: number): ResultAssignment[] {
  return (["A", "B"] as const).flatMap((arm) =>
    Array.from({ length: perArm }, (_, index) => ({
      fanUuid: `demo:result:${arm.toLowerCase()}:${String(index + 1).padStart(3, "0")}`,
      arm,
    })),
  );
}

function purchases(arm: Arm, amounts: readonly number[], reversed: readonly number[] = []): ResultPurchase[] {
  return amounts.map((grossMinor, index) => ({
    id: `demo:purchase:${arm.toLowerCase()}:${index + 1}`,
    fanUuid: `demo:result:${arm.toLowerCase()}:${String(index + 1).padStart(3, "0")}`,
    arm,
    grossMinor,
    refundedMinor: reversed.includes(index) ? grossMinor : 0,
    disputedMinor: 0,
    occurredAt: `2026-10-18T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
  }));
}

const completeWindow = {
  startedAt: "2026-10-17T09:00:00.000Z",
  endedAt: "2026-10-19T09:00:00.000Z",
  observedAt: "2026-10-19T10:00:00.000Z",
  evaluatedAt: "2026-10-20T09:00:00.000Z",
  isComplete: true,
};

/** Demo evidence events that match the fixture's state: no closed window while running, one send on a partial launch. */
function timeline(id: string, stage: "closed" | "running" | "partial" = "closed") {
  return [
    { id: `${id}:planned`, source: "DRY_RUN" as const, occurredAt: "2026-10-17T08:30:00.000Z", label: "Plan locked", detail: "Audience frozen and split into two arms. Nothing was sent yet." },
    stage === "partial"
      ? { id: `${id}:seeded`, source: "DEMO" as const, occurredAt: "2026-10-17T09:00:00.000Z", label: "Only one message confirmed", detail: "Arm B’s send did not confirm, so the launch stopped for operator review." }
      : { id: `${id}:seeded`, source: "DEMO" as const, occurredAt: "2026-10-17T09:00:00.000Z", label: "Both messages sent", detail: "Each arm received its own message at the same time." },
    ...(stage === "closed" ? [{ id: `${id}:observed`, source: "DEMO" as const, occurredAt: "2026-10-19T10:00:00.000Z", label: "Observation window closed", detail: "Purchases, refunds and disputes were counted through the window." }] : []),
  ];
}

const base = {
  fixtureVersion: DEMO_RESULTS_FIXTURE_VERSION,
  audienceScope: "Fictional active subscribers",
  sourceAudienceUuid: "demo:audience:active-subscribers",
  variants: [
    { arm: "A" as const, copy: "A new set is ready for you.", priceMinor: 1200, currency: "USD" as const, mediaUuid: "demo:media:afterglow" },
    { arm: "B" as const, copy: "See 12 new afterglow portraits from this week’s shoot.", priceMinor: 1200, currency: "USD" as const, mediaUuid: "demo:media:afterglow" },
  ],
  comparison: { armALabel: "Generic preview", armBLabel: "Specific preview", currency: "USD" as const },
};

const priceVariants = [
  { arm: "A" as const, copy: "A new set is ready for you.", priceMinor: 1200, currency: "USD" as const, mediaUuid: "demo:media:afterglow" },
  { arm: "B" as const, copy: "A new set is ready for you.", priceMinor: 1500, currency: "USD" as const, mediaUuid: "demo:media:afterglow" },
] as const;

const RAW_DEMO_RESULT_FIXTURES: readonly DemoResultFixture[] = [
  {
    ...base,
    id: "demo:result:copy-complete",
    experimentId: "demo:experiment:copy-complete",
    title: "Specific preview copy",
    variable: "COPY",
    state: "CLOSED",
    assignments: assignments(12),
    purchases: [...purchases("A", [1200, 1200]), ...purchases("B", [1200, 1200, 1200, 1200, 1200, 1200, 1200], [6])],
    observation: completeWindow,
    evidence: timeline("copy-complete"),
  },
  {
    ...base,
    id: "demo:result:price-complete",
    experimentId: "demo:analysis:price-complete",
    title: "Two PPV price points",
    variable: "PRICE",
    state: "CLOSED",
    assignments: assignments(12),
    purchases: [...purchases("A", [1200, 1200, 1200, 1200]), ...purchases("B", [1500, 1500, 1500, 1500, 1500, 1500])],
    observation: completeWindow,
    evidence: timeline("price-complete"),
    comparison: { armALabel: "$12 offer", armBLabel: "$15 offer", currency: "USD" },
    variants: priceVariants,
  },
  {
    ...base,
    id: "demo:result:low-volume",
    experimentId: "demo:analysis:low-volume",
    title: "Low-volume copy test",
    variable: "COPY",
    state: "CLOSED",
    assignments: assignments(4),
    purchases: [...purchases("A", [1200]), ...purchases("B", [1200, 1200])],
    observation: completeWindow,
    evidence: timeline("low-volume"),
  },
  {
    ...base,
    id: "demo:result:zero-purchases",
    experimentId: "demo:analysis:zero-purchases",
    title: "No purchases observed",
    variable: "COPY",
    state: "CLOSED",
    assignments: assignments(12),
    purchases: [],
    observation: completeWindow,
    evidence: timeline("zero-purchases"),
  },
  {
    ...base,
    id: "demo:result:stale",
    experimentId: "demo:analysis:stale",
    title: "Stale evidence",
    variable: "COPY",
    state: "CLOSED",
    assignments: assignments(12),
    purchases: [...purchases("A", [1200, 1200]), ...purchases("B", [1200, 1200, 1200, 1200, 1200])],
    observation: { ...completeWindow, observedAt: "2026-10-16T09:00:00.000Z" },
    evidence: timeline("stale"),
  },
  {
    ...base,
    id: "demo:result:incomplete",
    experimentId: "demo:experiment:price-running",
    title: "Two PPV price points",
    variable: "PRICE",
    sourceAudienceUuid: "demo:audience:recent-buyers",
    audienceScope: "Fictional recent buyers",
    variants: priceVariants,
    state: "RUNNING",
    assignments: assignments(12),
    purchases: [...purchases("A", [1200, 1200]), ...purchases("B", [1200, 1200, 1200, 1200])],
    observation: { ...completeWindow, isComplete: false },
    evidence: timeline("incomplete", "running"),
    comparison: { armALabel: "$12 offer", armBLabel: "$15 offer", currency: "USD" },
  },
  {
    ...base,
    id: "demo:result:partial-launch",
    experimentId: "demo:experiment:partial",
    title: "Weekend price check",
    variable: "PRICE",
    sourceAudienceUuid: "demo:audience:recent-buyers",
    audienceScope: "Fictional recent buyers",
    variants: priceVariants,
    state: "PARTIAL_LAUNCH",
    assignments: assignments(12),
    purchases: purchases("A", [1200, 1200]),
    observation: { ...completeWindow, isComplete: false },
    evidence: timeline("partial-launch", "partial"),
    comparison: { armALabel: "$12 offer", armBLabel: "$15 offer", currency: "USD" },
  },
  {
    ...base,
    id: "demo:result:invalid",
    experimentId: "demo:experiment:invalid",
    title: "Archive bundle copy",
    variable: "COPY",
    state: "INVALID",
    invalidReason: "The frozen audience no longer matched the launched recipients.",
    assignments: assignments(12),
    purchases: [...purchases("A", [1200, 1200]), ...purchases("B", [1200, 1200, 1200, 1200])],
    observation: completeWindow,
    evidence: timeline("invalid"),
  },
];

const dashboardExperimentIds = new Set([
  "demo:experiment:copy-complete",
  "demo:experiment:price-running",
  "demo:experiment:partial",
  "demo:experiment:invalid",
]);

/**
 * Seeded audiences mirror a live capture of the `subscribers` smart list (ADR 0009), so every
 * member is a current subscriber: active renewing, active not renewing or trialing. Never
 * subscribed and lapsed fans cannot appear in that list and are deliberately absent here too.
 */
const seededRelationshipPattern = [
  "active_renewing", "active_renewing", "active_not_renewing", "active_renewing",
  "trialing", "active_renewing", "active_not_renewing", "active_renewing",
] as const;
const day = 86_400_000;

function enrichAudience(fixture: DemoResultFixture): DemoResultFixture {
  const creatorUuid = "demo:creator:perform";
  const commerceEvents = fixture.purchases.flatMap((purchase): CommerceEventRecord[] => {
    const payment: CommerceEventRecord = {
      source: "SEEDED_FIXTURE",
      kind: "PAYMENT",
      eventId: `seed:event:${purchase.id}`,
      creatorUuid,
      paymentId: purchase.id,
      purchaserUuid: purchase.fanUuid,
      messageUuid: `demo:message:${purchase.arm.toLowerCase()}`,
      messageType: "BROADCAST",
      attributionStrategy: "ASSIGNMENT_WINDOW",
      messageMatched: true,
      experimentId: fixture.experimentId,
      arm: purchase.arm,
      grossMinor: purchase.grossMinor,
      netMinor: null,
      currency: "USD",
      occurredAt: purchase.occurredAt,
      payloadHash: `seed:payment:${purchase.id}`,
      receivedAt: purchase.occurredAt,
    };
    const reversalType = purchase.refundedMinor > 0 ? "REFUND" as const
      : purchase.disputedMinor > 0 ? "DISPUTE" as const : null;
    if (!reversalType) return [payment];
    const reversal: CommerceEventRecord = {
      source: "SEEDED_FIXTURE",
      kind: "REVERSAL",
      eventId: `seed:event:${purchase.id}:${reversalType.toLowerCase()}`,
      creatorUuid,
      paymentId: purchase.id,
      reversalId: `seed:reversal:${purchase.id}`,
      reversalType,
      amountMinor: reversalType === "REFUND" ? purchase.refundedMinor : purchase.disputedMinor,
      currency: "USD",
      occurredAt: fixture.observation.observedAt,
      payloadHash: `seed:reversal:${purchase.id}`,
      receivedAt: fixture.observation.observedAt,
    };
    return [payment, reversal];
  });
  const projectedPurchases = projectResultPurchases({
    experimentId: fixture.experimentId,
    events: commerceEvents,
    assignments: Object.fromEntries(fixture.assignments.map((row) => [row.fanUuid, row.arm])),
  });
  const withCommerce = { ...fixture, commerceEvents, purchases: projectedPurchases };
  if (!dashboardExperimentIds.has(fixture.experimentId)) return withCommerce;
  const capturedAt = fixture.observation.startedAt;
  const frozenAudience = fixture.assignments.map((assignment, index): AudienceEvidenceRow => {
    const priorSettledPurchaseCount = index % 2 === 0 ? 0 : index % 4 === 1 ? 1 : 3;
    const subscriberCohort = seededRelationshipPattern[index % seededRelationshipPattern.length];
    const months = subscriberCohort === "trialing" ? 0 : 1 + (index % 14);
    return {
      experimentId: fixture.experimentId,
      fanUuid: assignment.fanUuid,
      arm: assignment.arm,
      version: audienceEvidenceRowVersion,
      capturedAt,
      subscriberCohort,
      earliestSubscriptionAt: new Date(Date.parse(capturedAt) - (months === 0 ? 5 : months * 30) * day).toISOString(),
      validPeriodCount: Math.max(1, months),
      hasTrial: subscriberCohort === "trialing" || index % 5 === 0,
      resubscribedAfterLapse: subscriberCohort === "active_renewing" && index % 6 === 3,
      autoRenewalEnabled: subscriberCohort !== "active_not_renewing",
      renewsAt: new Date(Date.parse(capturedAt) + (1 + (index % 28)) * day).toISOString(),
      priorSettledPurchaseCount,
      priorSettledSpendMinor: priorSettledPurchaseCount * 1200,
    };
  });
  const audienceEvidence = frozenAudience.map((row): AudienceMemberEvidence => {
    const attributed = projectedPurchases.filter((purchase) => purchase.fanUuid === row.fanUuid);
    const settled = attributed.filter((purchase) => purchase.grossMinor - purchase.refundedMinor - purchase.disputedMinor > 0);
    return memberEvidenceFromRow(row, "DEMO", {
      converted: settled.length > 0,
      grossPurchaseCount: attributed.length,
      settledPurchaseCount: settled.length,
      grossRevenueMinor: attributed.reduce((total, purchase) => total + purchase.grossMinor, 0),
      settledRevenueMinor: settled.reduce((total, purchase) => total + purchase.grossMinor - purchase.refundedMinor - purchase.disputedMinor, 0),
      fullyRefunded: attributed.some((purchase) => purchase.refundedMinor === purchase.grossMinor),
      disputed: attributed.some((purchase) => purchase.disputedMinor > 0),
      lastOutcomeAt: attributed.at(-1)?.occurredAt,
    });
  });
  return { ...withCommerce, frozenAudience, audienceEvidence };
}

export const DEMO_RESULT_FIXTURES: readonly DemoResultFixture[] = RAW_DEMO_RESULT_FIXTURES.map(enrichAudience);
