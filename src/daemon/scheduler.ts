/**
 * Forked from Property-Linkware-v2.1/scripts/lib/orchestrator/scheduler.ts
 * at PLW commit v1 (26c8c049). Diverges from this point. Do not auto-sync.
 */
// scripts/lib/orchestrator/scheduler.ts
//
// Long-running scheduler loop. Reads schedules table, computes next run time
// per row via cron-parser.ts, sleeps until the next due time, dispatches the
// matching plw verb via spawn, updates last_run_iso + next_run_iso, repeats.
//
// missed_run_policy (per R7 Autobeat lift):
//   - "skip"    — if the scheduler missed runs while sleeping (e.g., daemon
//                 was down), skip them and only schedule the next future run
//   - "catchup" — fire one immediate run for the most-recent missed slot
//   - "fail"    — log a missed-run error finding and pause the schedule
//
// References:
//   - docs/plans/master-orchestrator-design-v2.md §15 (v0.3 phased build)
//   - R7 finding: 2026-05-02_agentmanager-autobeat-deep-dive.md (missed_run_policy)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Ledger, type MissedRunPolicy } from "./ledger.js";
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
}

export interface SchedulerOptions {
  readonly ledger: Ledger;
  /** Path to bin/plw to invoke. Default: resolve from PROJECT_ROOT. */
  readonly plwBin?: string;
  /** Function called every iteration AFTER a dispatch attempt (or when idle). */
  readonly onTick?: () => void;
  /** Seconds to sleep when no schedules are due. */
  readonly idleSleepSec?: number;
}

function err(line: string): void {
  process.stderr.write(line + "\n");
}

function listEnabledSchedules(ledger: Ledger): readonly ScheduleRow[] {
  return ledger.sessionStore.db
    .prepare(
      `SELECT id, cron_expr, verb, args_json, missed_run_policy, enabled,
              last_run_iso, next_run_iso
       FROM schedules
       WHERE enabled = 1
       ORDER BY id ASC`,
    )
    .all() as ScheduleRow[];
}

function updateScheduleAfterRun(
  ledger: Ledger,
  scheduleId: number,
  ranAtIso: string,
  nextRunIso: string | null,
): void {
  ledger.sessionStore.db
    .prepare(`UPDATE schedules SET last_run_iso = ?, next_run_iso = ? WHERE id = ?`)
    .run(ranAtIso, nextRunIso, scheduleId);
}

function disableSchedule(ledger: Ledger, scheduleId: number): void {
  ledger.sessionStore.db.prepare(`UPDATE schedules SET enabled = 0 WHERE id = ?`).run(scheduleId);
}

function dispatchVerb(
  plwBin: string,
  verb: string,
  argsJson: string,
): { exitCode: number; stderr: string } {
  let args: readonly string[];
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    args = Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    args = [];
  }
  const result = spawnSync("/usr/bin/env", [plwBin, verb, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? "",
  };
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

function decideOrDisable(ledger: Ledger, row: ScheduleRow, now: Date): DueDecision | null {
  try {
    return decideDueness(row, now);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`[scheduler] schedule #${String(row.id)}: parse error "${msg}". Disabling.`);
    disableSchedule(ledger, row.id);
    return null;
  }
}

function reportDispatchFailure(
  ledger: Ledger,
  row: ScheduleRow,
  exitCode: number,
  stderr: string,
): void {
  err(`[scheduler] schedule #${String(row.id)} dispatch FAILED: exit ${String(exitCode)}`);
  err(`[scheduler] stderr: ${stderr.slice(0, 500)}`);
  if (row.missed_run_policy === "fail") {
    err(`[scheduler] policy=fail; disabling schedule.`);
    disableSchedule(ledger, row.id);
  }
}

function tickOneSchedule(ledger: Ledger, plwBin: string, row: ScheduleRow, now: Date): void {
  const decision = decideOrDisable(ledger, row, now);
  if (decision === null) return;

  if (!decision.fire) {
    if (decision.nextScheduledIso !== row.next_run_iso) {
      updateScheduleAfterRun(ledger, row.id, row.last_run_iso ?? "", decision.nextScheduledIso);
    }
    return;
  }

  err(`[scheduler] firing schedule #${String(row.id)}: ${row.verb} (reason: ${decision.reason})`);
  const result = dispatchVerb(plwBin, row.verb, row.args_json);
  if (result.exitCode !== 0) {
    reportDispatchFailure(ledger, row, result.exitCode, result.stderr);
    if (row.missed_run_policy === "fail") return;
  }
  updateScheduleAfterRun(ledger, row.id, now.toISOString(), decision.nextScheduledIso);
}

function tickOnce(ledger: Ledger, plwBin: string): void {
  const now = new Date();
  for (const row of listEnabledSchedules(ledger)) {
    tickOneSchedule(ledger, plwBin, row, now);
  }
}

export function defaultPlwBin(): string {
  return resolve(process.env.PROJECT_ROOT ?? process.cwd(), "bin/plw");
}

/**
 * Synchronous tick — used by scheduler-daemon.ts which loops + sleeps.
 */
export function schedulerTick(opts: SchedulerOptions): void {
  const plwBin = opts.plwBin ?? defaultPlwBin();
  tickOnce(opts.ledger, plwBin);
  if (opts.onTick) opts.onTick();
}
