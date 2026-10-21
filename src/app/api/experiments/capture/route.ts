import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { runGuardedLiveAudienceCapture } from "../../../../live/capture-entry";
import type { LiveCapabilityId } from "../../../../live/capabilities";
import { D1PerformRepository, type SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

/**
 * Nothing records a Phase X verification or an owner activation yet, so every capability stays
 * below `active` and this route refuses before it opens a database or makes a Fanvue request.
 */
const verifiedCapabilities: readonly LiveCapabilityId[] = [];
const activatedCapabilities: readonly LiveCapabilityId[] = [];

function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

export async function POST(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  const body = await request.json().catch(() => ({})) as { experimentId?: unknown };
  if (typeof body.experimentId !== "string" || !body.experimentId) {
    return jsonError(400, "experiment_required", "An experiment ID is required.");
  }

  const result = await runGuardedLiveAudienceCapture({
    session: session ? { userUuid: session.userUuid, isCreator: session.isCreator, scope: session.scope } : null,
    env: process.env,
    verified: verifiedCapabilities,
    activated: activatedCapabilities,
    experimentId: body.experimentId,
    // ADR 0009: the subscribers smart list is the only documented contactable source.
    source: { kind: "SMART", uuid: "subscribers" },
    repositories: async (creatorUuid) => {
      const { env } = await getCloudflareContext({ async: true });
      if (!env.PERFORM_REAL_DB) throw new Error("The real database is not configured");
      const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;
      return {
        repository: new D1PerformRepository(db, creatorUuid, "REAL"),
        evidenceRepository: new D1LiveEvidenceRepository(db, creatorUuid, "REAL"),
      };
    },
    transport: () => { throw new Error("No live Fanvue transport is wired"); },
    now: () => new Date().toISOString(),
    commandId: crypto.randomUUID(),
  });

  if (result.status === "REFUSED") {
    const status = result.reason === "NOT_A_VERIFIED_CREATOR" ? 401
      : result.reason === "EXPERIMENT_NOT_FOUND" ? 404
      : result.reason === "CAPABILITY_NOT_ACTIVE" ? 409 : 403;
    return jsonError(status, result.reason.toLowerCase(), "Live audience capture is not available.", {
      capabilities: result.capabilities ?? null,
    });
  }
  return NextResponse.json(result, { status: result.status === "ALLOCATED" ? 200 : 422 });
}
