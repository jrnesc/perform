import { describe, expect, it } from "vitest";
import { analyseResult } from "./analyse";
import { DEMO_RESULT_FIXTURES } from "./demo-results-v1";
import { estimateCopyResult, estimatePriceResult } from "./inference";
import type { DemoResultFixture } from "./contracts";

function swapObservedArms(fixture: DemoResultFixture): DemoResultFixture {
  return {
    ...fixture,
    id: `${fixture.id}:a-leading`,
    audienceEvidence: undefined,
    purchases: fixture.purchases.map((purchase) => ({
      ...purchase,
      id: `${purchase.id}:swapped`,
      arm: purchase.arm === "A" ? "B" : "A",
      fanUuid: purchase.fanUuid.replace(purchase.arm === "A" ? ":a:" : ":b:", purchase.arm === "A" ? ":b:" : ":a:"),
    })),
  };
}

describe("Phase 4 inference", () => {
  it("makes the beta-binomial estimate deterministic for fixed evidence and seed", () => {
    const input = { assignedA: 50, purchasesA: 8, assignedB: 50, purchasesB: 16 };
    expect(estimateCopyResult(input, "fixed")).toEqual(estimateCopyResult(input, "fixed"));
    expect(estimateCopyResult(input, "fixed").probabilityArmBBetter).toBeGreaterThan(0.9);
  });

  it("bootstraps revenue per assigned recipient, including zero-revenue recipients", () => {
    const a = [1200, 1200, 0, 0, 0, 0];
    const b = [1500, 1500, 1500, 0, 0, 0];
    const result = estimatePriceResult(a, b, "fixed");
    expect(result).toEqual(estimatePriceResult(a, b, "fixed"));
    expect(result.method).toBe("RECIPIENT_BOOTSTRAP");
  });
});

describe("Phase 4 interpretation gates", () => {
  const byId = (suffix: string) => analyseResult(DEMO_RESULT_FIXTURES.find(({ id }) => id.endsWith(suffix))!);

  it("uses assigned-recipient denominators and removes full reversals", () => {
    const result = byId("copy-complete");
    expect(result.arms.B.assignedRecipients).toBe(120);
    expect(result.arms.B.grossPurchases).toBe(31);
    expect(result.arms.B.settledPurchases).toBe(30);
    expect(result.status).toBe("LEARNING_READY");
    expect(result.observedDirection.outcome).toBe("B_LED");
    expect(result.observedDirection.statement).toContain("Arm B produced");
    expect(result.confidence.status).toBe("DEPENDABLE");
    expect(result.learning?.statement).not.toMatch(/fan-|individual|personal/i);
  });

  it("reports the seeded price result as no dependable difference despite a small observed B lead", () => {
    const result = byId("price-complete");
    expect(result.status).toBe("LEARNING_READY");
    expect(result.observedDirection).toMatchObject({
      outcome: "B_LED",
      metric: "SETTLED_REVENUE_PER_ASSIGNED_RECIPIENT",
      armAValue: 240,
      armBValue: 255,
      differenceArmBMinusArmA: 15,
    });
    expect(result.observedDirection.statement).toContain(
      "Arm B produced $0.15 more settled revenue per assigned recipient",
    );
    expect(result.estimate!.probabilityArmBBetter).toBeGreaterThan(0.3);
    expect(result.estimate!.probabilityArmBBetter).toBeLessThan(0.7);
    expect(result.confidence.status).toBe("NOT_YET_DEPENDABLE");
    expect(result.confidence.statement).toContain("plausible outcomes in both directions");
    expect(result.confidence.nextStep).toMatch(/extend|repeat/i);
    expect(result.learning).toBeUndefined();
  });

  it("describes an observed A lead symmetrically and can save a dependable A learning", () => {
    const fixture = DEMO_RESULT_FIXTURES.find(({ id }) => id.endsWith("copy-complete"))!;
    const result = analyseResult(swapObservedArms(fixture));
    expect(result.observedDirection.outcome).toBe("A_LED");
    expect(result.observedDirection.statement).toContain("Arm A produced");
    expect(result.confidence.status).toBe("DEPENDABLE");
    expect(result.confidence.statement).toContain("Arm A was better");
    expect(result.learning?.statement).toContain("Arm A produced");
  });

  it("describes tied observed primary metrics without inventing a direction", () => {
    const fixture = DEMO_RESULT_FIXTURES.find(({ id }) => id.endsWith("price-complete"))!;
    const result = analyseResult({
      ...fixture,
      // Mirrored purchases no longer match the seeded audience evidence, so analyse the aggregates alone.
      audienceEvidence: undefined,
      frozenAudience: undefined,
      id: `${fixture.id}:tied`,
      purchases: [
        ...fixture.purchases.filter(({ arm }) => arm === "A"),
        ...fixture.purchases
          .filter(({ arm }) => arm === "A")
          .map((purchase) => ({
            ...purchase,
            id: `${purchase.id}:tie-b`,
            arm: "B" as const,
            fanUuid: purchase.fanUuid.replace(":a:", ":b:"),
          })),
      ],
    });
    expect(result.observedDirection.outcome).toBe("TIED");
    expect(result.observedDirection.statement).toContain("same settled revenue per assigned recipient");
    expect(result.observedDirection.relativeEffect).toBeNull();
    expect(result.confidence.status).toBe("NOT_YET_DEPENDABLE");
    expect(result.learning).toBeUndefined();
  });

  it("keeps observed direction separate when the evidence gate blocks learning", () => {
    const result = byId("low-volume");
    expect(result.status).toBe("LOW_VOLUME");
    expect(result.observedDirection.outcome).toBe("B_LED");
    expect(result.confidence.status).toBe("EVIDENCE_GATED");
    expect(result.confidence.supportsLearning).toBe(false);
    expect(result.learning).toBeUndefined();
  });

  it.each([
    ["low-volume", "LOW_VOLUME"],
    ["zero-purchases", "ZERO_PURCHASES"],
    ["stale", "STALE"],
    ["incomplete", "INCOMPLETE"],
    ["partial-launch", "PARTIAL_LAUNCH"],
    ["invalid", "INVALID"],
  ])("blocks %s evidence from emitting a learning", (suffix, status) => {
    const result = byId(suffix);
    expect(result.status).toBe(status);
    expect(result.learning).toBeUndefined();
  });

  it("treats assignment/purchase mismatches as invalid even when the fixture says closed", () => {
    const fixture = DEMO_RESULT_FIXTURES.find(({ id }) => id.endsWith("copy-complete"))!;
    const result = analyseResult({
      ...fixture,
      purchases: [{ ...fixture.purchases[0], fanUuid: "demo:fan:not-assigned" }],
    });
    expect(result.status).toBe("INVALID");
    expect(result.learning).toBeUndefined();
  });
});
