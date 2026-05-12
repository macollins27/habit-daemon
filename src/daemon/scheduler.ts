// scripts/lib/orchestrator/scheduler.ts
//
// Long-running scheduler loop. Reads schedules table, computes next run time
// per row via cron-parser.ts, sleeps until the next due time, dispatches the
// matching verb via spawn, updates last_run_iso + next_run_iso, repeats.
//
// missed_run_policy (per R7 Autobeat lift):
//   - "skip"    — if the scheduler missed runs while sleeping (e.g., daemon
//                 was down), skip them and only schedule the next future run
//   - "catchup" — fire one immediate run for the most-recent missed slot
//   - "fail"    — log a missed-run error finding and pause the schedule
//
// References:
//   - R7 finding: 2026-05-02_agentmanager-autobeat-deep-dive.md (missed_run_policy)

import type Database from "better-sqlite3";
import { type MissedRunPolicy } from "./ledger.js";
import { nextRunFromString } from "./cron-parser.js";

export interface ScheduleRow {
  readonly id: number;
  readonly cron_expr: string;
  readonly verb: string;
  readonly args_json: string;
  readonly missed_run_policy: MissedRunPolicy;
  readonly enabled: 0 | 1;
  readonly last_run_iso: string | null;
  readonly next_run_iso: string | null;
  readonly dispatch_priority: number;
}

/**
 * Caller-supplied verb dispatcher. Rejecting or throwing is treated as a
 * dispatch failure (analogous to a non-zero exit code in the subprocess
 * spawn-based implementation).
 */
export type DispatchFn = (verb: string, argsJson: string) => Promise<void> | void;

export interface SchedulerOptions {
  readonly db: Database.Database;
  readonly dispatch: DispatchFn;
  /** Function called every iteration AFTER a dispatch attempt (or when idle). */
  readonly onTick?: () => void;
  /** Seconds to sleep when no schedules are due. */
  readonly idleSleepSec?: number;
}

function err(line: string): void {
  process.stderr.write(line + "\n");
}

function listEnabledSchedules(db: Database.Database): readonly ScheduleRow[] {
  return db
    .prepare(
      `SELECT id, cron_expr, verb, args_json, missed_run_policy, enabled,
              last_run_iso, next_run_iso, dispatch_priority
       FROM schedules
       WHERE enabled = 1
       ORDER BY dispatch_priority ASC, id ASC`,
    )
    .all() as ScheduleRow[];
}

function updateScheduleAfterRun(
  db: Database.Database,
  scheduleId: number,
  ranAtIso: string,
  nextRunIso: string | null,
): void {
  db.prepare(`UPDATE schedules SET last_run_iso = ?, next_run_iso = ? WHERE id = ?`).run(
    ranAtIso,
    nextRunIso,
    scheduleId,
  );
}

function disableSchedule(db: Database.Database, scheduleId: number): void {
  db.prepare(`UPDATE schedules SET enabled = 0 WHERE id = ?`).run(scheduleId);
}

interface DueDecision {
  readonly fire: boolean;
  readonly fireAtIso: string | null;
  readonly nextScheduledIso: string | null;
  readonly reason: string;
}

function decideDueness(row: ScheduleRow, now: Date): DueDecision {
  const nextScheduled = nextRunFromString(row.cron_expr, now);
  if (nextScheduled === null) {
    return {
      fire: false,
      fireAtIso: null,
      nextScheduledIso: null,
      reason: "cron expression has no future match within scan window",
    };
  }
  const nextScheduledIso = nextScheduled.toISOString();
  const lastRunMs = row.last_run_iso !== null ? Date.parse(row.last_run_iso) : 0;
  const expectedNextMs = row.next_run_iso !== null ? Date.parse(row.next_run_iso) : 0;
  const nowMs = now.getTime();

  // Schedule is due if expected_next_iso has passed
  if (expectedNextMs > 0 && expectedNextMs <= nowMs) {
    const missedDuration = nowMs - expectedNextMs;
    const policy = row.missed_run_policy;
    if (policy === "skip" && missedDuration > 60_000) {
      // missed by >1 min — skip per policy, just reschedule
      return {
        fire: false,
        fireAtIso: null,
        nextScheduledIso,
        reason: `missed run by ${String(Math.floor(missedDuration / 1000))}s; policy=skip`,
      };
    }
    return {
      fire: true,
      fireAtIso: row.next_run_iso,
      nextScheduledIso,
      reason: policy === "catchup" ? "due (catchup)" : "due",
    };
  }

  // First-time scheduling (no prior run)
  if (lastRunMs === 0 && expectedNextMs === 0) {
    return {
      fire: false,
      fireAtIso: null,
      nextScheduledIso,
      reason: "initial scheduling",
    };
  }

  return {
    fire: false,
    fireAtIso: null,
    nextScheduledIso,
    reason: "not due",
  };
}

function decideOrDisable(db: Database.Database, row: ScheduleRow, now: Date): DueDecision | null {
  try {
    return decideDueness(row, now);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`[scheduler] schedule #${String(row.id)}: parse error "${msg}". Disabling.`);
    disableSchedule(db, row.id);
    return null;
  }
}

function reportDispatchFailure(db: Database.Database, row: ScheduleRow, error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  err(`[scheduler] schedule #${String(row.id)} dispatch FAILED: ${msg.slice(0, 500)}`);
  if (row.missed_run_policy === "fail") {
    err(`[scheduler] policy=fail; disabling schedule.`);
    disableSchedule(db, row.id);
  }
}

async function tickOneSchedule(
  db: Database.Database,
  dispatch: DispatchFn,
  row: ScheduleRow,
  now: Date,
): Promise<void> {
  const decision = decideOrDisable(db, row, now);
  if (decision === null) return;

  if (!decision.fire) {
    if (decision.nextScheduledIso !== row.next_run_iso) {
      updateScheduleAfterRun(db, row.id, row.last_run_iso ?? "", decision.nextScheduledIso);
    }
    return;
  }

  err(`[scheduler] firing schedule #${String(row.id)}: ${row.verb} (reason: ${decision.reason})`);
  try {
    await dispatch(row.verb, row.args_json);
  } catch (e: unknown) {
    reportDispatchFailure(db, row, e);
    if (row.missed_run_policy === "fail") return;
  }
  updateScheduleAfterRun(db, row.id, now.toISOString(), decision.nextScheduledIso);
}

async function tickOnce(db: Database.Database, dispatch: DispatchFn): Promise<void> {
  const now = new Date();
  for (const row of listEnabledSchedules(db)) {
    await tickOneSchedule(db, dispatch, row, now);
  }
}

/**
 * Asynchronous tick — used by scheduler-daemon.ts which loops + sleeps.
 * Iterates enabled schedules in `(dispatch_priority ASC, id ASC)` order,
 * decides due-ness per row, and awaits the caller-supplied dispatch callback
 * for any firing row. A throwing/rejecting dispatch is treated as a failed
 * run; the row is disabled iff missed_run_policy='fail'.
 */
export async function schedulerTick(opts: SchedulerOptions): Promise<void> {
  await tickOnce(opts.db, opts.dispatch);
  if (opts.onTick) opts.onTick();
}
