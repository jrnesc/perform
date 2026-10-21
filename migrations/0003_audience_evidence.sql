-- Immutable pre-assignment audience evidence for seeded and live experiments alike (ADRs 0010,
-- 0014, 0016): provenance is the database and experiments.data_provenance. Facts come from
-- subscription history, Fan Insights status and reversal-adjusted purchase totals. No handles,
-- display names or avatars. Also normalized purchase reversals.
PRAGMA foreign_keys = ON;

CREATE TABLE audience_member_evidence (
  experiment_id TEXT NOT NULL,
  fan_uuid TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('A', 'B')),
  evidence_version TEXT NOT NULL CHECK (evidence_version = 'perform-audience-member-evidence-v1'),
  captured_at TEXT NOT NULL,
  subscriber_cohort TEXT NOT NULL CHECK (subscriber_cohort IN (
    'never_subscribed', 'trialing', 'active_renewing', 'active_not_renewing', 'lapsed'
  )),
  earliest_subscription_at TEXT,
  valid_period_count INTEGER NOT NULL CHECK (valid_period_count >= 0),
  has_trial INTEGER NOT NULL CHECK (has_trial IN (0, 1)),
  resubscribed_after_lapse INTEGER NOT NULL CHECK (resubscribed_after_lapse IN (0, 1)),
  auto_renewal_enabled INTEGER NOT NULL CHECK (auto_renewal_enabled IN (0, 1)),
  renews_at TEXT,
  prior_settled_purchase_count INTEGER NOT NULL CHECK (prior_settled_purchase_count >= 0),
  prior_settled_spend_minor INTEGER NOT NULL CHECK (prior_settled_spend_minor >= 0),
  PRIMARY KEY (experiment_id, fan_uuid),
  FOREIGN KEY (experiment_id, fan_uuid) REFERENCES assignments(experiment_id, fan_uuid) ON DELETE CASCADE,
  FOREIGN KEY (experiment_id, arm) REFERENCES variants(experiment_id, arm) ON DELETE CASCADE,
  CHECK ((subscriber_cohort = 'never_subscribed') = (valid_period_count = 0)),
  CHECK ((valid_period_count = 0) = (earliest_subscription_at IS NULL))
) STRICT;

CREATE INDEX audience_member_evidence_cohort
  ON audience_member_evidence (experiment_id, arm, subscriber_cohort);

CREATE TRIGGER audience_member_evidence_immutable
BEFORE UPDATE ON audience_member_evidence
BEGIN
  SELECT RAISE(ABORT, 'audience_member_evidence is immutable');
END;

CREATE TABLE purchase_reversals (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  purchase_source TEXT NOT NULL,
  purchase_event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REFUND', 'DISPUTE')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (source, event_id),
  FOREIGN KEY (source, event_id) REFERENCES webhook_events(source, event_id) ON DELETE CASCADE,
  FOREIGN KEY (purchase_source, purchase_event_id) REFERENCES purchases(source, event_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX purchase_reversals_purchase
  ON purchase_reversals (purchase_source, purchase_event_id, occurred_at);
