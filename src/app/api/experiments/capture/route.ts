import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { runGuardedLiveAudienceCapture } from "../../../../live/capture-entry";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { createFanvueReadTransport } from "../../../../integrations/fanvue/read-transport";
import { D1PerformRepository, type SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

export async function POST(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  if (!session?.isCreator || !session.userUuid.trim()) {
    return jsonError(401, "not_a_verified_creator", "Open Perform from Fanvue to reconnect.");
  }
  const body = (await request.json().catch(() => ({}))) as { experimentId?: unknown };
  if (typeof body.experimentId !== "string" || !body.experimentId) {
    return jsonError(400, "experiment_required", "An experiment ID is required.");
  }

  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) return jsonError(503, "database_not_configured", "The real database is not configured.");
  const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;
  let records;
  try {
    records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
  } catch (error) {
    console.error("capability.records_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(503, "activation_records_unavailable", "Capability records are not available.");
  }

  const result = await runGuardedLiveAudienceCapture({
    session: session ? { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope } : null,
    env: process.env,
    verified: records.verified,
    activated: records.activated,
    experimentId: body.experimentId,
    // ADR 0009: the subscribers smart list is the only documented contactable source.
    source: { kind: "SMART", uuid: "subscribers" },
    repositories: async (creatorUuid) => {
      return {
        repository: new D1PerformRepository(db, creatorUuid, "REAL"),
        evidenceRepository: new D1LiveEvidenceRepository(db, creatorUuid, "REAL"),
      };
    },
    transport: () =>
      createFanvueReadTransport({
        accessToken: session.accessToken,
        coordinationKey: session.userUuid,
      }),
    now: () => new Date().toISOString(),
    commandId: crypto.randomUUID(),
  });

  if (result.status === "REFUSED") {
    const status =
      result.reason === "NOT_A_VERIFIED_CREATOR"
        ? 401
        : result.reason === "EXPERIMENT_NOT_FOUND"
          ? 404
          : result.reason === "CAPABILITY_NOT_ACTIVE"
            ? 409
            : 403;
    return jsonError(status, result.reason.toLowerCase(), "Live audience capture is not available.", {
      capabilities: result.capabilities ?? null,
    });
  }
  return NextResponse.json(result, { status: result.status === "ALLOCATED" ? 200 : 422 });
}
