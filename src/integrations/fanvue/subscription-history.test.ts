import { describe, expect, it, vi } from "vitest";
import { deriveSubscriberCohort, readSubscriptionHistories } from "./subscription-history";

const base = { capturedAt: "2026-10-21T09:59:00.000Z", assignmentCutoff: "2026-10-21T10:00:00.000Z" };

const period = (overrides: Record<string, unknown> = {}) => ({
  source: "profile",
  checkoutLinkUuid: null,
  type: "subscribe",
  paidAt: "2026-01-01T00:00:00Z",
  periodStart: "2026-01-01T00:00:00Z",
  periodEnd: "2026-02-01T00:00:00Z",
  amountPaid: 999,
  intervalMonths: 1,
  followsLapse: false,
  refunded: false,
  chargedBack: false,
  ...overrides,
});
const page = (data: unknown[], nextCursor: string | null = null) => new Response(JSON.stringify({ data, nextCursor }));
const fanOf = (path: string) => decodeURIComponent(path.split("/subscribers/")[1].split("/")[0]);

describe("live Fanvue subscription-history contract", () => {
  it("follows cursors per fan and summarises lineage at the cutoff", async () => {
    const pages: Record<string, Response[]> = {
      resub: [
        page(
          [period({ paidAt: "2026-06-01T00:00:00Z", periodStart: "2026-06-01T00:00:00Z", followsLapse: true })],
          "c2",
        ),
        page([period(), period()]),
      ],
      trial: [page([period({ type: "trial", amountPaid: 0, intervalMonths: null })])],
      none: [page([])],
    };
    const transport = vi.fn(async (path: string) => pages[fanOf(path)].shift()!);
    const result = await readSubscriptionHistories({
      ...base,
      fanUuids: ["resub", "trial", "none", "resub"],
      transport,
    });

    expect(result.requestsMade).toBe(4);
    const paths = transport.mock.calls.map(([path]) => path);
    expect(paths).toContain("/v1/subscribers/resub/history?size=50");
    expect(paths).toContain("/v1/subscribers/resub/history?size=50&cursor=c2");
    const by = Object.fromEntries(result.snapshots.map((s) => [s.fanUuid, s]));
    expect(by.resub).toMatchObject({
      validPeriodCount: 2,
      resubscribedAfterLapse: true,
      hasTrial: false,
      earliestSubscriptionAt: "2026-01-01T00:00:00.000Z",
      latestValidType: "subscribe",
    });
    expect(by.trial).toMatchObject({ hasTrial: true, latestValidType: "trial", validPeriodCount: 1 });
    expect(by.none).toMatchObject({ validPeriodCount: 0, earliestSubscriptionAt: null, latestValidType: null });
  });

  it("excludes refunded, charged-back, later-paid and non-profile periods", async () => {
    const transport = async () =>
      page([
        period({ paidAt: "2026-10-21T10:00:01Z", periodStart: "2026-10-21T10:00:01Z", type: "renew" }),
        period({ type: "renew", paidAt: "2026-03-01T00:00:00Z", periodStart: "2026-03-01T00:00:00Z", refunded: true }),
        period({
          type: "renew",
          paidAt: "2026-04-01T00:00:00Z",
          periodStart: "2026-04-01T00:00:00Z",
          chargedBack: true,
        }),
        period({
          source: "checkout_link",
          checkoutLinkUuid: "link-1",
          paidAt: "2025-01-01T00:00:00Z",
          periodStart: "2025-01-01T00:00:00Z",
        }),
        period({ source: "something_new", paidAt: "2025-02-01T00:00:00Z", periodStart: "2025-02-01T00:00:00Z" }),
        period(),
      ]);
    const [snapshot] = (await readSubscriptionHistories({ ...base, fanUuids: ["f"], transport })).snapshots;
    expect(snapshot).toMatchObject({
      validPeriodCount: 1,
      reversedPeriodCount: 2,
      periodsAfterCutoffIgnored: 1,
      earliestSubscriptionAt: "2026-01-01T00:00:00.000Z",
      latestValidType: "subscribe",
    });
  });

  it("treats null period ends as valid and fails closed on malformed rows", async () => {
    const transport = async (path: string) => {
      const fan = fanOf(path);
      if (fan === "old") return page([period({ periodEnd: null })]);
      if (fan === "badtype") return page([period({ type: "upgrade" })]);
      if (fan === "badflag") return page([period({ refunded: "no" })]);
      if (fan === "badpage") return new Response(JSON.stringify({ data: "x", nextCursor: null }));
      if (fan === "gone") return new Response("{}", { status: 404 });
      if (fan === "loop") return page([], "same");
      return page([period()]);
    };
    const result = await readSubscriptionHistories({
      ...base,
      fanUuids: ["old", "ok", "badtype", "badflag", "badpage", "gone", "loop"],
      transport,
      maxPagesPerFan: 5,
    });
    expect(result.snapshots.map((s) => s.fanUuid)).toEqual(["old", "ok"]);
    expect(result.errors).toEqual({
      badtype: "malformed",
      badflag: "malformed",
      badpage: "malformed",
      gone: "not_found",
      loop: "pagination",
    });
  });

  it("aborts the snapshot on rate limit, permission, sunset version or outage", async () => {
    const attempt = (status: number, headers?: HeadersInit) =>
      readSubscriptionHistories({
        ...base,
        fanUuids: ["a", "b"],
        transport: async () => new Response("{}", { status, headers }),
      });
    await expect(attempt(429, { "retry-after": "1" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSeconds: 1,
    });
    await expect(attempt(403)).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    await expect(attempt(401)).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    await expect(attempt(410)).rejects.toMatchObject({ code: "API_VERSION_UNSUPPORTED" });
    await expect(attempt(503)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("stays within Fanvue's six concurrent requests", async () => {
    let active = 0;
    let peak = 0;
    const transport = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return page([]);
    };
    const fanUuids = Array.from({ length: 20 }, (_, i) => `f${i}`);
    await readSubscriptionHistories({ ...base, fanUuids, transport, concurrency: 6 });
    expect(peak).toBeLessThanOrEqual(6);
    await expect(readSubscriptionHistories({ ...base, fanUuids, transport, concurrency: 7 })).rejects.toThrow(
      /between 1 and 6/,
    );
  });

  it("rejects a read timestamp after the assignment cutoff", async () => {
    await expect(
      readSubscriptionHistories({
        ...base,
        capturedAt: "2026-10-21T10:00:01.000Z",
        fanUuids: ["a"],
        transport: vi.fn(),
      }),
    ).rejects.toThrow(/no later than/);
  });
});

describe("subscriber cohort derivation", () => {
  const history = (overrides = {}) => ({
    fanUuid: "f",
    capturedAt: base.capturedAt,
    earliestSubscriptionAt: "2026-01-01T00:00:00.000Z",
    validPeriodCount: 2,
    hasTrial: false,
    resubscribedAfterLapse: false,
    latestValidType: "renew" as const,
    reversedPeriodCount: 0,
    periodsAfterCutoffIgnored: 0,
    ...overrides,
  });
  const now = (
    relationshipStatus: "subscriber" | "expired" | "follower" | "not_contactable",
    autoRenewalEnabled = true,
  ) => ({ relationshipStatus, autoRenewalEnabled });

  it("combines lineage with current state", () => {
    expect(deriveSubscriberCohort(history(), now("subscriber", true))).toBe("active_renewing");
    expect(deriveSubscriberCohort(history(), now("subscriber", false))).toBe("active_not_renewing");
    expect(deriveSubscriberCohort(history({ latestValidType: "trial", validPeriodCount: 1 }), now("subscriber"))).toBe(
      "trialing",
    );
    expect(deriveSubscriberCohort(history(), now("expired"))).toBe("lapsed");
    expect(deriveSubscriberCohort(history(), now("not_contactable"))).toBe("lapsed");
    expect(
      deriveSubscriberCohort(
        history({ validPeriodCount: 0, earliestSubscriptionAt: null, latestValidType: null }),
        now("follower"),
      ),
    ).toBe("never_subscribed");
  });

  it("flags a current subscriber with no profile history as a conflict", () => {
    expect(
      deriveSubscriberCohort(
        history({ validPeriodCount: 0, earliestSubscriptionAt: null, latestValidType: null }),
        now("subscriber"),
      ),
    ).toBe("CONFLICT");
  });
});
