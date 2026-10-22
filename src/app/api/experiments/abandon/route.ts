import { NextResponse } from "next/server";
import {
  createFanvueWriteTransport,
  fixtureFanvueWriteTransport,
} from "../../../../integrations/fanvue/write-transport";
import { abandonInterruptedLaunch } from "../../../../live/abandon";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { runGuardedAbandon } from "../../../../live/lifecycle-entry";
import { D1LaunchRepository } from "../../../../live/launch-repository";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

/**
 * Abandon a launch that stopped before any message was scheduled: delete its confirmed custom
 * lists and mark it INVALID. Returns 200 with ABANDONED, or 409 naming what needs review first.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { experimentId?: unknown; workspace?: unknown };
  const resolved = await experimentRequestContext(body);
  if ("error" in resolved) return resolved.error;
  const { session, db, experimentId } = resolved;
  const provenance = resolved.workspace === "real" ? ("REAL" as const) : ("DEMO" as const);
  const repositories = {
    repository: new D1PerformRepository(db, session.userUuid, provenance),
    launchRepository: new D1LaunchRepository(db, session.userUuid, experimentId),
    evidenceRepository: new D1LiveEvidenceRepository(db, session.userUuid, provenance),
  };
  const now = () => new Date().toISOString();
  try {
    let result;
    if (provenance === "DEMO") {
      result = await abandonInterruptedLaunch({
        experimentId,
        ...repositories,
        transport: fixtureFanvueWriteTransport(),
        now,
      });
    } else {
      const records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
      const outcome = await runGuardedAbandon({
        session: { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope },
        env: process.env,
        records,
        experimentId,
        repositories: async () => repositories,
        transport: () => createFanvueWriteTransport({ accessToken: session.accessToken }),
        now,
      });
      if (outcome.status === "REFUSED") {
        return jsonError(
          outcome.reason === "EXPERIMENT_NOT_FOUND" ? 404 : 409,
          outcome.reason.toLowerCase(),
          "Abandoning this real launch is not enabled.",
          { capabilities: outcome.capabilities ?? null },
        );
      }
      result = outcome.result;
    }
    return NextResponse.json({ provenance, result }, { status: result.status === "ABANDONED" ? 200 : 409 });
  } catch (error) {
    // Journaled deletions make a retry delete only what remains; the state is unchanged.
    console.error("experiment.abandon_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(
      502,
      "abandon_failed",
      error instanceof Error ? error.message : "The launch could not be abandoned.",
    );
  }
}
