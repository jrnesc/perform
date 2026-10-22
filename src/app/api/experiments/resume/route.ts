import { createFanvueClient } from "@fanvue/builder-sdk";
import { NextResponse } from "next/server";
import { DEMO_AUDIENCES } from "../../../../experiments/demo-audiences-v1";
import { liveSubscribersAudience, rebuildSavedReview } from "../../../../experiments/saved-experiment";
import { FanvueMediaGateway } from "../../../../integrations/fanvue/fanvue-media-gateway";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { DEMO_VAULT_ASSETS } from "../../../../workspace/demo-vault-v1";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

/**
 * Rebuild the launch review of a saved, allocated experiment so it can be launched without
 * re-capturing its audience. Reads only: the Vault asset for REAL, fixtures for seeded.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { experimentId?: unknown; workspace?: unknown };
  const resolved = await experimentRequestContext(body);
  if ("error" in resolved) return resolved.error;
  const real = resolved.workspace === "real";
  const repository = new D1PerformRepository(resolved.db, resolved.session.userUuid, real ? "REAL" : "DEMO");
  try {
    const experiment = await repository.getExperiment(resolved.experimentId);
    if (!experiment) return jsonError(404, "experiment_not_found", "That experiment is not in this workspace.");
    const [variants, assignments] = await Promise.all([
      repository.listVariants(experiment.id), repository.listAssignments(experiment.id),
    ]);
    const mediaUuid = variants[0]?.mediaUuid;
    if (!mediaUuid) throw new Error("The saved experiment has no variants");
    const asset = real
      ? await new FanvueMediaGateway(createFanvueClient(resolved.session.accessToken, null, {
        apiVersion: process.env.FANVUE_API_VERSION ?? "2025-06-26",
      }).vault).getMedia(mediaUuid)
      : DEMO_VAULT_ASSETS.find(({ id }) => id === mediaUuid) ?? null;
    if (!asset || asset.status !== "ready") return jsonError(409, "asset_unavailable", "The saved Vault asset is no longer available.");
    const audience = real
      ? liveSubscribersAudience(assignments, experiment.snapshotAt ?? experiment.createdAt)
      : DEMO_AUDIENCES.find(({ id }) => id === experiment.sourceAudienceUuid);
    if (!audience) throw new Error("The saved audience is no longer available");
    const { review, plan } = await rebuildSavedReview({
      experiment, variants, assignments, audience, asset, liveLaunch: real,
    });
    return NextResponse.json({ review, plan, persistence: { database: resolved.workspace, state: "ALLOCATED", saved: true } });
  } catch (error) {
    console.error("experiment.resume_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(409, "resume_failed", error instanceof Error ? error.message : "The experiment could not be reopened.");
  }
}
