import type { Arm } from "../../domain/allocation";
import {
  assignmentWindowStrategy,
  type PurchaseAttributionStrategy,
  type SendWindow,
} from "../../live/attribution";
import {
  json,
  LiveReadError,
  record,
  string,
  type FanvueReadTransport,
} from "./live-read-contracts";

/**
 * Only message sales and their reversals can belong to an experiment. Rewards (`referral`,
 * `affiliate`, `giveaway`) have no fan, `appStore` is the creator paying a developer, and
 * `earningsDeduction` takes earnings back without refunding the fan, so none of them is a fan
 * purchase and an unfamiliar shape there is not a data-quality failure.
 */
const relevantSources = new Set(["message", "refund", "chargeback"]);

type Earning = {
  transactionId: string;
  reversedTransactionId: string | null;
  fanUuid: string;
  messageUuid: string | null;
  messageType: string | null;
  occurredAt: string | null;
  source: string;
  grossMinor: number;
};

export type EarningsReconciliation = {
  settledPurchases: Readonly<Record<Arm, number>>;
  settledMinor: Readonly<Record<Arm, number>>;
  duplicateTransactions: number;
  ignoredRows: number;
  missingAssignments: readonly string[];
  orphanReversals: readonly string[];
  /** Settled rows placed by assignment and window although their message is not stored. */
  assignmentWindowOnly: number;
  /** Assigned, in-window BROADCAST rows that message-UUID matching left uncounted. */
  unmatchedPlausible: number;
  pagesRead: number;
};

function parseEarning(value: unknown): Earning | null {
  const item = record(value);
  const user = record(item?.user);
  const transactionId = string(item?.transactionOrderId);
  const source = string(item?.source);
  const fanUuid = string(user?.uuid);
  const gross = item?.gross;
  const messageUuid = item?.messageUuid === undefined || item.messageUuid === null
    ? null : string(item.messageUuid);
  const reversed = item?.reversedTransactionOrderId === undefined || item.reversedTransactionOrderId === null
    ? null : string(item.reversedTransactionOrderId);
  const messageType = item?.messageType == null ? null : string(item.messageType);
  const occurredAt = item?.date == null ? null : string(item.date);
  if (!transactionId || !source || !fanUuid || typeof gross !== "number" || !Number.isSafeInteger(gross) ||
      (item?.messageUuid != null && !messageUuid) || (item?.reversedTransactionOrderId != null && !reversed) ||
      (item?.messageType != null && !messageType) ||
      (occurredAt !== null && Number.isNaN(Date.parse(occurredAt)))) return null;
  return {
    transactionId, reversedTransactionId: reversed, fanUuid, messageUuid, messageType, occurredAt,
    source, grossMinor: gross,
  };
}

export async function reconcileExperimentEarnings(input: {
  startAt: string;
  endAt: string;
  messages: Readonly<Record<string, Arm>>;
  assignments: Readonly<Record<string, Arm>>;
  transport: FanvueReadTransport;
  maxPages?: number;
  /** ADR 0015. Defaults to assignment and window, with the read window as the send window. */
  attribution?: { strategy: PurchaseAttributionStrategy; window: SendWindow | null };
}): Promise<EarningsReconciliation> {
  if (Number.isNaN(Date.parse(input.startAt)) || Number.isNaN(Date.parse(input.endAt)) ||
      Date.parse(input.startAt) >= Date.parse(input.endAt)) throw new Error("A valid earnings reconciliation window is required");
  const rows = new Map<string, Earning>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let duplicateTransactions = 0;
  let ignoredRows = 0;
  let pagesRead = 0;
  do {
    if (pagesRead >= (input.maxPages ?? 1_000) || (cursor !== null && cursors.has(cursor))) {
      throw new LiveReadError("PAGINATION_LOOP", "Earnings pagination repeated or exceeded its bound.");
    }
    if (cursor) cursors.add(cursor);
    const query = new URLSearchParams({ startDate: input.startAt, endDate: input.endAt, size: "50" });
    if (cursor) query.set("cursor", cursor);
    const body = record(await json(await input.transport(`/v1/insights/earnings?${query}`)));
    if (!body || !Array.isArray(body.data) || !(body.nextCursor === null || typeof body.nextCursor === "string")) {
      throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned an invalid earnings page.");
    }
    pagesRead += 1;
    for (const raw of body.data) {
      const source = string(record(raw)?.source);
      if (source && !relevantSources.has(source)) continue;
      const row = parseEarning(raw);
      if (!row) {
        ignoredRows += 1;
        continue;
      }
      const prior = rows.get(row.transactionId);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(row)) {
          throw new LiveReadError("INVALID_RESPONSE", "A transaction ID was reused with different earnings content.");
        }
        duplicateTransactions += 1;
      } else rows.set(row.transactionId, row);
    }
    cursor = body.nextCursor as string | null;
  } while (cursor !== null);

  const reversed = new Set<string>();
  const orphanReversals: string[] = [];
  for (const row of rows.values()) {
    if ((row.source === "refund" || row.source === "chargeback") && row.reversedTransactionId) {
      reversed.add(row.reversedTransactionId);
      if (!rows.has(row.reversedTransactionId)) orphanReversals.push(row.transactionId);
    }
  }
  const settledPurchases: Record<Arm, number> = { A: 0, B: 0 };
  const settledMinor: Record<Arm, number> = { A: 0, B: 0 };
  const missingAssignments = new Set<string>();
  const strategy = input.attribution?.strategy ?? assignmentWindowStrategy;
  const window = input.attribution ? input.attribution.window : { startAt: input.startAt, endAt: input.endAt };
  let assignmentWindowOnly = 0;
  let unmatchedPlausible = 0;
  for (const row of rows.values()) {
    if (row.source !== "message" || reversed.has(row.transactionId)) continue;
    const candidate = {
      experimentId: "experiment",
      assignedArm: input.assignments[row.fanUuid] ?? null,
      messageArm: row.messageUuid ? input.messages[row.messageUuid] ?? null : null,
      window,
    };
    if (candidate.assignedArm === null && candidate.messageArm === null) continue;
    const decision = strategy.decide({
      purchaserUuid: row.fanUuid, messageUuid: row.messageUuid ?? "", messageType: row.messageType,
      occurredAt: row.occurredAt ?? input.startAt,
    }, [candidate]);
    if (decision.kind === "MISSING_ASSIGNMENT") {
      missingAssignments.add(row.fanUuid);
      continue;
    }
    if (decision.kind === "UNMATCHED_PLAUSIBLE") unmatchedPlausible += 1;
    if (decision.kind !== "ATTRIBUTED") continue;
    const arm = decision.arm;
    if (row.grossMinor < 0) {
      ignoredRows += 1;
      continue;
    }
    if (!decision.messageMatched) assignmentWindowOnly += 1;
    settledPurchases[arm] += 1;
    settledMinor[arm] += row.grossMinor;
  }
  return {
    settledPurchases,
    settledMinor,
    duplicateTransactions,
    ignoredRows,
    missingAssignments: [...missingAssignments],
    orphanReversals,
    assignmentWindowOnly,
    unmatchedPlausible,
    pagesRead,
  };
}
