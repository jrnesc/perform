import {
  json,
  LiveReadError,
  nonNegativeInteger,
  record,
  string,
  type FanvueReadTransport,
} from "./live-read-contracts";

/**
 * Per-fan subscription history (`GET /v1/subscribers/{userUuid}/history`, `read:fan`, ADR 0014).
 * Items are paid periods, newest first by `paidAt`, cursor-paginated (`size` 1–50). Checkout-link
 * subscriptions appear only when the token also holds `read:creator`, which Perform does not
 * request for this boundary, so only `profile` periods are counted and other sources are ignored.
 */
const eventTypes = new Set(["subscribe", "trial", "renew"]);
const maxConcurrency = 6; // Fanvue allows 6 requests in flight per OAuth client and user.

export type FrozenSubscriptionHistory = {
  fanUuid: string;
  capturedAt: string;
  /** Earliest `periodStart` among valid profile periods. */
  earliestSubscriptionAt: string | null;
  validPeriodCount: number;
  hasTrial: boolean;
  /** A valid paid start (`subscribe`) that followed a lapse. */
  resubscribedAfterLapse: boolean;
  latestValidType: "subscribe" | "trial" | "renew" | null;
  /** Periods dropped because they were refunded or charged back. */
  reversedPeriodCount: number;
  /** Periods paid after the assignment cutoff; never used. */
  periodsAfterCutoffIgnored: number;
};

export type SubscriptionHistoryErrorKind = "malformed" | "not_found" | "pagination";

export type SubscriptionHistoryRead = {
  snapshots: readonly FrozenSubscriptionHistory[];
  errors: Readonly<Record<string, SubscriptionHistoryErrorKind>>;
  requestsMade: number;
};

type Period = {
  type: "subscribe" | "trial" | "renew";
  paidAt: string;
  periodStart: string;
  followsLapse: boolean;
  reversed: boolean;
};

function timestamp(value: unknown): string | null {
  const text = string(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

/** Returns a counted profile period, "skip" for an unrecognised source, or null if malformed. */
function parsePeriod(value: unknown): Period | "skip" | null {
  const item = record(value);
  const source = string(item?.source);
  if (!item || !source) return null;
  // The documentation says more sources may be added; ignore ones we do not understand.
  if (source !== "profile") return "skip";
  const type = string(item.type);
  const paidAt = timestamp(item.paidAt);
  const periodStart = timestamp(item.periodStart);
  const periodEnd = item.periodEnd === null ? null : timestamp(item.periodEnd);
  if (
    !type ||
    !eventTypes.has(type) ||
    !paidAt ||
    !periodStart ||
    (item.periodEnd !== null && !periodEnd) ||
    nonNegativeInteger(item.amountPaid) === null ||
    typeof item.followsLapse !== "boolean" ||
    typeof item.refunded !== "boolean" ||
    typeof item.chargedBack !== "boolean"
  )
    return null;
  return {
    type: type as Period["type"],
    paidAt,
    periodStart,
    followsLapse: item.followsLapse,
    reversed: item.refunded || item.chargedBack,
  };
}

function summarise(
  fanUuid: string,
  periods: readonly Period[],
  capturedAt: string,
  cutoff: number,
): FrozenSubscriptionHistory {
  const before = periods.filter((period) => Date.parse(period.paidAt) <= cutoff);
  const valid = before.filter((period) => !period.reversed).sort((a, b) => Date.parse(a.paidAt) - Date.parse(b.paidAt));
  const starts = valid.map((period) => Date.parse(period.periodStart));
  return {
    fanUuid,
    capturedAt,
    earliestSubscriptionAt: valid.length ? new Date(Math.min(...starts)).toISOString() : null,
    validPeriodCount: valid.length,
    hasTrial: valid.some((period) => period.type === "trial"),
    resubscribedAfterLapse: valid.some((period) => period.type === "subscribe" && period.followsLapse),
    latestValidType: valid.at(-1)?.type ?? null,
    reversedPeriodCount: before.filter((period) => period.reversed).length,
    periodsAfterCutoffIgnored: periods.length - before.length,
  };
}

/** Freeze subscription lineage per fan, using only periods paid at or before the cutoff. */
export async function readSubscriptionHistories(input: {
  fanUuids: readonly string[];
  capturedAt: string;
  assignmentCutoff: string;
  transport: FanvueReadTransport;
  pageSize?: number;
  maxPagesPerFan?: number;
  concurrency?: number;
}): Promise<SubscriptionHistoryRead> {
  const captured = Date.parse(input.capturedAt);
  const cutoff = Date.parse(input.assignmentCutoff);
  if (Number.isNaN(captured) || Number.isNaN(cutoff) || captured > cutoff) {
    throw new Error("Subscription history must be captured no later than the assignment cutoff");
  }
  const pageSize = input.pageSize ?? 50;
  const maxPages = input.maxPagesPerFan ?? 20;
  const concurrency = input.concurrency ?? 4;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("Subscription history page size must be between 1 and 50");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > maxConcurrency) {
    throw new Error(`Subscription history concurrency must be between 1 and ${maxConcurrency}`);
  }
  const unique = [...new Set(input.fanUuids.map((uuid) => uuid.trim()))];
  if (unique.some((uuid) => !uuid)) throw new Error("Fan UUIDs must be non-empty");

  const snapshots = new Map<string, FrozenSubscriptionHistory>();
  const errors: Record<string, SubscriptionHistoryErrorKind> = {};
  let requestsMade = 0;
  let abort: LiveReadError | null = null;

  async function readFan(fanUuid: string) {
    const periods = new Map<string, Period>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (pages >= maxPages || (cursor !== null && cursors.has(cursor))) {
        errors[fanUuid] = "pagination";
        return;
      }
      if (cursor) cursors.add(cursor);
      const query = new URLSearchParams({ size: String(pageSize) });
      if (cursor) query.set("cursor", cursor);
      const response: Response = await input.transport(
        `/v1/subscribers/${encodeURIComponent(fanUuid)}/history?${query}`,
      );
      requestsMade += 1;
      pages += 1;
      if (response.status === 404) {
        errors[fanUuid] = "not_found";
        return;
      }
      const body = record(await json(response));
      const next = body?.nextCursor;
      if (!body || !Array.isArray(body.data) || !(next === null || typeof next === "string")) {
        errors[fanUuid] = "malformed";
        return;
      }
      for (const raw of body.data) {
        const period = parsePeriod(raw);
        if (period === "skip") continue;
        if (!period) {
          errors[fanUuid] = "malformed";
          return;
        }
        // No event ID exists, so identical periods repeated across pages collapse and
        // conflicting repeats cannot be told apart from corruption.
        const key = `${period.type}|${period.paidAt}|${period.periodStart}`;
        const prior = periods.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(period)) {
          errors[fanUuid] = "malformed";
          return;
        }
        periods.set(key, period);
      }
      cursor = next;
    } while (cursor !== null);
    snapshots.set(fanUuid, summarise(fanUuid, [...periods.values()], input.capturedAt, cutoff));
  }

  const queue = [...unique];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length && !abort) {
        const fanUuid = queue.shift()!;
        try {
          await readFan(fanUuid);
        } catch (error) {
          // 401/403/429/410/outage affect the whole credential or budget, not one fan.
          abort =
            error instanceof LiveReadError
              ? error
              : new LiveReadError("UNAVAILABLE", "Subscription history read failed.");
        }
      }
    }),
  );
  if (abort) throw abort;

  return { snapshots: unique.flatMap((uuid) => snapshots.get(uuid) ?? []), errors, requestsMade };
}

export type SubscriberCohort = "never_subscribed" | "trialing" | "active_renewing" | "active_not_renewing" | "lapsed";

/**
 * Combine lineage (history) with current state (Fan Insights `status` and renewal flag) read at
 * the same capture. A contradiction returns "CONFLICT" so the audience fails closed.
 */
export function deriveSubscriberCohort(
  history: FrozenSubscriptionHistory,
  current: {
    relationshipStatus: "subscriber" | "expired" | "follower" | "not_contactable";
    autoRenewalEnabled: boolean;
  },
): SubscriberCohort | "CONFLICT" {
  const subscribed = current.relationshipStatus === "subscriber";
  if (history.validPeriodCount === 0) return subscribed ? "CONFLICT" : "never_subscribed";
  if (!subscribed) return "lapsed";
  if (history.latestValidType === "trial") return "trialing";
  return current.autoRenewalEnabled ? "active_renewing" : "active_not_renewing";
}
