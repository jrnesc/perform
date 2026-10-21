import type { VariantDefinition } from "../../../../domain/experiment-state";
import { DEMO_AUDIENCES } from "../../../../experiments/demo-audiences-v1";
import { DEMO_EXPERIMENT_HISTORY } from "../../../../experiments/demo-experiment-history";
import { buildDryRunPlan } from "../../../../experiments/dry-run-plan";
import { buildExperimentReview } from "../../../../experiments/review";
import { buildDemoIntegrationContractProof } from "../../../../demo/integration-contract-proof";
import { analyseResult } from "../../../../results/analyse";
import { DEMO_RESULT_FIXTURES } from "../../../../results/demo-results-v1";
import { experimentResultDetail } from "../../../../results/experiment-results";
import { DEMO_VAULT_ASSETS } from "../../../../workspace/demo-vault-v1";

export const runtime = "nodejs";

function unavailable() {
  return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

function invalid(message: string) {
  return Response.json({ error: { code: "invalid_preview_draft", message } }, { status: 400 });
}

function parseVariants(raw: unknown, mediaUuid: string): readonly VariantDefinition[] {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("Exactly two variants are required");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Every variant must be an object");
    const candidate = item as Record<string, unknown>;
    if (candidate.arm !== "A" && candidate.arm !== "B") throw new Error("Variants A and B are required");
    if (typeof candidate.copy !== "string" || typeof candidate.priceMinor !== "number") {
      throw new Error(`Variant ${candidate.arm} requires copy and price`);
    }
    return {
      arm: candidate.arm,
      copy: candidate.copy,
      priceMinor: candidate.priceMinor,
      currency: "USD",
      mediaUuid,
    };
  });
}

export async function GET(_request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  if (resource === "media") {
    return Response.json({
      workspace: "demo",
      creator: { uuid: "preview:creator", displayName: "Local preview" },
      capabilities: { demoAvailable: true },
      page: {
        items: DEMO_VAULT_ASSETS,
        page: 1,
        pageSize: DEMO_VAULT_ASSETS.length,
        hasMore: false,
        total: DEMO_VAULT_ASSETS.length,
        provenance: { kind: "DEMO_SEEDED", label: "Seeded demo data", fixtureVersion: "perform-demo-vault-v1" },
      },
    });
  }
  if (resource === "audiences") {
    return Response.json({
      workspace: "demo",
      capabilities: { demoAvailable: true },
      audiences: DEMO_AUDIENCES,
    });
  }
  return unavailable();
}

export async function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  if (resource === "dry-run") {
    try {
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.id !== "string" || typeof body.name !== "string") {
        return invalid("Experiment ID and name are required.");
      }
      if (typeof body.audienceId !== "string" || typeof body.assetId !== "string") {
        return invalid("Audience and asset identifiers are required.");
      }
      if (body.variable !== "COPY" && body.variable !== "PRICE") {
        return invalid("The experiment variable must be COPY or PRICE.");
      }
      if (typeof body.hypothesis !== "string") return invalid("A hypothesis is required.");
      const audience = DEMO_AUDIENCES.find(({ id }) => id === body.audienceId);
      const asset = DEMO_VAULT_ASSETS.find(({ id }) => id === body.assetId);
      if (!audience || !asset) return invalid("The selected preview source is not recognised.");
      const review = await buildExperimentReview({
        id: body.id,
        name: body.name,
        audience,
        asset,
        variable: body.variable,
        hypothesis: body.hypothesis,
        variants: parseVariants(body.variants, asset.id),
      });
      return Response.json({
        review,
        plan: buildDryRunPlan(review),
        persistence: { database: "preview", state: "ALLOCATED", saved: true },
      });
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "The preview draft is invalid.");
    }
  }
  if (resource === "results") {
    const body = await request.json().catch(() => ({})) as { experimentId?: string };
    const experiment = DEMO_EXPERIMENT_HISTORY.find(({ id }) => id === body.experimentId);
    if (!experiment) return unavailable();
    const fixture = DEMO_RESULT_FIXTURES.find(({ experimentId }) => experimentId === experiment.id);
    const detail = experimentResultDetail(experiment, fixture ? analyseResult(fixture) : null);
    return Response.json({
      fixtureVersion: "perform-demo-results-v1",
      provenance: "DEMO",
      ...detail,
      learning: detail.result?.learning ?? null,
      integrationProof: await buildDemoIntegrationContractProof(),
      evidenceSources: {
        DEMO: "Versioned fictional evidence",
        DRY_RUN: "Planned action; no external effect",
        WEBHOOK_DERIVED: "Local signed-contract proof; no live receiver",
        FANVUE_RECONCILIATION: "Append-only local contract fixture; no live API read",
      },
      persistence: { database: "preview", saved: true },
    });
  }
  return unavailable();
}
