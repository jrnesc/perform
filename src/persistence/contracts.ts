import type { Assignment, Arm } from "../domain/allocation";
import type {
  ExperimentState,
  ExperimentVariable,
  SendStatus,
  TransitionEvidence,
  VariantDefinition,
} from "../domain/experiment-state";
import type { AnalysedResult, AudienceLearning, ExperimentResultSummary } from "../results/contracts";

export type DataProvenance = "REAL" | "DEMO";
export type MetricSource = "WEBHOOK_DERIVED" | "FANVUE_RECONCILIATION" | "DEMO" | "DRY_RUN";

export interface ExperimentRecord {
  id: string;
  name: string;
  creatorUuid: string;
  dataProvenance: DataProvenance;
  state: ExperimentState;
  variable: ExperimentVariable;
  hypothesis: string;
  sourceAudienceUuid: string;
  snapshotHash?: string;
  snapshotCount?: number;
  allocationAlgorithm?: string;
  snapshotAt?: string;
  launchedAt?: string;
  observationStartedAt?: string;
  observationEndedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentHistoryItem {
  experiment: ExperimentRecord;
  result: ExperimentResultSummary | null;
}

export interface NewExperiment {
  id: string;
  name: string;
  variable: ExperimentVariable;
  hypothesis: string;
  sourceAudienceUuid: string;
  variants: readonly VariantDefinition[];
  createdAt: string;
}

export interface AllocationCommit {
  commandId: string;
  experimentId: string;
  snapshotHash: string;
  snapshotCount: number;
  armCounts: Readonly<Record<Arm, number>>;
  algorithmVersion: string;
  snapshotAt: string;
}

export interface NewSendIntent {
  id: string;
  experimentId: string;
  arm: Arm;
  idempotencyKey: string;
  payloadJson: string;
  payloadHash: string;
  createdAt: string;
}

export interface SendOutcome {
  intentId: string;
  status: SendStatus;
  occurredAt: string;
  externalMessageUuid?: string;
  errorCode?: string;
  scheduledAt?: string;
  recipientCount?: number;
}

export interface StoredSendIntent extends NewSendIntent {
  status: SendStatus;
  externalMessageUuid?: string;
  scheduledAt?: string;
  recipientCount?: number;
  cancelledAt?: string;
}

export interface TransitionCommand {
  commandId: string;
  experimentId: string;
  to: ExperimentState;
  evidence: TransitionEvidence;
  occurredAt: string;
  reason?: string;
  fanDataDeleteAfter?: string;
  aggregateDeleteAfter?: string;
}

/**
 * Persistence port used by application code. It deliberately contains no D1,
 * Cloudflare or Fanvue types.
 */
export interface PerformRepository {
  createExperiment(input: NewExperiment): Promise<void>;
  getExperiment(id: string): Promise<ExperimentRecord | null>;
  getExperimentResult(experimentId: string): Promise<AnalysedResult | null>;
  listExperiments(): Promise<readonly ExperimentRecord[]>;
  listExperimentSummaries(): Promise<readonly ExperimentHistoryItem[]>;
  listAssignments(experimentId: string): Promise<readonly Assignment[]>;
  listVariants(experimentId: string): Promise<readonly VariantDefinition[]>;
  listSendIntents(experimentId: string): Promise<readonly StoredSendIntent[]>;
  saveAssignmentChunk(experimentId: string, assignments: readonly Assignment[], assignedAt: string): Promise<void>;
  finalizeAllocation(input: AllocationCommit): Promise<void>;
  createSendIntents(intents: readonly NewSendIntent[]): Promise<void>;
  recordSendOutcome(outcome: SendOutcome): Promise<void>;
  saveAnalysisResult(result: AnalysedResult): Promise<void>;
  saveAudienceLearning(learning: AudienceLearning): Promise<void>;
  listAudienceLearnings(): Promise<readonly AudienceLearning[]>;
  transitionExperiment(command: TransitionCommand): Promise<ExperimentState>;
  deleteFanData(fanUuid: string): Promise<void>;
}
