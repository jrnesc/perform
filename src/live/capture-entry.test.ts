import { describe, expect, it, vi } from "vitest";
import { D1PerformRepository } from "../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../persistence/live-evidence";
import { createMigratedDatabase } from "../test/sqlite-d1";
import { captureCapabilities, runGuardedLiveAudienceCapture } from "./capture-entry";
import { capturedAt, creatorUuid, fanvueTransport, seedExperiment, sixFans, sourceAudienceUuid } from "./test-fixtures";

const configured = {
  PERFORM_LIVE_CAPABILITIES: "audience_discovery,subscriber_state,purchase_enrichment",
  OAUTH_SCOPES: "read:self read:media read:chat read:fan read:insights",
};
const grantedSession = {
  userUuid: creatorUuid,
  isCreator: true,
  scope: "read:self read:media read:chat read:fan read:insights",
};

function harness(provenance: "REAL" | "DEMO" = "REAL") {
  const { sqlite, db } = createMigratedDatabase();
  const experimentId = seedExperiment(sqlite, { provenance });
  const repositories = vi.fn(async (creator: string) => ({
    repository: new D1PerformRepository(db, creator, provenance),
    evidenceRepository: new D1LiveEvidenceRepository(db, creator, provenance),
  }));
  const transport = vi.fn(fanvueTransport(sixFans));
  const transportFactory = vi.fn(() => transport);
  const run = (overrides: Partial<Parameters<typeof runGuardedLiveAudienceCapture>[0]> = {}) =>
    runGuardedLiveAudienceCapture({
      session: grantedSession,
      env: configured,
      verified: [],
      activated: [],
      experimentId,
      source: { kind: "SMART", uuid: sourceAudienceUuid },
      repositories,
      transport: transportFactory,
      now: () => capturedAt,
      commandId: "capture-1",
      ...overrides,
    });
  return { sqlite, experimentId, repositories, transport, transportFactory, run };
}

describe("guarded live audience capture", () => {
  it("refuses without a verified creator session before anything is opened", async () => {
    const h = harness();
    expect(await h.run({ session: null })).toEqual({ status: "REFUSED", reason: "NOT_A_VERIFIED_CREATOR" });
    expect(await h.run({ session: { ...grantedSession, isCreator: false } })).toMatchObject({
      reason: "NOT_A_VERIFIED_CREATOR",
    });
    expect(h.repositories).not.toHaveBeenCalled();
    expect(h.transportFactory).not.toHaveBeenCalled();
  });

  it("is inert at every rung below active, with no Fanvue request", async () => {
    const h = harness();
    const rungs = [
      { env: {}, expected: "fixture_backed" },
      { env: configured, session: { ...grantedSession, scope: "read:self read:media" }, expected: "configured" },
      { env: configured, expected: "connected" },
      { env: configured, verified: captureCapabilities, expected: "verified" },
      { env: configured, activated: captureCapabilities, expected: "connected" },
      {
        env: configured,
        verified: captureCapabilities,
        activated: ["audience_discovery", "subscriber_state"] as const,
        expected: "verified",
      },
    ];
    for (const { expected, ...rung } of rungs) {
      const result = await h.run(rung);
      expect(result).toMatchObject({ status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE" });
      if (result.status === "REFUSED") expect(Object.values(result.capabilities ?? {})).toContain(expected);
    }
    expect(h.repositories).not.toHaveBeenCalled();
    expect(h.transportFactory).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM assignments").get()).toEqual({ n: 0 });
  });

  const active = { verified: captureCapabilities, activated: captureCapabilities };

  it("refuses a demo experiment, another creator's experiment and a different source", async () => {
    expect(await harness("DEMO").run(active)).toMatchObject({ reason: "NOT_REAL_PROVENANCE" });
    const h = harness();
    expect(await h.run({ ...active, session: { ...grantedSession, userUuid: "someone-else" } })).toMatchObject({
      reason: "EXPERIMENT_NOT_FOUND",
    });
    expect(await h.run({ ...active, source: { kind: "SMART", uuid: "auto_renewing" } })).toMatchObject({
      reason: "SOURCE_AUDIENCE_MISMATCH",
    });
    expect(h.transportFactory).not.toHaveBeenCalled();
  });

  it("captures and allocates only once every capture capability is active", async () => {
    const h = harness();
    expect(await h.run(active)).toEqual({ status: "ALLOCATED", snapshotCount: 6, armCounts: { A: 3, B: 3 } });
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM audience_member_evidence").get()).toEqual({ n: 6 });
  });
});
