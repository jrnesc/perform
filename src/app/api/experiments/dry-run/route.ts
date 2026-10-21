import { getSession } from "@fanvue/builder-sdk/nextjs/embedded-app";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import type { VariantDefinition } from "../../../../domain/experiment-state";
import { DEMO_AUDIENCES } from "../../../../experiments/demo-audiences-v1";
import { buildDryRunPlan } from "../../../../experiments/dry-run-plan";
import { buildExperimentReview } from "../../../../experiments/review";
import {
  D1PerformRepository,
  assignmentChunkLimit,
  type SqlDatabase,
} from "../../../../persistence/d1-perform-repository";
import { canUseDemoWorkspace } from "../../../../workspace/authorization";
import { DEMO_VAULT_ASSETS } from "../../../../workspace/demo-vault-v1";

export const runtime = "nodejs";

type RequestBody = {
  id?: unknown;
  name?: unknown;
  audienceId?: unknown;
  assetId?: unknown;
  variable?: unknown;
  hypothesis?: unknown;
  variants?: unknown;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function parseVariants(raw: unknown, mediaUuid: string): readonly VariantDefinition[] {
  if (!Array.isArray(raw)) throw new Error("Exactly two variants are required");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Every variant must be an object");
    const candidate = item as Record<string, unknown>;
    if (candidate.arm !== "A" && candidate.arm !== "B") throw new Error("Variants A and B are required");
    if (typeof candidate.copy !== "string") throw new Error(`Variant ${candidate.arm} copy is required`);
    if (typeof candidate.priceMinor !== "number") throw new Error(`Variant ${candidate.arm} price is required`);
    return {
      arm: candidate.arm,
      copy: candidate.copy,
      priceMinor: candidate.priceMinor,
      currency: "USD",
      mediaUuid,
    };
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function persistDryRun(
  database: SqlDatabase,
  creatorUuid: string,
  review: Awaited<ReturnType<typeof buildExperimentReview>>,
  plan: ReturnType<typeof buildDryRunPlan>,
) {
  const repository = new D1PerformRepository(database, creatorUuid, "DEMO");
  let experiment = await repository.getExperiment(review.experimentId);
  const occurredAt = new Date().toISOString();

  if (!experiment) {
    await repository.createExperiment({
      id: review.experimentId,
      name: review.draft.name,
      variable: review.draft.variable,
      hypothesis: review.draft.hypothesis,
      sourceAudienceUuid: review.draft.audience.id,
      variants: review.draft.variants,
      createdAt: occurredAt,
    });
    experiment = await repository.getExperiment(review.experimentId);
  }
  if (!experiment) throw new Error("The persisted experiment could not be read back");
  if (
    experiment.variable !== review.draft.variable ||
    experiment.hypothesis !== review.draft.hypothesis ||
    experiment.sourceAudienceUuid !== review.draft.audience.id
  ) {
    throw new Error("The deterministic experiment ID is already bound to different inputs");
  }

  if (experiment.state === "DRAFT") {
    await repository.transitionExperiment({
      commandId: `${review.experimentId}:snapshot:start`,
      experimentId: review.experimentId,
      to: "SNAPSHOTTING",
      evidence: { variable: review.draft.variable, variants: review.draft.variants },
      occurredAt,
    });
    experiment = await repository.getExperiment(review.experimentId);
  }

  if (experiment?.state === "SNAPSHOTTING") {
    for (let index = 0; index < review.assignments.length; index += assignmentChunkLimit) {
      await repository.saveAssignmentChunk(
        review.experimentId,
        review.assignments.slice(index, index + assignmentChunkLimit),
        review.draft.audience.capturedAt,
      );
    }
    await repository.finalizeAllocation({
      commandId: `${review.experimentId}:snapshot:finalize`,
      experimentId: review.experimentId,
      snapshotHash: review.snapshotHash,
      snapshotCount: review.eligibleCount,
      armCounts: review.armCounts,
      algorithmVersion: review.assignments[0].algorithmVersion,
      snapshotAt: review.draft.audience.capturedAt,
    });
    experiment = await repository.getExperiment(review.experimentId);
  }

  if (experiment?.state !== "ALLOCATED") {
    throw new Error(`Dry-run persistence requires ALLOCATED state, received ${experiment?.state}`);
  }
  if (experiment.snapshotHash !== review.snapshotHash || experiment.snapshotCount !== review.eligibleCount) {
    throw new Error("Persisted snapshot evidence does not match the review");
  }

  const messageEffects = plan.effects.filter((effect) => effect.id.startsWith("send-message-"));
  await repository.createSendIntents(await Promise.all(messageEffects.map(async (effect) => {
    const arm = effect.id.endsWith("-a") ? "A" as const : "B" as const;
    const payloadJson = JSON.stringify(effect.body);
    return {
      id: `${review.experimentId}:intent:${arm}`,
      experimentId: review.experimentId,
      arm,
      idempotencyKey: effect.headers?.["Idempotency-Key"] ?? `${review.experimentId}:${arm}`,
      payloadJson,
      payloadHash: await sha256(payloadJson),
      createdAt: occurredAt,
    };
  })));

  return { database: "demo", state: "ALLOCATED" as const, saved: true };
}

export async function POST(request: Request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) return jsonError(503, "not_configured", "Perform is not configured.");
  const session = await getSession(sessionSecret);
  if (!session?.isCreator) return jsonError(401, "disconnected", "Open Perform from Fanvue to reconnect.");
  if (!canUseDemoWorkspace(
    session.userUuid,
    process.env.PERFORM_DEMO_CREATOR_UUIDS,
    session.handle,
    process.env.PERFORM_DEMO_CREATOR_HANDLES,
  )) {
    return jsonError(403, "demo_forbidden", "This verified creator is not authorised for the demo workspace.");
  }
  if ((process.env.PERFORM_WRITE_MODE ?? "disabled") !== "disabled") {
    return jsonError(503, "write_mode_refused", "Phase 3 persistence requires PERFORM_WRITE_MODE=disabled.");
  }

  try {
    const body = await request.json() as RequestBody;
    if (typeof body.id !== "string" || typeof body.name !== "string") {
      return jsonError(400, "invalid_draft", "Experiment ID and name are required.");
    }
    if (typeof body.audienceId !== "string" || typeof body.assetId !== "string") {
      return jsonError(400, "invalid_draft", "Audience and asset identifiers are required.");
    }
    if (body.variable !== "COPY" && body.variable !== "PRICE") {
      return jsonError(400, "invalid_draft", "The experiment variable must be COPY or PRICE.");
    }
    if (typeof body.hypothesis !== "string") {
      return jsonError(400, "invalid_draft", "A hypothesis is required.");
    }
    const audience = DEMO_AUDIENCES.find(({ id }) => id === body.audienceId);
    const asset = DEMO_VAULT_ASSETS.find(({ id }) => id === body.assetId);
    if (!audience || !asset) return jsonError(400, "invalid_demo_identifier", "The selected demo source is not recognised.");
    const variants = parseVariants(body.variants, asset.id);
    const review = await buildExperimentReview({
      id: body.id,
      name: body.name,
      audience,
      asset,
      variable: body.variable,
      hypothesis: body.hypothesis,
      variants,
    });
    const plan = buildDryRunPlan(review);
    const { env } = await getCloudflareContext({ async: true });
    if (!env.PERFORM_DEMO_DB) return jsonError(503, "database_not_configured", "The demo database is not configured.");
    const persistence = await persistDryRun(
      env.PERFORM_DEMO_DB as unknown as SqlDatabase,
      session.userUuid,
      review,
      plan,
    );
    return NextResponse.json({ review, plan, persistence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The dry-run could not be saved.";
    const invalid = /required|variant|price|copy|currency|media|provenance|dimension/i.test(message);
    console.error("experiment.dry_run_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return jsonError(
      invalid ? 400 : 500,
      invalid ? "invalid_draft" : "persistence_failed",
      invalid ? message : "Perform could not save the dry-run. Try again.",
    );
  }
}
