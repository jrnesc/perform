import { describe, expect, it, vi } from "vitest";
import { readWorkspaceMedia } from "./authorization";
import { DemoMediaGateway } from "./demo-media-gateway";
import type { MediaReadGateway } from "./contracts";

describe("demo workspace", () => {
  it("provides the same gateway page shape with explicit fixture provenance", async () => {
    const page = await new DemoMediaGateway().listMedia({ page: 1, pageSize: 2 });
    expect(page).toMatchObject({
      page: 1,
      pageSize: 2,
      hasMore: true,
      total: 3,
      provenance: { kind: "DEMO_SEEDED", fixtureVersion: "perform-demo-vault-v1" },
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((asset) => asset.id.startsWith("demo:") && asset.provenance.kind === "DEMO_SEEDED")).toBe(
      true,
    );
  });

  it("denies a client-selected demo workspace when the verified creator is not allowlisted", async () => {
    const realGateway = vi.fn();
    const demoGateway = vi.fn();
    await expect(
      readWorkspaceMedia({
        creatorUuid: "creator-other",
        workspace: "demo",
        page: 1,
        pageSize: 12,
        demoAllowlist: "creator-owner",
        realGateway,
        demoGateway,
      }),
    ).rejects.toThrow(/not authorised/);
    expect(realGateway).not.toHaveBeenCalled();
    expect(demoGateway).not.toHaveBeenCalled();
  });

  it("never constructs the real adapter for an authorised demo read", async () => {
    const realGateway = vi.fn();
    const demoGateway = vi.fn(() => new DemoMediaGateway());
    const result = await readWorkspaceMedia({
      creatorUuid: "creator-owner",
      workspace: "demo",
      page: 1,
      pageSize: 12,
      demoAllowlist: " creator-owner,creator-two ",
      realGateway,
      demoGateway,
    });
    expect(result.demoAvailable).toBe(true);
    expect(result.page.provenance.kind).toBe("DEMO_SEEDED");
    expect(realGateway).not.toHaveBeenCalled();
  });

  it("normalises an authenticated handle before checking its separate allowlist", async () => {
    const result = await readWorkspaceMedia({
      creatorUuid: "creator-not-listed",
      creatorHandle: "Productive-Marlin-874",
      workspace: "demo",
      page: 1,
      pageSize: 12,
      demoAllowlist: undefined,
      demoHandleAllowlist: " @productive-marlin-874 ",
      realGateway: vi.fn(),
      demoGateway: () => new DemoMediaGateway(),
    });
    expect(result.demoAvailable).toBe(true);
  });

  it("keeps real reads on the real gateway even for a demo-capable creator", async () => {
    const livePage = {
      items: [],
      page: 1,
      pageSize: 12,
      hasMore: false,
      total: 0,
      provenance: { kind: "FANVUE", label: "Live Fanvue Vault" } as const,
    };
    const live: MediaReadGateway = { listMedia: vi.fn().mockResolvedValue(livePage), getMedia: vi.fn() };
    const demoGateway = vi.fn();
    const result = await readWorkspaceMedia({
      creatorUuid: "creator-owner",
      workspace: "real",
      page: 1,
      pageSize: 12,
      demoAllowlist: "creator-owner",
      realGateway: () => live,
      demoGateway,
    });
    expect(result.page.provenance.kind).toBe("FANVUE");
    expect(demoGateway).not.toHaveBeenCalled();
  });
});
