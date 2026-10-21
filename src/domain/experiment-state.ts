import type { Arm } from "./allocation";
import { allocationAlgorithmVersion } from "./allocation";

export const experimentStates = [
  "DRAFT",
  "SNAPSHOTTING",
  "ALLOCATED",
  "PROVISIONING",
  "VERIFIED",
  "ARMED",
  "SENDING",
  "RUNNING",
  "PARTIAL_LAUNCH",
  "OPERATOR_REVIEW",
  "CLOSED",
  "INVALID",
] as const;

export type ExperimentState = (typeof experimentStates)[number];
export type ExperimentVariable = "COPY" | "PRICE";
export type SendStatus = "PENDING" | "CONFIRMED" | "FAILED" | "UNKNOWN";

export const experimentNameMaxLength = 120;

export function normalizeExperimentName(value: string): string {
  const name = value.trim();
  assert(name.length > 0, "An experiment name is required");
  assert(
    name.length <= experimentNameMaxLength,
    `Experiment names may contain at most ${experimentNameMaxLength} characters`,
  );
  return name;
}

export interface VariantDefinition {
  arm: Arm;
  copy: string;
  priceMinor: number;
  currency: string;
  mediaUuid: string;
}

export interface SnapshotEvidence {
  hash: string;
  eligibleCount: number;
  assignmentCount: number;
  armCounts: Readonly<Record<Arm, number>>;
  algorithmVersion: string;
}

export interface ProvisioningEvidence {
  armCounts: Readonly<Record<Arm, number>>;
  expectedArmCounts: Readonly<Record<Arm, number>>;
}

export interface SendIntentEvidence {
  arm: Arm;
  idempotencyKey: string;
  payloadHash: string;
  status: SendStatus;
  externalMessageUuid?: string;
}

export interface TransitionEvidence {
  variable?: ExperimentVariable;
  variants?: readonly VariantDefinition[];
  snapshot?: SnapshotEvidence;
  provisioning?: ProvisioningEvidence;
  sendIntents?: readonly SendIntentEvidence[];
  launchConfirmed?: boolean;
  observationEnded?: boolean;
  metricsFinal?: boolean;
  operatorReviewOpened?: boolean;
  invalidReason?: string;
}

export const allowedTransitions: Readonly<
  Record<ExperimentState, readonly ExperimentState[]>
> = {
  DRAFT: ["SNAPSHOTTING", "INVALID"],
  SNAPSHOTTING: ["ALLOCATED", "INVALID"],
  ALLOCATED: ["PROVISIONING", "INVALID"],
  PROVISIONING: ["VERIFIED", "INVALID"],
  VERIFIED: ["ARMED", "INVALID"],
  ARMED: ["SENDING", "INVALID"],
  SENDING: ["RUNNING", "PARTIAL_LAUNCH", "INVALID"],
  RUNNING: ["CLOSED", "INVALID"],
  PARTIAL_LAUNCH: ["OPERATOR_REVIEW", "INVALID"],
  OPERATOR_REVIEW: ["INVALID"],
  CLOSED: [],
  INVALID: [],
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateVariants(
  variable: ExperimentVariable,
  variants: readonly VariantDefinition[],
): void {
  assert(variants.length === 2, "Exactly two variants are required");
  const a = variants.find(({ arm }) => arm === "A");
  const b = variants.find(({ arm }) => arm === "B");
  assert(a && b, "Variants A and B are both required");

  for (const variant of variants) {
    assert(variant.copy.trim(), `Variant ${variant.arm} copy is required`);
    assert(
      Number.isSafeInteger(variant.priceMinor) && variant.priceMinor > 0,
      `Variant ${variant.arm} price must be a positive integer in minor units`,
    );
    assert(variant.currency.trim(), `Variant ${variant.arm} currency is required`);
    assert(variant.mediaUuid.trim(), `Variant ${variant.arm} media UUID is required`);
  }

  assert(a.currency === b.currency, "Variants must use the same currency");
  assert(a.mediaUuid === b.mediaUuid, "Variants must use the same media asset");

  if (variable === "COPY") {
    assert(a.priceMinor === b.priceMinor, "A copy test must keep price unchanged");
    assert(a.copy !== b.copy, "A copy test must use different copy");
  } else {
    assert(a.copy === b.copy, "A price test must keep copy unchanged");
    assert(a.priceMinor !== b.priceMinor, "A price test must use different prices");
  }
}

function validateSnapshot(snapshot: SnapshotEvidence | undefined): void {
  assert(snapshot, "A completed audience snapshot is required");
  assert(/^[a-f0-9]{64}$/.test(snapshot.hash), "Snapshot hash must be SHA-256");
  assert(snapshot.eligibleCount >= 2, "At least two eligible fans are required");
  assert(
    snapshot.assignmentCount === snapshot.eligibleCount,
    "Every eligible fan must have exactly one assignment",
  );
  assert(
    snapshot.armCounts.A + snapshot.armCounts.B === snapshot.assignmentCount,
    "Arm counts must equal the assignment count",
  );
  assert(snapshot.armCounts.A > 0 && snapshot.armCounts.B > 0, "Both arms must be non-empty");
  assert(
    snapshot.algorithmVersion === allocationAlgorithmVersion,
    "The persisted allocation algorithm version is not supported",
  );
}

function validateTwoSendIntents(
  intents: readonly SendIntentEvidence[] | undefined,
): readonly [SendIntentEvidence, SendIntentEvidence] {
  assert(intents?.length === 2, "Exactly two send intents are required");
  const a = intents.find(({ arm }) => arm === "A");
  const b = intents.find(({ arm }) => arm === "B");
  assert(a && b, "Send intents for arms A and B are required");
  assert(a.idempotencyKey && b.idempotencyKey, "Every send intent needs an idempotency key");
  assert(a.idempotencyKey !== b.idempotencyKey, "Send idempotency keys must be unique");
  assert(a.payloadHash && b.payloadHash, "Every send intent needs an immutable payload hash");
  return [a, b];
}

function validateTransitionEvidence(
  from: ExperimentState,
  to: ExperimentState,
  evidence: TransitionEvidence,
): void {
  if (to === "INVALID") {
    assert(evidence.invalidReason?.trim(), "Invalidation requires a reason");
    if (from === "SENDING") {
      const confirmed = evidence.sendIntents?.filter(({ status }) => status === "CONFIRMED") ?? [];
      assert(confirmed.length === 0, "A confirmed send requires the partial-launch path");
    }
    return;
  }

  if (from === "DRAFT" && to === "SNAPSHOTTING") {
    assert(evidence.variable && evidence.variants, "The experiment definition is required");
    validateVariants(evidence.variable, evidence.variants);
  } else if (from === "SNAPSHOTTING" && to === "ALLOCATED") {
    validateSnapshot(evidence.snapshot);
  } else if (from === "ALLOCATED" && to === "PROVISIONING") {
    validateSnapshot(evidence.snapshot);
  } else if (from === "PROVISIONING" && to === "VERIFIED") {
    const provisioning = evidence.provisioning;
    assert(provisioning, "Provisioning verification is required");
    assert(
      provisioning.armCounts.A === provisioning.expectedArmCounts.A &&
        provisioning.armCounts.B === provisioning.expectedArmCounts.B,
      "Both provisioned groups must exactly match their assignments",
    );
  } else if (from === "VERIFIED" && to === "ARMED") {
    validateTwoSendIntents(evidence.sendIntents);
    assert(evidence.launchConfirmed, "Arming requires deliberate launch confirmation");
  } else if (from === "ARMED" && to === "SENDING") {
    const intents = validateTwoSendIntents(evidence.sendIntents);
    assert(intents.every(({ status }) => status === "PENDING"), "Both sends must be pending");
  } else if (from === "SENDING" && to === "RUNNING") {
    const intents = validateTwoSendIntents(evidence.sendIntents);
    assert(
      intents.every(({ status, externalMessageUuid }) =>
        status === "CONFIRMED" && Boolean(externalMessageUuid),
      ),
      "Both sends must be confirmed with external message UUIDs",
    );
  } else if (from === "SENDING" && to === "PARTIAL_LAUNCH") {
    const intents = validateTwoSendIntents(evidence.sendIntents);
    assert(
      intents.filter(({ status }) => status === "CONFIRMED").length === 1,
      "A partial launch means exactly one send was confirmed",
    );
  } else if (from === "RUNNING" && to === "CLOSED") {
    assert(evidence.observationEnded, "The observation window must have ended");
    assert(evidence.metricsFinal, "Metrics must be final before closing");
  } else if (from === "PARTIAL_LAUNCH" && to === "OPERATOR_REVIEW") {
    assert(evidence.operatorReviewOpened, "An operator review must be opened");
  }
}

export function canTransition(from: ExperimentState, to: ExperimentState): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

/**
 * Validate and apply a lifecycle command. Repeating an already-applied command
 * is a no-op; it is not represented as a lifecycle self-edge.
 */
export function transition(
  from: ExperimentState,
  to: ExperimentState,
  evidence: TransitionEvidence = {},
): ExperimentState {
  if (from === to) return from;
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid experiment transition: ${from} → ${to}`);
  }
  validateTransitionEvidence(from, to, evidence);
  return to;
}
