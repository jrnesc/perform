import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { buildOperatorEvidenceView } from "../../../../live/operator-view";
import type { SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Read-only operator view of live commerce evidence. It exists only once the owner sets
 * PERFORM_LIVE_CREATOR_UUID, answers only that verified creator, reads only PERFORM_REAL_DB and
 * never writes or calls Fanvue.
 */
export async function GET() {
  const liveCreatorUuid = process.env.PERFORM_LIVE_CREATOR_UUID;
  if (!liveCreatorUuid) return jsonError(404, "not_found", "Not found");
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  if (!session?.isCreator) return jsonError(401, "disconnected", "Open Perform from Fanvue to reconnect.");
  if (session.userUuid !== liveCreatorUuid)
    return jsonError(403, "operator_forbidden", "This creator is not the live operator.");

  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) return jsonError(503, "database_not_configured", "The real database is not configured.");
  try {
    const reads = new D1LiveEvidenceRepository(env.PERFORM_REAL_DB as unknown as SqlDatabase, liveCreatorUuid, "REAL");
    return NextResponse.json(await buildOperatorEvidenceView(reads), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Before migration 0004 is applied the tables do not exist; say so without detail.
    console.error("operator.live_evidence_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(503, "evidence_unavailable", "Live evidence tables are not available.");
  }
}
