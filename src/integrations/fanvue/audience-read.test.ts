import { describe, expect, it, vi } from "vitest";
import { readAudienceSnapshot } from "./audience-read";

const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

describe("live Fanvue audience contract", () => {
  it("walks cursors, removes duplicate members and excludes creators", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          data: [
            { uuid: "fan-a", displayName: "discard", handle: "discard", isCreator: false },
            { uuid: "creator-a", displayName: "discard", handle: "discard", isCreator: true },
          ],
          nextCursor: "cursor-2",
          total: null,
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: [
            { uuid: "fan-a", displayName: "discard", handle: "discard", isCreator: false },
            { uuid: "fan-b", displayName: "discard", handle: "discard", isCreator: false },
          ],
          nextCursor: null,
          total: null,
        }),
      );

    const result = await readAudienceSnapshot({
      source: { kind: "SMART", uuid: "subscribers" },
      transport,
    });

    expect(result).toEqual({
      members: [
        { fanUuid: "fan-a", eligibility: "ELIGIBLE" },
        { fanUuid: "fan-b", eligibility: "ELIGIBLE" },
      ],
      duplicateMembers: 1,
      malformedMembers: 0,
      pagesRead: 2,
    });
    expect(transport.mock.calls[1][0]).toContain("cursor=cursor-2");
  });

  it("fails custom-list membership closed and counts malformed rows", async () => {
    const transport = vi.fn().mockResolvedValue(
      response({
        data: [
          { uuid: "fan-a", displayName: "A", handle: "a", isCreator: false },
          { uuid: "fan-b", isCreator: "no" },
          { isCreator: false },
        ],
        nextCursor: null,
        total: null,
      }),
    );
    const result = await readAudienceSnapshot({
      source: { kind: "CUSTOM", uuid: "list-a" },
      transport,
    });
    expect(result.members).toEqual([{ fanUuid: "fan-a", eligibility: "REQUIRES_CONTACTABILITY_PROOF" }]);
    expect(result.malformedMembers).toBe(2);
  });

  it("rejects duplicate cursors rather than looping", async () => {
    const transport = vi.fn().mockImplementation(async () => response({ data: [], nextCursor: "same", total: null }));
    await expect(
      readAudienceSnapshot({
        source: { kind: "SMART", uuid: "followers" },
        transport,
      }),
    ).rejects.toMatchObject({ code: "PAGINATION_LOOP" });
  });

  it("preserves a bounded retry delay on rate limits", async () => {
    const transport = vi.fn().mockResolvedValue(response({}, 429, { "retry-after": "17" }));
    await expect(
      readAudienceSnapshot({
        source: { kind: "SMART", uuid: "subscribers" },
        transport,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 17 });
  });
});
