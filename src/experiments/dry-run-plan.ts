import type { Arm } from "../domain/allocation";
import type { DryRunEffect, DryRunPlan, ExperimentReview } from "./contracts";

const batchSize = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

function armEffects(review: ExperimentReview, arm: Arm): DryRunEffect[] {
  const suffix = arm.toLowerCase();
  const listRef = `$effect:create-list-${suffix}.uuid`;
  const members = review.assignments
    .filter((assignment) => assignment.arm === arm)
    .map((assignment) => assignment.fanUuid)
    .sort();
  const variant = review.draft.variants.find((item) => item.arm === arm);
  if (!variant) throw new Error(`Variant ${arm} is required`);

  const create: DryRunEffect = {
    id: `create-list-${suffix}`,
    method: "POST",
    path: "/v1/chats/lists/custom",
    purpose: `Perform will create the isolated recipient list for arm ${arm}`,
    body: { name: `Perform ${review.experimentId} · ${arm}` },
  };
  const memberEffects = chunks(members, batchSize).map<DryRunEffect>((userUuids, index) => ({
    id: `add-members-${suffix}-${index + 1}`,
    method: "POST",
    path: `/v1/chats/lists/custom/${listRef}/members`,
    purpose: `Perform will add arm ${arm} members, batch ${index + 1}`,
    body: { userUuids },
  }));
  const message: DryRunEffect = {
    id: `send-message-${suffix}`,
    method: "POST",
    path: "/v1/chats/mass-messages",
    purpose: `Perform will send the PPV message for arm ${arm}`,
    headers: { "Idempotency-Key": `${review.experimentId}:${arm}` },
    body: {
      text: variant.copy,
      includedLists: { customListUuids: [listRef] },
      excludedLists: {},
      mediaUuids: [variant.mediaUuid],
      price: variant.priceMinor,
    },
  };
  return [create, ...memberEffects, message];
}

/** Build data only. This module deliberately exposes no effect executor. */
export function buildDryRunPlan(review: ExperimentReview): DryRunPlan {
  if (review.overlapCount !== 0) throw new Error("A dry run requires zero cohort overlap");
  if (review.provenance.kind === "FANVUE") {
    throw new Error("Phase 3 dry runs accept the server-authorised demo audience only");
  }
  for (const variant of review.draft.variants) {
    if (variant.copy.length > 5_000) throw new Error(`Variant ${variant.arm} copy exceeds 5000 characters`);
    if (!Number.isSafeInteger(variant.priceMinor) || variant.priceMinor < 300) {
      throw new Error(`Variant ${variant.arm} price must be at least 300 USD cents`);
    }
  }
  const effects = [...armEffects(review, "A"), ...armEffects(review, "B")];
  const memberBatches = effects.filter((effect) => effect.id.startsWith("add-members-")).length;
  return {
    version: "perform-dry-run-v1",
    mode: "DRY_RUN",
    writeMode: "disabled",
    experimentId: review.experimentId,
    snapshotHash: review.snapshotHash,
    provenance: review.provenance,
    summary: {
      listCreations: 2,
      memberBatches,
      messages: 2,
      intendedRecipients: review.eligibleCount,
      executedEffects: 0,
    },
    effects,
  };
}
