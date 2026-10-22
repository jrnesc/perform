import { describe, expect, it, vi } from "vitest";
import type { PerformRepository } from "../persistence/contracts";
import type { LiveEvidenceRepository } from "../persistence/live-evidence";
import { DEMO_RESULT_FIXTURES } from "../results/demo-results-v1";
import { assignmentWindowCaveat } from "./attribution";
import { liveResultsCapabilities, runGuardedLiveResults } from "./results-entry";

const scopes = "read:chat read:fan read:insights read:creator";
const env = {
  OAUTH_SCOPES: scopes,
  PERFORM_LIVE_CAPABILITIES: liveResultsCapabilities.join(","),
  FANVUE_WEBHOOK_SIGNING_SECRET: "configured-only",
  PERFORM_LIVE_CREATOR_UUID: "creator",
};
const session = { userUuid: "creator", isCreator: true, scope: scopes };

describe("REAL Results entry", () => {
  it("refuses below active without opening evidence repositories", async () => {
    const repositories = vi.fn();
    const result = await runGuardedLiveResults({
      session,
      env,
      records: { verified: [], activated: [] },
      experimentId: "experiment",
      repositories,
    });
    expect(result).toMatchObject({ status: "REFUSED", reason: "CAPABILITY_NOT_ACTIVE" });
    expect(repositories).not.toHaveBeenCalled();
  });

  function liveCopyExperiment(state: "RUNNING" | "CLOSED", reconciliations: readonly unknown[]) {
    const fixture = DEMO_RESULT_FIXTURES.find((item) => item.frozenAudience && item.commerceEvents?.length)!;
    const experimentId = "real-experiment";
    const rows = fixture.frozenAudience!.map((row) => ({ ...row, experimentId }));
    const events = fixture.commerceEvents!.map((event) => ({
      ...event,
      creatorUuid: "creator",
      ...(event.kind === "PAYMENT" ? { experimentId } : {}),
    }));
    const repository = {
      getExperiment: async () => ({
        id: experimentId,
        name: "Live result",
        creatorUuid: "creator",
        dataProvenance: "REAL",
        state,
        variable: "COPY",
        hypothesis: "Specific copy wins",
        sourceAudienceUuid: "subscribers",
        createdAt: fixture.observation.startedAt,
        updatedAt: fixture.observation.startedAt,
        launchedAt: fixture.observation.startedAt,
      }),
      listVariants: async () => fixture.variants,
    } as unknown as PerformRepository;
    const evidenceRepository = {
      listAudienceEvidence: async () => rows,
      listCommerceEvents: async () => events,
      listReconciliations: async () => reconciliations,
    } as unknown as LiveEvidenceRepository;
    const records = { verified: liveResultsCapabilities, activated: liveResultsCapabilities };
    return runGuardedLiveResults({
      session,
      env,
      records,
      experimentId,
      now: () => "2026-10-25T09:00:00.000Z",
      repositories: async () => ({ repository, evidenceRepository }),
    });
  }

  it("returns REAL-labelled shared evidence and the attribution caveat at active", async () => {
    const experimentId = "real-experiment";
    const result = await liveCopyExperiment("RUNNING", []);
    expect(result).toMatchObject({
      status: "AVAILABLE",
      provenance: "REAL",
      experimentId,
      breakdown: { provenance: "REAL", attributionStrategy: "ASSIGNMENT_WINDOW", caveat: assignmentWindowCaveat },
    });
  });

  it("analyses a running experiment but holds its verdict until close", async () => {
    const result = await liveCopyExperiment("RUNNING", []);
    if (result.status !== "AVAILABLE") throw new Error("expected live results");
    expect(result.analysis).toMatchObject({ status: "INCOMPLETE", observedDirection: { outcome: "B_LED" } });
    expect(result.analysis?.learning).toBeUndefined();
  });

  it("gives a closed, fully reconciled experiment the same verdict the seeded analysis would", async () => {
    const result = await liveCopyExperiment("CLOSED", [
      {
        capturedAt: "2026-10-19T10:00:00.000Z",
        windowStart: "2026-10-17T09:00:00.000Z",
        windowEnd: "2026-10-19T09:00:00.000Z",
        isComplete: true,
        attributionStrategy: "ASSIGNMENT_WINDOW",
      },
    ]);
    if (result.status !== "AVAILABLE") throw new Error("expected live results");
    expect(result.analysis).toMatchObject({
      status: "LEARNING_READY",
      confidence: { status: "DEPENDABLE" },
      arms: { A: { assignedRecipients: 120, settledBuyers: 12 }, B: { assignedRecipients: 120, settledBuyers: 30 } },
    });
    expect(result.analysis?.learning?.provenance).toBe("REAL");
  });
});
