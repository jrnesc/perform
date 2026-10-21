import {
  json,
  LiveReadError,
  record,
  string,
  type FanvueReadTransport,
} from "./live-read-contracts";

/** Documented smart-list identifiers (`GET /v1/chats/lists/smart/{uuid}`). */
const smartListIds = new Set([
  "subscribers", "auto_renewing", "non_renewing", "followers", "free_trial_subscribers",
  "expired_subscribers", "spent_more_than_50", "muted", "creators",
]);
/**
 * Only `subscribers` is documented as limited to fans the creator can contact. Membership of
 * any other list is not eligibility evidence and stays fail-closed until proven.
 */
const contactableSmartLists = new Set(["subscribers"]);

export type AudienceSource = {
  kind: "SMART" | "CUSTOM";
  uuid: string;
};

export type LiveAudienceMember = {
  fanUuid: string;
  eligibility: "ELIGIBLE" | "REQUIRES_CONTACTABILITY_PROOF";
};

export type AudienceSnapshotRead = {
  members: readonly LiveAudienceMember[];
  duplicateMembers: number;
  malformedMembers: number;
  pagesRead: number;
};

type Page = {
  data: unknown[];
  nextCursor: string | null;
};

function parsePage(value: unknown): Page {
  const body = record(value);
  const nextCursor = body?.nextCursor;
  if (!body || !Array.isArray(body.data) ||
      !(nextCursor === null || typeof nextCursor === "string")) {
    throw new LiveReadError("INVALID_RESPONSE", "Fanvue returned an invalid audience page.");
  }
  return { data: body.data, nextCursor };
}

function path(source: AudienceSource, cursor: string | null, size: number): string {
  const kind = source.kind === "SMART" ? "smart" : "custom";
  const query = new URLSearchParams({ size: String(size) });
  if (cursor) query.set("cursor", cursor);
  return `/v1/chats/lists/${kind}/${encodeURIComponent(source.uuid)}?${query}`;
}

/**
 * Reads a complete stable-UUID audience without retaining profile fields. Only the
 * `subscribers` smart list is documented as contactability-filtered; every other smart list
 * and every custom list requires separate contactability proof and remains fail-closed.
 */
export async function readAudienceSnapshot(input: {
  source: AudienceSource;
  transport: FanvueReadTransport;
  pageSize?: number;
  maxPages?: number;
}): Promise<AudienceSnapshotRead> {
  if (input.source.kind === "SMART" && !smartListIds.has(input.source.uuid)) {
    throw new Error(`Unknown smart list identifier: ${input.source.uuid}`);
  }
  const eligibility = input.source.kind === "SMART" && contactableSmartLists.has(input.source.uuid)
    ? "ELIGIBLE" as const
    : "REQUIRES_CONTACTABILITY_PROOF" as const;
  const pageSize = input.pageSize ?? 50;
  const maxPages = input.maxPages ?? 1_000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new Error("Audience page size must be between 1 and 50");
  }

  const members = new Map<string, LiveAudienceMember>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let duplicateMembers = 0;
  let malformedMembers = 0;
  let pagesRead = 0;

  do {
    if (pagesRead >= maxPages) {
      throw new LiveReadError("PAGINATION_LOOP", "Audience pagination exceeded its bounded page limit.");
    }
    if (cursor && cursors.has(cursor)) {
      throw new LiveReadError("PAGINATION_LOOP", "Fanvue repeated an audience cursor.");
    }
    if (cursor) cursors.add(cursor);

    const page = parsePage(await json(await input.transport(path(input.source, cursor, pageSize))));
    pagesRead += 1;
    for (const candidate of page.data) {
      const item = record(candidate);
      const fanUuid = string(item?.uuid);
      if (!fanUuid || typeof item?.isCreator !== "boolean") {
        malformedMembers += 1;
        continue;
      }
      if (item.isCreator) continue;
      if (members.has(fanUuid)) {
        duplicateMembers += 1;
        continue;
      }
      members.set(fanUuid, {
        fanUuid,
        eligibility,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  return { members: [...members.values()], duplicateMembers, malformedMembers, pagesRead };
}
