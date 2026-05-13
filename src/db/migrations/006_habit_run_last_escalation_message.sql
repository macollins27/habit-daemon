-- Migration 006: habit_runs.last_escalation_message_id
--
-- Tracks the Discord message id of the most recent escalation posted by
-- habit-checkin. When the run is later autonomously closed by the reconciler
-- or by the in-tick short-circuit, the completion path posts a brief
-- follow-up in the same channel referencing this message — instead of
-- leaving the escalation orphaned.
--
-- nullable: a run that completes before any escalation fires (rare but
-- possible — e.g. user rows before fire_date's first scheduler tick after
-- create-habit-run) has no message id to track.

ALTER TABLE habit_runs ADD COLUMN last_escalation_message_id TEXT;
