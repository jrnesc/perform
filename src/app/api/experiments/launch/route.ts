import { NextResponse } from "next/server";
import { observationWindowProblem } from "../../../../domain/observation-window";
import { createFanvueWriteTransport, fixtureFanvueWriteTransport } from "../../../../integrations/fanvue/write-transport";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { cancelScheduledLaunch, executeConfirmedLaunch } from "../../../../live/launch";
import { runGuardedRealLaunch } from "../../../../live/launch-entry";
import { D1LaunchRepository } from "../../../../live/launch-repository";
import { D1PerformRepository } from "../../../../persistence/d1-perform-repository";
import { experimentRequestContext, jsonError } from "../workspace-context";

export const runtime = "nodejs";

type Body = {
  experimentId?: unknown; workspace?: unknown; scheduledAt?: unknown; observationEndsAt?: unknown; confirmed?: unknown;
};

async function hashConfirmation(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Body;
  const resolved = await experimentRequestContext(body);
  if ("error" in resolved) return resolved.error;
  if (body.confirmed !== true || typeof body.scheduledAt !== "string" || typeof body.observationEndsAt !== "string") {
    return jsonError(400, "confirmation_required", "Confirm the exact effects, a scheduled delivery time and an observation window.");
  }
  const windowProblem = observationWindowProblem(body.scheduledAt, body.observationEndsAt);
  if (windowProblem) return jsonError(400, "observation_window_invalid", `${windowProblem}.`);
  const observationEndsAt = body.observationEndsAt;
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
    scheduledAt: body.scheduledAt, observationEndsAt, variants,
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
        scheduledAt: body.scheduledAt, observationEndsAt, confirmationHash, repository, launchRepository,
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
      scheduledAt: body.scheduledAt, observationEndsAt, confirmationHash,
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
  const resolved = await experimentRequestContext(body);
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
