import { allocationAlgorithmVersion, type Assignment } from "../domain/allocation";
import {
  normalizeExperimentName,
  transition,
  validateVariants,
  type ExperimentState,
} from "../domain/experiment-state";
import type { AnalysedResult, AudienceLearning } from "../results/contracts";
import { experimentResultSummary } from "../results/experiment-results";
import type {
  AllocationCommit,
  DataProvenance,
  ExperimentRecord,
  NewExperiment,
  NewSendIntent,
  PerformRepository,
  SendOutcome,
  StoredSendIntent,
  TransitionCommand,
} from "./contracts";

type SqlValue = string | number | null | ArrayBuffer;

interface SqlResult<Row = Record<string, unknown>> {
  results?: Row[];
  success: boolean;
  meta?: { changes?: number };
}

interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  run<Row = Record<string, unknown>>(): Promise<SqlResult<Row>>;
  all<Row = Record<string, unknown>>(): Promise<SqlResult<Row>>;
}

/** The subset of D1Database used here, kept out of the domain and port types. */
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch<Row = Record<string, unknown>>(
    statements: readonly SqlStatement[],
  ): Promise<SqlResult<Row>[]>;
}

interface ExperimentRow {
  id: string;
  name: string;
  creator_uuid: string;
  data_provenance: DataProvenance;
  state: ExperimentState;
  variable: "COPY" | "PRICE";
  hypothesis: string;
  source_audience_uuid: string;
  snapshot_hash: string | null;
  snapshot_count: number | null;
  allocation_algorithm: string | null;
  snapshot_at: string | null;
  launched_at: string | null;
  observation_started_at: string | null;
  observation_ended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LearningRow {
  id: string;
  experiment_id: string;
  audience_scope: string;
  variable: "COPY" | "PRICE";
  statement: string;
  created_at: string;
  evidence_provenance: "DEMO";
}

export const assignmentChunkLimit = 40;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nullable(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function changes(result: SqlResult): number {
  return result.meta?.changes ?? 0;
}

function retentionDates(occurredAt: string): {
  fanDataDeleteAfter: string;
  aggregateDeleteAfter: string;
} {
  const occurred = new Date(occurredAt);
  requireValue(!Number.isNaN(occurred.valueOf()), "Transition time must be ISO-8601");
  const fanData = new Date(occurred);
  fanData.setUTCDate(fanData.getUTCDate() + 90);
  const aggregates = new Date(occurred);
  aggregates.setUTCMonth(aggregates.getUTCMonth() + 24);
  return {
    fanDataDeleteAfter: fanData.toISOString(),
    aggregateDeleteAfter: aggregates.toISOString(),
  };
}

/**
 * D1 adapter. Each instance is scoped to one creator and one data provenance,
 * preventing application calls from crossing real and demo workspaces.
 */
export class D1PerformRepository implements PerformRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly creatorUuid: string,
    private readonly dataProvenance: DataProvenance,
  ) {
    requireValue(creatorUuid.trim(), "A creator UUID is required");
  }

  async createExperiment(input: NewExperiment): Promise<void> {
    requireValue(input.id.trim(), "An experiment ID is required");
    const name = normalizeExperimentName(input.name);
    requireValue(input.hypothesis.trim(), "A hypothesis is required");
    requireValue(input.sourceAudienceUuid.trim(), "A source audience is required");
    validateVariants(input.variable, input.variants);

    const statements = [
      this.db
        .prepare(
          `INSERT INTO experiments (
             id, name, creator_uuid, data_provenance, state, variable, hypothesis,
             source_audience_uuid, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          name,
          this.creatorUuid,
          this.dataProvenance,
          input.variable,
          input.hypothesis,
          input.sourceAudienceUuid,
          input.createdAt,
          input.createdAt,
        ),
      ...input.variants.map((variant) =>
        this.db
          .prepare(
            `INSERT INTO variants (
               experiment_id, arm, copy_text, price_minor, currency, media_uuid
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.id,
            variant.arm,
            variant.copy,
            variant.priceMinor,
            variant.currency,
            variant.mediaUuid,
          ),
      ),
    ];

    await this.db.batch(statements);
  }

  async getExperiment(id: string): Promise<ExperimentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name, creator_uuid, data_provenance, state, variable, hypothesis,
                source_audience_uuid, snapshot_hash, snapshot_count,
                allocation_algorithm, snapshot_at, launched_at,
                observation_started_at, observation_ended_at, created_at, updated_at
         FROM experiments
         WHERE id = ? AND creator_uuid = ? AND data_provenance = ?`,
      )
      .bind(id, this.creatorUuid, this.dataProvenance)
      .first<ExperimentRow>();

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      creatorUuid: row.creator_uuid,
      dataProvenance: row.data_provenance,
      state: row.state,
      variable: row.variable,
      hypothesis: row.hypothesis,
      sourceAudienceUuid: row.source_audience_uuid,
      snapshotHash: row.snapshot_hash ?? undefined,
      snapshotCount: row.snapshot_count ?? undefined,
      allocationAlgorithm: row.allocation_algorithm ?? undefined,
      snapshotAt: row.snapshot_at ?? undefined,
      launchedAt: row.launched_at ?? undefined,
      observationStartedAt: row.observation_started_at ?? undefined,
      observationEndedAt: row.observation_ended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listExperiments(): Promise<readonly ExperimentRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, name, creator_uuid, data_provenance, state, variable, hypothesis,
                source_audience_uuid, snapshot_hash, snapshot_count,
                allocation_algorithm, snapshot_at, launched_at,
                observation_started_at, observation_ended_at, created_at, updated_at
         FROM experiments
         WHERE creator_uuid = ? AND data_provenance = ?
         ORDER BY updated_at DESC, created_at DESC, id ASC`,
      )
      .bind(this.creatorUuid, this.dataProvenance)
      .all<ExperimentRow>();

    return (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      creatorUuid: row.creator_uuid,
      dataProvenance: row.data_provenance,
      state: row.state,
      variable: row.variable,
      hypothesis: row.hypothesis,
      sourceAudienceUuid: row.source_audience_uuid,
      snapshotHash: row.snapshot_hash ?? undefined,
      snapshotCount: row.snapshot_count ?? undefined,
      allocationAlgorithm: row.allocation_algorithm ?? undefined,
      snapshotAt: row.snapshot_at ?? undefined,
      launchedAt: row.launched_at ?? undefined,
      observationStartedAt: row.observation_started_at ?? undefined,
      observationEndedAt: row.observation_ended_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listAssignments(experimentId: string): Promise<readonly Assignment[]> {
    await this.requireExperiment(experimentId);
    const rows = await this.db.prepare(
      `SELECT fan_uuid, arm, stratum, algorithm_version
       FROM assignments WHERE experiment_id = ? ORDER BY arm, fan_uuid`,
    ).bind(experimentId).all<{
      fan_uuid: string; arm: "A" | "B"; stratum: string; algorithm_version: string;
    }>();
    return (rows.results ?? []).map((row) => {
      requireValue(row.algorithm_version === allocationAlgorithmVersion, "Assignment algorithm version mismatch");
      return {
        fanUuid: row.fan_uuid,
        arm: row.arm,
        stratum: row.stratum,
        algorithmVersion: allocationAlgorithmVersion,
      };
    });
  }

  async listVariants(experimentId: string) {
    await this.requireExperiment(experimentId);
    const rows = await this.db.prepare(
      `SELECT arm, copy_text, price_minor, currency, media_uuid
       FROM variants WHERE experiment_id = ? ORDER BY arm`,
    ).bind(experimentId).all<{
      arm: "A" | "B"; copy_text: string; price_minor: number; currency: string; media_uuid: string;
    }>();
    return (rows.results ?? []).map((row) => ({
      arm: row.arm, copy: row.copy_text, priceMinor: row.price_minor,
      currency: row.currency, mediaUuid: row.media_uuid,
    }));
  }

  async listSendIntents(experimentId: string): Promise<readonly StoredSendIntent[]> {
    await this.requireExperiment(experimentId);
    const rows = await this.db.prepare(
      `SELECT id, experiment_id, arm, idempotency_key, payload_json, payload_hash,
              status, external_message_uuid, scheduled_at, recipient_count,
              cancelled_at, created_at
       FROM send_intents
       WHERE experiment_id = ? AND creator_uuid = ? ORDER BY arm`,
    ).bind(experimentId, this.creatorUuid).all<{
      id: string; experiment_id: string; arm: "A" | "B"; idempotency_key: string;
      payload_json: string; payload_hash: string; status: StoredSendIntent["status"];
      external_message_uuid: string | null; scheduled_at: string | null;
      recipient_count: number | null; cancelled_at: string | null; created_at: string;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id, experimentId: row.experiment_id, arm: row.arm,
      idempotencyKey: row.idempotency_key, payloadJson: row.payload_json,
      payloadHash: row.payload_hash, status: row.status,
      externalMessageUuid: row.external_message_uuid ?? undefined,
      scheduledAt: row.scheduled_at ?? undefined,
      recipientCount: row.recipient_count ?? undefined,
      cancelledAt: row.cancelled_at ?? undefined,
      createdAt: row.created_at,
    }));
  }

  async getExperimentResult(experimentId: string): Promise<AnalysedResult | null> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) return null;
    const row = await this.db
      .prepare(
        `SELECT result_json
         FROM result_snapshots
         WHERE experiment_id = ? AND creator_uuid = ? AND data_provenance = ?
         ORDER BY evaluated_at DESC, created_at DESC, id ASC
         LIMIT 1`,
      )
      .bind(experimentId, this.creatorUuid, this.dataProvenance)
      .first<{ result_json: string }>();
    if (!row) return null;
    const result = JSON.parse(row.result_json) as AnalysedResult;
    experimentResultSummary(experiment, result);
    return result;
  }

  async listExperimentSummaries() {
    const experiments = await this.listExperiments();
    return Promise.all(experiments.map(async (experiment) => {
      const result = await this.getExperimentResult(experiment.id);
      return { experiment, result: experimentResultSummary(experiment, result) };
    }));
  }

  async saveAssignmentChunk(
    experimentId: string,
    assignments: readonly Assignment[],
    assignedAt: string,
  ): Promise<void> {
    if (assignments.length === 0) return;
    requireValue(
      assignments.length <= assignmentChunkLimit,
      `Assignment chunks may contain at most ${assignmentChunkLimit} rows`,
    );
    const experiment = await this.requireExperiment(experimentId);
    requireValue(experiment.state === "SNAPSHOTTING", "Assignments require SNAPSHOTTING state");
    requireValue(
      assignments.every(({ algorithmVersion }) =>
        algorithmVersion === allocationAlgorithmVersion,
      ),
      "Assignment algorithm version mismatch",
    );

    await this.db.batch(
      assignments.map((assignment) =>
        this.db
          .prepare(
            `INSERT INTO assignments (
               experiment_id, fan_uuid, arm, stratum, algorithm_version, assigned_at
             )
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM experiments
               WHERE id = ? AND creator_uuid = ? AND data_provenance = ?
                 AND state = 'SNAPSHOTTING'
             )
             AND NOT EXISTS (
               SELECT 1 FROM assignments
               WHERE experiment_id = ? AND fan_uuid = ? AND arm = ?
                 AND stratum = ? AND algorithm_version = ?
             )`,
          )
          .bind(
            experimentId,
            assignment.fanUuid,
            assignment.arm,
            assignment.stratum,
            assignment.algorithmVersion,
            assignedAt,
            experimentId,
            this.creatorUuid,
            this.dataProvenance,
            experimentId,
            assignment.fanUuid,
            assignment.arm,
            assignment.stratum,
            assignment.algorithmVersion,
          ),
      ),
    );
  }

  async finalizeAllocation(input: AllocationCommit): Promise<void> {
    const current = await this.requireExperiment(input.experimentId);
    if (current.state === "ALLOCATED") {
      requireValue(
        current.snapshotHash === input.snapshotHash &&
          current.snapshotCount === input.snapshotCount &&
          current.allocationAlgorithm === input.algorithmVersion,
        "Allocation was already finalized with different evidence",
      );
      return;
    }

    transition("SNAPSHOTTING", "ALLOCATED", {
      snapshot: {
        hash: input.snapshotHash,
        eligibleCount: input.snapshotCount,
        assignmentCount: input.snapshotCount,
        armCounts: input.armCounts,
        algorithmVersion: input.algorithmVersion,
      },
    });
    requireValue(current.state === "SNAPSHOTTING", "Allocation requires SNAPSHOTTING state");

    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE experiments
           SET state = 'ALLOCATED', snapshot_hash = ?, snapshot_count = ?,
               allocation_algorithm = ?, snapshot_at = ?, updated_at = ?
           WHERE id = ? AND creator_uuid = ? AND data_provenance = ?
             AND state = 'SNAPSHOTTING'
             AND (SELECT count(*) FROM assignments WHERE experiment_id = ?) = ?
             AND (SELECT count(*) FROM assignments WHERE experiment_id = ? AND arm = 'A') = ?
             AND (SELECT count(*) FROM assignments WHERE experiment_id = ? AND arm = 'B') = ?
             AND NOT EXISTS (
               SELECT 1 FROM assignments
               WHERE experiment_id = ? AND algorithm_version <> ?
             )`,
        )
        .bind(
          input.snapshotHash,
          input.snapshotCount,
          input.algorithmVersion,
          input.snapshotAt,
          input.snapshotAt,
          input.experimentId,
          this.creatorUuid,
          this.dataProvenance,
          input.experimentId,
          input.snapshotCount,
          input.experimentId,
          input.armCounts.A,
          input.experimentId,
          input.armCounts.B,
          input.experimentId,
          input.algorithmVersion,
        ),
      this.db
        .prepare(
          `INSERT INTO experiment_transitions (
             experiment_id, command_id, from_state, to_state, occurred_at
           )
           SELECT ?, ?, 'SNAPSHOTTING', 'ALLOCATED', ?
           WHERE EXISTS (
             SELECT 1 FROM experiments
             WHERE id = ? AND creator_uuid = ? AND data_provenance = ?
               AND state = 'ALLOCATED' AND snapshot_hash = ? AND updated_at = ?
           )`,
        )
        .bind(
          input.experimentId,
          input.commandId,
          input.snapshotAt,
          input.experimentId,
          this.creatorUuid,
          this.dataProvenance,
          input.snapshotHash,
          input.snapshotAt,
        ),
    ]);

    requireValue(changes(update) === 1, "Allocation evidence did not match persisted assignments");
  }

  async createSendIntents(intents: readonly NewSendIntent[]): Promise<void> {
    requireValue(intents.length === 2, "Exactly two send intents are required");
    requireValue(intents[0].experimentId === intents[1].experimentId, "Send intents must share an experiment");
    requireValue(new Set(intents.map(({ arm }) => arm)).size === 2, "Arms A and B are required");
    requireValue(
      new Set(intents.map(({ idempotencyKey }) => idempotencyKey)).size === 2,
      "Send idempotency keys must be unique",
    );
    await this.requireExperiment(intents[0].experimentId);
    for (const intent of intents) JSON.parse(intent.payloadJson);

    await this.db.batch(
      intents.map((intent) =>
        this.db
          .prepare(
            `INSERT INTO send_intents (
               id, creator_uuid, experiment_id, arm, idempotency_key, payload_json,
               payload_hash, status, created_at, updated_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM send_intents
               WHERE id = ? AND experiment_id = ? AND arm = ?
                 AND idempotency_key = ? AND payload_hash = ?
             )`,
          )
          .bind(
            intent.id,
            this.creatorUuid,
            intent.experimentId,
            intent.arm,
            intent.idempotencyKey,
            intent.payloadJson,
            intent.payloadHash,
            intent.createdAt,
            intent.createdAt,
            intent.id,
            intent.experimentId,
            intent.arm,
            intent.idempotencyKey,
            intent.payloadHash,
          ),
      ),
    );
  }

  async recordSendOutcome(outcome: SendOutcome): Promise<void> {
    requireValue(
      outcome.status !== "CONFIRMED" || Boolean(outcome.externalMessageUuid),
      "A confirmed send requires an external message UUID",
    );
    const result = await this.db
      .prepare(
        `UPDATE send_intents
         SET status = ?, external_message_uuid = ?, attempted_at = ?,
             confirmed_at = CASE WHEN ? = 'CONFIRMED' THEN ? ELSE NULL END,
             last_error_code = ?, scheduled_at = COALESCE(?, scheduled_at),
             recipient_count = COALESCE(?, recipient_count), updated_at = ?
         WHERE id = ? AND creator_uuid = ?
           AND status IN ('PENDING', 'UNKNOWN')`,
      )
      .bind(
        outcome.status,
        nullable(outcome.externalMessageUuid),
        outcome.occurredAt,
        outcome.status,
        outcome.occurredAt,
        nullable(outcome.errorCode),
        nullable(outcome.scheduledAt),
        nullable(outcome.recipientCount),
        outcome.occurredAt,
        outcome.intentId,
        this.creatorUuid,
      )
      .run();
    requireValue(changes(result) === 1, "Send outcome was stale or the intent was not found");
  }

  async saveAnalysisResult(result: AnalysedResult): Promise<void> {
    requireValue(result.fixture.fixtureVersion === "perform-demo-results-v1", "Unsupported result fixture version");
    requireValue(this.dataProvenance === "DEMO", "Seeded results may only be saved in the demo repository");
    const experiment = await this.requireExperiment(result.fixture.experimentId);
    experimentResultSummary(experiment, result);
    await this.db
      .prepare(
        `INSERT INTO result_snapshots (
           id, creator_uuid, data_provenance, experiment_id, fixture_version,
           variable, lifecycle_state, interpretation_status, evidence_source,
           observed_at, evaluated_at, is_complete, result_json, created_at
         ) VALUES (?, ?, 'DEMO', ?, ?, ?, ?, ?, 'DEMO', ?, ?, ?, ?, ?)
         ON CONFLICT(id, creator_uuid) DO UPDATE SET
           interpretation_status = excluded.interpretation_status,
           result_json = excluded.result_json,
           evaluated_at = excluded.evaluated_at,
           is_complete = excluded.is_complete`,
      )
      .bind(
        result.fixture.id,
        this.creatorUuid,
        result.fixture.experimentId,
        result.fixture.fixtureVersion,
        result.fixture.variable,
        result.fixture.state,
        result.status,
        result.fixture.observation.observedAt,
        result.fixture.observation.evaluatedAt,
        result.fixture.observation.isComplete ? 1 : 0,
        JSON.stringify(result),
        result.fixture.observation.evaluatedAt,
      )
      .run();
  }

  async saveAudienceLearning(learning: AudienceLearning): Promise<void> {
    requireValue(this.dataProvenance === "DEMO", "Seeded learnings may only be saved in the demo repository");
    requireValue(learning.provenance === "DEMO", "Learning provenance must match the repository");
    await this.db
      .prepare(
        `INSERT INTO audience_learnings (
           id, creator_uuid, data_provenance, experiment_id, audience_scope,
           variable, statement, evidence_provenance, created_at
         ) VALUES (?, ?, 'DEMO', ?, ?, ?, ?, 'DEMO', ?)
         ON CONFLICT(creator_uuid, experiment_id) DO NOTHING`,
      )
      .bind(
        learning.id,
        this.creatorUuid,
        learning.experimentId,
        learning.audienceScope,
        learning.variable,
        learning.statement,
        learning.createdAt,
      )
      .run();
  }

  async listAudienceLearnings(): Promise<readonly AudienceLearning[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, experiment_id, audience_scope, variable, statement,
                created_at, evidence_provenance
         FROM audience_learnings
         WHERE creator_uuid = ? AND data_provenance = ?
         ORDER BY created_at DESC`,
      )
      .bind(this.creatorUuid, this.dataProvenance)
      .all<LearningRow>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      experimentId: row.experiment_id,
      audienceScope: row.audience_scope,
      variable: row.variable,
      statement: row.statement,
      createdAt: row.created_at,
      provenance: row.evidence_provenance,
    }));
  }

  async transitionExperiment(command: TransitionCommand): Promise<ExperimentState> {
    const current = await this.requireExperiment(command.experimentId);
    if (current.state === command.to) return current.state;
    transition(current.state, command.to, command.evidence);

    const terminal = command.to === "CLOSED" || command.to === "INVALID";
    const defaults = terminal ? retentionDates(command.occurredAt) : undefined;
    const invalidReason = command.to === "INVALID" ? command.evidence.invalidReason : undefined;
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE experiments
           SET state = ?, invalid_reason = ?, updated_at = ?, terminal_at = ?,
               launched_at = CASE WHEN ? = 'RUNNING' THEN COALESCE(launched_at, ?) ELSE launched_at END,
               observation_started_at = CASE WHEN ? = 'RUNNING' THEN COALESCE(observation_started_at, ?) ELSE observation_started_at END,
               observation_ended_at = CASE WHEN ? = 'CLOSED' THEN COALESCE(observation_ended_at, ?) ELSE observation_ended_at END,
               fan_data_delete_after = ?, aggregate_delete_after = ?
           WHERE id = ? AND creator_uuid = ? AND data_provenance = ? AND state = ?`,
        )
        .bind(
          command.to,
          nullable(invalidReason),
          command.occurredAt,
          terminal ? command.occurredAt : null,
          command.to,
          command.occurredAt,
          command.to,
          command.occurredAt,
          command.to,
          command.occurredAt,
          terminal ? command.fanDataDeleteAfter ?? defaults?.fanDataDeleteAfter ?? null : null,
          terminal ? command.aggregateDeleteAfter ?? defaults?.aggregateDeleteAfter ?? null : null,
          command.experimentId,
          this.creatorUuid,
          this.dataProvenance,
          current.state,
        ),
      this.db
        .prepare(
          `INSERT INTO experiment_transitions (
             experiment_id, command_id, from_state, to_state, reason, occurred_at
           )
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM experiments
             WHERE id = ? AND creator_uuid = ? AND data_provenance = ?
               AND state = ? AND updated_at = ?
           )`,
        )
        .bind(
          command.experimentId,
          command.commandId,
          current.state,
          command.to,
          nullable(command.reason ?? invalidReason),
          command.occurredAt,
          command.experimentId,
          this.creatorUuid,
          this.dataProvenance,
          command.to,
          command.occurredAt,
        ),
    ]);

    if (changes(update) !== 1) {
      const latest = await this.requireExperiment(command.experimentId);
      requireValue(latest.state === command.to, "Experiment state changed concurrently");
    }
    return command.to;
  }

  async deleteFanData(fanUuid: string): Promise<void> {
    requireValue(fanUuid.trim(), "A fan UUID is required");
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM commerce_events
           WHERE kind = 'PAYMENT' AND purchaser_uuid = ? AND creator_uuid = ?
             AND experiment_id IN (
               SELECT id FROM experiments
               WHERE creator_uuid = ? AND data_provenance = ?
             )`,
        )
        .bind(fanUuid, this.creatorUuid, this.creatorUuid, this.dataProvenance),
      this.db
        .prepare(
          `DELETE FROM assignments
           WHERE fan_uuid = ? AND experiment_id IN (
             SELECT id FROM experiments
             WHERE creator_uuid = ? AND data_provenance = ?
           )`,
        )
        .bind(fanUuid, this.creatorUuid, this.dataProvenance),
    ]);
  }

  private async requireExperiment(id: string): Promise<ExperimentRecord> {
    const experiment = await this.getExperiment(id);
    requireValue(experiment, "Experiment was not found in this workspace");
    return experiment;
  }
}
