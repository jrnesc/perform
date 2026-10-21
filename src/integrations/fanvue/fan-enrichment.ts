import {
  json,
  LiveReadError,
  nonNegativeInteger,
  record,
  string,
  type FanvueReadTransport,
} from "./live-read-contracts";

const fanPaymentSources = new Set([
  "subscription", "renewal", "message", "post", "tip", "checkoutLink", "mediaLink",
  "fanExperience",
]);

export type FrozenFanEnrichment = {
  fanUuid: string;
  capturedAt: string;
  relationshipStatus: "subscriber" | "expired" | "follower" | "not_contactable";
  priorSettledPurchaseCount: number;
  priorSettledSpendMinor: number;
  subscriptionCreatedAt: string | null;
  /** Current renewal state at capture; history says nothing about it. */
  autoRenewalEnabled: boolean;
  renewsAt: string | null;
  relationshipStartedAt: null;
};

export type FanEnrichmentRead = {
  snapshots: readonly FrozenFanEnrichment[];
  errors: Readonly<Record<string, "forbidden" | "not_found" | "internal" | "malformed">>;
  batchesRead: number;
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseFan(fanUuid: string, value: unknown, capturedAt: string): FrozenFanEnrichment | null {
  const item = record(value);
  const status = string(item?.status);
  const spending = record(item?.spending);
  const sources = record(spending?.sources);
  const subscription = record(item?.subscription);
  if (!item || !sources || !subscription ||
      !["subscriber", "expired", "follower", "not_contactable"].includes(status ?? "")) return null;

  let priorSettledPurchaseCount = 0;
  let priorSettledSpendMinor = 0;
  for (const [source, raw] of Object.entries(sources)) {
    if (!fanPaymentSources.has(source)) continue;
    const sourceValue = record(raw);
    const count = nonNegativeInteger(sourceValue?.netCount);
    const spend = nonNegativeInteger(sourceValue?.netTotal);
    if (count === null || spend === null) return null;
    priorSettledPurchaseCount += count;
    priorSettledSpendMinor += spend;
  }

  const created = subscription.createdAt;
  const subscriptionCreatedAt = created === null ? null : string(created);
  if (created !== null && (!subscriptionCreatedAt || Number.isNaN(Date.parse(subscriptionCreatedAt)))) {
    return null;
  }
  const renewsAt = subscription.renewsAt === null || subscription.renewsAt === undefined
    ? null : string(subscription.renewsAt);
  if (typeof subscription.autoRenewalEnabled !== "boolean" ||
      (subscription.renewsAt != null && (!renewsAt || Number.isNaN(Date.parse(renewsAt))))) return null;
  return {
    fanUuid,
    capturedAt,
    autoRenewalEnabled: subscription.autoRenewalEnabled,
    renewsAt,
    relationshipStatus: status as FrozenFanEnrichment["relationshipStatus"],
    priorSettledPurchaseCount,
    priorSettledSpendMinor,
    subscriptionCreatedAt,
    // Fan Insights does not expose the first creator/fan relationship date.
    relationshipStartedAt: null,
  };
}

/** Freeze live aggregates immediately before assignment; never re-read them as historical facts. */
export async function readFanEnrichment(input: {
  fanUuids: readonly string[];
  capturedAt: string;
  assignmentCutoff: string;
  transport: FanvueReadTransport;
}): Promise<FanEnrichmentRead> {
  const captured = Date.parse(input.capturedAt);
  const cutoff = Date.parse(input.assignmentCutoff);
  if (Number.isNaN(captured) || Number.isNaN(cutoff) || captured > cutoff) {
    throw new Error("Fan enrichment must be captured no later than the assignment cutoff");
  }
  const unique = [...new Set(input.fanUuids.map((uuid) => uuid.trim()))];
  if (unique.some((uuid) => !uuid)) throw new Error("Fan UUIDs must be non-empty");

  const snapshots: FrozenFanEnrichment[] = [];
  const errors: Record<string, "forbidden" | "not_found" | "internal" | "malformed"> = {};
  const batches = chunks(unique, 100);
  for (const batch of batches) {
    const body = record(await json(await input.transport("/v1/insights/fans/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userUuids: batch }),
    })));
    if (!body) throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned an invalid fan-insights batch.");
    for (const fanUuid of batch) {
      const value = body[fanUuid];
      const error = string(record(value)?.error);
      if (error === "forbidden" || error === "not_found" || error === "internal") {
        errors[fanUuid] = error;
        continue;
      }
      const parsed = parseFan(fanUuid, value, input.capturedAt);
      if (!parsed) errors[fanUuid] = "malformed";
      else snapshots.push(parsed);
    }
  }
  return { snapshots, errors, batchesRead: batches.length };
}
