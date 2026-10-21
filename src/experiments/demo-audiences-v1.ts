import type { AudienceSnapshot } from "./contracts";

export const DEMO_AUDIENCE_FIXTURE_VERSION = "perform-demo-audiences-v1";

const members = Array.from({ length: 24 }, (_, index) => ({
  fanUuid: `demo:fan:${String(index + 1).padStart(3, "0")}`,
  stratum: index % 3 === 0 ? "recent-subscriber" : "established-subscriber",
}));

const provenance = {
  kind: "DEMO_SEEDED",
  label: "Seeded demo data",
  fixtureVersion: DEMO_AUDIENCE_FIXTURE_VERSION,
} as const;

export const DEMO_AUDIENCES: readonly AudienceSnapshot[] = [
  {
    id: "demo:audience:active-subscribers",
    name: "Fictional active subscribers",
    description: "A versioned, fictional audience prepared for a safe setup rehearsal.",
    sourceKind: "DEMO_FIXTURE",
    capturedAt: "2026-10-20T12:00:00.000Z",
    members,
    sourceCount: 29,
    exclusions: [
      { reason: "MUTED", count: 2, explanation: "Excluded because the fictional fan is muted." },
      { reason: "NOT_CONTACTABLE", count: 1, explanation: "Excluded because messaging is unavailable." },
      { reason: "CREATOR_ACCOUNT", count: 1, explanation: "Excluded because the member is a creator account." },
      { reason: "DUPLICATE", count: 1, explanation: "Collapsed to one stable fan UUID before allocation." },
    ],
    provenance,
  },
  {
    id: "demo:audience:recent-buyers",
    name: "Fictional recent buyers",
    description: "A smaller fictional cohort for reviewing low-volume experiment warnings.",
    sourceKind: "DEMO_FIXTURE",
    capturedAt: "2026-10-20T12:00:00.000Z",
    members: members.slice(0, 10),
    sourceCount: 12,
    exclusions: [
      { reason: "MUTED", count: 1, explanation: "Excluded because the fictional fan is muted." },
      { reason: "NOT_CONTACTABLE", count: 1, explanation: "Excluded because messaging is unavailable." },
    ],
    provenance,
  },
];
