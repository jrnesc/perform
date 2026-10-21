-- Live commerce evidence (ADRs 0011, 0013, 0015): verified webhook events, dead letters and
-- append-only earnings reconciliation. Nothing here makes a capability live.
PRAGMA foreign_keys = ON;

-- Verified, creator-scoped commerce events attributed to an experiment (ADR 0015).
-- Unrelated payments never reach this table. Reversals may arrive before their payment.
-- A payment counts toward arm totals unless it is MESSAGE_UUID_MATCH with message_matched = 0,
-- which records a plausible purchase that the message-UUID rule could not place.
CREATE TABLE commerce_events (
  source TEXT NOT NULL CHECK (source = 'FANVUE_WEBHOOK'),
  event_id TEXT NOT NULL,
  creator_uuid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PAYMENT', 'REVERSAL')),
  payment_id TEXT NOT NULL,
  reversal_id TEXT,
  reversal_type TEXT CHECK (reversal_type IS NULL OR reversal_type IN ('REFUND', 'DISPUTE')),
  purchaser_uuid TEXT,
  message_uuid TEXT,
  message_type TEXT,
  attribution_strategy TEXT CHECK (attribution_strategy IS NULL OR attribution_strategy IN (
    'MESSAGE_UUID_MATCH', 'ASSIGNMENT_WINDOW'
  )),
  message_matched INTEGER CHECK (message_matched IS NULL OR message_matched IN (0, 1)),
  experiment_id TEXT REFERENCES experiments(id) ON DELETE CASCADE,
  arm TEXT CHECK (arm IS NULL OR arm IN ('A', 'B')),
  gross_minor INTEGER CHECK (gross_minor IS NULL OR gross_minor >= 0),
  net_minor INTEGER CHECK (net_minor IS NULL OR net_minor >= 0),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT, -- informational: Fanvue reports amounts in USD cents and may send null
  occurred_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (source, event_id),
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE,
  CHECK (
    (kind = 'PAYMENT' AND purchaser_uuid IS NOT NULL AND message_uuid IS NOT NULL
      AND experiment_id IS NOT NULL AND arm IS NOT NULL AND gross_minor IS NOT NULL
      AND attribution_strategy IS NOT NULL AND message_matched IS NOT NULL
      AND reversal_id IS NULL AND reversal_type IS NULL)
    OR
    (kind = 'REVERSAL' AND reversal_id IS NOT NULL AND reversal_type IS NOT NULL
      AND purchaser_uuid IS NULL AND message_uuid IS NULL AND experiment_id IS NULL
      AND arm IS NULL AND gross_minor IS NULL AND message_type IS NULL
      AND attribution_strategy IS NULL AND message_matched IS NULL)
  )
) STRICT;

-- A Fanvue payment ID can be carried by one payment event only.
CREATE UNIQUE INDEX commerce_events_payment
  ON commerce_events (creator_uuid, payment_id) WHERE kind = 'PAYMENT';

CREATE INDEX commerce_events_reversal
  ON commerce_events (creator_uuid, payment_id) WHERE kind = 'REVERSAL';

CREATE INDEX commerce_events_experiment
  ON commerce_events (experiment_id, arm, occurred_at) WHERE kind = 'PAYMENT';

CREATE INDEX commerce_events_purchaser
  ON commerce_events (creator_uuid, purchaser_uuid) WHERE kind = 'PAYMENT';

-- Verified but unprocessable deliveries. Only a hash is kept: bodies can carry display fields.
CREATE TABLE commerce_dead_letters (
  id TEXT PRIMARY KEY,
  creator_uuid TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'INVALID_PAYLOAD', 'WRONG_CREATOR', 'EVENT_ID_REUSED', 'PAYMENT_ID_REUSED',
    'ATTRIBUTION_AMBIGUOUS'
  )),
  event_id TEXT,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL
) STRICT;

CREATE INDEX commerce_dead_letters_received
  ON commerce_dead_letters (creator_uuid, received_at DESC);

-- Append-only earnings reconciliation. A later read never overwrites an earlier one.
CREATE TABLE reconciliation_snapshots (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  discrepancy INTEGER NOT NULL CHECK (discrepancy IN (0, 1)),
  needs_reanalysis INTEGER NOT NULL CHECK (needs_reanalysis IN (0, 1)),
  webhook_a_purchases INTEGER NOT NULL CHECK (webhook_a_purchases >= 0),
  webhook_b_purchases INTEGER NOT NULL CHECK (webhook_b_purchases >= 0),
  webhook_a_minor INTEGER NOT NULL CHECK (webhook_a_minor >= 0),
  webhook_b_minor INTEGER NOT NULL CHECK (webhook_b_minor >= 0),
  reconciled_a_purchases INTEGER NOT NULL CHECK (reconciled_a_purchases >= 0),
  reconciled_b_purchases INTEGER NOT NULL CHECK (reconciled_b_purchases >= 0),
  reconciled_a_minor INTEGER NOT NULL CHECK (reconciled_a_minor >= 0),
  reconciled_b_minor INTEGER NOT NULL CHECK (reconciled_b_minor >= 0),
  missing_assignment_count INTEGER NOT NULL CHECK (missing_assignment_count >= 0),
  orphan_reversal_count INTEGER NOT NULL CHECK (orphan_reversal_count >= 0),
  ignored_row_count INTEGER NOT NULL CHECK (ignored_row_count >= 0),
  attribution_strategy TEXT NOT NULL CHECK (attribution_strategy IN ('MESSAGE_UUID_MATCH', 'ASSIGNMENT_WINDOW')),
  assignment_window_only_count INTEGER NOT NULL CHECK (assignment_window_only_count >= 0),
  unmatched_plausible_count INTEGER NOT NULL CHECK (unmatched_plausible_count >= 0),
  -- Fanvue's own per-message totals (GET /v1/chats/mass-messages), summed per arm over the whole
  -- observation. Null when the check was not run.
  fanvue_a_purchases INTEGER CHECK (fanvue_a_purchases IS NULL OR fanvue_a_purchases >= 0),
  fanvue_b_purchases INTEGER CHECK (fanvue_b_purchases IS NULL OR fanvue_b_purchases >= 0),
  fanvue_a_minor INTEGER CHECK (fanvue_a_minor IS NULL OR fanvue_a_minor >= 0),
  fanvue_b_minor INTEGER CHECK (fanvue_b_minor IS NULL OR fanvue_b_minor >= 0),
  aggregate_mismatch INTEGER CHECK (aggregate_mismatch IS NULL OR aggregate_mismatch IN (0, 1)),
  note TEXT NOT NULL,
  CHECK (window_start < window_end),
  CHECK ((fanvue_a_purchases IS NULL) = (aggregate_mismatch IS NULL))
) STRICT;

CREATE INDEX reconciliation_snapshots_experiment
  ON reconciliation_snapshots (experiment_id, captured_at DESC);

CREATE TRIGGER reconciliation_snapshots_immutable
BEFORE UPDATE ON reconciliation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'reconciliation_snapshots are append-only');
END;
