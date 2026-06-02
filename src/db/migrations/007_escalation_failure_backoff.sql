-- Escalation dispatch backoff (incident 2026-06-02).
--
-- The scheduler re-fires every "due" habit_run each tick. When the
-- habit-checkin dispatch fails (e.g. the model API is out of credit), the
-- habit-checkin verb throws BEFORE it advances next_escalation_at, so the run
-- stays perpetually due and re-fires every tick — a tight retry loop that
-- spawned ~370k failed claude sessions (8.7 GB) before it was caught.
--
-- These columns let the scheduler track consecutive dispatch failures per run
-- so it can apply exponential backoff (and surface the last error) instead of
-- hammering a perpetually-failing run. See src/daemon/scheduler.ts.
ALTER TABLE habit_runs ADD COLUMN escalation_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE habit_runs ADD COLUMN last_dispatch_error TEXT;
