import { describe, expect, it } from "vitest";
import { allocationAlgorithmVersion } from "./allocation";
import {
  allowedTransitions,
  experimentStates,
  transition,
  validateVariants,
  type ExperimentState,
  type SendIntentEvidence,
  type SnapshotEvidence,
  type TransitionEvidence,
  type VariantDefinition,
} from "./experiment-state";

const copyVariants: readonly VariantDefinition[] = [
  { arm: "A", copy: "A preview", priceMinor: 1000, currency: "USD", mediaUuid: "media-1" },
  { arm: "B", copy: "A specific preview", priceMinor: 1000, currency: "USD", mediaUuid: "media-1" },
];

const snapshot: SnapshotEvidence = {
  hash: "a".repeat(64),
  eligibleCount: 10,
  assignmentCount: 10,
  armCounts: { A: 5, B: 5 },
  algorithmVersion: allocationAlgorithmVersion,
};

const pendingIntents: readonly SendIntentEvidence[] = [
  { arm: "A", idempotencyKey: "exp:A", payloadHash: "hash-a", status: "PENDING" },
  { arm: "B", idempotencyKey: "exp:B", payloadHash: "hash-b", status: "PENDING" },
];

const confirmedIntents: readonly SendIntentEvidence[] = pendingIntents.map((intent) => ({
  ...intent,
  status: "CONFIRMED",
  externalMessageUuid: `message-${intent.arm}`,
}));

function evidenceFor(from: ExperimentState, to: ExperimentState): TransitionEvidence {
  if (to === "INVALID") return { invalidReason: "Integrity check failed", sendIntents: pendingIntents };
  if (from === "DRAFT") return { variable: "COPY", variants: copyVariants };
  if (from === "SNAPSHOTTING" || from === "ALLOCATED") return { snapshot };
  if (from === "PROVISIONING") {
    return { provisioning: { armCounts: { A: 5, B: 5 }, expectedArmCounts: { A: 5, B: 5 } } };
  }
  if (from === "VERIFIED") return { sendIntents: pendingIntents, launchConfirmed: true };
  if (from === "ARMED") return { sendIntents: pendingIntents };
  if (from === "SENDING" && to === "RUNNING") return { sendIntents: confirmedIntents };
  if (from === "SENDING") {
    return { sendIntents: [confirmedIntents[0], { ...pendingIntents[1], status: "UNKNOWN" }] };
  }
  if (from === "RUNNING") return { observationEnded: true, metricsFinal: true };
  if (from === "PARTIAL_LAUNCH") return { operatorReviewOpened: true };
  return {};
}

describe("experiment variant invariants", () => {
  it("allows exactly one changed dimension", () => {
    expect(() => validateVariants("COPY", copyVariants)).not.toThrow();
    expect(() =>
      validateVariants("PRICE", [
        { ...copyVariants[0], copy: "same", priceMinor: 1000 },
        { ...copyVariants[1], copy: "same", priceMinor: 1200 },
      ]),
    ).not.toThrow();
  });

  it("rejects changing copy and price together", () => {
    expect(() => validateVariants("COPY", [copyVariants[0], { ...copyVariants[1], priceMinor: 1200 }])).toThrow(
      /keep price unchanged/,
    );
  });
});

describe("experiment state machine", () => {
  it("accepts every documented edge when its invariant evidence is present", () => {
    for (const from of experimentStates) {
      for (const to of allowedTransitions[from]) {
        expect(transition(from, to, evidenceFor(from, to))).toBe(to);
      }
    }
  });

  it("rejects every undocumented edge", () => {
    for (const from of experimentStates) {
      for (const to of experimentStates) {
        if (from === to || allowedTransitions[from].includes(to)) continue;
        expect(() => transition(from, to)).toThrow(/Invalid experiment transition/);
      }
    }
  });

  it("treats a repeated transition command as an idempotent no-op", () => {
    expect(transition("ALLOCATED", "ALLOCATED")).toBe("ALLOCATED");
  });

  it("requires a complete frozen snapshot before allocation", () => {
    expect(() =>
      transition("SNAPSHOTTING", "ALLOCATED", {
        snapshot: { ...snapshot, assignmentCount: 9 },
      }),
    ).toThrow(/Every eligible fan/);
  });

  it("requires exact provisioned membership before verification", () => {
    expect(() =>
      transition("PROVISIONING", "VERIFIED", {
        provisioning: { armCounts: { A: 5, B: 4 }, expectedArmCounts: { A: 5, B: 5 } },
      }),
    ).toThrow(/exactly match/);
  });

  it("never treats a one-sided send as a running or valid result", () => {
    const partial = [confirmedIntents[0], { ...pendingIntents[1], status: "UNKNOWN" }] as const;
    expect(() => transition("SENDING", "RUNNING", { sendIntents: partial })).toThrow();
    expect(transition("SENDING", "PARTIAL_LAUNCH", { sendIntents: partial })).toBe("PARTIAL_LAUNCH");
    expect(() => transition("PARTIAL_LAUNCH", "CLOSED")).toThrow();
  });

  it("requires an invalidation reason", () => {
    expect(() => transition("DRAFT", "INVALID")).toThrow(/reason/);
  });
});
