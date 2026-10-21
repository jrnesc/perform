import { allocateAudience, hashAudienceSnapshot } from "../domain/allocation";
import { normalizeExperimentName, validateVariants } from "../domain/experiment-state";
import { isDemoIdentifier } from "../workspace/contracts";
import type { ExactDifference, ExperimentDraft, ExperimentReview } from "./contracts";

function assertDemoBoundary(draft: ExperimentDraft): void {
  const audienceIsDemo = draft.audience.provenance.kind === "DEMO_SEEDED";
  const assetIsDemo = draft.asset.provenance.kind === "DEMO_SEEDED";
  if (audienceIsDemo !== assetIsDemo) {
    throw new Error("Audience and asset provenance must match");
  }
  if (audienceIsDemo && (!isDemoIdentifier(draft.audience.id) || !isDemoIdentifier(draft.asset.id))) {
    throw new Error("Demo setup requires namespaced demo identifiers");
  }
}

function exactDifference(draft: ExperimentDraft): ExactDifference {
  const a = draft.variants.find((variant) => variant.arm === "A");
  const b = draft.variants.find((variant) => variant.arm === "B");
  if (!a || !b) throw new Error("Variants A and B are required");
  return draft.variable === "COPY"
    ? { field: "copy", label: "Message copy", armA: a.copy, armB: b.copy }
    : {
        field: "priceMinor",
        label: "Price",
        armA: `${a.currency} ${(a.priceMinor / 100).toFixed(2)}`,
        armB: `${b.currency} ${(b.priceMinor / 100).toFixed(2)}`,
      };
}

export async function buildExperimentReview(draft: ExperimentDraft): Promise<ExperimentReview> {
  if (!draft.id.trim()) throw new Error("An experiment ID is required");
  normalizeExperimentName(draft.name);
  if (!draft.hypothesis.trim()) throw new Error("A hypothesis is required");
  if (draft.audience.members.length < 2) throw new Error("At least two eligible fans are required");
  if (draft.asset.status !== "ready") throw new Error("The selected asset must be ready");
  assertDemoBoundary(draft);
  validateVariants(draft.variable, draft.variants);

  const experimentId = draft.id;
  const assignments = allocateAudience(experimentId, draft.audience.members);
  const a = new Set(assignments.filter(({ arm }) => arm === "A").map(({ fanUuid }) => fanUuid));
  const b = new Set(assignments.filter(({ arm }) => arm === "B").map(({ fanUuid }) => fanUuid));
  const overlapCount = [...a].filter((fanUuid) => b.has(fanUuid)).length;
  if (overlapCount !== 0 || a.size + b.size !== assignments.length) {
    throw new Error("Allocation must be complete and disjoint");
  }

  return {
    experimentId,
    draft,
    exactDifference: exactDifference(draft),
    snapshotHash: await hashAudienceSnapshot(draft.audience.members),
    assignments,
    armCounts: { A: a.size, B: b.size },
    overlapCount,
    eligibleCount: assignments.length,
    excludedCount: draft.audience.exclusions.reduce((total, item) => total + item.count, 0),
    provenance: draft.asset.provenance,
  };
}
