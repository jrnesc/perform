import type { Arm } from "../domain/allocation";
import type { AttributionCandidate, AttributionStrategyId, SendWindow } from "../live/attribution";
import type { SubscriberCohort } from "../integrations/fanvue/subscription-history";
import type { DataProvenance } from "./contracts";
import type { SqlDatabase } from "./d1-perform-repository";

export const audienceEvidenceRowVersion = "perform-audience-member-evidence-v1";
export const audienceEvidenceChunkLimit = 40;

/** Immutable, privacy-minimal pre-assignment facts. Never holds handles or display names. */
export type AudienceEvidenceRow = {
  experimentId: string;
  fanUuid: string;
  arm: Arm;
  version: typeof audienceEvidenceRowVersion;
  capturedAt: string;
  subscriberCohort: SubscriberCohort;
  earliestSubscriptionAt: string | null;
  validPeriodCount: number;
  hasTrial: boolean;
  resubscribedAfterLapse: boolean;
  autoRenewalEnabled: boolean;
  renewsAt: string | null;
  priorSettledPurchaseCount: number;
  priorSettledSpendMinor: number;
};

export type CommerceEventRecord =
  | {
      kind: "PAYMENT";
      eventId: string;
      creatorUuid: string;
      paymentId: string;
      purchaserUuid: string;
      messageUuid: string;
      messageType: string | null;
      attributionStrategy: AttributionStrategyId;
      /** False when the arm came from the assignment-window rule, not a stored message UUID. */
      messageMatched: boolean;
      experimentId: string;
      arm: Arm;
      grossMinor: number;
      netMinor: number | null;
      currency: string | null;
      occurredAt: string;
      payloadHash: string;
      receivedAt: string;
    }
  | {
      kind: "REVERSAL";
      eventId: string;
      creatorUuid: string;
      paymentId: string;
      reversalId: string;
      reversalType: "REFUND" | "DISPUTE";
      amountMinor: number | null;
      currency: string | null;
      occurredAt: string;
      payloadHash: string;
      receivedAt: string;
    };

export type CommerceRecordResult = "RECORDED" | "DUPLICATE" | "EVENT_ID_REUSED" | "PAYMENT_ID_REUSED";

export type DeadLetterReason =
  | "INVALID_PAYLOAD"
  | "WRONG_CREATOR"
  | "EVENT_ID_REUSED"
  | "PAYMENT_ID_REUSED"
  | "ATTRIBUTION_AMBIGUOUS";

/** A payment only counts toward arm totals when its strategy placed it. */
export function countsTowardArms(record: Extract<CommerceEventRecord, { kind: "PAYMENT" }>): boolean {
  return record.attributionStrategy === "ASSIGNMENT_WINDOW" || record.messageMatched;
}

/** Operator view rows: identifiers and counts only, never payload or profile fields. */
export type DeadLetterSummary = {
  id: string;
  reason: DeadLetterReason;
  eventId: string | null;
  receivedAt: string;
};

export type PendingReversalSummary = {
  eventId: string;
  paymentId: string;
  reversalId: string;
  reversalType: "REFUND" | "DISPUTE";
  receivedAt: string;
};

export type ExperimentAttributionCounts = {
  experimentId: string;
  messageMatched: number;
  /** Placed by assignment and window although the message UUID is not a stored experiment message. */
  assignmentWindowOnly: number;
  /** Plausible but uncounted under message-UUID matching. */
  unmatchedPlausible: number;
};

export type ReconciliationRecord = {
  id: string;
  experimentId: string;
  windowStart: string;
  windowEnd: string;
  capturedAt: string;
  isComplete: boolean;
  discrepancy: boolean;
  needsReanalysis: boolean;
  webhookSettledPurchases: Readonly<Record<Arm, number>>;
  webhookSettledMinor: Readonly<Record<Arm, number>>;
  reconciledSettledPurchases: Readonly<Record<Arm, number>>;
  reconciledSettledMinor: Readonly<Record<Arm, number>>;
  missingAssignmentCount: number;
  orphanReversalCount: number;
  ignoredRowCount: number;
  attributionStrategy: AttributionStrategyId;
  assignmentWindowOnlyCount: number;
  unmatchedPlausibleCount: number;
  /** Fanvue's per-message totals over the whole observation, when the check ran. */
  massMessageCheck: {
    purchases: Readonly<Record<Arm, number>>;
    revenueMinor: Readonly<Record<Arm, number>>;
    mismatch: boolean;
  } | null;
  note: string;
};

export interface AttributionContext {
  messages: Readonly<Record<string, Arm>>;
  assignments: Readonly<Record<string, Arm>>;
  /** From the first observed send to the observation end; null before launch. */
  window: SendWindow | null;
}

/** Persistence port for the disabled-by-default live-data boundaries. */
export interface LiveEvidenceRepository {
  saveAudienceEvidence(experimentId: string, rows: readonly AudienceEvidenceRow[]): Promise<void>;
  countAudienceEvidence(experimentId: string): Promise<number>;
  listAudienceEvidence(experimentId: string): Promise<readonly AudienceEvidenceRow[]>;
  listAttributionCandidates(purchaserUuid: string, messageUuid: string): Promise<readonly AttributionCandidate[]>;
  getAttributionContext(experimentId: string): Promise<AttributionContext>;
  recordCommerceEvent(event: CommerceEventRecord): Promise<CommerceRecordResult>;
  listCommerceEvents(experimentId: string): Promise<readonly CommerceEventRecord[]>;
  countReversalsAwaitingPayment(): Promise<number>;
  recordDeadLetter(input: {
    id: string;
    reason: DeadLetterReason;
    eventId: string | null;
    payloadHash: string;
    receivedAt: string;
  }): Promise<void>;
  appendReconciliation(record: ReconciliationRecord): Promise<void>;
  listReconciliations(experimentId: string): Promise<readonly ReconciliationRecord[]>;
}

/** Read-only queries behind the operator view. */
export interface LiveEvidenceOperatorReads {
  listDeadLetters(limit: number): Promise<readonly DeadLetterSummary[]>;
  countDeadLettersByReason(): Promise<Readonly<Partial<Record<DeadLetterReason, number>>>>;
  listReversalsAwaitingPayment(limit: number): Promise<readonly PendingReversalSummary[]>;
  countReversalsAwaitingPayment(): Promise<number>;
  latestReconciliations(): Promise<readonly ReconciliationRecord[]>;
  attributionCounts(): Promise<readonly ExperimentAttributionCounts[]>;
}

type Row = Record<string, string | number | null>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function changes(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

/** D1 adapter scoped, like the main repository, to one creator and one provenance. */
export class D1LiveEvidenceRepository implements LiveEvidenceRepository, LiveEvidenceOperatorReads {
  constructor(
    private readonly db: SqlDatabase,
    private readonly creatorUuid: string,
    private readonly dataProvenance: DataProvenance,
  ) {
    requireValue(creatorUuid.trim(), "A creator UUID is required");
  }

  private async requireExperiment(experimentId: string): Promise<void> {
    const row = await this.db.prepare(
      `SELECT id FROM experiments WHERE id = ? AND creator_uuid = ? AND data_provenance = ?`,
    ).bind(experimentId, this.creatorUuid, this.dataProvenance).first();
    requireValue(row, "Experiment was not found in this workspace");
  }

  async saveAudienceEvidence(experimentId: string, rows: readonly AudienceEvidenceRow[]): Promise<void> {
    if (rows.length === 0) return;
    requireValue(rows.length <= audienceEvidenceChunkLimit, `Live evidence chunks may contain at most ${audienceEvidenceChunkLimit} rows`);
    requireValue(rows.every((row) => row.experimentId === experimentId), "Live evidence belongs to another experiment");
    await this.requireExperiment(experimentId);
    await this.db.batch(rows.map((row) => this.db.prepare(
      `INSERT INTO audience_member_evidence (
         experiment_id, fan_uuid, arm, evidence_version, captured_at, subscriber_cohort,
         earliest_subscription_at, valid_period_count, has_trial, resubscribed_after_lapse,
         auto_renewal_enabled, renews_at, prior_settled_purchase_count, prior_settled_spend_minor
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM assignments a JOIN experiments e ON e.id = a.experiment_id
         WHERE a.experiment_id = ? AND a.fan_uuid = ? AND a.arm = ?
           AND e.creator_uuid = ? AND e.data_provenance = ? AND e.state = 'SNAPSHOTTING'
       )
       ON CONFLICT(experiment_id, fan_uuid) DO NOTHING`,
    ).bind(
      row.experimentId, row.fanUuid, row.arm, row.version, row.capturedAt, row.subscriberCohort,
      row.earliestSubscriptionAt, row.validPeriodCount, row.hasTrial ? 1 : 0,
      row.resubscribedAfterLapse ? 1 : 0, row.autoRenewalEnabled ? 1 : 0, row.renewsAt,
      row.priorSettledPurchaseCount, row.priorSettledSpendMinor,
      row.experimentId, row.fanUuid, row.arm, this.creatorUuid, this.dataProvenance,
    )));
  }

  async countAudienceEvidence(experimentId: string): Promise<number> {
    await this.requireExperiment(experimentId);
    const row = await this.db.prepare(
      `SELECT count(*) AS total FROM audience_member_evidence WHERE experiment_id = ?`,
    ).bind(experimentId).first<{ total: number }>();
    return row?.total ?? 0;
  }

  async listAudienceEvidence(experimentId: string): Promise<readonly AudienceEvidenceRow[]> {
    await this.requireExperiment(experimentId);
    const rows = await this.db.prepare(
      `SELECT * FROM audience_member_evidence WHERE experiment_id = ? ORDER BY fan_uuid`,
    ).bind(experimentId).all<Row>();
    return (rows.results ?? []).map((row) => ({
      experimentId: String(row.experiment_id),
      fanUuid: String(row.fan_uuid),
      arm: row.arm as Arm,
      version: audienceEvidenceRowVersion,
      capturedAt: String(row.captured_at),
      subscriberCohort: row.subscriber_cohort as SubscriberCohort,
      earliestSubscriptionAt: row.earliest_subscription_at === null ? null : String(row.earliest_subscription_at),
      validPeriodCount: Number(row.valid_period_count),
      hasTrial: row.has_trial === 1,
      resubscribedAfterLapse: row.resubscribed_after_lapse === 1,
      autoRenewalEnabled: row.auto_renewal_enabled === 1,
      renewsAt: row.renews_at === null ? null : String(row.renews_at),
      priorSettledPurchaseCount: Number(row.prior_settled_purchase_count),
      priorSettledSpendMinor: Number(row.prior_settled_spend_minor),
    }));
  }

  async listAttributionCandidates(purchaserUuid: string, messageUuid: string): Promise<readonly AttributionCandidate[]> {
    const rows = await this.db.prepare(
      `SELECT * FROM (
         SELECT e.id AS experiment_id,
           (SELECT a.arm FROM assignments a WHERE a.experiment_id = e.id AND a.fan_uuid = ?) AS assigned_arm,
           (SELECT si.arm FROM send_intents si
            WHERE si.experiment_id = e.id AND si.creator_uuid = e.creator_uuid AND si.status = 'CONFIRMED'
              AND si.external_message_uuid = ?) AS message_arm,
           ${windowColumns}
         FROM experiments e WHERE e.creator_uuid = ? AND e.data_provenance = ?
       ) WHERE assigned_arm IS NOT NULL OR message_arm IS NOT NULL
       ORDER BY experiment_id`,
    ).bind(purchaserUuid, messageUuid, this.creatorUuid, this.dataProvenance)
      .all<{ experiment_id: string; assigned_arm: Arm | null; message_arm: Arm | null; window_start: string | null; window_end: string | null }>();
    return (rows.results ?? []).map((row) => ({
      experimentId: row.experiment_id,
      assignedArm: row.assigned_arm,
      messageArm: row.message_arm,
      window: sendWindow(row),
    }));
  }

  async getAttributionContext(experimentId: string): Promise<AttributionContext> {
    await this.requireExperiment(experimentId);
    const messages = await this.db.prepare(
      `SELECT external_message_uuid AS message_uuid, arm FROM send_intents
       WHERE experiment_id = ? AND creator_uuid = ? AND status = 'CONFIRMED'
         AND external_message_uuid IS NOT NULL`,
    ).bind(experimentId, this.creatorUuid).all<{ message_uuid: string; arm: Arm }>();
    const assignments = await this.db.prepare(
      `SELECT fan_uuid, arm FROM assignments WHERE experiment_id = ?`,
    ).bind(experimentId).all<{ fan_uuid: string; arm: Arm }>();
    const window = await this.db.prepare(
      `SELECT ${windowColumns} FROM experiments e WHERE e.id = ?`,
    ).bind(experimentId).first<{ window_start: string | null; window_end: string | null }>();
    return {
      messages: Object.fromEntries((messages.results ?? []).map((row) => [row.message_uuid, row.arm])),
      assignments: Object.fromEntries((assignments.results ?? []).map((row) => [row.fan_uuid, row.arm])),
      window: window ? sendWindow(window) : null,
    };
  }

  async recordCommerceEvent(event: CommerceEventRecord): Promise<CommerceRecordResult> {
    requireValue(event.creatorUuid === this.creatorUuid, "Commerce event belongs to another creator");
    if (event.kind === "PAYMENT") await this.requireExperiment(event.experimentId);

    const classify = async (): Promise<CommerceRecordResult | null> => {
      const existing = await this.db.prepare(
        `SELECT payload_hash FROM commerce_events WHERE source = 'FANVUE_WEBHOOK' AND event_id = ?`,
      ).bind(event.eventId).first<{ payload_hash: string }>();
      if (existing) return existing.payload_hash === event.payloadHash ? "DUPLICATE" : "EVENT_ID_REUSED";
      if (event.kind === "PAYMENT") {
        const payment = await this.db.prepare(
          `SELECT event_id FROM commerce_events
           WHERE creator_uuid = ? AND payment_id = ? AND kind = 'PAYMENT'`,
        ).bind(this.creatorUuid, event.paymentId).first();
        if (payment) return "PAYMENT_ID_REUSED";
      }
      return null;
    };

    const prior = await classify();
    if (prior) return prior;

    const payment = event.kind === "PAYMENT" ? event : null;
    const reversal = event.kind === "REVERSAL" ? event : null;
    const result = await this.db.prepare(
      `INSERT INTO commerce_events (
         source, event_id, creator_uuid, kind, payment_id, reversal_id, reversal_type,
         purchaser_uuid, message_uuid, message_type, attribution_strategy, message_matched,
         experiment_id, arm, gross_minor, net_minor,
         amount_minor, currency, occurred_at, payload_hash, received_at
       ) VALUES ('FANVUE_WEBHOOK', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(
      event.eventId, event.creatorUuid, event.kind, event.paymentId,
      reversal?.reversalId ?? null, reversal?.reversalType ?? null,
      payment?.purchaserUuid ?? null, payment?.messageUuid ?? null,
      payment?.messageType ?? null, payment?.attributionStrategy ?? null,
      payment ? (payment.messageMatched ? 1 : 0) : null,
      payment?.experimentId ?? null, payment?.arm ?? null,
      payment?.grossMinor ?? null, payment?.netMinor ?? null,
      reversal?.amountMinor ?? null, payment?.currency ?? reversal?.currency ?? null,
      event.occurredAt, event.payloadHash, event.receivedAt,
    ).run();
    if (changes(result) === 1) return "RECORDED";
    // A concurrent delivery won the race; report why this one did not insert.
    return (await classify()) ?? "DUPLICATE";
  }

  async listCommerceEvents(experimentId: string): Promise<readonly CommerceEventRecord[]> {
    await this.requireExperiment(experimentId);
    const payments = await this.db.prepare(
      `SELECT * FROM commerce_events
       WHERE kind = 'PAYMENT' AND experiment_id = ? AND creator_uuid = ?
       ORDER BY occurred_at, event_id`,
    ).bind(experimentId, this.creatorUuid).all<Row>();
    const reversals = await this.db.prepare(
      `SELECT * FROM commerce_events
       WHERE kind = 'REVERSAL' AND creator_uuid = ? AND payment_id IN (
         SELECT payment_id FROM commerce_events
         WHERE kind = 'PAYMENT' AND experiment_id = ? AND creator_uuid = ?
       )
       ORDER BY occurred_at, event_id`,
    ).bind(this.creatorUuid, experimentId, this.creatorUuid).all<Row>();
    return [...(payments.results ?? []), ...(reversals.results ?? [])].map(commerceFromRow);
  }

  async countReversalsAwaitingPayment(): Promise<number> {
    const row = await this.db.prepare(
      `SELECT count(*) AS total FROM commerce_events r
       WHERE r.kind = 'REVERSAL' AND r.creator_uuid = ? AND NOT EXISTS (
         SELECT 1 FROM commerce_events p
         WHERE p.kind = 'PAYMENT' AND p.creator_uuid = r.creator_uuid AND p.payment_id = r.payment_id
       )`,
    ).bind(this.creatorUuid).first<{ total: number }>();
    return row?.total ?? 0;
  }

  async recordDeadLetter(input: {
    id: string; reason: DeadLetterReason; eventId: string | null; payloadHash: string; receivedAt: string;
  }): Promise<void> {
    await this.db.prepare(
      `INSERT INTO commerce_dead_letters (id, creator_uuid, reason, event_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).bind(input.id, this.creatorUuid, input.reason, input.eventId, input.payloadHash, input.receivedAt).run();
  }

  async appendReconciliation(record: ReconciliationRecord): Promise<void> {
    await this.requireExperiment(record.experimentId);
    await this.db.prepare(
      `INSERT INTO reconciliation_snapshots (
         id, experiment_id, window_start, window_end, captured_at, is_complete, discrepancy,
         needs_reanalysis, webhook_a_purchases, webhook_b_purchases, webhook_a_minor,
         webhook_b_minor, reconciled_a_purchases, reconciled_b_purchases, reconciled_a_minor,
         reconciled_b_minor, missing_assignment_count, orphan_reversal_count, ignored_row_count,
         attribution_strategy, assignment_window_only_count, unmatched_plausible_count,
         fanvue_a_purchases, fanvue_b_purchases, fanvue_a_minor, fanvue_b_minor, aggregate_mismatch, note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      record.id, record.experimentId, record.windowStart, record.windowEnd, record.capturedAt,
      record.isComplete ? 1 : 0, record.discrepancy ? 1 : 0, record.needsReanalysis ? 1 : 0,
      record.webhookSettledPurchases.A, record.webhookSettledPurchases.B,
      record.webhookSettledMinor.A, record.webhookSettledMinor.B,
      record.reconciledSettledPurchases.A, record.reconciledSettledPurchases.B,
      record.reconciledSettledMinor.A, record.reconciledSettledMinor.B,
      record.missingAssignmentCount, record.orphanReversalCount, record.ignoredRowCount,
      record.attributionStrategy, record.assignmentWindowOnlyCount, record.unmatchedPlausibleCount,
      record.massMessageCheck?.purchases.A ?? null, record.massMessageCheck?.purchases.B ?? null,
      record.massMessageCheck?.revenueMinor.A ?? null, record.massMessageCheck?.revenueMinor.B ?? null,
      record.massMessageCheck ? (record.massMessageCheck.mismatch ? 1 : 0) : null,
      record.note,
    ).run();
  }

  async listReconciliations(experimentId: string): Promise<readonly ReconciliationRecord[]> {
    await this.requireExperiment(experimentId);
    const rows = await this.db.prepare(
      `SELECT * FROM reconciliation_snapshots WHERE experiment_id = ? ORDER BY captured_at, id`,
    ).bind(experimentId).all<Row>();
    return (rows.results ?? []).map(reconciliationFromRow);
  }

  async listDeadLetters(limit: number): Promise<readonly DeadLetterSummary[]> {
    const rows = await this.db.prepare(
      `SELECT id, reason, event_id, received_at FROM commerce_dead_letters
       WHERE creator_uuid = ? ORDER BY received_at DESC, id LIMIT ?`,
    ).bind(this.creatorUuid, boundedLimit(limit)).all<Row>();
    return (rows.results ?? []).map((row) => ({
      id: String(row.id),
      reason: row.reason as DeadLetterReason,
      eventId: row.event_id === null ? null : String(row.event_id),
      receivedAt: String(row.received_at),
    }));
  }

  async countDeadLettersByReason() {
    const rows = await this.db.prepare(
      `SELECT reason, count(*) AS total FROM commerce_dead_letters WHERE creator_uuid = ? GROUP BY reason`,
    ).bind(this.creatorUuid).all<{ reason: DeadLetterReason; total: number }>();
    return Object.fromEntries((rows.results ?? []).map((row) => [row.reason, Number(row.total)]));
  }

  async listReversalsAwaitingPayment(limit: number): Promise<readonly PendingReversalSummary[]> {
    const rows = await this.db.prepare(
      `SELECT r.event_id, r.payment_id, r.reversal_id, r.reversal_type, r.received_at
       FROM commerce_events r
       WHERE r.kind = 'REVERSAL' AND r.creator_uuid = ? AND NOT EXISTS (
         SELECT 1 FROM commerce_events p
         WHERE p.kind = 'PAYMENT' AND p.creator_uuid = r.creator_uuid AND p.payment_id = r.payment_id
       )
       ORDER BY r.received_at, r.event_id LIMIT ?`,
    ).bind(this.creatorUuid, boundedLimit(limit)).all<Row>();
    return (rows.results ?? []).map((row) => ({
      eventId: String(row.event_id),
      paymentId: String(row.payment_id),
      reversalId: String(row.reversal_id),
      reversalType: row.reversal_type as "REFUND" | "DISPUTE",
      receivedAt: String(row.received_at),
    }));
  }

  async latestReconciliations(): Promise<readonly ReconciliationRecord[]> {
    const rows = await this.db.prepare(
      `SELECT r.* FROM reconciliation_snapshots r
       JOIN experiments e ON e.id = r.experiment_id
       WHERE e.creator_uuid = ? AND e.data_provenance = ? AND r.id = (
         SELECT latest.id FROM reconciliation_snapshots latest
         WHERE latest.experiment_id = r.experiment_id
         ORDER BY latest.captured_at DESC, latest.id DESC LIMIT 1
       )
       ORDER BY r.experiment_id`,
    ).bind(this.creatorUuid, this.dataProvenance).all<Row>();
    return (rows.results ?? []).map(reconciliationFromRow);
  }

  async attributionCounts(): Promise<readonly ExperimentAttributionCounts[]> {
    const rows = await this.db.prepare(
      `SELECT c.experiment_id,
         sum(CASE WHEN c.message_matched = 1 THEN 1 ELSE 0 END) AS message_matched,
         sum(CASE WHEN c.message_matched = 0 AND c.attribution_strategy = 'ASSIGNMENT_WINDOW' THEN 1 ELSE 0 END) AS window_only,
         sum(CASE WHEN c.message_matched = 0 AND c.attribution_strategy = 'MESSAGE_UUID_MATCH' THEN 1 ELSE 0 END) AS unmatched
       FROM commerce_events c JOIN experiments e ON e.id = c.experiment_id
       WHERE c.kind = 'PAYMENT' AND c.creator_uuid = ? AND e.creator_uuid = ? AND e.data_provenance = ?
       GROUP BY c.experiment_id ORDER BY c.experiment_id`,
    ).bind(this.creatorUuid, this.creatorUuid, this.dataProvenance).all<Row>();
    return (rows.results ?? []).map((row) => ({
      experimentId: String(row.experiment_id),
      messageMatched: Number(row.message_matched),
      assignmentWindowOnly: Number(row.window_only),
      unmatchedPlausible: Number(row.unmatched),
    }));
  }
}

/** Window from the first observed send (or launch) to the observation end, if any. */
const windowColumns = `COALESCE(e.observation_started_at, e.launched_at) AS window_start,
           COALESCE(e.observation_ended_at, e.observation_ends_at) AS window_end`;

function sendWindow(row: { window_start: string | null; window_end: string | null }): SendWindow | null {
  return row.window_start ? { startAt: row.window_start, endAt: row.window_end } : null;
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function reconciliationFromRow(row: Row): ReconciliationRecord {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    capturedAt: String(row.captured_at),
    isComplete: row.is_complete === 1,
    discrepancy: row.discrepancy === 1,
    needsReanalysis: row.needs_reanalysis === 1,
    webhookSettledPurchases: { A: Number(row.webhook_a_purchases), B: Number(row.webhook_b_purchases) },
    webhookSettledMinor: { A: Number(row.webhook_a_minor), B: Number(row.webhook_b_minor) },
    reconciledSettledPurchases: { A: Number(row.reconciled_a_purchases), B: Number(row.reconciled_b_purchases) },
    reconciledSettledMinor: { A: Number(row.reconciled_a_minor), B: Number(row.reconciled_b_minor) },
    missingAssignmentCount: Number(row.missing_assignment_count),
    orphanReversalCount: Number(row.orphan_reversal_count),
    ignoredRowCount: Number(row.ignored_row_count),
    attributionStrategy: row.attribution_strategy as AttributionStrategyId,
    assignmentWindowOnlyCount: Number(row.assignment_window_only_count),
    unmatchedPlausibleCount: Number(row.unmatched_plausible_count),
    massMessageCheck: row.aggregate_mismatch === null ? null : {
      purchases: { A: Number(row.fanvue_a_purchases), B: Number(row.fanvue_b_purchases) },
      revenueMinor: { A: Number(row.fanvue_a_minor), B: Number(row.fanvue_b_minor) },
      mismatch: row.aggregate_mismatch === 1,
    },
    note: String(row.note),
  };
}

function commerceFromRow(row: Row): CommerceEventRecord {
  const common = {
    eventId: String(row.event_id),
    creatorUuid: String(row.creator_uuid),
    paymentId: String(row.payment_id),
    occurredAt: String(row.occurred_at),
    payloadHash: String(row.payload_hash),
    receivedAt: String(row.received_at),
  };
  if (row.kind === "PAYMENT") {
    return {
      ...common, kind: "PAYMENT",
      purchaserUuid: String(row.purchaser_uuid), messageUuid: String(row.message_uuid),
      messageType: row.message_type === null ? null : String(row.message_type),
      attributionStrategy: row.attribution_strategy as AttributionStrategyId,
      messageMatched: row.message_matched === 1,
      experimentId: String(row.experiment_id), arm: row.arm as Arm,
      grossMinor: Number(row.gross_minor),
      netMinor: row.net_minor === null ? null : Number(row.net_minor),
      currency: row.currency === null ? null : String(row.currency),
    };
  }
  return {
    ...common, kind: "REVERSAL",
    reversalId: String(row.reversal_id),
    reversalType: row.reversal_type as "REFUND" | "DISPUTE",
    amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
    currency: row.currency === null ? null : String(row.currency),
  };
}
