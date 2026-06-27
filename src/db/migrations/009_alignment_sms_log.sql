-- Daily-alignment text-escalation send log (capped iMessage transport).
--
-- The daily-alignment habit texts the operator on an hourly cadence until the
-- 4-question checkpoint is answered, BOUNDED by a per-calendar-day cap, a
-- minimum interval, and quiet hours. This table is the restart-durable record
-- of every escalation actually delivered, so the daily cap and the
-- min-interval survive a daemon restart.
--
-- Why a dedicated table and not the `actions` ledger: `actions.run_id` is a
-- NOT NULL foreign key to `runs(run_id)`, and the daemon never inserts habit
-- activity into `runs` (foreign_keys=ON), so a habit-run id there would
-- violate the FK. This table has no such entanglement.
CREATE TABLE IF NOT EXISTS alignment_sms_sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id   TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  fire_date  TEXT NOT NULL,   -- local YYYY-MM-DD; the per-day cap window key
  sent_at    INTEGER NOT NULL, -- epoch ms
  level      INTEGER NOT NULL, -- escalation copy level used (1..3)
  sms_ok     INTEGER NOT NULL DEFAULT 0 -- 1 if the iMessage send succeeded
);

CREATE INDEX IF NOT EXISTS idx_alignment_sms_sends_habit_date
  ON alignment_sms_sends (habit_id, fire_date);
