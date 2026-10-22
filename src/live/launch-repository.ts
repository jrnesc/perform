import type { Arm } from "../domain/allocation";
import type { SqlDatabase } from "../persistence/d1-perform-repository";

export type ProvisionedListRecord = {
  arm: Arm;
  status: "CREATING" | "CONFIRMED" | "UNKNOWN" | "DELETED";
  externalListUuid?: string;
  expectedCount: number;
  actualCount?: number;
  lastErrorCode?: string;
};

export type ProvisioningBatchRecord = {
  arm: Arm;
  batchNumber: number;
  payloadHash: string;
  memberCount: number;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "UNKNOWN";
};

export type LaunchConfirmation = {
  scheduledAt: string;
  observationEndsAt: string;
  confirmationHash: string;
  confirmedAt: string;
};

export interface LaunchRepository {
  recordConfirmation(input: LaunchConfirmation): Promise<void>;
  getConfirmation(): Promise<LaunchConfirmation | null>;
  /** `claimed` is true only for the caller whose insert created the row; everyone else must not create a list. */
  beginList(
    arm: Arm,
    expectedCount: number,
    occurredAt: string,
  ): Promise<{ record: ProvisionedListRecord; claimed: boolean }>;
  recordListOutcome(input: ProvisionedListRecord & { occurredAt: string }): Promise<void>;
  getList(arm: Arm): Promise<ProvisionedListRecord | null>;
  beginBatch(input: Omit<ProvisioningBatchRecord, "status"> & { occurredAt: string }): Promise<ProvisioningBatchRecord>;
  recordBatchOutcome(input: ProvisioningBatchRecord & { errorCode?: string; occurredAt: string }): Promise<void>;
  markIntentCancelled(intentId: string, occurredAt: string): Promise<void>;
}

type ListRow = {
  arm: Arm;
  status: ProvisionedListRecord["status"];
  external_list_uuid: string | null;
  expected_count: number;
  actual_count: number | null;
  last_error_code: string | null;
};
type BatchRow = {
  arm: Arm;
  batch_number: number;
  payload_hash: string;
  member_count: number;
  status: ProvisioningBatchRecord["status"];
};

function listRecord(row: ListRow): ProvisionedListRecord {
  return {
    arm: row.arm,
    status: row.status,
    expectedCount: row.expected_count,
    externalListUuid: row.external_list_uuid ?? undefined,
    actualCount: row.actual_count ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
  };
}

function batchRecord(row: BatchRow): ProvisioningBatchRecord {
  return {
    arm: row.arm,
    batchNumber: row.batch_number,
    payloadHash: row.payload_hash,
    memberCount: row.member_count,
    status: row.status,
  };
}

/** Creator- and experiment-scoped durable launch ledger. */
export class D1LaunchRepository implements LaunchRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly creatorUuid: string,
    private readonly experimentId: string,
  ) {}

  async recordConfirmation(input: LaunchConfirmation): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO launch_confirmations (
         experiment_id, creator_uuid, scheduled_at, observation_ends_at, confirmation_hash, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(experiment_id) DO NOTHING`,
      )
      .bind(
        this.experimentId,
        this.creatorUuid,
        input.scheduledAt,
        input.observationEndsAt,
        input.confirmationHash,
        input.confirmedAt,
      )
      .run();
    const saved = await this.getConfirmation();
    if (
      !saved ||
      saved.scheduledAt !== input.scheduledAt ||
      saved.observationEndsAt !== input.observationEndsAt ||
      saved.confirmationHash !== input.confirmationHash
    ) {
      throw new Error("Launch confirmation is already bound to different effects");
    }
    // Attribution and reconciliation read the window end from the experiment row.
    await this.db
      .prepare(
        `UPDATE experiments SET observation_ends_at = ?
       WHERE id = ? AND creator_uuid = ? AND observation_ends_at IS NULL`,
      )
      .bind(input.observationEndsAt, this.experimentId, this.creatorUuid)
      .run();
  }

  async getConfirmation(): Promise<LaunchConfirmation | null> {
    const row = await this.db
      .prepare(
        `SELECT scheduled_at, observation_ends_at, confirmation_hash, confirmed_at FROM launch_confirmations
       WHERE experiment_id = ? AND creator_uuid = ?`,
      )
      .bind(this.experimentId, this.creatorUuid)
      .first<{
        scheduled_at: string;
        observation_ends_at: string;
        confirmation_hash: string;
        confirmed_at: string;
      }>();
    return row
      ? {
          scheduledAt: row.scheduled_at,
          observationEndsAt: row.observation_ends_at,
          confirmationHash: row.confirmation_hash,
          confirmedAt: row.confirmed_at,
        }
      : null;
  }

  async beginList(
    arm: Arm,
    expectedCount: number,
    occurredAt: string,
  ): Promise<{ record: ProvisionedListRecord; claimed: boolean }> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO provisioned_lists (
         experiment_id, arm, creator_uuid, status, expected_count, created_at, updated_at
       ) VALUES (?, ?, ?, 'CREATING', ?, ?, ?)
       ON CONFLICT(experiment_id, arm) DO NOTHING`,
      )
      .bind(this.experimentId, arm, this.creatorUuid, expectedCount, occurredAt, occurredAt)
      .run();
    const record = await this.getList(arm);
    if (!record || record.expectedCount !== expectedCount)
      throw new Error(`Arm ${arm} list is bound to different assignments`);
    return { record, claimed: inserted.meta?.changes === 1 };
  }

  async recordListOutcome(input: ProvisionedListRecord & { occurredAt: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE provisioned_lists SET status = ?, external_list_uuid = COALESCE(?, external_list_uuid),
         actual_count = COALESCE(?, actual_count), last_error_code = ?, updated_at = ?
       WHERE experiment_id = ? AND arm = ? AND creator_uuid = ?`,
      )
      .bind(
        input.status,
        input.externalListUuid ?? null,
        input.actualCount ?? null,
        input.lastErrorCode ?? null,
        input.occurredAt,
        this.experimentId,
        input.arm,
        this.creatorUuid,
      )
      .run();
  }

  async getList(arm: Arm): Promise<ProvisionedListRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT arm, status, external_list_uuid, expected_count, actual_count, last_error_code
       FROM provisioned_lists WHERE experiment_id = ? AND arm = ? AND creator_uuid = ?`,
      )
      .bind(this.experimentId, arm, this.creatorUuid)
      .first<ListRow>();
    return row ? listRecord(row) : null;
  }

  async beginBatch(
    input: Omit<ProvisioningBatchRecord, "status"> & { occurredAt: string },
  ): Promise<ProvisioningBatchRecord> {
    await this.db
      .prepare(
        `INSERT INTO provisioning_batches (
         experiment_id, arm, batch_number, payload_hash, member_count, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
       ON CONFLICT(experiment_id, arm, batch_number) DO NOTHING`,
      )
      .bind(
        this.experimentId,
        input.arm,
        input.batchNumber,
        input.payloadHash,
        input.memberCount,
        input.occurredAt,
        input.occurredAt,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT arm, batch_number, payload_hash, member_count, status
       FROM provisioning_batches WHERE experiment_id = ? AND arm = ? AND batch_number = ?`,
      )
      .bind(this.experimentId, input.arm, input.batchNumber)
      .first<BatchRow>();
    if (!row || row.payload_hash !== input.payloadHash || row.member_count !== input.memberCount) {
      throw new Error(`Arm ${input.arm} batch ${input.batchNumber} is bound to different members`);
    }
    return batchRecord(row);
  }

  async recordBatchOutcome(input: ProvisioningBatchRecord & { errorCode?: string; occurredAt: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE provisioning_batches SET status = ?, last_error_code = ?, updated_at = ?
       WHERE experiment_id = ? AND arm = ? AND batch_number = ? AND payload_hash = ?`,
      )
      .bind(
        input.status,
        input.errorCode ?? null,
        input.occurredAt,
        this.experimentId,
        input.arm,
        input.batchNumber,
        input.payloadHash,
      )
      .run();
  }

  async markIntentCancelled(intentId: string, occurredAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE send_intents SET cancelled_at = ?, updated_at = ?
       WHERE id = ? AND creator_uuid = ? AND experiment_id = ? AND external_message_uuid IS NOT NULL`,
      )
      .bind(occurredAt, occurredAt, intentId, this.creatorUuid, this.experimentId)
      .run();
  }
}
