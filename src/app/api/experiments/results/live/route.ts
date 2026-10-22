import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { D1CapabilityRecordReader } from "../../../../../live/capability-records";
import { runGuardedLiveResults } from "../../../../../live/results-entry";
import { D1PerformRepository, type SqlDatabase } from "../../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../../persistence/live-evidence";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

export async function GET(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  if (!session?.isCreator) return jsonError(401, "disconnected", "Open Perform from Fanvue to reconnect.");
  const experimentId = new URL(request.url).searchParams.get("experimentId");
  if (!experimentId) return jsonError(400, "experiment_required", "An experiment ID is required.");
  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) return jsonError(503, "database_not_configured", "The real database is not configured.");
  const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;
  let records;
  try {
    records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
  } catch (error) {
    console.error("results.activation_records_unavailable", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return jsonError(503, "activation_records_unavailable", "Capability records are not available.");
  }
  const result = await runGuardedLiveResults({
    session: { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope },
    env: process.env,
    records,
    experimentId,
    repositories: async (creatorUuid) => ({
      repository: new D1PerformRepository(db, creatorUuid, "REAL"),
      evidenceRepository: new D1LiveEvidenceRepository(db, creatorUuid, "REAL"),
    }),
  });
  if (result.status === "REFUSED") {
    const status =
      result.reason === "EXPERIMENT_NOT_FOUND" ? 404 : result.reason === "CAPABILITY_NOT_ACTIVE" ? 409 : 403;
    return jsonError(status, result.reason.toLowerCase(), "Live Results are not available.", {
      capabilities: result.capabilities ?? null,
    });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
