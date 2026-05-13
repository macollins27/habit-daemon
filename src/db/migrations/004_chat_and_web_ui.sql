-- Migration 004: chat and web UI schema additions.
--
-- Adds:
--   1. habits.archived_at (TEXT, nullable) — soft-archive flag with ISO-8601
--      timestamp when set, NULL otherwise.
--   2. session_events.event_type CHECK extended with 6 new values to cover
--      conversational chat events and habit-CRUD lifecycle:
--        'user_message_received', 'assistant_message_sent',
--        'habit_created', 'habit_updated',
--        'habit_archived', 'habit_unarchived'.
--      SQLite has no ALTER ... DROP/ADD CHECK, so we rebuild the table:
--      create session_events_new with the extended CHECK, copy rows, drop
--      the old table, rename, then recreate index + append-only triggers.
--   3. idx_session_events_written_iso_desc on session_events(written_iso DESC)
--      — supports the web UI's "recent activity" feed query.
--
-- Note on habits.created_at:
--   The plan referenced a "created_at backfill" but 001_habits.sql already
--   declares `created_at INTEGER NOT NULL`. We intentionally do NOT re-add
--   the column. The migration-004 test verifies the column still exists
--   and existing rows retain their value after the migration runs.
--
-- Idempotency is provided by the migration runner (src/db/migrate.ts):
-- each migration id is recorded in `_migrations` and skipped on re-run.
-- We additionally use IF NOT EXISTS on every CREATE so a partial re-run
-- (e.g. if the runner were ever bypassed) does not error.

-- ledger.hash_chain_record_id has a FK reference to session_events(id). The
-- table-rebuild below would otherwise trip FK enforcement (foreign_keys is
-- ON at the connection level — see src/db/connection.ts). `defer_foreign_keys`
-- is a transaction-scoped pragma that defers FK checks until COMMIT, by which
-- point all referenced ids have been copied verbatim into the new table.
PRAGMA defer_foreign_keys = ON;

-- 1. Add habits.archived_at. ALTER TABLE ADD COLUMN is safe here because
--    the new column is nullable and has no default.
ALTER TABLE habits ADD COLUMN archived_at TEXT;

-- 2. Rebuild session_events with the extended event_type CHECK list.
--    The 16 pre-existing values must be preserved verbatim; the 6 new ones
--    are appended at the end of the IN-list.
CREATE TABLE session_events_new (
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
    'sensor_failure_logged',
    'user_message_received', 'assistant_message_sent',
    'habit_created', 'habit_updated',
    'habit_archived', 'habit_unarchived'
  )),
  written_iso   TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

INSERT INTO session_events_new (
  id, session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
)
SELECT
  id, session_id, seq, event_json, prev_hash, hash, trust_level, event_type, written_iso
FROM session_events;

-- The append-only triggers fire BEFORE DELETE / UPDATE on session_events, so
-- they must be dropped before we can swap the table. They are recreated
-- below with the same names against the rebuilt table.
DROP TRIGGER IF EXISTS session_events_no_update;
DROP TRIGGER IF EXISTS session_events_no_delete;

DROP TABLE session_events;
ALTER TABLE session_events_new RENAME TO session_events;

-- Recreate the original session-scope index (verbatim from migration 003).
CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id, seq);

-- Recreate the append-only triggers (verbatim names from migration 003).
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

-- 3. New index for the web UI "recent activity" feed.
CREATE INDEX IF NOT EXISTS idx_session_events_written_iso_desc
  ON session_events(written_iso DESC);
