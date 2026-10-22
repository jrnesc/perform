import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { D1PerformRepository, type SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { canUseDemoWorkspace } from "../../../../workspace/authorization";
import { buildDemoIntegrationContractProof } from "../../../../demo/integration-contract-proof";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  if (!session?.isCreator) return jsonError(401, "disconnected", "Open Perform from Fanvue to reconnect.");
  if (!canUseDemoWorkspace(
    session.userUuid,
    process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle,
    process.env.PERFORM_DEMO_CREATOR_HANDLES,
  )) {
    return jsonError(403, "demo_forbidden", "This verified creator is not authorised for demo results.");
  }
  try {
    const { env } = await getCloudflareContext({ async: true });
    if (!env.PERFORM_DEMO_DB) return jsonError(503, "database_not_configured", "The demo database is not configured.");
    const repository = new D1PerformRepository(
      env.PERFORM_DEMO_DB as unknown as SqlDatabase,
      session.userUuid,
      "DEMO",
    );
    const body = await request.json().catch(() => ({})) as { experimentId?: string };
    if (!body.experimentId) return jsonError(400, "experiment_required", "An experiment ID is required.");
    const experiment = await repository.getExperiment(body.experimentId);
    if (!experiment) return jsonError(404, "experiment_not_found", "That experiment is not in this workspace.");
    const result = await repository.getExperimentResult(experiment.id);
    const integrationProof = await buildDemoIntegrationContractProof();
    return NextResponse.json({
      fixtureVersion: "perform-demo-results-v1",
      provenance: "DEMO",
      experiment,
      result,
      availability: result ? "AVAILABLE" : "NO_EVIDENCE",
      learning: result?.learning ?? null,
      integrationProof,
      evidenceSources: {
        DEMO: "Versioned fictional evidence",
        DRY_RUN: "Planned action; no external effect",
        WEBHOOK_DERIVED: "Local signed-contract proof; no live receiver",
        FANVUE_RECONCILIATION: "Append-only local contract fixture; no live API read",
      },
      persistence: { database: "demo", saved: true },
    });
  } catch (error) {
    console.error("experiment.results_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(500, "results_failed", "Perform could not load the seeded result evidence.");
  }
}
