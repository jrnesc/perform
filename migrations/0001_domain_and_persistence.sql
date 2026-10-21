PRAGMA foreign_keys = ON;

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  -- A creator-facing label, not an identity: id stays the stable key.
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  creator_uuid TEXT NOT NULL,
  data_provenance TEXT NOT NULL CHECK (data_provenance IN ('REAL', 'DEMO')),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT', 'SNAPSHOTTING', 'ALLOCATED', 'PROVISIONING', 'VERIFIED', 'ARMED',
    'SENDING', 'RUNNING', 'PARTIAL_LAUNCH', 'OPERATOR_REVIEW', 'CLOSED', 'INVALID'
  )),
  variable TEXT NOT NULL CHECK (variable IN ('COPY', 'PRICE')),
  hypothesis TEXT NOT NULL CHECK (length(trim(hypothesis)) > 0),
  source_audience_uuid TEXT NOT NULL,
  snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR length(snapshot_hash) = 64),
  snapshot_count INTEGER CHECK (snapshot_count IS NULL OR snapshot_count >= 2),
  allocation_algorithm TEXT,
  snapshot_at TEXT,
  observation_ends_at TEXT,
  launched_at TEXT,
  observation_started_at TEXT,
  observation_ended_at TEXT,
  invalid_reason TEXT,
  fan_data_delete_after TEXT,
  aggregate_delete_after TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK (
    (snapshot_hash IS NULL AND snapshot_count IS NULL AND allocation_algorithm IS NULL AND snapshot_at IS NULL)
    OR
    (snapshot_hash IS NOT NULL AND snapshot_count IS NOT NULL AND allocation_algorithm IS NOT NULL AND snapshot_at IS NOT NULL)
  ),
  CHECK (state IN ('DRAFT', 'SNAPSHOTTING', 'INVALID') OR snapshot_hash IS NOT NULL),
  CHECK (
    state <> 'INVALID'
    OR (invalid_reason IS NOT NULL AND length(trim(invalid_reason)) > 0)
  )
) STRICT;

CREATE INDEX experiments_creator_provenance_history
  ON experiments (creator_uuid, data_provenance, updated_at DESC, created_at DESC, id ASC);

CREATE TABLE variants (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  copy_text TEXT NOT NULL CHECK (length(trim(copy_text)) > 0),
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  media_uuid TEXT NOT NULL,
  PRIMARY KEY (experiment_id, arm)
) STRICT;

CREATE TABLE assignments (
  experiment_id TEXT NOT NULL,
  fan_uuid TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  stratum TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, fan_uuid),
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE
) STRICT;

CREATE INDEX assignments_experiment_arm
  ON assignments (experiment_id, arm);

CREATE TABLE send_intents (
  id TEXT PRIMARY KEY,
  creator_uuid TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
  external_message_uuid TEXT,
  attempted_at TEXT,
  confirmed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (experiment_id, arm),
  UNIQUE (creator_uuid, idempotency_key),
  UNIQUE (external_message_uuid),
  UNIQUE (experiment_id, arm, external_message_uuid),
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE,
  CHECK (
    status <> 'CONFIRMED'
    OR (external_message_uuid IS NOT NULL AND confirmed_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE webhook_events (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  PRIMARY KEY (source, event_id)
) STRICT;

CREATE TABLE purchases (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  purchaser_uuid TEXT NOT NULL,
  external_message_uuid TEXT NOT NULL,
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  net_minor INTEGER CHECK (net_minor IS NULL OR net_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (source, event_id),
  FOREIGN KEY (source, event_id) REFERENCES webhook_events(source, event_id) ON DELETE CASCADE,
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE,
  FOREIGN KEY (experiment_id, arm, external_message_uuid)
    REFERENCES send_intents(experiment_id, arm, external_message_uuid)
) STRICT;

CREATE INDEX purchases_experiment_arm
  ON purchases (experiment_id, arm, occurred_at);

CREATE INDEX purchases_purchaser
  ON purchases (purchaser_uuid);

CREATE TABLE metric_snapshots (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  source TEXT NOT NULL CHECK (source IN (
    'WEBHOOK_DERIVED', 'FANVUE_RECONCILIATION', 'DEMO', 'DRY_RUN'
  )),
  assigned_recipient_count INTEGER NOT NULL CHECK (assigned_recipient_count >= 0),
  delivered_count INTEGER CHECK (delivered_count IS NULL OR delivered_count >= 0),
  view_count INTEGER CHECK (view_count IS NULL OR view_count >= 0),
  purchase_count INTEGER NOT NULL CHECK (purchase_count >= 0),
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  net_minor INTEGER CHECK (net_minor IS NULL OR net_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  source_observed_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  provenance_note TEXT,
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE
) STRICT;

CREATE INDEX metric_snapshots_experiment_captured
  ON metric_snapshots (experiment_id, captured_at DESC);

CREATE TABLE experiment_transitions (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (experiment_id, command_id),
  CHECK (from_state <> to_state)
) STRICT;

CREATE INDEX experiment_transitions_timeline
  ON experiment_transitions (experiment_id, occurred_at);
