import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateAudience, allocationAlgorithmVersion } from "../domain/allocation";
import { observationEndFor } from "../domain/observation-window";
import { fixtureReconciliationReadTransport } from "../integrations/fanvue/fixture-read-transport";
import { FanvueWriteError, fixtureFanvueWriteTransport, type FanvueWriteTransport } from "../integrations/fanvue/write-transport";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository, type ReconciliationRecord } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { closeBlockers, closeExperimentIfReady } from "./close";
import { executeConfirmedLaunch } from "./launch";
import { D1LaunchRepository } from "./launch-repository";
import { runGuardedClose, runGuardedReconciliation } from "./lifecycle-entry";
import { reconcileObservation } from "./reconciliation";

const createdAt = "2026-10-22T12:00:00.000Z";
const scheduledAt = "2026-10-22T12:05:00.000Z";
const observationEndsAt = observationEndFor(scheduledAt, 7);
const afterWindow = "2026-10-30T00:00:00.000Z";

async function allocatedExperiment(provenance: "REAL" | "DEMO") {
  const { sqlite, db } = createMigratedDatabase();
  const repository = new D1PerformRepository(db, "creator-1", provenance);
  const variants = [
    { arm: "A" as const, copy: "Control", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
    { arm: "B" as const, copy: "Specific preview", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
  ];
  await repository.createExperiment({
    id: "experiment-1", name: "Close test", variable: "COPY", hypothesis: "Specific copy wins",
    sourceAudienceUuid: "subscribers", variants, createdAt,
  });
  await repository.transitionExperiment({
    commandId: "snapshot-start", experimentId: "experiment-1", to: "SNAPSHOTTING",
    evidence: { variable: "COPY", variants }, occurredAt: createdAt,
  });
  const assignments = allocateAudience("experiment-1", [
    { fanUuid: "fan-1", stratum: "new" }, { fanUuid: "fan-2", stratum: "new" },
    { fanUuid: "fan-3", stratum: "returning" }, { fanUuid: "fan-4", stratum: "returning" },
  ]);
  await repository.saveAssignmentChunk("experiment-1", assignments, createdAt);
  await repository.finalizeAllocation({
    commandId: "snapshot-final", experimentId: "experiment-1", snapshotHash: "a".repeat(64),
    snapshotCount: assignments.length,
    armCounts: {
      A: assignments.filter(({ arm }) => arm === "A").length,
      B: assignments.filter(({ arm }) => arm === "B").length,
    },
    algorithmVersion: allocationAlgorithmVersion, snapshotAt: createdAt,
  });
  return { sqlite, db, repository, launchRepository: new D1LaunchRepository(db, "creator-1", "experiment-1") };
}

async function runningExperiment(provenance: "REAL" | "DEMO") {
  const { sqlite, db, repository, launchRepository } = await allocatedExperiment(provenance);
  const writes = fixtureFanvueWriteTransport();
  const launched = await executeConfirmedLaunch({
    creatorUuid: "creator-1", experimentId: "experiment-1", scheduledAt, observationEndsAt,
    confirmationHash: "b".repeat(64), repository, launchRepository, transport: writes, now: () => createdAt,
  });
  expect(launched.status).toBe("RUNNING");
  const evidenceRepository = new D1LiveEvidenceRepository(db, "creator-1", provenance);
  return { sqlite, db, repository, launchRepository, evidenceRepository };
}

function cleanReconciliation(overrides: Partial<ReconciliationRecord> = {}): ReconciliationRecord {
  return {
    id: `reconciliation-${Math.random()}`, experimentId: "experiment-1",
    windowStart: scheduledAt, windowEnd: observationEndsAt, capturedAt: afterWindow,
    isComplete: true, discrepancy: false, needsReanalysis: false,
    webhookSettledPurchases: { A: 0, B: 0 }, webhookSettledMinor: { A: 0, B: 0 },
    reconciledSettledPurchases: { A: 0, B: 0 }, reconciledSettledMinor: { A: 0, B: 0 },
    missingAssignmentCount: 0, orphanReversalCount: 0, ignoredRowCount: 0,
    attributionStrategy: "ASSIGNMENT_WINDOW", assignmentWindowOnlyCount: 0, unmatchedPlausibleCount: 0,
    massMessageCheck: { purchases: { A: 0, B: 0 }, revenueMinor: { A: 0, B: 0 }, mismatch: false },
    note: "Webhook evidence agrees with the earnings ledger.", ...overrides,
  };
}

const activeEnv = {
  PERFORM_WRITE_MODE: "enabled",
  PERFORM_LIVE_CAPABILITIES: "send,earnings_reconciliation,mass_message_totals",
  OAUTH_SCOPES: "write:chat read:fan read:insights read:chat",
};
const activeSession = { userUuid: "creator-1", isCreator: true, scope: "write:chat read:fan read:insights read:chat" };
const allActive = {
  verified: ["send", "earnings_reconciliation", "mass_message_totals"] as const,
  activated: ["send", "earnings_reconciliation", "mass_message_totals"] as const,
};

afterEach(() => vi.restoreAllMocks());

describe("observation window", () => {
  it("is persisted with the confirmation and on the experiment for attribution", async () => {
    const { sqlite, launchRepository } = await runningExperiment("REAL");
    expect(await launchRepository.getConfirmation()).toMatchObject({ scheduledAt, observationEndsAt });
    expect(sqlite.prepare("SELECT observation_ends_at FROM experiments WHERE id = 'experiment-1'").get())
      .toEqual({ observation_ends_at: observationEndsAt });
  });

  it("refuses a launch whose window is not whole days within bounds", async () => {
    const { repository, launchRepository } = await allocatedExperiment("DEMO");
    for (const end of [scheduledAt, "2026-10-23T00:00:00.000Z", observationEndFor(scheduledAt, 91)]) {
      await expect(executeConfirmedLaunch({
        creatorUuid: "creator-1", experimentId: "experiment-1", scheduledAt, observationEndsAt: end,
        confirmationHash: "c".repeat(64), repository, launchRepository,
        transport: fixtureFanvueWriteTransport(), now: () => createdAt,
      })).rejects.toThrow(/whole days/);
    }
    expect(await launchRepository.getConfirmation()).toBeNull();
  });
});

describe("close checks", () => {
  it("names every blocker", () => {
    const now = "2026-10-25T00:00:00.000Z";
    expect(closeBlockers({ observationEndsAt, latestReconciliation: null, now })).toEqual([
      "The observation window has not ended", "No reconciliation has run",
    ]);
    expect(closeBlockers({ observationEndsAt: null, latestReconciliation: cleanReconciliation(), now: afterWindow }))
      .toEqual(["No observation window was confirmed at launch"]);
    expect(closeBlockers({
      observationEndsAt, now: afterWindow,
      latestReconciliation: cleanReconciliation({
        windowEnd: "2026-10-26T00:00:00.000Z", isComplete: false, discrepancy: true, massMessageCheck: null,
      }),
    })).toEqual([
      "The latest reconciliation does not cover the whole observation window",
      "The latest reconciliation is incomplete",
      "The latest reconciliation has a discrepancy",
      "The mass-message totals check has not run",
    ]);
    expect(closeBlockers({
      observationEndsAt, now: afterWindow,
      latestReconciliation: cleanReconciliation({
        massMessageCheck: { purchases: { A: 1, B: 0 }, revenueMinor: { A: 500, B: 0 }, mismatch: true },
      }),
    })).toEqual(["Mass-message totals do not match attributed totals"]);
    expect(closeBlockers({ observationEndsAt, latestReconciliation: cleanReconciliation(), now: afterWindow })).toEqual([]);
  });

  it.each([
    ["before the window ends", "2026-10-25T00:00:00.000Z", cleanReconciliation(), "The observation window has not ended"],
    ["with an incomplete reconciliation", afterWindow, cleanReconciliation({ isComplete: false }), "The latest reconciliation is incomplete"],
    ["with a discrepancy", afterWindow, cleanReconciliation({ discrepancy: true }), "The latest reconciliation has a discrepancy"],
    ["with the totals check unrun", afterWindow, cleanReconciliation({ massMessageCheck: null }), "The mass-message totals check has not run"],
    ["with mismatched totals", afterWindow,
      cleanReconciliation({ massMessageCheck: { purchases: { A: 1, B: 0 }, revenueMinor: { A: 500, B: 0 }, mismatch: true } }),
      "Mass-message totals do not match attributed totals"],
  ])("refuses a REAL close %s, without touching Fanvue", async (_label, now, record, reason) => {
    const { repository, launchRepository, evidenceRepository } = await runningExperiment("REAL");
    await evidenceRepository.appendReconciliation(record);
    const deleteCustomList = vi.fn();
    const outcome = await runGuardedClose({
      session: activeSession, env: activeEnv, records: allActive, experimentId: "experiment-1",
      repositories: async () => ({ repository, launchRepository, evidenceRepository }),
      transport: () => ({ ...fixtureFanvueWriteTransport(), deleteCustomList }), now: () => now,
    });
    expect(outcome).toEqual({ status: "CHECKED", result: { status: "OPEN", reasons: [reason] } });
    expect(deleteCustomList).not.toHaveBeenCalled();
    expect((await repository.getExperiment("experiment-1"))?.state).toBe("RUNNING");
  });

  it("refuses a REAL close with the write switch off before opening repositories", async () => {
    const repositories = vi.fn();
    const transport = vi.fn();
    const outcome = await runGuardedClose({
      session: activeSession, env: { ...activeEnv, PERFORM_WRITE_MODE: "disabled" }, records: allActive,
      experimentId: "experiment-1", repositories, transport, now: () => afterWindow,
    });
    expect(outcome).toEqual({ status: "REFUSED", reason: "WRITE_MODE_DISABLED" });
    expect(repositories).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a seeded experiment on the REAL entry points", async () => {
    const { repository, launchRepository, evidenceRepository } = await runningExperiment("DEMO");
    const transport = vi.fn();
    const repositories = async () => ({ repository, launchRepository, evidenceRepository });
    const base = { session: activeSession, env: activeEnv, records: allActive, experimentId: "experiment-1", repositories };
    expect(await runGuardedClose({ ...base, transport, now: () => afterWindow }))
      .toEqual({ status: "REFUSED", reason: "NOT_REAL_PROVENANCE" });
    expect(await runGuardedReconciliation({ ...base, transport, now: () => afterWindow, newId: () => "r" }))
      .toEqual({ status: "REFUSED", reason: "NOT_REAL_PROVENANCE" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a REAL reconciliation until both totals capabilities are active", async () => {
    const transport = vi.fn();
    const outcome = await runGuardedReconciliation({
      session: activeSession, env: activeEnv, records: { verified: ["send"], activated: ["send"] },
      experimentId: "experiment-1", repositories: vi.fn(), transport, now: () => afterWindow, newId: () => "r",
    });
    expect(outcome).toMatchObject({
      status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE",
      capabilities: { earnings_reconciliation: "connected", mass_message_totals: "connected" },
    });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("closing", () => {
  it("launches, observes and closes a seeded experiment with zero Fanvue requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { repository, launchRepository, evidenceRepository } = await runningExperiment("DEMO");
    const context = await evidenceRepository.getAttributionContext("experiment-1");
    const reads = fixtureReconciliationReadTransport(Object.keys(context.messages));
    const record = await reconcileObservation({
      experimentId: "experiment-1", creatorUuid: "creator-1", repository, launchRepository, evidenceRepository,
      transport: reads, now: () => afterWindow, newId: () => "reconciliation-1",
    });
    expect(record).toMatchObject({ isComplete: true, discrepancy: false, windowStart: scheduledAt, windowEnd: observationEndsAt });
    expect(record.massMessageCheck?.mismatch).toBe(false);

    const writes = fixtureFanvueWriteTransport();
    const result = await closeExperimentIfReady({
      experimentId: "experiment-1", latestReconciliation: record, repository, launchRepository,
      transport: writes, now: () => afterWindow,
    });
    expect(result).toEqual({ status: "CLOSED", deletedLists: 2 });
    expect(writes.effects.filter((effect) => effect.startsWith("delete-list"))).toHaveLength(2);
    expect(await repository.getExperiment("experiment-1")).toMatchObject({ state: "CLOSED", observationEndedAt: afterWindow });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reconciles only up to now while the window is open", async () => {
    const { repository, launchRepository, evidenceRepository } = await runningExperiment("DEMO");
    const now = "2026-10-25T00:00:00.000Z";
    const record = await reconcileObservation({
      experimentId: "experiment-1", creatorUuid: "creator-1", repository, launchRepository, evidenceRepository,
      transport: fixtureReconciliationReadTransport([]), now: () => now, newId: () => "reconciliation-1",
    });
    expect(record.windowEnd).toBe(now);
    expect(record.massMessageCheck?.mismatch).toBe(true);
    expect(closeBlockers({ observationEndsAt, latestReconciliation: record, now })).toContain(
      "The latest reconciliation does not cover the whole observation window",
    );
  });

  it("deletes each list exactly once and stays RUNNING when a delete fails", async () => {
    const { repository, launchRepository, evidenceRepository } = await runningExperiment("REAL");
    await evidenceRepository.appendReconciliation(cleanReconciliation());
    const deleted: string[] = [];
    let failB = true;
    const transport: FanvueWriteTransport = {
      ...fixtureFanvueWriteTransport(),
      async deleteCustomList(uuid) {
        if (uuid === (await launchRepository.getList("B"))?.externalListUuid && failB) {
          failB = false;
          throw new FanvueWriteError("UNCERTAIN", 503, "upstream unavailable");
        }
        deleted.push(uuid);
      },
    };
    const close = () => runGuardedClose({
      session: activeSession, env: activeEnv, records: allActive, experimentId: "experiment-1",
      repositories: async () => ({ repository, launchRepository, evidenceRepository }),
      transport: () => transport, now: () => afterWindow,
    });
    await expect(close()).rejects.toThrow(/upstream unavailable/);
    expect((await repository.getExperiment("experiment-1"))?.state).toBe("RUNNING");
    expect((await launchRepository.getList("A"))?.status).toBe("DELETED");
    expect((await launchRepository.getList("B"))?.status).toBe("CONFIRMED");

    expect(await close()).toEqual({ status: "CHECKED", result: { status: "CLOSED", deletedLists: 1 } });
    expect(await close()).toEqual({ status: "CHECKED", result: { status: "CLOSED", deletedLists: 0 } });
    expect(deleted).toHaveLength(2);
    expect(new Set(deleted).size).toBe(2);
    expect((await repository.getExperiment("experiment-1"))?.state).toBe("CLOSED");
  });

  it("treats a 404 on retry as an already-deleted list", async () => {
    const { repository, launchRepository } = await runningExperiment("REAL");
    const transport: FanvueWriteTransport = {
      ...fixtureFanvueWriteTransport(),
      async deleteCustomList() { throw new FanvueWriteError("DEFINITE", 404, "not found"); },
    };
    const result = await closeExperimentIfReady({
      experimentId: "experiment-1", latestReconciliation: cleanReconciliation(), repository, launchRepository,
      transport, now: () => afterWindow,
    });
    expect(result).toEqual({ status: "CLOSED", deletedLists: 2 });
  });
});
