import { describe, expect, it, vi } from "vitest";
import { allocateAudience, allocationAlgorithmVersion } from "../domain/allocation";
import { observationEndFor } from "../domain/observation-window";
import {
  FanvueWriteError,
  fixtureFanvueWriteTransport,
  type FanvueWriteTransport,
} from "../integrations/fanvue/write-transport";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { abandonedReason, abandonInterruptedLaunch } from "./abandon";
import { executeConfirmedLaunch } from "./launch";
import { D1LaunchRepository } from "./launch-repository";
import { runGuardedAbandon } from "./lifecycle-entry";

const now = "2026-10-22T12:00:00.000Z";
const scheduledAt = "2026-10-22T12:05:00.000Z";

/** A REAL launch that created both lists, then failed read-back verification (the first real launch). */
async function interruptedLaunch() {
  const { sqlite, db } = createMigratedDatabase();
  const repository = new D1PerformRepository(db, "creator-1", "REAL");
  const variants = [
    { arm: "A" as const, copy: "Control", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
    { arm: "B" as const, copy: "Specific", priceMinor: 500, currency: "USD", mediaUuid: "media-1" },
  ];
  await repository.createExperiment({
    id: "experiment-1",
    name: "Oct",
    variable: "COPY",
    hypothesis: "h",
    sourceAudienceUuid: "subscribers",
    variants,
    createdAt: now,
  });
  await repository.transitionExperiment({
    commandId: "s",
    experimentId: "experiment-1",
    to: "SNAPSHOTTING",
    evidence: { variable: "COPY", variants },
    occurredAt: now,
  });
  const assignments = allocateAudience("experiment-1", [{ fanUuid: "fan-1" }, { fanUuid: "fan-2" }]);
  await repository.saveAssignmentChunk("experiment-1", assignments, now);
  await repository.finalizeAllocation({
    commandId: "f",
    experimentId: "experiment-1",
    snapshotHash: "a".repeat(64),
    snapshotCount: 2,
    armCounts: { A: 1, B: 1 },
    algorithmVersion: allocationAlgorithmVersion,
    snapshotAt: now,
  });
  const launchRepository = new D1LaunchRepository(db, "creator-1", "experiment-1");
  const broken = { ...fixtureFanvueWriteTransport(), listCustomListMembers: async () => [] };
  await expect(
    executeConfirmedLaunch({
      creatorUuid: "creator-1",
      experimentId: "experiment-1",
      scheduledAt,
      observationEndsAt: observationEndFor(scheduledAt, 7),
      confirmationHash: "b".repeat(64),
      repository,
      launchRepository,
      transport: broken,
      now: () => now,
    }),
  ).rejects.toThrow(/verification/);
  expect((await repository.getExperiment("experiment-1"))?.state).toBe("PROVISIONING");
  return { sqlite, db, repository, launchRepository };
}

function recordingTransport(fail?: (uuid: string) => Error | null): FanvueWriteTransport & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    ...fixtureFanvueWriteTransport(),
    deleted,
    async deleteCustomList(uuid) {
      const error = fail?.(uuid);
      if (error) throw error;
      deleted.push(uuid);
    },
  };
}

describe("abandon an interrupted launch", () => {
  it("deletes both confirmed lists once, marks it invalid and is safe to repeat", async () => {
    const { sqlite, repository, launchRepository } = await interruptedLaunch();
    const transport = recordingTransport();
    const run = () =>
      abandonInterruptedLaunch({
        experimentId: "experiment-1",
        repository,
        launchRepository,
        transport,
        now: () => now,
      });
    expect(await run()).toEqual({ status: "ABANDONED", deletedLists: 2 });
    expect(await run()).toEqual({ status: "ABANDONED", deletedLists: 0 });
    expect(transport.deleted).toHaveLength(2);
    expect(sqlite.prepare("SELECT state, invalid_reason FROM experiments").get()).toEqual({
      state: "INVALID",
      invalid_reason: abandonedReason,
    });
  });

  it("stays PROVISIONING when a delete fails, and a retry deletes only what remains", async () => {
    const { repository, launchRepository } = await interruptedLaunch();
    const listB = (await launchRepository.getList("B"))!.externalListUuid!;
    let failOnce = true;
    const transport = recordingTransport((uuid) => {
      if (uuid !== listB || !failOnce) return null;
      failOnce = false;
      return new FanvueWriteError("UNCERTAIN", 503, "upstream unavailable");
    });
    const run = () =>
      abandonInterruptedLaunch({
        experimentId: "experiment-1",
        repository,
        launchRepository,
        transport,
        now: () => now,
      });
    await expect(run()).rejects.toThrow(/upstream/);
    expect((await repository.getExperiment("experiment-1"))?.state).toBe("PROVISIONING");
    expect(await run()).toEqual({ status: "ABANDONED", deletedLists: 1 });
    expect(transport.deleted).toHaveLength(2);
  });

  it("refuses when a list create is uncertain", async () => {
    const { sqlite, repository, launchRepository } = await interruptedLaunch();
    sqlite.prepare("UPDATE provisioned_lists SET status = 'UNKNOWN' WHERE arm = 'A'").run();
    const transport = recordingTransport();
    const result = await abandonInterruptedLaunch({
      experimentId: "experiment-1",
      repository,
      launchRepository,
      transport,
      now: () => now,
    });
    expect(result).toEqual({ status: "REFUSED", reasons: [expect.stringMatching(/Arm A list creation is uncertain/)] });
    expect(transport.deleted).toHaveLength(0);
  });

  it("refuses an experiment that is not an interrupted launch", async () => {
    const { sqlite, repository, launchRepository } = await interruptedLaunch();
    sqlite.prepare("UPDATE experiments SET state = 'RUNNING'").run();
    const result = await abandonInterruptedLaunch({
      experimentId: "experiment-1",
      repository,
      launchRepository,
      transport: recordingTransport(),
      now: () => now,
    });
    expect(result).toMatchObject({ status: "REFUSED" });
  });

  it("refuses a REAL abandon with the write switch off, without a transport", async () => {
    const transport = vi.fn();
    const repositories = vi.fn();
    const outcome = await runGuardedAbandon({
      session: { userUuid: "creator-1", isCreator: true, scope: "write:chat read:fan" },
      env: { PERFORM_WRITE_MODE: "disabled" },
      records: { verified: ["send"], activated: ["send"] },
      experimentId: "experiment-1",
      repositories,
      transport,
      now: () => now,
    });
    expect(outcome).toEqual({ status: "REFUSED", reason: "WRITE_MODE_DISABLED" });
    expect(transport).not.toHaveBeenCalled();
    expect(repositories).not.toHaveBeenCalled();
  });

  it("abandons through the REAL entry point when every gate passes", async () => {
    const { db, repository, launchRepository } = await interruptedLaunch();
    const transport = recordingTransport();
    const outcome = await runGuardedAbandon({
      session: { userUuid: "creator-1", isCreator: true, scope: "write:chat read:fan" },
      env: { PERFORM_WRITE_MODE: "enabled", PERFORM_LIVE_CAPABILITIES: "send", OAUTH_SCOPES: "write:chat read:fan" },
      records: { verified: ["send"], activated: ["send"] },
      experimentId: "experiment-1",
      repositories: async () => ({
        repository,
        launchRepository,
        evidenceRepository: new D1LiveEvidenceRepository(db, "creator-1", "REAL"),
      }),
      transport: () => transport,
      now: () => now,
    });
    expect(outcome).toEqual({ status: "CHECKED", result: { status: "ABANDONED", deletedLists: 2 } });
  });
});
