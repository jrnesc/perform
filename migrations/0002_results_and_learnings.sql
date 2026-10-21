PRAGMA foreign_keys = ON;

CREATE TABLE result_snapshots (
  id TEXT NOT NULL,
  creator_uuid TEXT NOT NULL,
  data_provenance TEXT NOT NULL CHECK (data_provenance IN ('REAL', 'DEMO')),
  experiment_id TEXT NOT NULL,
  fixture_version TEXT,
  variable TEXT NOT NULL CHECK (variable IN ('COPY', 'PRICE')),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'DRAFT', 'SNAPSHOTTING', 'ALLOCATED', 'PROVISIONING', 'VERIFIED', 'ARMED',
    'SENDING', 'RUNNING', 'PARTIAL_LAUNCH', 'OPERATOR_REVIEW', 'CLOSED', 'INVALID'
  )),
  interpretation_status TEXT NOT NULL CHECK (interpretation_status IN (
    'LEARNING_READY', 'LOW_VOLUME', 'ZERO_PURCHASES', 'STALE', 'INCOMPLETE',
    'PARTIAL_LAUNCH', 'INVALID'
  )),
  evidence_source TEXT NOT NULL CHECK (evidence_source IN (
    'WEBHOOK_DERIVED', 'FANVUE_RECONCILIATION', 'DEMO', 'DRY_RUN'
  )),
  observed_at TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, creator_uuid)
) STRICT;

CREATE INDEX result_snapshots_creator_evaluated
  ON result_snapshots (creator_uuid, data_provenance, evaluated_at DESC);

CREATE TABLE audience_learnings (
  id TEXT NOT NULL,
  creator_uuid TEXT NOT NULL,
  data_provenance TEXT NOT NULL CHECK (data_provenance IN ('REAL', 'DEMO')),
  experiment_id TEXT NOT NULL,
  audience_scope TEXT NOT NULL CHECK (length(trim(audience_scope)) > 0),
  variable TEXT NOT NULL CHECK (variable IN ('COPY', 'PRICE')),
  statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
  evidence_provenance TEXT NOT NULL CHECK (evidence_provenance IN (
    'WEBHOOK_DERIVED', 'FANVUE_RECONCILIATION', 'DEMO', 'DRY_RUN'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, creator_uuid),
  UNIQUE (creator_uuid, experiment_id)
) STRICT;

CREATE INDEX audience_learnings_creator_created
  ON audience_learnings (creator_uuid, data_provenance, created_at DESC);
