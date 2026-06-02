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

// -----------------------------------------------------------------------------
// Escalation dispatch backoff (incident 2026-06-02).
//
// A habit-checkin dispatch that fails (e.g. the model API is out of credit)
// used to leave the run perpetually due, so the scheduler re-fired it every
// tick — a tight retry loop that spawned ~370k dead claude sessions. The
// scheduler now backs a failing escalation off exponentially, resets on
// success, and trips a circuit breaker when failures are systemic.
// -----------------------------------------------------------------------------

export const ESCALATION_BACKOFF_BASE_MS = 60_000; // 1 minute
export const ESCALATION_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Consecutive escalation dispatch failures before the breaker opens. */
export const ESCALATION_CIRCUIT_BREAKER_THRESHOLD = 3;
/**
 * After this many consecutive failures a single run is PARKED
 * (`next_escalation_at = NULL`) — it gives up entirely instead of retrying
 * forever. Handles deterministic per-run failures (e.g. a config bug) that no
 * amount of backoff will fix.
 */
export const MAX_ESCALATION_ATTEMPTS = 8;
/** First cooldown after the breaker opens; doubles per failed probe up to max. */
export const ESCALATION_BREAKER_BASE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
export const ESCALATION_BREAKER_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Exponential backoff for a habit-checkin escalation that has failed
 * `failureCount` times (1-based). Doubles from the base, capped at the max, so
 * a persistently-failing run retries at most every few hours instead of every
 * tick — and self-heals (no hard park) the moment a dispatch succeeds again.
 */
export function escalationBackoffMs(failureCount: number): number {
  const exp = Math.min(Math.max(failureCount - 1, 0), 30);
  return Math.min(
    ESCALATION_BACKOFF_BASE_MS * 2 ** exp,
    ESCALATION_BACKOFF_MAX_MS,
  );
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

interface DueHabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly current_level: number;
  readonly fired_at: number;
  readonly escalation_failure_count: number;
}

function listDueHabitRuns(
  db: Database.Database,
  nowMs: number,
): readonly DueHabitRunRow[] {
  return db
    .prepare(
      `SELECT id, habit_id, current_level, fired_at, escalation_failure_count
       FROM habit_runs
       WHERE next_escalation_at IS NOT NULL
         AND next_escalation_at <= ?
         AND status = 'pending'
       ORDER BY fired_at ASC`,
    )
    .all(nowMs) as DueHabitRunRow[];
}

/**
 * A habit-checkin dispatch failed. Back the run off (exponential, capped) so a
 * persistently-failing run no longer re-fires every tick, and record the
 * attempt count + last error. After `MAX_ESCALATION_ATTEMPTS` the run is PARKED
 * (`next_escalation_at = NULL`): it gives up entirely rather than trickling
 * forever. The run self-heals on the next successful dispatch via
 * `clearEscalationFailureState`.
 */
function recordEscalationFailure(
  db: Database.Database,
  row: DueHabitRunRow,
  error: unknown,
  nowMs: number,
): void {
  const newCount = row.escalation_failure_count + 1;
  const msg = (error instanceof Error ? error.message : String(error)).slice(
    0,
    500,
  );
  if (newCount >= MAX_ESCALATION_ATTEMPTS) {
    db.prepare(
      `UPDATE habit_runs
          SET escalation_failure_count = ?,
              next_escalation_at = NULL,
              last_dispatch_error = ?
        WHERE id = ?`,
    ).run(newCount, msg, row.id);
    err(
      `[scheduler] run ${row.id} PARKED after ${String(newCount)} consecutive ` +
        `escalation failures (giving up): ${msg}`,
    );
    return;
  }
  const nextEscalationAt = nowMs + escalationBackoffMs(newCount);
  db.prepare(
    `UPDATE habit_runs
        SET escalation_failure_count = ?,
            next_escalation_at = ?,
            last_dispatch_error = ?
      WHERE id = ?`,
  ).run(newCount, nextEscalationAt, msg, row.id);
}

// -----------------------------------------------------------------------------
// Persistent escalation circuit breaker (migration 008).
//
// When habit-checkin dispatch fails systemically (e.g. the model API is out of
// credit) the breaker OPENS and the scheduler stops dispatching entirely,
// probing sparsely (exponential cooldown) to detect recovery — instead of
// retrying every run on its own backoff forever. The breaker is persisted so
// "open" survives across ticks (the previous per-tick-only guard reset every
// tick and so never actually stopped the trickle).
// -----------------------------------------------------------------------------

interface BreakerState {
  readonly state: "closed" | "open";
  readonly consecutiveFailures: number;
  readonly openedAt: number | null;
  readonly probeCooldownMs: number;
}

const CLOSED_BREAKER: BreakerState = {
  state: "closed",
  consecutiveFailures: 0,
  openedAt: null,
  probeCooldownMs: 0,
};

interface BreakerRow {
  readonly state: "closed" | "open";
  readonly consecutive_failures: number;
  readonly opened_at: number | null;
  readonly probe_cooldown_ms: number;
}

function loadBreaker(db: Database.Database): BreakerState {
  try {
    const row = db
      .prepare(
        `SELECT state, consecutive_failures, opened_at, probe_cooldown_ms
           FROM escalation_breaker WHERE id = 1`,
      )
      .get() as BreakerRow | undefined;
    if (row === undefined) return CLOSED_BREAKER;
    return {
      state: row.state,
      consecutiveFailures: row.consecutive_failures,
      openedAt: row.opened_at,
      probeCooldownMs: row.probe_cooldown_ms,
    };
  } catch {
    // escalation_breaker table absent (minimal/legacy schema, e.g. a smoke
    // test): degrade to closed so dispatch proceeds normally.
    return CLOSED_BREAKER;
  }
}

function persistBreaker(
  db: Database.Database,
  next: BreakerState,
  lastError: string | null,
): void {
  try {
    db.prepare(
      `UPDATE escalation_breaker
          SET state = ?, consecutive_failures = ?, opened_at = ?,
              probe_cooldown_ms = ?, last_error = ?
        WHERE id = 1`,
    ).run(
      next.state,
      next.consecutiveFailures,
      next.openedAt,
      next.probeCooldownMs,
      lastError,
    );
  } catch {
    // Table absent — nothing to persist (breaker effectively disabled).
  }
}

function nextProbeCooldownMs(prevCooldownMs: number): number {
  const grown =
    prevCooldownMs > 0
      ? prevCooldownMs * 2
      : ESCALATION_BREAKER_BASE_COOLDOWN_MS;
  return Math.min(grown, ESCALATION_BREAKER_MAX_COOLDOWN_MS);
}

/**
 * Dispatch one due run. Returns true on success (and clears its failure
 * bookkeeping), false on failure (and backs the run off / parks it). Never
 * throws — the scheduler decides what to do with the boolean.
 */
async function dispatchEscalation(
  db: Database.Database,
  dispatch: DispatchFn,
  row: DueHabitRunRow,
  nowMs: number,
): Promise<boolean> {
  const argsJson = JSON.stringify({
    runId: row.id,
    currentLevel: row.current_level,
  });
  try {
    await dispatch("habit-checkin", argsJson);
    clearEscalationFailureState(db, row);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    err(
      `[scheduler] habit-checkin dispatch FAILED for run ${row.id}: ${msg.slice(0, 500)} ` +
        `(failure #${String(row.escalation_failure_count + 1)})`,
    );
    recordEscalationFailure(db, row, e, nowMs);
    return false;
  }
}

/**
 * A habit-checkin dispatch succeeded. Clear any prior failure bookkeeping. The
 * scheduler does NOT touch `next_escalation_at` here — the habit-checkin verb
 * owns the success cadence (it advanced the level + next_escalation_at inside
 * its own transaction).
 */
function clearEscalationFailureState(
  db: Database.Database,
  row: DueHabitRunRow,
): void {
  if (row.escalation_failure_count === 0) return;
  db.prepare(
    `UPDATE habit_runs
        SET escalation_failure_count = 0, last_dispatch_error = NULL
      WHERE id = ?`,
  ).run(row.id);
}

/**
 * Poll habit_runs for due escalations and dispatch `habit-checkin` for each.
 *
 * The scheduler is intentionally "fire only" here: it does NOT modify
 * `current_level` or `next_escalation_at` after dispatch. The `habit-checkin`
 * verb (Task 24+, wired in Task 39) owns those writes. Keeping the scheduler
 * stateless w.r.t. escalation cadence means the verb is the single writer of
 * run state — which is critical for atomicity around the "dispatch + level
 * advance + event append" triple.
 *
 * Phase A simplification: rows are ordered by `fired_at ASC` (oldest first
 * = fairness). `dispatch_priority` is a `schedules` column, not a
 * `habit_runs` column; with only 3 Phase A habits, differential per-run
 * priority is unnecessary. Phase B could add `habit_runs.dispatch_priority`
 * if needed.
 *
 * Failure handling (incident 2026-06-02): each failed dispatch backs the run
 * off exponentially (`recordEscalationFailure`) and parks it after
 * `MAX_ESCALATION_ATTEMPTS`. Systemic failure is handled by a PERSISTENT
 * circuit breaker (migration 008): after `ESCALATION_CIRCUIT_BREAKER_THRESHOLD`
 * consecutive failures the breaker OPENS and subsequent ticks dispatch NOTHING
 * until a cooldown elapses, then a single half-open probe runs; success closes
 * the breaker (resume), failure re-opens it with a doubled cooldown. A
 * successful dispatch always resets the failure bookkeeping; the verb still
 * owns `current_level` / `next_escalation_at` on success.
 */
async function tickHabitRunEscalations(
  db: Database.Database,
  dispatch: DispatchFn,
  nowMs: number,
): Promise<void> {
  const due = listDueHabitRuns(db, nowMs);
  if (due.length === 0) return;

  const breaker = loadBreaker(db);

  if (breaker.state === "open") {
    const cooldownEnds = (breaker.openedAt ?? nowMs) + breaker.probeCooldownMs;
    if (nowMs < cooldownEnds) {
      err(
        `[scheduler] escalation breaker OPEN — deferring ${String(due.length)} ` +
          `due escalation(s); next probe in ` +
          `${String(Math.round((cooldownEnds - nowMs) / 1000))}s`,
      );
      return; // halt: zero dispatch while the dependency is down
    }
    err("[scheduler] escalation breaker half-open — probing for recovery");
  }

  // `trial` = we are half-open (probing). In trial mode the failure counter
  // starts fresh so a single success closes the breaker; reaching the threshold
  // re-opens it with a longer cooldown.
  const trial = breaker.state === "open";
  let consecutive = trial ? 0 : breaker.consecutiveFailures;
  let sawSuccess = false;

  for (const row of due) {
    const ok = await dispatchEscalation(db, dispatch, row, nowMs);
    if (ok) {
      consecutive = 0;
      if (!sawSuccess && trial) {
        err("[scheduler] escalation breaker CLOSED after successful probe — resuming");
      }
      sawSuccess = true;
    } else {
      consecutive += 1;
      if (consecutive >= ESCALATION_CIRCUIT_BREAKER_THRESHOLD) {
        const cooldown = nextProbeCooldownMs(
          trial ? breaker.probeCooldownMs : 0,
        );
        err(
          `[scheduler] escalation circuit breaker OPEN after ${String(consecutive)} ` +
            `consecutive failures — halting dispatch; next probe in ` +
            `${String(Math.round(cooldown / 1000))}s`,
        );
        persistBreaker(
          db,
          {
            state: "open",
            consecutiveFailures: consecutive,
            openedAt: nowMs,
            probeCooldownMs: cooldown,
          },
          null,
        );
        return;
      }
    }
  }

  if (trial && !sawSuccess) {
    // Probed every due run (fewer than the threshold) and none succeeded —
    // still down. Stay open with a longer cooldown.
    const cooldown = nextProbeCooldownMs(breaker.probeCooldownMs);
    err(
      `[scheduler] escalation breaker still OPEN (probe failed); next probe in ` +
        `${String(Math.round(cooldown / 1000))}s`,
    );
    persistBreaker(
      db,
      {
        state: "open",
        consecutiveFailures: consecutive,
        openedAt: nowMs,
        probeCooldownMs: cooldown,
      },
      null,
    );
    return;
  }

  persistBreaker(
    db,
    {
      state: "closed",
      consecutiveFailures: consecutive,
      openedAt: null,
      probeCooldownMs: 0,
    },
    null,
  );
}

/**
 * Asynchronous tick — used by scheduler-daemon.ts which loops + sleeps.
 *
 * Runs two polling passes per tick, in order:
 *   1. `schedules` table (cron-driven verb dispatch) — iterated in
 *      `(dispatch_priority ASC, id ASC)` order. A throwing/rejecting dispatch
 *      is treated as a failed run; the row is disabled iff
 *      missed_run_policy='fail'.
 *   2. `habit_runs.next_escalation_at` (escalation-driven `habit-checkin`
 *      dispatch) — iterated in `fired_at ASC` order. The scheduler does NOT
 *      mutate run state; the verb owns level / next_escalation_at writes.
 *
 * Schedules-first ordering means a midnight wins-poster always runs before
 * habit-checkin pickups on the same tick, which matches the intent of the
 * cron-driven daily ceremonies (R7 Autobeat lift, doc § 3).
 */
export async function schedulerTick(opts: SchedulerOptions): Promise<void> {
  await tickOnce(opts.db, opts.dispatch);
  await tickHabitRunEscalations(opts.db, opts.dispatch, Date.now());
  if (opts.onTick) opts.onTick();
}
