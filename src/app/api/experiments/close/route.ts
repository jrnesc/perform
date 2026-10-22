import { NextResponse } from "next/server";
import { createFanvueWriteTransport, fixtureFanvueWriteTransport } from "../../../../integrations/fanvue/write-transport";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { closeExperimentIfReady } from "../../../../live/close";
import { runGuardedClose } from "../../../../live/lifecycle-entry";
import { D1LaunchRepository } from "../../../../live/launch-repository";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

/**
 * Close a running experiment once its window has ended and its latest reconciliation is clean.
 * Returns 200 with CLOSED, or 409 naming every blocker. Seeded experiments use the fixture gateway.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { experimentId?: unknown; workspace?: unknown };
  const resolved = await experimentRequestContext(body);
  if ("error" in resolved) return resolved.error;
  const { session, db, experimentId } = resolved;
  const provenance = resolved.workspace === "real" ? "REAL" as const : "DEMO" as const;
  const repositories = {
    repository: new D1PerformRepository(db, session.userUuid, provenance),
    launchRepository: new D1LaunchRepository(db, session.userUuid, experimentId),
    evidenceRepository: new D1LiveEvidenceRepository(db, session.userUuid, provenance),
  };
  const now = () => new Date().toISOString();
  try {
    let result;
    if (provenance === "DEMO") {
      if (!await repositories.repository.getExperiment(experimentId)) {
        return jsonError(404, "experiment_not_found", "That experiment is not in this workspace.");
      }
      const latestReconciliation = (await repositories.evidenceRepository.listReconciliations(experimentId)).at(-1) ?? null;
      result = await closeExperimentIfReady({
        experimentId, latestReconciliation, ...repositories, transport: fixtureFanvueWriteTransport(), now,
      });
    } else {
      const records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
      const outcome = await runGuardedClose({
        session: { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope },
        env: process.env, records, experimentId,
        repositories: async () => repositories,
        transport: () => createFanvueWriteTransport({ accessToken: session.accessToken }),
        now,
      });
      if (outcome.status === "REFUSED") {
        return jsonError(outcome.reason === "EXPERIMENT_NOT_FOUND" ? 404 : 409, outcome.reason.toLowerCase(),
          "Closing this real experiment is not enabled.", { capabilities: outcome.capabilities ?? null });
      }
      result = outcome.result;
    }
    return NextResponse.json({ provenance, result }, { status: result.status === "CLOSED" ? 200 : 409 });
  } catch (error) {
    // The experiment stays RUNNING; journaled deletions make a retry delete only what remains.
    console.error("experiment.close_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(502, "close_failed", error instanceof Error ? error.message : "The experiment could not be closed.");
  }
}
