import { describe, expect, it } from "vitest";
import { DEMO_VAULT_ASSETS } from "../workspace/demo-vault-v1";
import { DEMO_AUDIENCES } from "./demo-audiences-v1";
import { buildDryRunPlan } from "./dry-run-plan";
import { buildExperimentReview } from "./review";

function draft(variable: "COPY" | "PRICE" = "COPY") {
  const asset = DEMO_VAULT_ASSETS[0];
  const shared = {
    priceMinor: 1200,
    currency: "USD",
    mediaUuid: asset.id,
  };
  return {
    id: "experiment-setup-test",
    name: "Specific preview copy",
    audience: DEMO_AUDIENCES[0],
    asset,
    variable,
    hypothesis: "Specific copy will make the value clearer.",
    variants:
      variable === "COPY"
        ? ([
            { arm: "A", copy: "A new set is ready", ...shared },
            { arm: "B", copy: "See 12 new afterglow portraits", ...shared },
          ] as const)
        : ([
            { arm: "A", copy: "A new set is ready", ...shared },
            { arm: "B", copy: "A new set is ready", ...shared, priceMinor: 1500 },
          ] as const),
  };
}

describe("Phase 3 experiment review", () => {
  it("builds a deterministic, complete and disjoint allocation", async () => {
    const first = await buildExperimentReview(draft());
    const second = await buildExperimentReview(draft());
    expect(second).toEqual(first);
    expect(first.armCounts.A + first.armCounts.B).toBe(first.eligibleCount);
    expect(first.overlapCount).toBe(0);
    expect(first.exactDifference.field).toBe("copy");
  });

  it("rejects a demo audience combined with a live asset", async () => {
    const input = draft();
    await expect(
      buildExperimentReview({
        ...input,
        asset: { ...input.asset, id: "live-media", provenance: { kind: "FANVUE", label: "Live Fanvue Vault" } },
        variants: input.variants.map((variant) => ({ ...variant, mediaUuid: "live-media" })),
      }),
    ).rejects.toThrow(/provenance/);
  });
});

describe("Phase 3 dry-run plan", () => {
  it("describes two lists, bounded member batches and two messages without executing", async () => {
    const plan = buildDryRunPlan(await buildExperimentReview(draft()));
    expect(plan.summary).toEqual({
      listCreations: 2,
      memberBatches: 2,
      messages: 2,
      intendedRecipients: 24,
      executedEffects: 0,
    });
    expect(plan.effects.filter(({ path }) => path === "/v1/chats/mass-messages")).toHaveLength(2);
    expect(
      plan.effects
        .filter(({ id }) => id.startsWith("add-members-"))
        .every((effect) => {
          const body = effect.body as { userUuids: string[] };
          return body.userUuids.length > 0 && body.userUuids.length <= 100;
        }),
    ).toBe(true);
  });

  it("is deterministic and keeps every message field equal except the declared copy change", async () => {
    const review = await buildExperimentReview(draft());
    const first = buildDryRunPlan(review);
    const second = buildDryRunPlan(review);
    expect(second).toEqual(first);
    const messages = first.effects.filter(({ id }) => id.startsWith("send-message-"));
    const [a, b] = messages.map((effect) => effect.body as Record<string, unknown>);
    expect(a.text).not.toBe(b.text);
    expect({ ...a, text: "same", includedLists: "arm-list" }).toEqual({
      ...b,
      text: "same",
      includedLists: "arm-list",
    });
    expect(first.writeMode).toBe("disabled");
  });

  it("refuses payloads below Fanvue's documented 300-cent PPV minimum", async () => {
    const input = draft();
    const review = await buildExperimentReview({
      ...input,
      variants: input.variants.map((variant) => ({ ...variant, priceMinor: 299 })),
    });
    expect(() => buildDryRunPlan(review)).toThrow(/at least 300/);
  });
});
