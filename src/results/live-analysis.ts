import type { Arm } from "../domain/allocation";
import type { VariantDefinition } from "../domain/experiment-state";
import { projectResultPurchases } from "../live/commerce-projection";
import type { ExperimentRecord } from "../persistence/contracts";
import type { AudienceEvidenceRow, CommerceEventRecord, ReconciliationRecord } from "../persistence/live-evidence";
import { analyseResult } from "./analyse";
import type { AnalysedResult, DemoResultFixture } from "./contracts";

/**
 * Runs the same analysis and evidence gates the seeded results use over a REAL experiment's frozen
 * audience and stored commerce events. A result only passes the gates once the experiment is closed
 * on a complete reconciliation; until then it reports INCOMPLETE with the observed direction.
 */
export function analyseLiveExperiment(input: {
  experiment: ExperimentRecord;
  variants: readonly VariantDefinition[];
  rows: readonly AudienceEvidenceRow[];
  events: readonly CommerceEventRecord[];
  reconciliations: readonly ReconciliationRecord[];
  now: string;
}): AnalysedResult | null {
  const { experiment, rows } = input;
  if (rows.length === 0 || input.variants.length !== 2) return null;
  const assignments = rows.map((row) => ({ fanUuid: row.fanUuid, arm: row.arm }));
  const capturedAt = new Map(rows.map((row) => [row.fanUuid, row.capturedAt]));
  // The same purchases the live breakdown counts: by the fan's own arm, after assignment.
  const purchases = projectResultPurchases({
    experimentId: experiment.id,
    events: input.events,
    assignments: Object.fromEntries(rows.map((row) => [row.fanUuid, row.arm])) as Record<string, Arm>,
  }).filter((purchase) => purchase.occurredAt >= (capturedAt.get(purchase.fanUuid) ?? purchase.occurredAt));
  const latest = input.reconciliations.at(-1) ?? null;
  const observedAt = latest?.capturedAt ?? input.now;
  const fixture: DemoResultFixture = {
    id: `live:${experiment.id}`,
    experimentId: experiment.id,
    fixtureVersion: "perform-live-v1",
    provenance: "REAL",
    title: experiment.name,
    audienceScope: "This audience",
    sourceAudienceUuid: experiment.sourceAudienceUuid,
    variable: experiment.variable,
    state: experiment.state,
    variants: input.variants,
    assignments,
    purchases,
    observation: {
      startedAt: experiment.launchedAt ?? rows[0].capturedAt,
      endedAt: latest?.windowEnd ?? input.now,
      observedAt,
      // A closed result is judged at its final reconciliation, so it does not go stale afterwards.
      evaluatedAt: observedAt,
      isComplete: experiment.state === "CLOSED" && latest?.isComplete === true,
    },
    evidence: [],
    comparison: { armALabel: "Arm A", armBLabel: "Arm B", currency: "USD" },
  };
  return analyseResult(fixture);
}
