import { describe, expect, it, vi } from "vitest";
import { readFanEnrichment } from "./fan-enrichment";

function insight(status = "subscriber") {
  return {
    status,
    spending: {
      sources: {
        message: { netCount: 2, netTotal: 2400 },
        subscription: { netCount: 1, netTotal: 999 },
        mediaLink: { netCount: 1, netTotal: 500 },
        referral: { netCount: 8, netTotal: 8000 },
      },
    },
    subscription: { createdAt: "2026-01-01T00:00:00.000Z", renewsAt: null, autoRenewalEnabled: false },
  };
}

describe("live Fanvue fan-enrichment contract", () => {
  it("batches at 100, preserves per-key errors and freezes privacy-minimal facts", async () => {
    const fanUuids = Array.from({ length: 101 }, (_, index) => `fan-${index}`);
    const transport = vi.fn().mockImplementation(async (_path: string, init?: RequestInit) => {
      const requested = (JSON.parse(String(init?.body)) as { userUuids: string[] }).userUuids;
      const body = Object.fromEntries(
        requested.map((uuid) => [uuid, uuid === "fan-100" ? { error: "not_found" } : insight()]),
      );
      return new Response(JSON.stringify(body));
    });

    const result = await readFanEnrichment({
      fanUuids,
      capturedAt: "2026-10-21T09:59:59.000Z",
      assignmentCutoff: "2026-10-21T10:00:00.000Z",
      transport,
    });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).userUuids).toHaveLength(100);
    expect(result.batchesRead).toBe(2);
    expect(result.errors).toEqual({ "fan-100": "not_found" });
    expect(result.snapshots[0]).toEqual({
      fanUuid: "fan-0",
      capturedAt: "2026-10-21T09:59:59.000Z",
      relationshipStatus: "subscriber",
      priorSettledPurchaseCount: 4,
      priorSettledSpendMinor: 3899,
      subscriptionCreatedAt: "2026-01-01T00:00:00.000Z",
      autoRenewalEnabled: false,
      renewsAt: null,
      relationshipStartedAt: null,
    });
  });

  it("fails closed on malformed fan data without losing valid keys", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          "fan-ok": insight("follower"),
          "fan-bad": { ...insight(), spending: { sources: { message: { netCount: -1, netTotal: 10 } } } },
          "fan-forbidden": { error: "forbidden" },
        }),
      ),
    );
    const result = await readFanEnrichment({
      fanUuids: ["fan-ok", "fan-bad", "fan-forbidden"],
      capturedAt: "2026-10-21T09:00:00.000Z",
      assignmentCutoff: "2026-10-21T10:00:00.000Z",
      transport,
    });
    expect(result.snapshots.map(({ fanUuid }) => fanUuid)).toEqual(["fan-ok"]);
    expect(result.errors).toEqual({ "fan-bad": "malformed", "fan-forbidden": "forbidden" });
  });

  it("rejects a read timestamp after the assignment cutoff", async () => {
    await expect(
      readFanEnrichment({
        fanUuids: ["fan-a"],
        capturedAt: "2026-10-21T10:00:01.000Z",
        assignmentCutoff: "2026-10-21T10:00:00.000Z",
        transport: vi.fn(),
      }),
    ).rejects.toThrow(/no later than/);
  });
});
