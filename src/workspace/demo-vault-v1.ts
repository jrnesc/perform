import type { MediaAsset } from "./contracts";

export const DEMO_FIXTURE_VERSION = "perform-demo-vault-v1";

const provenance = {
  kind: "DEMO_SEEDED",
  label: "Seeded demo data",
  fixtureVersion: DEMO_FIXTURE_VERSION,
} as const;

export const DEMO_VAULT_ASSETS: readonly MediaAsset[] = [
  {
    id: "demo:media:afterglow-set",
    name: "Fictional Afterglow set",
    mediaType: "image",
    status: "ready",
    createdAt: "2026-09-18T14:20:00.000Z",
    thumbnailUrl: null,
    provenance,
  },
  {
    id: "demo:media:studio-diary",
    name: "Fictional studio diary",
    mediaType: "video",
    status: "ready",
    createdAt: "2026-09-12T09:05:00.000Z",
    thumbnailUrl: null,
    provenance,
  },
  {
    id: "demo:media:voice-note",
    name: "Fictional weekend voice note",
    mediaType: "audio",
    status: "ready",
    createdAt: "2026-09-02T18:40:00.000Z",
    thumbnailUrl: null,
    provenance,
  },
];
