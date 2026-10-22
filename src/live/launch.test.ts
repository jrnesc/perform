import { describe, expect, it, vi } from "vitest";
import { allocateAudience, allocationAlgorithmVersion } from "../domain/allocation";
import { FanvueWriteError, fixtureFanvueWriteTransport } from "../integrations/fanvue/write-transport";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { runGuardedRealLaunch } from "./launch-entry";
import { D1LaunchRepository } from "./launch-repository";

const occurredAt = "2026-10-22T12:00:00.000Z";
const scheduledAt = "2026-10-22T12:05:00.000Z";
const observationEndsAt = "2026-10-29T12:05:00.000Z";

async function allocatedExperiment(provenance: "REAL" | "DEMO" = "REAL") {
  const { sqlite, db } = createMigratedDatabase();
  const repository = new D1PerformRepository(db, "creator-1", provenance);
  const variants = [
    { arm: "A" as const, copy: "Control", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
    { arm: "B" as const, copy: "Specific preview", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
  ];
  await repository.createExperiment({
    id: "experiment-1",
    name: "Launch test",
    variable: "COPY",
    hypothesis: "Specific copy wins",
    sourceAudienceUuid: "subscribers",
    variants,
    createdAt: occurredAt,
  });
  await repository.transitionExperiment({
    commandId: "snapshot-start",
    experimentId: "experiment-1",
    to: "SNAPSHOTTING",
    evidence: { variable: "COPY", variants },
    occurredAt,
  });
  const assignments = allocateAudience("experiment-1", [
    { fanUuid: "fan-1", stratum: "new" },
    { fanUuid: "fan-2", stratum: "new" },
    { fanUuid: "fan-3", stratum: "returning" },
    { fanUuid: "fan-4", stratum: "returning" },
  ]);
  await repository.saveAssignmentChunk("experiment-1", assignments, occurredAt);
  await repository.finalizeAllocation({
    commandId: "snapshot-final",
    experimentId: "experiment-1",
    snapshotHash: "a".repeat(64),
    snapshotCount: assignments.length,
    armCounts: {
      A: assignments.filter(({ arm }) => arm === "A").length,
      B: assignments.filter(({ arm }) => arm === "B").length,
    },
    algorithmVersion: allocationAlgorithmVersion,
    snapshotAt: occurredAt,
  });
  return { sqlite, db, repository };
}

describe("controlled launch", () => {
  it("makes no Fanvue request while the deployment switch is disabled", async () => {
    const transport = vi.fn();
    const repositories = vi.fn();
    const result = await runGuardedRealLaunch({
      session: { userUuid: "creator-1", isCreator: true, scope: "write:chat read:fan" },
      env: { PERFORM_WRITE_MODE: "disabled" },
      records: { verified: ["send"], activated: ["send"] },
      experimentId: "experiment-1",
      scheduledAt,
      observationEndsAt,
      confirmationHash: "b".repeat(64),
      repositories,
      transport,
      now: () => occurredAt,
    });
    expect(result).toEqual({ status: "REFUSED", reason: "WRITE_MODE_DISABLED" });
    expect(repositories).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("runs a REAL launch end to end and opens the observation window", async () => {
    const { sqlite, db, repository } = await allocatedExperiment();
    sqlite
      .prepare(
        `INSERT INTO capability_verifications
      (id, creator_uuid, capability, outcome, contract_reference, evidence_note, recorded_at)
      VALUES ('verify-send', 'creator-1', 'send', 'PASS', 'phase-x:5', 'Owner observed contracts', ?)`,
      )
      .run(occurredAt);
    sqlite
      .prepare(
        `INSERT INTO capability_activations
      (id, creator_uuid, capability, verification_id, action, decision_note, recorded_at)
      VALUES ('activate-send', 'creator-1', 'send', 'verify-send', 'ACTIVATE', 'Owner approved', ?)`,
      )
      .run(occurredAt);
    const transport = fixtureFanvueWriteTransport();
    const result = await runGuardedRealLaunch({
      session: { userUuid: "creator-1", isCreator: true, scope: "write:chat read:fan" },
      env: {
        PERFORM_WRITE_MODE: "enabled",
        PERFORM_LIVE_CAPABILITIES: "send",
        OAUTH_SCOPES: "write:chat read:fan",
      },
      records: { verified: ["send"], activated: ["send"] },
      experimentId: "experiment-1",
      scheduledAt,
      observationEndsAt,
      confirmationHash: "b".repeat(64),
      repositories: async () => ({
        repository,
        launchRepository: new D1LaunchRepository(db, "creator-1", "experiment-1"),
      }),
      transport: () => transport,
      now: () => occurredAt,
    });
    expect(result.status).toBe("LAUNCHED");
    if (result.status === "LAUNCHED") expect(result.result.status).toBe("RUNNING");
    expect(await repository.getExperiment("experiment-1")).toMatchObject({
      state: "RUNNING",
      launchedAt: scheduledAt,
      observationStartedAt: scheduledAt,
    });
    expect(transport.effects.filter((effect) => effect.startsWith("schedule-message"))).toHaveLength(2);
  });

  it("does not create a second list after an uncertain create", async () => {
    const { db, repository } = await allocatedExperiment("DEMO");
    let armACreateCalls = 0;
    const base = fixtureFanvueWriteTransport();
    const transport = {
      ...base,
      async createCustomList(name: string) {
        if (name.endsWith("· A")) {
          armACreateCalls += 1;
          if (armACreateCalls === 1) throw new Error("timeout");
        }
        return base.createCustomList(name);
      },
    };
    const launchRepository = new D1LaunchRepository(db, "creator-1", "experiment-1");
    const launch = () =>
      import("./launch").then(({ executeConfirmedLaunch }) =>
        executeConfirmedLaunch({
          creatorUuid: "creator-1",
          experimentId: "experiment-1",
          scheduledAt,
          observationEndsAt,
          confirmationHash: "c".repeat(64),
          repository,
          launchRepository,
          transport,
          now: () => occurredAt,
        }),
      );
    await expect(launch()).rejects.toThrow(/uncertain/);
    await expect(launch()).rejects.toThrow(/second list will not be created/);
    expect(armACreateCalls).toBe(1);
  });

  it("resolves an uncertain send and retries only with its persisted key", async () => {
    const { db, repository } = await allocatedExperiment("DEMO");
    const base = fixtureFanvueWriteTransport();
    const attemptedKeys: string[] = [];
    let firstB = true;
    const transport = {
      ...base,
      async createMassMessage(payload: Parameters<typeof base.createMassMessage>[0], key: string) {
        attemptedKeys.push(key);
        if (key.endsWith(":B") && firstB) {
          firstB = false;
          throw new FanvueWriteError("UNCERTAIN", 503, "upstream unavailable");
        }
        return base.createMassMessage(payload, key);
      },
    };
    const launchRepository = new D1LaunchRepository(db, "creator-1", "experiment-1");
    const { executeConfirmedLaunch } = await import("./launch");
    const launch = () =>
      executeConfirmedLaunch({
        creatorUuid: "creator-1",
        experimentId: "experiment-1",
        scheduledAt,
        observationEndsAt,
        confirmationHash: "d".repeat(64),
        repository,
        launchRepository,
        transport,
        now: () => occurredAt,
      });
    await expect(launch()).resolves.toMatchObject({ status: "RETRYABLE" });
    await expect(launch()).resolves.toMatchObject({ status: "RUNNING" });
    expect(attemptedKeys).toEqual(["experiment-1:A", "experiment-1:B", "experiment-1:B"]);
    expect(new Set(attemptedKeys)).toEqual(new Set(["experiment-1:A", "experiment-1:B"]));
  });
  it("gives list creation to exactly one of two concurrent resumes", async () => {
    // A fresh double-click is serialised by the ALLOCATED -> PROVISIONING swap; resumes from
    // PROVISIONING are not, so the list row itself must decide who may call Fanvue.
    const { db } = await allocatedExperiment("DEMO");
    const first = new D1LaunchRepository(db, "creator-1", "experiment-1");
    const second = new D1LaunchRepository(db, "creator-1", "experiment-1");
    const claims = await Promise.all([first.beginList("A", 2, occurredAt), second.beginList("A", 2, occurredAt)]);
    expect(claims.map(({ claimed }) => claimed).sort()).toEqual([false, true]);
  });

  it("resolves an uncertain send inside the final three minutes before delivery", async () => {
    const { db, repository } = await allocatedExperiment("DEMO");
    const base = fixtureFanvueWriteTransport();
    let firstB = true;
    const transport = {
      ...base,
      async createMassMessage(payload: Parameters<typeof base.createMassMessage>[0], key: string) {
        if (key.endsWith(":B") && firstB) {
          firstB = false;
          throw new FanvueWriteError("UNCERTAIN", 503, "upstream unavailable");
        }
        return base.createMassMessage(payload, key);
      },
    };
    const launchRepository = new D1LaunchRepository(db, "creator-1", "experiment-1");
    const { executeConfirmedLaunch } = await import("./launch");
    const launch = (now: string) =>
      executeConfirmedLaunch({
        creatorUuid: "creator-1",
        experimentId: "experiment-1",
        scheduledAt,
        observationEndsAt,
        confirmationHash: "f".repeat(64),
        repository,
        launchRepository,
        transport,
        now: () => now,
      });
    await expect(launch(occurredAt)).resolves.toMatchObject({ status: "RETRYABLE" });
    await expect(launch("2026-10-22T12:04:00.000Z")).resolves.toMatchObject({ status: "RUNNING" });
  });
});
