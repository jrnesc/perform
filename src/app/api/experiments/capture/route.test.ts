import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const fakeDatabase = {
  prepare: () => ({
    bind() { return this; },
    async all() { return { success: true, results: [] }; },
  }),
};
const getCloudflareContext = vi.fn(async () => ({ env: { PERFORM_REAL_DB: fakeDatabase } }));
vi.mock("@fanvue/builder-sdk/nextjs/embedded-app", () => ({ getSession }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

const { POST } = await import("./route");
const request = () => new Request("https://perform.test/api/experiments/capture", {
  method: "POST", body: JSON.stringify({ experimentId: "experiment-1" }),
});

describe("live audience capture route", () => {
  afterEach(() => { vi.unstubAllEnvs(); getSession.mockReset(); });

  it("refuses an unverified caller", async () => {
    vi.stubEnv("SESSION_SECRET", "secret");
    getSession.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
  });

  it("refuses a fully configured and granted creator because nothing is activated", async () => {
    vi.stubEnv("SESSION_SECRET", "secret");
    vi.stubEnv("PERFORM_LIVE_CAPABILITIES", "audience_discovery,subscriber_state,purchase_enrichment");
    vi.stubEnv("OAUTH_SCOPES", "read:self read:media read:chat read:fan read:insights");
    getSession.mockResolvedValue({ userUuid: "creator", isCreator: true, scope: "read:self read:media read:chat read:fan read:insights" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "capability_not_active" },
      capabilities: { audience_discovery: "connected", subscriber_state: "connected", purchase_enrichment: "connected" },
    });
    expect(getCloudflareContext).toHaveBeenCalledOnce();
  });
});
