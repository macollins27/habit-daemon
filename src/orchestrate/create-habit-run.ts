/**
 * create-habit-run — orchestration verb that creates a habit_runs row when a
 * habit's morning cron fires.
 *
 * Flow:
 *   1. Habit's cron expression (e.g., `5 9 * * *` for morning-row) fires.
 *   2. Scheduler invokes this verb with args `{habitId}`.
 *   3. This verb INSERTs a habit_runs row for today's local date:
 *      - current_level = 1
 *      - status = 'pending'
 *      - fired_at = now
 *      - next_escalation_at = now (so the scheduler's habit_runs polling picks
 *        it up on the very next tick and dispatches habit-checkin for L1).
 *   4. Idempotent: if a habit_runs row already exists for (habitId, today)
 *      due to the UNIQUE(habit_id, fire_date) constraint from migration 001,
 *      the verb returns `{created: false}` without throwing.
 *
 * The verb does NOT advance the level or send a Discord message — that's
 * habit-checkin's job, invoked on the next tick via the escalation polling
 * pass in scheduler.ts.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface CreateHabitRunOptions {
  readonly db: Database.Database;
  readonly habitId: string;
  readonly now: number;        // epoch ms
  readonly today: string;      // YYYY-MM-DD in local time, provided by caller
}

export interface CreateHabitRunResult {
  readonly runId: string;
  readonly created: boolean;
}

interface ExistingRunRow {
  readonly id: string;
}

interface HabitRow {
  readonly _: 1;
}

export function createHabitRun(opts: CreateHabitRunOptions): CreateHabitRunResult {
  const { db, habitId, now, today } = opts;

  // Verify the habit exists; fail-loud on unknown habit id.
  const habitRow = db
    .prepare(`SELECT 1 AS _ FROM habits WHERE id = ?`)
    .get(habitId) as HabitRow | undefined;
  if (!habitRow) {
    throw new Error(`createHabitRun: habit not found: ${habitId}`);
  }

  // Idempotent: if a run already exists for (habit_id, fire_date) today, return it.
  const existing = db
    .prepare(`SELECT id FROM habit_runs WHERE habit_id = ? AND fire_date = ?`)
    .get(habitId, today) as ExistingRunRow | undefined;
  if (existing) {
    return { runId: existing.id, created: false };
  }

  const runId = randomUUID();
  db.prepare(
    `INSERT INTO habit_runs (
      id, habit_id, fire_date, fired_at, current_level, next_escalation_at, status
    ) VALUES (?, ?, ?, ?, 1, ?, 'pending')`,
  ).run(runId, habitId, today, now, now);

  return { runId, created: true };
}
