// Task 32: scheduler polls habit_runs.next_escalation_at and dispatches
// `habit-checkin` for each due pending run.
//
// The scheduler tick performs TWO polling passes per iteration:
//   1. The existing schedules table poll (Task 4) — fires verbs whose cron
//      time has elapsed.
//   2. The new habit_runs poll (Task 32) — fires `habit-checkin` for every
//      run with `next_escalation_at <= now AND status = 'pending'`.
//
// The scheduler is intentionally a "fire only" component for habit_runs: it
// does NOT modify `current_level` or `next_escalation_at` after dispatch.
// The `habit-checkin` verb (Task 24+, wired in Task 39) owns those writes.
// This separation keeps the scheduler stateless w.r.t. escalation cadence;
// the verb is the single writer of run state.
//
// Phase A simplification: habit_runs polling orders by `fired_at ASC` only.
// `dispatch_priority` is a schedules-table column; differential per-run
// priority is a Phase B concern (only 3 habits, fairness via oldest-first
// is sufficient).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 32
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (escalation cadence)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { schedulerTick } from "../../src/daemon/scheduler.js";

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const FIRE_DATE = "2026-05-12";

// A fixed reference point for "now". Tests pass `now` to the SQL comparison
// indirectly via the scheduler reading Date.now(); we vi.setSystemTime() so
// the scheduler's internal `Date.now()` lines up with this constant.
const NOW_MS = Date.parse("2026-05-12T09:30:00.000Z");

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId: string;
  readonly nextEscalationAt: number | null;
  readonly status?: string;
  readonly currentLevel?: number;
  readonly firedAt?: number;
}

function seedHabitRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.habitId,
    FIRE_DATE,
    opts.firedAt ?? NOW_MS,
    opts.currentLevel ?? 1,
    opts.nextEscalationAt,
    opts.status ?? "pending",
    null,
    null,
    null,
    0,
  );
}

function getHabitCheckinCalls(
  dispatch: ReturnType<typeof vi.fn>,
): readonly { verb: string; args: { runId: string; currentLevel: number } }[] {
  return dispatch.mock.calls
    .filter((c) => c[0] === "habit-checkin")
    .map((c) => ({
      verb: c[0] as string,
      args: JSON.parse(c[1] as string) as {
        runId: string;
        currentLevel: number;
      },
    }));
}

describe("schedulerTick — habit_runs.next_escalation_at polling", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-esc-poll-"));
    const dbPath = join(tempDir, "store.db");
    db = openDatabase(dbPath);
    await runMigrations(db, loadMigrations());
    seedHabits(db, SEED_CHANNELS);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no escalations due: habit-checkin NOT dispatched", async () => {
    seedHabitRun(db, {
      runId: "run-future",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS + 60 * 60 * 1000, // +1 hour
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("one escalation due: dispatches habit-checkin with runId + currentLevel", async () => {
    seedHabitRun(db, {
      runId: "run-due-1",
      habitId: "morning-row",
      currentLevel: 2,
      nextEscalationAt: NOW_MS - 60 * 1000, // -60s (due)
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    const calls = getHabitCheckinCalls(dispatch);
    expect(calls.length).toBe(1);
    expect(calls[0]!.args).toEqual({ runId: "run-due-1", currentLevel: 2 });
  });

  it("multiple escalations due: dispatched in fired_at-ascending order", async () => {
    // Seed three runs all due at NOW; fired_at differs.
    seedHabitRun(db, {
      runId: "run-second",
      habitId: "morning-row",
      firedAt: NOW_MS - 90 * 60 * 1000,
      nextEscalationAt: NOW_MS - 60 * 1000,
      currentLevel: 1,
    });
    seedHabitRun(db, {
      runId: "run-first",
      habitId: "strength-mwf",
      firedAt: NOW_MS - 120 * 60 * 1000, // oldest
      nextEscalationAt: NOW_MS - 60 * 1000,
      currentLevel: 2,
    });
    seedHabitRun(db, {
      runId: "run-third",
      habitId: "wind-down",
      firedAt: NOW_MS - 30 * 60 * 1000, // newest
      nextEscalationAt: NOW_MS - 60 * 1000,
      currentLevel: 3,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    const calls = getHabitCheckinCalls(dispatch);
    expect(calls.length).toBe(3);
    expect(calls[0]!.args.runId).toBe("run-first");
    expect(calls[1]!.args.runId).toBe("run-second");
    expect(calls[2]!.args.runId).toBe("run-third");
  });

  it("status='completed' NOT dispatched even if next_escalation_at <= now", async () => {
    seedHabitRun(db, {
      runId: "run-completed",
      habitId: "morning-row",
      status: "completed",
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("status='missed' NOT dispatched", async () => {
    seedHabitRun(db, {
      runId: "run-missed",
      habitId: "morning-row",
      status: "missed",
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("status='partial' NOT dispatched (Task 37 owns stage-B wind-down)", async () => {
    seedHabitRun(db, {
      runId: "run-partial",
      habitId: "wind-down",
      status: "partial",
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("next_escalation_at IS NULL NOT dispatched (terminal/idle run)", async () => {
    seedHabitRun(db, {
      runId: "run-null",
      habitId: "morning-row",
      nextEscalationAt: null,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("next_escalation_at > now NOT dispatched (not yet due)", async () => {
    seedHabitRun(db, {
      runId: "run-future-tight",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS + 1, // +1 ms — explicitly after now
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    expect(getHabitCheckinCalls(dispatch).length).toBe(0);
  });

  it("dispatch error on one row does NOT halt loop; remaining rows still dispatched", async () => {
    seedHabitRun(db, {
      runId: "run-a",
      habitId: "morning-row",
      firedAt: NOW_MS - 90 * 60 * 1000,
      nextEscalationAt: NOW_MS - 60 * 1000,
    });
    seedHabitRun(db, {
      runId: "run-b",
      habitId: "strength-mwf",
      firedAt: NOW_MS - 60 * 60 * 1000,
      nextEscalationAt: NOW_MS - 60 * 1000,
    });
    seedHabitRun(db, {
      runId: "run-c",
      habitId: "wind-down",
      firedAt: NOW_MS - 30 * 60 * 1000,
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
        );
        return true;
      });

    let callIndex = 0;
    const dispatch = vi.fn(async (verb: string, _argsJson: string) => {
      if (verb !== "habit-checkin") return;
      callIndex += 1;
      if (callIndex === 2) {
        throw new Error("simulated dispatch failure");
      }
    });

    try {
      await schedulerTick({ db, dispatch });
    } finally {
      stderrSpy.mockRestore();
    }

    const calls = getHabitCheckinCalls(dispatch);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.args.runId)).toEqual(["run-a", "run-b", "run-c"]);

    const errorLogged = stderrWrites.some((line) =>
      line.includes("simulated dispatch failure"),
    );
    expect(errorLogged).toBe(true);
  });

  it("existing schedules polling still works alongside habit_runs polling", async () => {
    // Seed a schedules row that is due, plus a due habit_run.
    db.prepare(
      `INSERT INTO schedules (
         cron_expr, verb, args_json, missed_run_policy, enabled,
         last_run_iso, next_run_iso, dispatch_priority
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "* * * * *",
      "wins-poster",
      "{}",
      "skip",
      1,
      // last_run is recent so the "skip" missed_run_policy doesn't fire
      new Date(NOW_MS - 60 * 1000).toISOString(),
      new Date(NOW_MS - 30 * 1000).toISOString(),
      100,
    );

    seedHabitRun(db, {
      runId: "run-mixed",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const dispatch = vi.fn();
    await schedulerTick({ db, dispatch });

    // Schedules row dispatched first (via existing polling), then habit_run.
    expect(dispatch.mock.calls.length).toBe(2);
    expect(dispatch.mock.calls[0]![0]).toBe("wins-poster");
    expect(dispatch.mock.calls[1]![0]).toBe("habit-checkin");
    const habitArgs = JSON.parse(dispatch.mock.calls[1]![1] as string) as {
      runId: string;
    };
    expect(habitArgs.runId).toBe("run-mixed");
  });

  it("schedulerTick is awaitable and resolves cleanly with no rows", async () => {
    const dispatch = vi.fn();
    await expect(schedulerTick({ db, dispatch })).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("onTick callback fires after habit_runs polling completes", async () => {
    seedHabitRun(db, {
      runId: "run-cb",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS - 60 * 1000,
    });

    const order: string[] = [];
    const dispatch = vi.fn(async (verb: string) => {
      if (verb === "habit-checkin") order.push("dispatch");
    });
    const onTick = vi.fn(() => order.push("onTick"));

    await schedulerTick({ db, dispatch, onTick });

    expect(order).toEqual(["dispatch", "onTick"]);
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
