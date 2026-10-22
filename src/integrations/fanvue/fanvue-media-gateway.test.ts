import { describe, expect, it, vi } from "vitest";
import type { ApiError, FanvueClient, VaultMediaItem, VaultMediaPage } from "@fanvue/builder-sdk";
import { FanvueMediaGateway } from "./fanvue-media-gateway";

function ok<T>(value: T) {
  return { value, isOk: () => true, isErr: () => false } as never;
}

function err(error: ApiError) {
  return { error, isOk: () => false, isErr: () => true } as never;
}

function item(uuid = "fanvue-media-1"): VaultMediaItem {
  return {
    uuid,
    status: "ready",
    name: "Campaign set",
    caption: null,
    mediaType: "image",
    createdAt: "2026-10-01T10:00:00.000Z",
    isNsfw: false,
    purchasedByFan: null,
    variants: [{ uuid: "variant-1", variantType: "thumbnail", displayPosition: null, url: "https://cdn.example/thumb", width: 320, height: 320, lengthMs: null }],
  };
}

function gateway(listResult: unknown, getResult: unknown = ok(item())) {
  const listMedia = vi.fn().mockResolvedValue(listResult);
  const getMedia = vi.fn().mockResolvedValue(getResult);
  const vault = { listMedia, getMedia } as unknown as Pick<FanvueClient["vault"], "listMedia" | "getMedia">;
  return { gateway: new FanvueMediaGateway(vault), listMedia, getMedia };
}

describe("FanvueMediaGateway", () => {
  it("maps Fanvue pagination and attaches live provenance", async () => {
    const page: VaultMediaPage = { data: [item()], pagination: { page: 2, size: 1, hasMore: true }, total: 8 };
    const subject = gateway(ok(page));

    const result = await subject.gateway.listMedia({ page: 2, pageSize: 12 });

    expect(subject.listMedia).toHaveBeenCalledWith({ page: 2, size: 12, status: ["ready"], variants: ["thumbnail", "thumbnail_gallery", "main"] });
    expect(result).toMatchObject({ page: 2, pageSize: 12, hasMore: true, total: 8, provenance: { kind: "FANVUE" } });
    expect(result.items[0]).toMatchObject({ id: "fanvue-media-1", thumbnailUrl: "https://cdn.example/thumb", provenance: { kind: "FANVUE" } });
  });

  it.each([
    [401, "RECONNECT_REQUIRED"],
    [403, "PERMISSION_REQUIRED"],
    [429, "RATE_LIMITED"],
    [503, "UNAVAILABLE"],
  ] as const)("maps HTTP %s without leaking upstream messages", async (statusCode, code) => {
    const subject = gateway(err({ code: "API_ERROR_RESPONSE", statusCode, message: "secret upstream detail", reason: null, retryAfterSeconds: 17 }));
    await expect(subject.gateway.listMedia({ page: 1, pageSize: 12 })).rejects.toMatchObject({ code });
    await expect(subject.gateway.listMedia({ page: 1, pageSize: 12 })).rejects.not.toThrow(/secret upstream detail/);
  });

  it("rejects a demo identifier before the real client is called", async () => {
    const subject = gateway(ok({ data: [], pagination: { page: 1, size: 0, hasMore: false }, total: 0 }));
    await expect(subject.gateway.getMedia("demo:media:voice-note")).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
    expect(subject.getMedia).not.toHaveBeenCalled();
  });
});
