import { describe, expect, it, vi } from "vitest";
import { createFanvueWriteTransport, FanvueWriteError, fixtureFanvueWriteTransport } from "./write-transport";

describe("Fanvue write transport", () => {
  it("pins the API version and idempotency key on a scheduled send", async () => {
    const fetchImpl = vi.fn(async (...request: Parameters<typeof fetch>) => {
      void request;
      return Response.json({ uuid: "message-1", recipientCount: 12 }, { status: 201 });
    });
    const transport = createFanvueWriteTransport({ accessToken: "creator-token", fetchImpl });
    await expect(transport.createMassMessage({
      text: "Preview", includedLists: { customListUuids: ["list-a"] }, excludedLists: {},
      mediaUuids: ["media-1"], price: 300, scheduledAt: "2026-10-22T12:05:00.000Z",
    }, "experiment-1:A")).resolves.toMatchObject({ uuid: "message-1", recipientCount: 12 });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.fanvue.com/v1/chats/mass-messages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer creator-token",
        "X-Fanvue-API-Version": "2025-06-26",
        "Idempotency-Key": "experiment-1:A",
      }),
    }));
  });

  it.each([409, 429, 500, 503])("classifies HTTP %s as uncertain", async (status) => {
    const transport = createFanvueWriteTransport({
      accessToken: "token", fetchImpl: vi.fn(async () => new Response("no", { status })),
    });
    await expect(transport.createCustomList("Arm A")).rejects.toMatchObject({
      kind: "UNCERTAIN", status,
    } satisfies Partial<FanvueWriteError>);
  });

  it("keeps the fixture gateway deterministic and idempotent", async () => {
    const transport = fixtureFanvueWriteTransport();
    const payload = { text: "Preview", includedLists: { customListUuids: ["list-a"] }, excludedLists: {}, mediaUuids: ["media"], price: 300, scheduledAt: "2026-10-22T12:05:00.000Z" } as const;
    const first = await transport.createMassMessage(payload, "experiment:A");
    const second = await transport.createMassMessage(payload, "experiment:A");
    expect(second).toEqual(first);
    expect(transport.effects.filter((effect) => effect.startsWith("schedule-message"))).toHaveLength(1);
  });
});
