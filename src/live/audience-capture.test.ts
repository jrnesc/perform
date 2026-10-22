import { describe, expect, it } from "vitest";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { captureLiveAudience, persistLiveAudienceSnapshot } from "./audience-capture";
import {
  assignmentCutoff,
  capturedAt,
  creatorUuid,
  fanvueTransport,
  seedExperiment,
  sixFans,
  sourceAudienceUuid,
} from "./test-fixtures";

const source = { kind: "SMART", uuid: sourceAudienceUuid } as const;
const base = { experimentId: "experiment-live", source, capturedAt, assignmentCutoff };

async function ready() {
  const capture = await captureLiveAudience({ ...base, transport: fanvueTransport(sixFans) });
  if (capture.status !== "READY") throw new Error("expected a complete capture");
  return capture;
}

describe("live audience capture", () => {
  it("captures a complete audience stratified by subscriber cohort", async () => {
    const capture = await ready();
    expect(capture.assignments).toHaveLength(6);
    expect(capture.armCounts).toEqual({ A: 3, B: 3 });
    const byCohort = new Map<string, number[]>();
    for (const row of capture.evidence) {
      const counts = byCohort.get(row.subscriberCohort) ?? [0, 0];
      counts[row.arm === "A" ? 0 : 1] += 1;
      byCohort.set(row.subscriberCohort, counts);
    }
    expect(byCohort.get("active_renewing")).toEqual([2, 2]);
    expect(byCohort.get("active_not_renewing")).toEqual([1, 1]);
    expect(capture.evidence.find((row) => row.fanUuid === "fan-1")).toMatchObject({
      priorSettledPurchaseCount: 2,
      priorSettledSpendMinor: 2000,
      autoRenewalEnabled: true,
      subscriberCohort: "active_renewing",
      validPeriodCount: 2,
      hasTrial: false,
      resubscribedAfterLapse: false,
      earliestSubscriptionAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(capture)).not.toMatch(/private-handle|Private Name/);
  });

  it("derives resubscription and trial cohorts from documented history fields", async () => {
    const fans = [
      { uuid: "r1", kind: "renewing" as const },
      { uuid: "r2", kind: "renewing" as const },
      { uuid: "back", kind: "resubscriber" as const },
      { uuid: "new", kind: "trialing" as const },
    ];
    const capture = await captureLiveAudience({ ...base, transport: fanvueTransport(fans) });
    if (capture.status !== "READY") throw new Error("expected a complete capture");
    const by = Object.fromEntries(capture.evidence.map((row) => [row.fanUuid, row]));
    expect(by.back).toMatchObject({ subscriberCohort: "active_renewing", resubscribedAfterLapse: true });
    expect(by.new).toMatchObject({ subscriberCohort: "trialing", hasTrial: true });
    expect(by.r1.resubscribedAfterLapse).toBe(false);
  });

  it.each([
    [
      "a custom list",
      { ...base, source: { kind: "CUSTOM", uuid: "custom-1" } as const },
      fanvueTransport(sixFans),
      ["SOURCE_NOT_ELIGIBLE"],
    ],
    [
      "a smart list not documented as contactable",
      { ...base, source: { kind: "SMART", uuid: "followers" } as const },
      fanvueTransport(sixFans),
      ["SOURCE_NOT_ELIGIBLE"],
    ],
    [
      "a missing subscription history",
      base,
      fanvueTransport(sixFans, { "/v1/subscribers/fan-3/history": () => new Response("{}", { status: 404 }) }),
      ["SUBSCRIPTION_HISTORY_FAILED"],
    ],
    [
      "a failed purchase lookup",
      base,
      fanvueTransport(sixFans, {
        "/v1/insights/fans/batch": () => new Response(JSON.stringify({ "fan-1": { error: "internal" } })),
      }),
      ["PURCHASE_ENRICHMENT_FAILED"],
    ],
    ["an empty audience", base, fanvueTransport([]), ["AUDIENCE_EMPTY"]],
  ])("is incomplete for %s and allocates nothing", async (_name, input, transport, reasons) => {
    const result = await captureLiveAudience({ ...input, transport });
    expect(result).toMatchObject({ status: "INCOMPLETE" });
    expect(result.status === "INCOMPLETE" && result.reasons).toEqual(expect.arrayContaining(reasons));
    expect("assignments" in result).toBe(false);
  });

  it("is incomplete when purchase and subscriber reads contradict each other", async () => {
    // Fan Insights says subscriber, but the profile history is empty (for example, history lag).
    const fans = sixFans.map((fan) => (fan.uuid === "fan-2" ? { ...fan, kind: "never" as const } : fan));
    const transport = fanvueTransport(sixFans, {
      "/v1/subscribers/fan-2/history": async () => await fanvueTransport(fans)("/v1/subscribers/fan-2/history"),
    });
    const result = await captureLiveAudience({ ...base, transport });
    expect(result).toMatchObject({ status: "INCOMPLETE", reasons: ["STATE_CONFLICT"], failedFanUuids: ["fan-2"] });
  });

  it("surfaces a rate limit as an aborted read with its retry delay", async () => {
    const transport = fanvueTransport(sixFans, {
      "/v1/insights/fans/batch": () => new Response("{}", { status: 429, headers: { "retry-after": "9" } }),
    });
    expect(await captureLiveAudience({ ...base, transport })).toEqual({
      status: "INCOMPLETE",
      reasons: ["READ_ABORTED"],
      failedFanUuids: [],
      abort: { code: "RATE_LIMITED", retryAfterSeconds: 9 },
    });
  });
});

describe("live audience persistence", () => {
  function setup(options: Parameters<typeof seedExperiment>[1] = {}) {
    const { sqlite, db } = createMigratedDatabase();
    seedExperiment(sqlite, options);
    return {
      sqlite,
      repository: new D1PerformRepository(db, creatorUuid, "REAL"),
      evidenceRepository: new D1LiveEvidenceRepository(db, creatorUuid, "REAL"),
    };
  }

  it("stores assignments and immutable evidence, then finalises allocation", async () => {
    const { sqlite, repository, evidenceRepository } = setup();
    await persistLiveAudienceSnapshot({
      repository,
      evidenceRepository,
      experimentId: "experiment-live",
      source,
      capture: await ready(),
      commandId: "command-1",
    });
    expect(await repository.getExperiment("experiment-live")).toMatchObject({
      state: "ALLOCATED",
      snapshotCount: 6,
    });
    expect(await evidenceRepository.countAudienceEvidence("experiment-live")).toBe(6);
    expect(() => sqlite.prepare("UPDATE audience_member_evidence SET subscriber_cohort = 'lapsed'").run()).toThrow(
      /immutable/,
    );
    const columns = sqlite
      .prepare("PRAGMA table_info(audience_member_evidence)")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).not.toEqual(expect.arrayContaining(["handle", "display_name", "avatar_url"]));
  });

  it("does not finalise when evidence is missing for any assignment", async () => {
    const { repository, evidenceRepository } = setup();
    const capture = await ready();
    await expect(
      persistLiveAudienceSnapshot({
        repository,
        evidenceRepository,
        experimentId: "experiment-live",
        source,
        capture: { ...capture, evidence: capture.evidence.slice(1) },
        commandId: "command-1",
      }),
    ).rejects.toThrow(/incomplete/);
    expect(await repository.getExperiment("experiment-live")).toMatchObject({ state: "SNAPSHOTTING" });
    expect(await evidenceRepository.countAudienceEvidence("experiment-live")).toBe(0);
  });

  it("refuses demo experiments and a source other than the declared audience", async () => {
    const demo = setup({ provenance: "DEMO" });
    const demoRepository = new D1PerformRepository(
      (demo.repository as unknown as { db: never }).db,
      creatorUuid,
      "DEMO",
    );
    await expect(
      persistLiveAudienceSnapshot({
        repository: demoRepository,
        evidenceRepository: demo.evidenceRepository,
        experimentId: "experiment-live",
        source,
        capture: await ready(),
        commandId: "c",
      }),
    ).rejects.toThrow(/REAL/);

    const real = setup({ source: "another-audience" });
    await expect(
      persistLiveAudienceSnapshot({
        repository: real.repository,
        evidenceRepository: real.evidenceRepository,
        experimentId: "experiment-live",
        source,
        capture: await ready(),
        commandId: "c",
      }),
    ).rejects.toThrow(/declared source/);
  });

  it("is idempotent when the same capture is persisted again", async () => {
    const { repository, evidenceRepository } = setup();
    const capture = await ready();
    const input = {
      repository,
      evidenceRepository,
      experimentId: "experiment-live",
      source,
      capture,
      commandId: "command-1",
    };
    await persistLiveAudienceSnapshot(input);
    await expect(
      repository.finalizeAllocation({
        commandId: "command-1",
        experimentId: "experiment-live",
        snapshotHash: capture.snapshotHash,
        snapshotCount: 6,
        armCounts: capture.armCounts,
        algorithmVersion: capture.assignments[0].algorithmVersion,
        snapshotAt: capturedAt,
      }),
    ).resolves.toBeUndefined();
  });
});
