import { describe, expect, it } from "vitest";
import { analyseResult } from "./analyse";
import { assertAudienceEvidence, audienceSegments } from "./audience-evidence";
import { DEMO_RESULT_FIXTURES } from "./demo-results-v1";

describe("Phase 8C audience evidence", () => {
  const dashboardIds = new Set([
    "demo:experiment:copy-complete",
    "demo:experiment:price-running",
    "demo:experiment:partial",
    "demo:experiment:invalid",
  ]);

  it("enriches only the four coherent dashboard fixtures", () => {
    expect(DEMO_RESULT_FIXTURES.filter((fixture) => fixture.audienceEvidence).map((fixture) => fixture.experimentId)).toEqual(
      DEMO_RESULT_FIXTURES.filter((fixture) => dashboardIds.has(fixture.experimentId)).map((fixture) => fixture.experimentId),
    );
  });

  it.each(DEMO_RESULT_FIXTURES.filter((fixture) => dashboardIds.has(fixture.experimentId))) (
    "reconciles member and segment evidence for $experimentId",
    (fixture) => {
      expect(() => assertAudienceEvidence(fixture)).not.toThrow();
      const result = analyseResult(fixture);
      const evidence = fixture.audienceEvidence!;
      for (const arm of ["A", "B"] as const) {
        const rows = evidence.filter((row) => row.arm === arm);
        expect(rows).toHaveLength(result.arms[arm].assignedRecipients);
        expect(rows.reduce((total, row) => total + row.settledPurchaseCount, 0)).toBe(result.arms[arm].settledPurchases);
        expect(rows.reduce((total, row) => total + row.settledRevenueMinor, 0)).toBe(result.arms[arm].settledRevenueMinor);
      }
      for (const dimension of ["PRIOR_PURCHASER", "RELATIONSHIP"] as const) {
        const segments = audienceSegments(evidence, dimension);
        expect(segments.reduce((total, segment) => total + segment.members.length, 0)).toBe(evidence.length);
      }
    },
  );

  it("fails evidence whose frozen status disagrees with its pre-experiment count", () => {
    const fixture = DEMO_RESULT_FIXTURES[0];
    const first = fixture.audienceEvidence![0];
    expect(() => assertAudienceEvidence({
      ...fixture,
      audienceEvidence: [{ ...first, priorPurchaserStatus: "PRIOR_PURCHASER" }, ...fixture.audienceEvidence!.slice(1)],
    })).toThrow(/derived from pre-experiment/);
  });

  it("fails an outcome timestamp that precedes the frozen assignment", () => {
    const fixture = DEMO_RESULT_FIXTURES[0];
    expect(() => assertAudienceEvidence({
      ...fixture,
      purchases: [{ ...fixture.purchases[0], occurredAt: "2026-10-16T10:00:00.000Z" }, ...fixture.purchases.slice(1)],
    })).toThrow(/follow assignment/);
  });
});
