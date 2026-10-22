import { describe, expect, it } from "vitest";
import { LiveReadError, readError } from "./live-read-contracts";
import {
  createFanvueReadTransport,
  fanvueApiVersion,
  fanvueReadBudgetPerMinute,
  fanvueReadConcurrency,
} from "./read-transport";

describe("Fanvue read transport", () => {
  it("pins authentication and the documented API version", async () => {
    let calls = 0;
    const transport = createFanvueReadTransport({
      accessToken: "verified-token",
      coordinationKey: "header-test",
      fetch: async (input, init) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        expect(String(input)).toBe("https://api.fanvue.com/v1/chats/lists/smart/subscribers?size=50");
        expect(headers.get("authorization")).toBe("Bearer verified-token");
        expect(headers.get("x-fanvue-api-version")).toBe(fanvueApiVersion);
        return new Response("{}");
      },
    });
    await transport("/v1/chats/lists/smart/subscribers?size=50");
    expect(calls).toBe(1);
  });

  it("allows no more than six requests in flight", async () => {
    let active = 0;
    let maximum = 0;
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const transport = createFanvueReadTransport({
      accessToken: "token",
      coordinationKey: "concurrency-test",
      fetch: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return new Response("{}");
      },
    });
    const requests = Array.from({ length: fanvueReadConcurrency + 1 }, (_, index) => transport(`/v1/test/${index}`));
    await Promise.resolve();
    await Promise.resolve();
    expect(maximum).toBe(fanvueReadConcurrency);
    releaseAll();
    await Promise.all(requests);
  });

  it("waits for the rolling minute before request 201", async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const transport = createFanvueReadTransport({
      accessToken: "token",
      coordinationKey: "budget-test",
      now: () => clock,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      fetch: async () => new Response("{}"),
    });
    for (let index = 0; index <= fanvueReadBudgetPerMinute; index += 1) {
      await transport(`/v1/test/${index}`);
    }
    expect(waits).toEqual([60_000]);
  });

  it("preserves Retry-After for the shared error mapper", async () => {
    const transport = createFanvueReadTransport({
      accessToken: "token",
      coordinationKey: "retry-after-test",
      fetch: async () => new Response("{}", { status: 429, headers: { "Retry-After": "17" } }),
    });
    const response = await transport("/v1/test");
    const error = readError(response);
    expect(error).toBeInstanceOf(LiveReadError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 17 });
  });
});
