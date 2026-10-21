import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const getCloudflareContext = vi.fn(() => { throw new Error("database must not be opened"); });
vi.mock("@fanvue/builder-sdk/nextjs/embedded-app", () => ({ getSession }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

const { GET } = await import("./route");

describe("operator live-evidence route", () => {
  afterEach(() => { vi.unstubAllEnvs(); getSession.mockReset(); });

  it("does not exist until a live creator is configured", async () => {
    expect((await GET()).status).toBe(404);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers only the configured live creator and opens nothing otherwise", async () => {
    vi.stubEnv("PERFORM_LIVE_CREATOR_UUID", "owner");
    vi.stubEnv("SESSION_SECRET", "secret");
    getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    getSession.mockResolvedValue({ userUuid: "someone-else", isCreator: true });
    expect((await GET()).status).toBe(403);
    expect(getCloudflareContext).not.toHaveBeenCalled();
  });
});
