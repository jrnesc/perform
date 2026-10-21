import { describe, expect, it } from "vitest";
import { allocationAlgorithmVersion } from "../domain/allocation";
import { assignmentWindowCaveat } from "../live/attribution";
import { allocatedExperiment, creatorUuid, seedExperiment } from "../live/test-fixtures";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import type { CommerceEventRecord } from "../persistence/live-evidence";
import { audienceSegments } from "./audience-evidence";
import { DEMO_RESULT_FIXTURES } from "./demo-results-v1";
import { buildLiveAudienceBreakdown } from "./live-audience-evidence";

const payment = (id: string, fan: string, arm: "A" | "B", experimentId: string, overrides: Partial<CommerceEventRecord> = {}): CommerceEventRecord => ({
  kind: "PAYMENT", eventId: `event-${id}`, creatorUuid, paymentId: id, purchaserUuid: fan,
  messageUuid: "per-recipient", messageType: "BROADCAST", attributionStrategy: "ASSIGNMENT_WINDOW",
  messageMatched: false, experimentId, arm, grossMinor: 1200, netMinor: 960, currency: "USD",
  occurredAt: "2026-10-21T11:00:00.000Z", payloadHash: `hash-${id}`, receivedAt: "2026-10-21T11:00:01.000Z",
  ...overrides,
} as CommerceEventRecord);

describe("live evidence in Results breakdowns", () => {
  it("maps frozen live cohorts and counted outcomes onto the shared contract with REAL provenance", async () => {
    const ctx = await allocatedExperiment();
    const rows = await ctx.store.listAudienceEvidence(ctx.experimentId);
    const arm = ctx.armOf("fan-1");
    const breakdown = buildLiveAudienceBreakdown({
      experimentId: ctx.experimentId, rows, attributionStrategy: "ASSIGNMENT_WINDOW",
      events: [
        payment("p-1", "fan-1", arm, ctx.experimentId),
        payment("p-2", "fan-5", ctx.armOf("fan-5"), ctx.experimentId, { messageMatched: true }),
        { kind: "REVERSAL", eventId: "event-r", creatorUuid, paymentId: "p-2", reversalId: "r", reversalType: "REFUND", amountMinor: 1200, currency: "USD", occurredAt: "2026-10-21T12:00:00.000Z", payloadHash: "h", receivedAt: "2026-10-21T12:00:01.000Z" },
        payment("p-3", "fan-2", ctx.armOf("fan-2") === "A" ? "B" : "A", ctx.experimentId),
        payment("p-4", "fan-3", ctx.armOf("fan-3"), ctx.experimentId, { attributionStrategy: "MESSAGE_UUID_MATCH" }),
        payment("p-5", "fan-4", ctx.armOf("fan-4"), ctx.experimentId, { occurredAt: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    expect(breakdown).toMatchObject({ provenance: "REAL", assignmentWindowOnly: 1, unmatchedPlausible: 1, caveat: assignmentWindowCaveat });
    expect(breakdown.evidence.every((row) => row.provenance === "REAL")).toBe(true);
    const byFan = Object.fromEntries(breakdown.evidence.map((row) => [row.fanUuid, row]));
    expect(byFan["fan-1"]).toMatchObject({ subscriberRelationship: "active_renewing", converted: true, settledRevenueMinor: 1200, priorPurchaserStatus: "PRIOR_PURCHASER" });
    expect(byFan["fan-5"]).toMatchObject({ subscriberRelationship: "active_not_renewing", converted: false, grossPurchaseCount: 1, fullyRefunded: true });
    for (const fan of ["fan-2", "fan-3", "fan-4"]) expect(byFan[fan].grossPurchaseCount).toBe(0);

    const segments = audienceSegments(breakdown.evidence, "RELATIONSHIP");
    expect(segments.map((segment) => [segment.key, segment.members.length])).toEqual([
      ["never_subscribed", 0], ["trialing", 0], ["active_renewing", 4], ["active_not_renewing", 2], ["lapsed", 0],
    ]);
  });

  it("carries no caveat when message UUIDs were proven and used", async () => {
    const ctx = await allocatedExperiment();
    const breakdown = buildLiveAudienceBreakdown({
      experimentId: ctx.experimentId, rows: await ctx.store.listAudienceEvidence(ctx.experimentId), events: [], attributionStrategy: "MESSAGE_UUID_MATCH",
    });
    expect(breakdown.caveat).toBeNull();
  });

  it("refuses to combine seeded and live members in one breakdown", () => {
    const seeded = DEMO_RESULT_FIXTURES[0].audienceEvidence!;
    expect(() => audienceSegments([...seeded, { ...seeded[0], fanUuid: "live", provenance: "REAL" }], "RELATIONSHIP"))
      .toThrow(/cannot be combined/);
  });

  it("seeds only the cohorts a subscribers smart list can contain", () => {
    const cohorts = new Set(DEMO_RESULT_FIXTURES.flatMap((fixture) => fixture.audienceEvidence ?? []).map((row) => row.subscriberRelationship));
    expect([...cohorts].sort()).toEqual(["active_not_renewing", "active_renewing", "trialing"]);
  });

  it("stores seeded members in the same table and under the same rules as a live capture", async () => {
    const fixture = DEMO_RESULT_FIXTURES.find((item) => item.frozenAudience)!;
    const { sqlite, db } = createMigratedDatabase();
    const experimentId = seedExperiment(sqlite, { provenance: "DEMO" });
    const repository = new D1PerformRepository(db, creatorUuid, "DEMO");
    const store = new D1LiveEvidenceRepository(db, creatorUuid, "DEMO");
    const rows = fixture.frozenAudience!.map((row) => ({ ...row, experimentId }));
    await repository.saveAssignmentChunk(experimentId, rows.map(({ fanUuid, arm, subscriberCohort }) => ({ fanUuid, arm, stratum: subscriberCohort, algorithmVersion: allocationAlgorithmVersion })), fixture.observation.startedAt);
    for (let index = 0; index < rows.length; index += 40) await store.saveAudienceEvidence(experimentId, rows.slice(index, index + 40));
    expect(await store.countAudienceEvidence(experimentId)).toBe(rows.length);
    const stored = await store.listAudienceEvidence(experimentId);
    expect([...stored].sort((a, b) => a.fanUuid.localeCompare(b.fanUuid))).toEqual([...rows].sort((a, b) => a.fanUuid.localeCompare(b.fanUuid)));
  });
});
