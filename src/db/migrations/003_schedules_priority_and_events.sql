-- Migration 003: schedules.dispatch_priority + session_events.event_type CHECK.
--
-- Resolves Issue 1 (event_type Option B "Full") and Issue 6 (ordering
-- idempotence). The CREATE TABLE IF NOT EXISTS clauses below mirror the
-- definitions in:
--   - src/daemon/ledger.ts        (applyLedgerSchema, for schedules)
--   - src/daemon/session-store.ts (applySchema, for sessions + session_events)
--
-- The duplication is intentional: this file is the migration history
-- record, and the Ledger/SessionStore files are the runtime schema
-- creators. They must stay in sync; the migration-003.test.ts in-both-orders
-- test guards against drift.

-- sessions table must exist before session_events FK can reference it.
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  created_iso     TEXT NOT NULL,
  parent_session  TEXT REFERENCES sessions(session_id),
  fork_uuid       TEXT,
  status          TEXT NOT NULL CHECK(status IN ('active','completed','failed','aborted'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_expr           TEXT NOT NULL,
  verb                TEXT NOT NULL,
  args_json           TEXT NOT NULL,
  missed_run_policy   TEXT NOT NULL DEFAULT 'skip'
                      CHECK(missed_run_policy IN ('skip','catchup','fail')),
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  last_run_iso        TEXT,
  next_run_iso        TEXT,
  dispatch_priority   INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS session_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  seq           INTEGER NOT NULL,
  event_json    TEXT NOT NULL,
  prev_hash     TEXT,
  hash          TEXT NOT NULL,
  trust_level   TEXT NOT NULL CHECK(trust_level IN ('L0','L1','L2','L3','L4')),
  event_type    TEXT CHECK(event_type IS NULL OR event_type IN (
    'habit_prompt_sent', 'habit_user_response', 'habit_proof_received',
    'habit_completed', 'habit_missed', 'habit_skip_requested',
    'habit_dodge_requested', 'proof_attempt_rejected', 'proposal_emitted',
    'proposal_applied', 'proposal_rejected', 'proposal_discussion_opened',
    'proposal_discussion_message', 'proposal_resolved', 'plan_change_applied',
    'sensor_failure_logged'
  )),
  written_iso   TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id, seq);

CREATE TRIGGER IF NOT EXISTS session_events_no_update
  BEFORE UPDATE ON session_events
  BEGIN
    SELECT RAISE(FAIL, 'session_events is append-only (use a new event for corrections)');
  END;

CREATE TRIGGER IF NOT EXISTS session_events_no_delete
  BEFORE DELETE ON session_events
  BEGIN
    SELECT RAISE(FAIL, 'session_events is append-only (deletion forbidden)');
  END;
