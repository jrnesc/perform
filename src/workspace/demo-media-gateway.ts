import { DEMO_FIXTURE_VERSION, DEMO_VAULT_ASSETS } from "./demo-vault-v1";
import type { ListMediaInput, MediaPage, MediaReadGateway } from "./contracts";

const provenance = {
  kind: "DEMO_SEEDED",
  label: "Seeded demo data",
  fixtureVersion: DEMO_FIXTURE_VERSION,
} as const;

export class DemoMediaGateway implements MediaReadGateway {
  async listMedia({ page, pageSize }: ListMediaInput): Promise<MediaPage> {
    const start = (page - 1) * pageSize;
    return {
      items: DEMO_VAULT_ASSETS.slice(start, start + pageSize),
      page,
      pageSize,
      hasMore: start + pageSize < DEMO_VAULT_ASSETS.length,
      total: DEMO_VAULT_ASSETS.length,
      provenance,
    };
  }

  async getMedia(id: string) {
    return DEMO_VAULT_ASSETS.find((asset) => asset.id === id) ?? null;
  }
}
