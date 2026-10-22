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

  it("returns REAL-labelled shared evidence and the attribution caveat at active", async () => {
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
        state: "RUNNING",
        variable: "COPY",
        hypothesis: "Specific copy wins",
        sourceAudienceUuid: "subscribers",
        createdAt: fixture.observation.startedAt,
        updatedAt: fixture.observation.startedAt,
      }),
    } as unknown as PerformRepository;
    const evidenceRepository = {
      listAudienceEvidence: async () => rows,
      listCommerceEvents: async () => events,
      listReconciliations: async () => [],
    } as unknown as LiveEvidenceRepository;
    const records = { verified: liveResultsCapabilities, activated: liveResultsCapabilities };
    const result = await runGuardedLiveResults({
      session,
      env,
      records,
      experimentId,
      repositories: async () => ({ repository, evidenceRepository }),
    });
    expect(result).toMatchObject({
      status: "AVAILABLE",
      provenance: "REAL",
      experimentId,
      breakdown: { provenance: "REAL", attributionStrategy: "ASSIGNMENT_WINDOW", caveat: assignmentWindowCaveat },
    });
  });
});
