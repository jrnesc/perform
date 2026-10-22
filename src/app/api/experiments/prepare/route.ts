import { createFanvueClient } from "@fanvue/builder-sdk";
import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import type { VariantDefinition } from "../../../../domain/experiment-state";
import { buildDryRunPlan } from "../../../../experiments/dry-run-plan";
import { buildExperimentReview } from "../../../../experiments/review";
import { FanvueMediaGateway } from "../../../../integrations/fanvue/fanvue-media-gateway";
import { createFanvueReadTransport } from "../../../../integrations/fanvue/read-transport";
import { captureLiveAudience, persistLiveAudienceSnapshot } from "../../../../live/audience-capture";
import { D1CapabilityRecordReader } from "../../../../live/capability-records";
import { captureCapabilities } from "../../../../live/capture-entry";
import { deriveCapabilityStates } from "../../../../live/capabilities";
import { D1PerformRepository, type SqlDatabase } from "../../../../persistence/d1-perform-repository";
import { D1LiveEvidenceRepository } from "../../../../persistence/live-evidence";

export const runtime = "nodejs";

type Body = {
  id?: unknown; name?: unknown; audienceId?: unknown; assetId?: unknown;
  variable?: unknown; hypothesis?: unknown; variants?: unknown;
};

function jsonError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, message }, ...extra }, { status });
}

function parseVariants(raw: unknown, mediaUuid: string): readonly VariantDefinition[] {
  if (!Array.isArray(raw)) throw new Error("Exactly two variants are required");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Every variant must be an object");
    const row = item as Record<string, unknown>;
    if (row.arm !== "A" && row.arm !== "B") throw new Error("Variants A and B are required");
    if (typeof row.copy !== "string" || typeof row.priceMinor !== "number") throw new Error(`Variant ${row.arm} is incomplete`);
    return { arm: row.arm, copy: row.copy, priceMinor: row.priceMinor, currency: "USD", mediaUuid };
  });
}

export async function POST(request: Request) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(secret);
  if (!session?.isCreator || !session.userUuid.trim()) return jsonError(401, "not_a_verified_creator", "Open Perform from Fanvue to reconnect.");
  const body = await request.json().catch(() => ({})) as Body;
  if (typeof body.id !== "string" || typeof body.name !== "string" ||
      body.audienceId !== "subscribers" || typeof body.assetId !== "string" ||
      (body.variable !== "COPY" && body.variable !== "PRICE") || typeof body.hypothesis !== "string") {
    return jsonError(400, "invalid_draft", "A complete experiment using the subscribers audience is required.");
  }
  const { env } = await getCloudflareContext({ async: true });
  if (!env.PERFORM_REAL_DB) return jsonError(503, "database_not_configured", "The real database is not configured.");
  const db = env.PERFORM_REAL_DB as unknown as SqlDatabase;
  const records = await new D1CapabilityRecordReader(db, session.userUuid).snapshot();
  const capabilities = deriveCapabilityStates({
    env: process.env, grantedScopes: (session.scope ?? "").split(/\s+/).filter(Boolean),
    verified: records.verified, activated: records.activated,
  });
  if (captureCapabilities.some((id) => capabilities[id].state !== "active")) {
    return jsonError(409, "capability_not_active", "Live audience capture is not active.", {
      capabilities: Object.fromEntries(captureCapabilities.map((id) => [id, capabilities[id].state])),
    });
  }

  try {
    const media = await new FanvueMediaGateway(createFanvueClient(session.accessToken, null, {
      apiVersion: process.env.FANVUE_API_VERSION ?? "2025-06-26",
    }).vault).getMedia(body.assetId);
    if (!media || media.status !== "ready") return jsonError(400, "invalid_asset", "Choose a ready Vault asset.");
    const variants = parseVariants(body.variants, media.id);
    const repository = new D1PerformRepository(db, session.userUuid, "REAL");
    const evidenceRepository = new D1LiveEvidenceRepository(db, session.userUuid, "REAL");
    let experiment = await repository.getExperiment(body.id);
    const now = new Date().toISOString();
    if (!experiment) {
      await repository.createExperiment({
        id: body.id, name: body.name, variable: body.variable, hypothesis: body.hypothesis,
        sourceAudienceUuid: "subscribers", variants, createdAt: now,
      });
      experiment = await repository.getExperiment(body.id);
    }
    if (!experiment) throw new Error("The experiment could not be read back");
    if (experiment.state === "DRAFT") {
      await repository.transitionExperiment({
        commandId: `${experiment.id}:snapshot:start`, experimentId: experiment.id,
        to: "SNAPSHOTTING", evidence: { variable: body.variable, variants }, occurredAt: now,
      });
      experiment = (await repository.getExperiment(experiment.id))!;
    }

    let assignments = await repository.listAssignments(experiment.id);
    let capturedAt = experiment.snapshotAt ?? now;
    if (experiment.state === "SNAPSHOTTING") {
      const capture = await captureLiveAudience({
        experimentId: experiment.id, source: { kind: "SMART", uuid: "subscribers" },
        capturedAt: now, assignmentCutoff: now,
        transport: createFanvueReadTransport({ accessToken: session.accessToken, coordinationKey: session.userUuid }),
      });
      if (capture.status === "INCOMPLETE") {
        return jsonError(422, "capture_incomplete", "The complete subscribers audience could not be frozen.", {
          reasons: capture.reasons, failedFanCount: capture.failedFanUuids.length,
        });
      }
      await persistLiveAudienceSnapshot({
        repository, evidenceRepository, experimentId: experiment.id,
        source: { kind: "SMART", uuid: "subscribers" }, capture,
        commandId: `${experiment.id}:snapshot:finalize`,
      });
      assignments = capture.assignments;
      capturedAt = capture.capturedAt;
    }
    if ((await repository.getExperiment(experiment.id))?.state !== "ALLOCATED") {
      throw new Error("Live preparation requires an allocated experiment");
    }
    const audience = {
      id: "subscribers", name: "Active subscribers",
      description: "Contactable subscribers read from Fanvue and frozen before launch.",
      sourceKind: "FANVUE_SMART_LIST" as const, capturedAt,
      members: assignments.map(({ fanUuid, stratum }) => ({ fanUuid, stratum })),
      sourceCount: assignments.length, exclusions: [],
      provenance: { kind: "FANVUE" as const, label: "Live Fanvue audience" as const },
    };
    const review = await buildExperimentReview({
      id: experiment.id, name: body.name, audience, asset: media,
      variable: body.variable, hypothesis: body.hypothesis, variants,
    });
    const plan = buildDryRunPlan(review, { liveLaunch: true });
    return NextResponse.json({
      review, plan, persistence: { database: "real", state: "ALLOCATED", saved: true },
    });
  } catch (error) {
    console.error("experiment.prepare_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(409, "prepare_failed", error instanceof Error ? error.message : "The experiment could not be prepared.");
  }
}
