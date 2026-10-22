import {
  json,
  LiveReadError,
  nonNegativeInteger,
  record,
  string,
  type FanvueReadTransport,
} from "./live-read-contracts";

/**
 * Per-message totals Fanvue computes itself (`GET /v1/chats/mass-messages`, `read:chat`). They
 * need no payment-to-message join, so they are the authoritative per-arm check whatever the
 * attribution strategy. Amounts are USD cents.
 */
export type MassMessageAggregate = {
  uuid: string;
  status: string;
  recipientCount: number;
  viewCount: number;
  purchaseCount: number;
  totalRevenueMinor: number;
};

export type MassMessageAggregateRead = {
  aggregates: Readonly<Record<string, MassMessageAggregate>>;
  /** Requested UUIDs not found after walking every page. */
  missing: readonly string[];
  pagesRead: number;
};

function parseAggregate(value: unknown): MassMessageAggregate | null {
  const item = record(value);
  const uuid = string(item?.uuid);
  const status = string(item?.status);
  const recipientCount = nonNegativeInteger(item?.recipientCount);
  const viewCount = nonNegativeInteger(item?.viewCount);
  const purchaseCount = nonNegativeInteger(item?.purchaseCount);
  const totalRevenueMinor = nonNegativeInteger(item?.totalRevenue);
  if (
    !uuid ||
    !status ||
    recipientCount === null ||
    viewCount === null ||
    purchaseCount === null ||
    totalRevenueMinor === null
  )
    return null;
  return { uuid, status, recipientCount, viewCount, purchaseCount, totalRevenueMinor };
}

/**
 * Walks the creator's mass messages, most recent first, until every requested UUID is found or
 * the cursor ends. A requested row that is malformed fails the read rather than reading as zero.
 */
export async function readMassMessageAggregates(input: {
  messageUuids: readonly string[];
  transport: FanvueReadTransport;
  maxPages?: number;
}): Promise<MassMessageAggregateRead> {
  const wanted = new Set(input.messageUuids);
  const aggregates: Record<string, MassMessageAggregate> = {};
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pagesRead = 0;
  while (wanted.size > Object.keys(aggregates).length) {
    if (pagesRead >= (input.maxPages ?? 200) || (cursor !== null && cursors.has(cursor))) {
      throw new LiveReadError("PAGINATION_LOOP", "Mass-message pagination repeated or exceeded its bound.");
    }
    if (cursor) cursors.add(cursor);
    const query = new URLSearchParams({ size: "50" });
    if (cursor) query.set("cursor", cursor);
    const body = record(await json(await input.transport(`/v1/chats/mass-messages?${query}`)));
    if (!body || !Array.isArray(body.data) || !(body.nextCursor === null || typeof body.nextCursor === "string")) {
      throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned an invalid mass-message page.");
    }
    pagesRead += 1;
    for (const raw of body.data) {
      const uuid = string(record(raw)?.uuid);
      if (!uuid || !wanted.has(uuid)) continue;
      const aggregate = parseAggregate(raw);
      if (!aggregate) throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned a malformed mass-message total.");
      aggregates[uuid] = aggregate;
    }
    cursor = body.nextCursor as string | null;
    if (cursor === null) break;
  }
  return { aggregates, missing: [...wanted].filter((uuid) => !aggregates[uuid]), pagesRead };
}
