import type { ExperimentRecord } from "../persistence/contracts";

export const DEMO_EXPERIMENT_HISTORY: readonly ExperimentRecord[] = (
  [
    [
      "demo:experiment:copy-complete",
      "Specific preview copy",
      "CLOSED",
      "COPY",
      "2026-10-20T09:00:00.000Z",
      "Specific copy will make the offer clearer.",
      "demo:audience:active-subscribers",
      240,
    ],
    [
      "demo:experiment:price-complete",
      "Raise PPV to $15",
      "CLOSED",
      "PRICE",
      "2026-10-20T15:00:00.000Z",
      "A $15 price will earn more per recipient than $12.",
      "demo:audience:recent-buyers",
      200,
    ],
    [
      "demo:experiment:price-running",
      "Two PPV price points",
      "RUNNING",
      "PRICE",
      "2026-10-21T10:30:00.000Z",
      "A higher price will increase revenue per assigned recipient.",
      "demo:audience:recent-buyers",
      24,
    ],
    [
      "demo:experiment:partial",
      "Weekend price check",
      "PARTIAL_LAUNCH",
      "PRICE",
      "2026-10-19T12:00:00.000Z",
      "A lower weekend price will improve settled revenue.",
      "demo:audience:recent-buyers",
      24,
    ],
    [
      "demo:experiment:invalid",
      "Archive bundle copy",
      "INVALID",
      "COPY",
      "2026-10-18T14:00:00.000Z",
      "A collection-led message will increase purchases.",
      "demo:audience:active-subscribers",
      24,
    ],
  ] as const satisfies readonly (readonly [string, string, string, string, string, string, string, number])[]
).map(([id, name, state, variable, updatedAt, hypothesis, sourceAudienceUuid, snapshotCount], index) => ({
  id,
  name,
  state,
  variable,
  hypothesis,
  creatorUuid: "preview:creator",
  dataProvenance: "DEMO",
  sourceAudienceUuid,
  snapshotCount,
  createdAt: `2026-10-${String(15 + index).padStart(2, "0")}T09:00:00.000Z`,
  updatedAt,
  launchedAt: (["RUNNING", "CLOSED", "PARTIAL_LAUNCH", "INVALID"] as string[]).includes(state)
    ? "2026-10-18T09:00:00.000Z"
    : undefined,
})) as readonly ExperimentRecord[];
