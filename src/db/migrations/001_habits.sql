-- Migration 001: core habit tables.
--
-- Source of truth: docs/plans/2026-05-12-habit-daemon-design.md § 2.
-- Schema is reproduced verbatim from the design doc; do not "improve" types
-- or constraints without first amending the design.
--
-- SQLite-flavored SQL. Booleans are stored as INTEGER 0/1; the BOOLEAN type
-- name is a SQLite type-affinity alias for INTEGER and is kept here so the
-- schema reads identically to the design doc.

CREATE TABLE habits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,                -- 'row' | 'strength' | 'wind-down'
  cron_expr TEXT NOT NULL,
  why_stakes_json TEXT NOT NULL,
  proof_type TEXT NOT NULL,
  proof_config_json TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE habit_runs (
  id TEXT PRIMARY KEY,
  habit_id TEXT NOT NULL REFERENCES habits(id),
  fire_date TEXT NOT NULL,             -- YYYY-MM-DD
  fired_at INTEGER NOT NULL,
  current_level INTEGER NOT NULL DEFAULT 1,
  next_escalation_at INTEGER,          -- NULL when terminal
  status TEXT NOT NULL CHECK (status IN (
    'pending','completed','missed','skipped','partial',
    'unresolved','unresolved_no_data'
  )),
  completed_at INTEGER,
  proof_payload_json TEXT,
  skip_reason TEXT,
  proof_rejection_callout_due BOOLEAN NOT NULL DEFAULT 0,
  UNIQUE(habit_id, fire_date)
);

CREATE TABLE proof_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES habit_runs(id),
  stage TEXT NOT NULL,                 -- 'a' (typed msg) | 'b' (garmin sleep)
  satisfied BOOLEAN NOT NULL DEFAULT 0,
  satisfied_at INTEGER,
  data_json TEXT
);
