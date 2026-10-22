import type { Arm } from "../../domain/allocation";

export const fanvueWriteApiVersion = "2025-06-26";

export type MassMessagePayload = {
  text: string;
  includedLists: { customListUuids: readonly string[] };
  excludedLists: Record<string, never>;
  mediaUuids: readonly string[];
  price: number;
  scheduledAt: string;
};

export type ScheduledMessage = {
  uuid: string;
  idempotencyKey?: string;
  scheduledAt?: string;
  recipientCount?: number;
};

export interface FanvueWriteTransport {
  createCustomList(name: string): Promise<{ uuid: string }>;
  addCustomListMembers(listUuid: string, userUuids: readonly string[]): Promise<void>;
  listCustomListMembers(listUuid: string): Promise<readonly string[]>;
  deleteCustomList(listUuid: string): Promise<void>;
  createMassMessage(payload: MassMessagePayload, idempotencyKey: string): Promise<ScheduledMessage>;
  findMassMessageByIdempotencyKey(idempotencyKey: string): Promise<ScheduledMessage | null>;
  cancelMassMessage(messageUuid: string): Promise<void>;
}

export type FanvueWriteErrorKind = "DEFINITE" | "UNCERTAIN";

export class FanvueWriteError extends Error {
  constructor(
    readonly kind: FanvueWriteErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "FanvueWriteError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FanvueWriteError("UNCERTAIN", null, "Fanvue returned an unreadable response");
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FanvueWriteError("UNCERTAIN", null, `Fanvue did not return ${label}`);
  }
  return value;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

async function fanvueError(response: Response): Promise<FanvueWriteError> {
  const detail = await response.text().catch(() => "");
  const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
  const uncertain = response.status === 409 || response.status === 429 || response.status >= 500;
  const retry = retryAfterSeconds(response);
  return new FanvueWriteError(
    uncertain ? "UNCERTAIN" : "DEFINITE",
    response.status,
    `Fanvue write failed with ${response.status}${retry === null ? "" : ` (retry after ${retry}s)`}${suffix}`,
  );
}

export function createFanvueWriteTransport(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): FanvueWriteTransport {
  if (!input.accessToken.trim()) throw new Error("A verified creator access token is required");
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? "https://api.fanvue.com").replace(/\/$/, "");

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
          "X-Fanvue-API-Version": fanvueWriteApiVersion,
          ...init.headers,
        },
      });
    } catch {
      throw new FanvueWriteError("UNCERTAIN", null, "Fanvue request did not return a response");
    }
    if (!response.ok) throw await fanvueError(response);
    return response;
  };

  return {
    async createCustomList(name) {
      const body = object(await (await request("/v1/chats/lists/custom", {
        method: "POST", body: JSON.stringify({ name }),
      })).json());
      return { uuid: requiredString(body.uuid ?? object(body.data ?? {}).uuid, "a custom-list UUID") };
    },

    async addCustomListMembers(listUuid, userUuids) {
      if (userUuids.length < 1 || userUuids.length > 100) throw new Error("Member batches must contain 1–100 UUIDs");
      await request(`/v1/chats/lists/custom/${encodeURIComponent(listUuid)}/members`, {
        method: "POST", body: JSON.stringify({ userUuids }),
      });
    },

    async listCustomListMembers(listUuid) {
      const members: string[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const body = object(await (await request(`/v1/chats/lists/custom/${encodeURIComponent(listUuid)}${query}`)).json());
        const data = object(body.data ?? body);
        const page = data.members ?? data.users ?? [];
        if (!Array.isArray(page)) throw new FanvueWriteError("UNCERTAIN", null, "Fanvue returned unreadable list members");
        for (const item of page) {
          const row = object(item);
          members.push(requiredString(row.uuid ?? row.userUuid, "a member UUID"));
        }
        const next = typeof data.nextCursor === "string" ? data.nextCursor
          : typeof object(data.pagination ?? {}).nextCursor === "string"
            ? object(data.pagination ?? {}).nextCursor as string : null;
        if (next && seen.has(next)) throw new FanvueWriteError("UNCERTAIN", null, "Fanvue repeated a list cursor");
        if (next) seen.add(next);
        cursor = next;
      } while (cursor);
      return members;
    },

    async deleteCustomList(listUuid) {
      await request(`/v1/chats/lists/custom/${encodeURIComponent(listUuid)}`, { method: "DELETE" });
    },

    async createMassMessage(payload, idempotencyKey) {
      const body = object(await (await request("/v1/chats/mass-messages", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      })).json());
      const data = object(body.data ?? body);
      return {
        uuid: requiredString(data.uuid ?? data.messageUuid, "a mass-message UUID"),
        idempotencyKey,
        scheduledAt: typeof data.scheduledAt === "string" ? data.scheduledAt : payload.scheduledAt,
        recipientCount: typeof data.recipientCount === "number" ? data.recipientCount : undefined,
      };
    },

    async findMassMessageByIdempotencyKey(idempotencyKey) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const body = object(await (await request(`/v1/chats/mass-messages${query}`)).json());
        const data = object(body.data ?? body);
        const rows = data.messages ?? data.items ?? [];
        if (!Array.isArray(rows)) throw new FanvueWriteError("UNCERTAIN", null, "Fanvue returned unreadable mass messages");
        for (const item of rows) {
          const row = object(item);
          if (row.idempotencyKey === idempotencyKey) {
            return {
              uuid: requiredString(row.uuid ?? row.messageUuid, "a mass-message UUID"),
              idempotencyKey,
              scheduledAt: typeof row.scheduledAt === "string" ? row.scheduledAt : undefined,
              recipientCount: typeof row.recipientCount === "number" ? row.recipientCount : undefined,
            };
          }
        }
        const next = typeof data.nextCursor === "string" ? data.nextCursor : null;
        if (next && seen.has(next)) throw new FanvueWriteError("UNCERTAIN", null, "Fanvue repeated a message cursor");
        if (next) seen.add(next);
        cursor = next;
      } while (cursor);
      return null;
    },

    async cancelMassMessage(messageUuid) {
      await request(`/v1/chats/mass-messages/${encodeURIComponent(messageUuid)}`, { method: "DELETE" });
    },
  };
}

export function fixtureFanvueWriteTransport(): FanvueWriteTransport & { effects: readonly string[] } {
  const effects: string[] = [];
  const lists = new Map<string, Set<string>>();
  const messages = new Map<string, ScheduledMessage>();
  return {
    effects,
    async createCustomList(name) {
      const uuid = `fixture:list:${lists.size + 1}`;
      effects.push(`create-list:${name}`);
      lists.set(uuid, new Set());
      return { uuid };
    },
    async addCustomListMembers(listUuid, userUuids) {
      effects.push(`add-members:${listUuid}:${userUuids.length}`);
      const list = lists.get(listUuid);
      if (!list) throw new FanvueWriteError("DEFINITE", 404, "Fixture list was not found");
      userUuids.forEach((uuid) => list.add(uuid));
    },
    async listCustomListMembers(listUuid) { return [...(lists.get(listUuid) ?? [])]; },
    async deleteCustomList(listUuid) { effects.push(`delete-list:${listUuid}`); lists.delete(listUuid); },
    async createMassMessage(payload, idempotencyKey) {
      const existing = messages.get(idempotencyKey);
      if (existing) return existing;
      const message = { uuid: `fixture:message:${messages.size + 1}`, idempotencyKey, scheduledAt: payload.scheduledAt };
      effects.push(`schedule-message:${idempotencyKey}`);
      messages.set(idempotencyKey, message);
      return message;
    },
    async findMassMessageByIdempotencyKey(key) { return messages.get(key) ?? null; },
    async cancelMassMessage(uuid) { effects.push(`cancel-message:${uuid}`); },
  };
}

export function armFromIntentKey(key: string): Arm | null {
  return key.endsWith(":A") ? "A" : key.endsWith(":B") ? "B" : null;
}
