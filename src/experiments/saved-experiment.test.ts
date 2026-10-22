import { describe, expect, it } from "vitest";
import { D1PerformRepository, assignmentChunkLimit } from "../persistence/d1-perform-repository";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { DEMO_VAULT_ASSETS } from "../workspace/demo-vault-v1";
import { DEMO_AUDIENCES } from "./demo-audiences-v1";
import { buildExperimentReview } from "./review";
import { discardExperiment, discardedReason, rebuildSavedReview } from "./saved-experiment";

const now = "2026-10-22T12:00:00.000Z";
const audience = DEMO_AUDIENCES[0];
const asset = DEMO_VAULT_ASSETS.find(({ status }) => status === "ready")!;
const variants = [
  { arm: "A" as const, copy: "A new set is ready.", priceMinor: 1200, currency: "USD", mediaUuid: asset.id },
  { arm: "B" as const, copy: "See 12 new portraits.", priceMinor: 1200, currency: "USD", mediaUuid: asset.id },
];

/** Saves an allocated seeded experiment the way the dry-run route does. */
async function savedExperiment() {
  const { sqlite, db } = createMigratedDatabase();
  const repository = new D1PerformRepository(db, "creator-1", "DEMO");
  const review = await buildExperimentReview({
    id: "experiment-1",
    name: "Saved test",
    audience,
    asset,
    variable: "COPY",
    hypothesis: "Specific copy wins",
    variants,
  });
  await repository.createExperiment({
    id: review.experimentId,
    name: review.draft.name,
    variable: "COPY",
    hypothesis: review.draft.hypothesis,
    sourceAudienceUuid: audience.id,
    variants,
    createdAt: now,
  });
  await repository.transitionExperiment({
    commandId: "start",
    experimentId: review.experimentId,
    to: "SNAPSHOTTING",
    evidence: { variable: "COPY", variants },
    occurredAt: now,
  });
  for (let index = 0; index < review.assignments.length; index += assignmentChunkLimit) {
    await repository.saveAssignmentChunk(
      review.experimentId,
      review.assignments.slice(index, index + assignmentChunkLimit),
      now,
    );
  }
  await repository.finalizeAllocation({
    commandId: "finalize",
    experimentId: review.experimentId,
    snapshotHash: review.snapshotHash,
    snapshotCount: review.eligibleCount,
    armCounts: review.armCounts,
    algorithmVersion: review.assignments[0].algorithmVersion,
    snapshotAt: now,
  });
  return { sqlite, db, repository, review };
}

async function rebuild(repository: D1PerformRepository) {
  const experiment = (await repository.getExperiment("experiment-1"))!;
  return rebuildSavedReview({
    experiment,
    variants: await repository.listVariants(experiment.id),
    assignments: await repository.listAssignments(experiment.id),
    audience,
    asset,
    liveLaunch: false,
  });
}

describe("continue to launch", () => {
  it("rebuilds the same review and plan from what was saved", async () => {
    const { repository, review } = await savedExperiment();
    const rebuilt = await rebuild(repository);
    expect(rebuilt.review.snapshotHash).toBe(review.snapshotHash);
    expect(rebuilt.review.assignments).toEqual(review.assignments);
    expect(rebuilt.review.draft.variants).toEqual(variants);
    expect(rebuilt.plan.experimentId).toBe("experiment-1");
  });

  it("refuses when the stored split no longer reproduces", async () => {
    const { sqlite, repository } = await savedExperiment();
    const fan = sqlite.prepare("SELECT fan_uuid, arm FROM assignments LIMIT 1").get() as {
      fan_uuid: string;
      arm: string;
    };
    sqlite.prepare("PRAGMA foreign_keys = OFF").run();
    sqlite.prepare("UPDATE assignments SET arm = ? WHERE fan_uuid = ?").run(fan.arm === "A" ? "B" : "A", fan.fan_uuid);
    await expect(rebuild(repository)).rejects.toThrow(/could not be reproduced/);
  });

  it("refuses an experiment that is no longer allocated", async () => {
    const { repository } = await savedExperiment();
    await discardExperiment({ repository, experimentId: "experiment-1", now: () => now });
    await expect(rebuild(repository)).rejects.toThrow(/Only an allocated experiment/);
  });
});

describe("discard", () => {
  it("marks an unlaunched experiment invalid with the discard reason, idempotently", async () => {
    const { sqlite, repository } = await savedExperiment();
    await discardExperiment({ repository, experimentId: "experiment-1", now: () => now });
    await discardExperiment({ repository, experimentId: "experiment-1", now: () => now });
    expect(sqlite.prepare("SELECT state, invalid_reason FROM experiments").get()).toEqual({
      state: "INVALID",
      invalid_reason: discardedReason,
    });
  });

  it("refuses a launched experiment", async () => {
    const { sqlite, repository } = await savedExperiment();
    sqlite.prepare("UPDATE experiments SET state = 'RUNNING'").run();
    await expect(discardExperiment({ repository, experimentId: "experiment-1", now: () => now })).rejects.toThrow(
      /not been launched/,
    );
  });

  it("does not find another creator's experiment", async () => {
    const { db } = await savedExperiment();
    const other = new D1PerformRepository(db, "creator-2", "DEMO");
    await expect(
      discardExperiment({ repository: other, experimentId: "experiment-1", now: () => now }),
    ).rejects.toThrow(/not in this workspace/);
  });
});
