-- Migration 002: intel + sensor tables.
--
-- Source of truth: docs/plans/2026-05-12-habit-daemon-design.md § 2.
-- Schema is reproduced verbatim from the design doc; do not "improve" types
-- or constraints without first amending the design.
--
-- SQLite-flavored SQL. The classification space (gaming | work-late | etc. |
-- no_response) is intentionally open per the Phase B intel design — no CHECK
-- constraint here. Likewise sensor_signals.source is documented as 'garmin' |
-- 'concept2' but kept open to additional sources without a schema migration.

CREATE TABLE miss_reasons (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  run_id TEXT NOT NULL REFERENCES habit_runs(id),
  miss_date TEXT NOT NULL,
  user_response_text TEXT,              -- NULL when no_response classification
  classification TEXT,                  -- 'gaming' | 'work-late' | etc. | 'no_response'
  inferred_specifics TEXT,              -- slug format: 'category:entity'
  key_entities_json TEXT,
  classification_confidence REAL,
  gap_metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sensor_signals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- 'garmin' | 'concept2'
  payload_date TEXT NOT NULL,           -- YYYY-MM-DD
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE(source, payload_date)
);

CREATE TABLE plan_changes (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  prior_config_json TEXT NOT NULL,
  new_config_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  reverted_at INTEGER                   -- NULL until/unless reverted
);
