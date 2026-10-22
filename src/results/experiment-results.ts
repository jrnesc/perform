import type { ExperimentRecord } from "../persistence/contracts";
import type { AnalysedResult, ExperimentResultSummary } from "./contracts";

export type ExperimentResultDetail = {
  experiment: ExperimentRecord;
  result: AnalysedResult | null;
  availability: "AVAILABLE" | "NO_EVIDENCE";
};

export function assertResultBelongsToExperiment(experiment: ExperimentRecord, result: AnalysedResult): void {
  const fixture = result.fixture;
  if (
    fixture.experimentId !== experiment.id ||
    fixture.title !== experiment.name ||
    fixture.variable !== experiment.variable ||
    fixture.state !== experiment.state ||
    fixture.sourceAudienceUuid !== experiment.sourceAudienceUuid
  ) {
    throw new Error("Result evidence does not match the selected experiment definition");
  }
}

export function experimentResultDetail(
  experiment: ExperimentRecord,
  result: AnalysedResult | null,
): ExperimentResultDetail {
  if (result) assertResultBelongsToExperiment(experiment, result);
  return { experiment, result, availability: result ? "AVAILABLE" : "NO_EVIDENCE" };
}

export function experimentResultSummary(
  experiment: ExperimentRecord,
  result: AnalysedResult | null,
): ExperimentResultSummary | null {
  if (!result) return null;
  assertResultBelongsToExperiment(experiment, result);
  return {
    experimentId: experiment.id,
    status: result.status,
    observedDirection: result.observedDirection,
    observedAt: result.fixture.observation.observedAt,
    isComplete: result.fixture.observation.isComplete,
  };
}
