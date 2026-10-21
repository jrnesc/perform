import type { Arm } from "../domain/allocation";

/**
 * Purchase attribution (ADR 0015). Fanvue does not document whether a payment's `message_uuid`
 * equals the mass-message UUID returned by a send, so attribution must not depend on it.
 *
 * - `MESSAGE_UUID_MATCH`: a payment belongs to an arm only when its message UUID is a stored,
 *   confirmed experiment message. Valid only once a real send proves the UUIDs are equal.
 * - `ASSIGNMENT_WINDOW`: the default. A BROADCAST message purchase by a fan with a frozen
 *   assignment, made inside that experiment's send window, belongs to the fan's assigned arm.
 *   A fan's unrelated broadcast purchases in the window add noise, but not arm bias, because
 *   assignment is randomised.
 *
 * Either way, a purchase that matches the assignment-window rule but not a stored message is
 * counted, so a UUID mismatch is visible instead of silent.
 */
export const attributionStrategyIds = ["MESSAGE_UUID_MATCH", "ASSIGNMENT_WINDOW"] as const;
export type AttributionStrategyId = (typeof attributionStrategyIds)[number];

export const defaultAttributionStrategy: AttributionStrategyId = "ASSIGNMENT_WINDOW";

/** Only a mass message can carry an experiment variant. Fanvue's `messageType` for one. */
export const broadcastMessageType = "BROADCAST";

export type AttributablePayment = {
  purchaserUuid: string;
  messageUuid: string;
  /** Fanvue `message_type` / `messageType`; null when the payload omits it. */
  messageType: string | null;
  occurredAt: string;
};

/** `endAt` null means the observation is still open. */
export type SendWindow = { startAt: string; endAt: string | null };

/** One experiment the purchaser is assigned to, or whose stored message the payment names. */
export type AttributionCandidate = {
  experimentId: string;
  assignedArm: Arm | null;
  messageArm: Arm | null;
  window: SendWindow | null;
};

export type AttributionDecision =
  | { kind: "ATTRIBUTED"; experimentId: string; arm: Arm; messageMatched: boolean }
  /** A stored experiment message bought by a fan without the matching frozen assignment. */
  | { kind: "MISSING_ASSIGNMENT"; experimentId: string; arm: Arm }
  /** Assigned fan, in window, BROADCAST, unknown message, under message-UUID matching. */
  | { kind: "UNMATCHED_PLAUSIBLE"; experimentId: string; arm: Arm }
  /** Plausible for more than one experiment's window; never guessed. */
  | { kind: "AMBIGUOUS"; experimentIds: readonly string[] }
  | { kind: "UNRELATED" };

export interface PurchaseAttributionStrategy {
  readonly id: AttributionStrategyId;
  decide(payment: AttributablePayment, candidates: readonly AttributionCandidate[]): AttributionDecision;
}

export function inSendWindow(occurredAt: string, window: SendWindow | null): boolean {
  if (!window) return false;
  const at = Date.parse(occurredAt);
  return !Number.isNaN(at) && at >= Date.parse(window.startAt) &&
    (window.endAt === null || at < Date.parse(window.endAt));
}

function messageMatch(candidates: readonly AttributionCandidate[]): AttributionDecision | null {
  const matched = candidates.filter((candidate) => candidate.messageArm !== null);
  if (matched.length === 0) return null;
  if (matched.length > 1) return { kind: "AMBIGUOUS", experimentIds: matched.map((c) => c.experimentId) };
  const [candidate] = matched;
  return candidate.assignedArm === candidate.messageArm
    ? { kind: "ATTRIBUTED", experimentId: candidate.experimentId, arm: candidate.messageArm!, messageMatched: true }
    : { kind: "MISSING_ASSIGNMENT", experimentId: candidate.experimentId, arm: candidate.messageArm! };
}

function plausible(payment: AttributablePayment, candidates: readonly AttributionCandidate[]) {
  if (payment.messageType !== broadcastMessageType) return [];
  return candidates.filter((candidate) =>
    candidate.assignedArm !== null && inSendWindow(payment.occurredAt, candidate.window));
}

export const messageUuidMatchStrategy: PurchaseAttributionStrategy = {
  id: "MESSAGE_UUID_MATCH",
  decide(payment, candidates) {
    const matched = messageMatch(candidates);
    if (matched) return matched;
    const rest = plausible(payment, candidates);
    if (rest.length > 1) return { kind: "AMBIGUOUS", experimentIds: rest.map((c) => c.experimentId) };
    return rest.length === 1
      ? { kind: "UNMATCHED_PLAUSIBLE", experimentId: rest[0].experimentId, arm: rest[0].assignedArm! }
      : { kind: "UNRELATED" };
  },
};

export const assignmentWindowStrategy: PurchaseAttributionStrategy = {
  id: "ASSIGNMENT_WINDOW",
  decide(payment, candidates) {
    const matched = messageMatch(candidates);
    if (matched) return matched;
    const rest = plausible(payment, candidates);
    if (rest.length > 1) return { kind: "AMBIGUOUS", experimentIds: rest.map((c) => c.experimentId) };
    return rest.length === 1
      ? { kind: "ATTRIBUTED", experimentId: rest[0].experimentId, arm: rest[0].assignedArm!, messageMatched: false }
      : { kind: "UNRELATED" };
  },
};

export function attributionStrategy(id: AttributionStrategyId): PurchaseAttributionStrategy {
  return id === "MESSAGE_UUID_MATCH" ? messageUuidMatchStrategy : assignmentWindowStrategy;
}

/**
 * Message-UUID matching is only selectable with a recorded proof from a real send that the
 * payment and mass-message UUIDs are equal. Nothing records that proof yet, so every caller
 * passes false and gets the assignment-window strategy.
 */
export function selectAttributionStrategy(input: {
  requested?: AttributionStrategyId;
  messageUuidEqualityProven: boolean;
}): PurchaseAttributionStrategy {
  if (input.requested === "MESSAGE_UUID_MATCH" && input.messageUuidEqualityProven) return messageUuidMatchStrategy;
  return assignmentWindowStrategy;
}

/** Results copy shown with any live breakdown attributed by assignment and window. */
export const assignmentWindowCaveat =
  "Purchases are attributed by the buyer's frozen assignment and the send window, not by message ID. " +
  "A fan's unrelated broadcast purchases in the window add noise to both arms, but not bias, because assignment is randomised.";
