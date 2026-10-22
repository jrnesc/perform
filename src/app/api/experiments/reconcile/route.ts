import { NextResponse } from "next/server";
import { fixtureReconciliationReadTransport } from "../../../../integrations/fanvue/fixture-read-transport";
import { createFanvueReadTransport } from "../../../../integrations/fanvue/read-transport";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { runGuardedReconciliation } from "../../../../live/lifecycle-entry";
import { D1LaunchRepository } from "../../../../live/launch-repository";
import { reconcileObservation } from "../../../../live/reconciliation";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

/**
 * Owner-run reconciliation until the operations phase schedules it (ADR 0020). Read-only against
 * Fanvue; appends one snapshot covering delivery to the observation end (or now).
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
  const newId = () => crypto.randomUUID();
  try {
    let record;
    if (provenance === "DEMO") {
      if (!await repositories.repository.getExperiment(experimentId)) {
        return jsonError(404, "experiment_not_found", "That experiment is not in this workspace.");
      }
      const context = await repositories.evidenceRepository.getAttributionContext(experimentId);
      record = await reconcileObservation({
        experimentId, creatorUuid: session.userUuid, ...repositories,
        transport: fixtureReconciliationReadTransport(Object.keys(context.messages)), now, newId,
      });
    } else {
      const records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
      const outcome = await runGuardedReconciliation({
        session: { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope },
        env: process.env, records, experimentId,
        repositories: async () => repositories,
        transport: () => createFanvueReadTransport({ accessToken: session.accessToken, coordinationKey: session.userUuid }),
        now, newId,
      });
      if (outcome.status === "REFUSED") {
        return jsonError(outcome.reason === "EXPERIMENT_NOT_FOUND" ? 404 : 409, outcome.reason.toLowerCase(),
          "Reconciling this real experiment is not enabled.", { capabilities: outcome.capabilities ?? null });
      }
      record = outcome.record;
    }
    return NextResponse.json({ provenance, reconciliation: record });
  } catch (error) {
    // A failed read appends nothing, so a missing snapshot is never mistaken for agreement.
    console.error("experiment.reconcile_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(409, "reconcile_failed", error instanceof Error ? error.message : "Reconciliation could not run.");
  }
}
