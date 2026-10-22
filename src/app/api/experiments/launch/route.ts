import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { createFanvueWriteTransport, fixtureFanvueWriteTransport } from "../../../../integrations/fanvue/write-transport";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { cancelScheduledLaunch, executeConfirmedLaunch } from "../../../../live/launch";
import { runGuardedRealLaunch } from "../../../../live/launch-entry";
import { D1LaunchRepository } from "../../../../live/launch-repository";
import { D1PerformRepository, type SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { canUseDemoWorkspace } from "../../../../workspace/authorization";

export const runtime = "nodejs";

type Body = { experimentId?: unknown; workspace?: unknown; scheduledAt?: unknown; confirmed?: unknown };

function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

async function hashConfirmation(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function context(body: Body) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return { error: jsonError(503, "not_configured", "Perform is not configured.") };
  const session = await getSession(sessionSecret);
  if (!session?.isCreator || !session.userUuid.trim()) {
    return { error: jsonError(401, "not_a_verified_creator", "Open Perform from Fanvue to reconnect.") };
  }
  if (typeof body.experimentId !== "string" || !body.experimentId.trim()) {
    return { error: jsonError(400, "experiment_required", "An experiment ID is required.") };
  }
  const workspace = body.workspace === "real" ? "real" as const : body.workspace === "demo" ? "demo" as const : null;
  if (!workspace) return { error: jsonError(400, "workspace_required", "Choose the real or seeded workspace.") };
  if (workspace === "demo" && !canUseDemoWorkspace(
    session.userUuid, process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle, process.env.PERFORM_DEMO_CREATOR_HANDLES,
  )) return { error: jsonError(403, "demo_forbidden", "This creator is not authorised for the seeded workspace.") };
  const { env } = await getCloudflareContext({ async: true });
  const binding = workspace === "real" ? env.PERFORM_REAL_DB : env.PERFORM_DEMO_DB;
  if (!binding) return { error: jsonError(503, "database_not_configured", "The selected database is not configured.") };
  const db = binding as unknown as SqlDatabase;
  return { session, workspace, db, experimentId: body.experimentId };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Body;
  const resolved = await context(body);
  if ("error" in resolved) return resolved.error;
  if (body.confirmed !== true || typeof body.scheduledAt !== "string") {
    return jsonError(400, "confirmation_required", "Confirm the exact effects and a scheduled delivery time.");
  }
  const repository = new D1PerformRepository(
    resolved.db, resolved.session.userUuid, resolved.workspace === "real" ? "REAL" : "DEMO",
  );
  const experiment = await repository.getExperiment(resolved.experimentId);
  if (!experiment) return jsonError(404, "experiment_not_found", "That experiment is not in this workspace.");
  const [variants, assignments] = await Promise.all([
    repository.listVariants(experiment.id), repository.listAssignments(experiment.id),
  ]);
  const confirmationHash = await hashConfirmation({
    experimentId: experiment.id, creatorUuid: resolved.session.userUuid,
    scheduledAt: body.scheduledAt, variants,
    recipients: {
      A: assignments.filter(({ arm }) => arm === "A").map(({ fanUuid }) => fanUuid).sort(),
      B: assignments.filter(({ arm }) => arm === "B").map(({ fanUuid }) => fanUuid).sort(),
    },
  });
  const launchRepository = new D1LaunchRepository(resolved.db, resolved.session.userUuid, experiment.id);
  try {
    if (resolved.workspace === "demo") {
      const result = await executeConfirmedLaunch({
        creatorUuid: resolved.session.userUuid, experimentId: experiment.id,
        scheduledAt: body.scheduledAt, confirmationHash, repository, launchRepository,
        transport: fixtureFanvueWriteTransport(), now: () => new Date().toISOString(),
      });
      return NextResponse.json({ provenance: "DEMO", externalRequests: 0, result });
    }
    const records = await new D1CapabilityRecordReader(resolved.db, resolved.session.userUuid).snapshot();
    const outcome = await runGuardedRealLaunch({
      session: {
        userUuid: resolved.session.userUuid, isCreator: resolved.session.isCreator,
        scope: resolved.session.scope,
      },
      env: process.env, records, experimentId: experiment.id,
      scheduledAt: body.scheduledAt, confirmationHash,
      repositories: async () => ({ repository, launchRepository }),
      transport: () => createFanvueWriteTransport({ accessToken: resolved.session.accessToken }),
      now: () => new Date().toISOString(),
    });
    if (outcome.status === "REFUSED") {
      return jsonError(outcome.reason === "EXPERIMENT_NOT_FOUND" ? 404 : 409, outcome.reason.toLowerCase(), "This real launch is not enabled.", { capability: outcome.capability ?? null });
    }
    return NextResponse.json({ provenance: "REAL", result: outcome.result });
  } catch (error) {
    console.error("experiment.launch_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(409, "launch_failed", error instanceof Error ? error.message : "The launch could not continue.");
  }
}

export async function DELETE(request: Request) {
  const body = await request.json().catch(() => ({})) as Body;
  const resolved = await context(body);
  if ("error" in resolved) return resolved.error;
  const repository = new D1PerformRepository(
    resolved.db, resolved.session.userUuid, resolved.workspace === "real" ? "REAL" : "DEMO",
  );
  const launchRepository = new D1LaunchRepository(resolved.db, resolved.session.userUuid, resolved.experimentId);
  if (resolved.workspace === "real" && process.env.PERFORM_WRITE_MODE !== "enabled") {
    return jsonError(409, "write_mode_disabled", "Real cancellation is disabled with the sending switch.");
  }
  try {
    const result = await cancelScheduledLaunch({
      experimentId: resolved.experimentId, repository, launchRepository,
      transport: resolved.workspace === "demo" ? fixtureFanvueWriteTransport()
        : createFanvueWriteTransport({ accessToken: resolved.session.accessToken }),
      now: () => new Date().toISOString(),
    });
    return NextResponse.json({ provenance: resolved.workspace === "demo" ? "DEMO" : "REAL", result });
  } catch (error) {
    return jsonError(409, "cancel_failed", error instanceof Error ? error.message : "Cancellation failed.");
  }
}
