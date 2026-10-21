import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("Fanvue webhook route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a 404 and never reads the body while disabled", async () => {
    const request = new Request("https://perform.test/api/webhooks/fanvue", { method: "POST", body: "{}" });
    const response = await POST(request);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ outcome: "DISABLED" });
    expect(request.bodyUsed).toBe(false);
  });

  it("is still disabled for any value other than exactly true", async () => {
    vi.stubEnv("PERFORM_LIVE_COMMERCE_WEBHOOK_ENABLED", "1");
    expect((await POST(new Request("https://perform.test/x", { method: "POST", body: "{}" }))).status).toBe(404);
  });
});
