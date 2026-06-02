// Incident 2026-06-02: a failing habit-checkin dispatch left the run
// perpetually due, so the scheduler re-fired it every tick (~370k dead
// claude sessions, 8.7 GB). The scheduler must instead back off a failing
// escalation exponentially, reset on success, and stop the tick early when
// the whole API is failing (circuit breaker).
//
// Companion to escalation-polling.test.ts (the happy-path polling contract).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import {
  schedulerTick,
  escalationBackoffMs,
  ESCALATION_CIRCUIT_BREAKER_THRESHOLD,
} from "../../src/daemon/scheduler.js";

const SEED_CHANNELS = {
  morningRow: "1000000000000000001",
  strength: "1000000000000000002",
  windDown: "1000000000000000003",
} as const;

const FIRE_DATE = "2026-05-12";
const NOW_MS = Date.parse("2026-05-12T09:30:00.000Z");

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId: string;
  readonly nextEscalationAt: number | null;
  readonly status?: string;
  readonly currentLevel?: number;
  readonly firedAt?: number;
  readonly escalationFailureCount?: number;
  readonly fireDate?: string;
}

function seedHabitRun(db: Database.Database, opts: SeedRunOpts): void {
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due, escalation_failure_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.habitId,
    opts.fireDate ?? FIRE_DATE,
    opts.firedAt ?? NOW_MS,
    opts.currentLevel ?? 1,
    opts.nextEscalationAt,
    opts.status ?? "pending",
    null,
    null,
    null,
    0,
    opts.escalationFailureCount ?? 0,
  );
}

interface RunStateRow {
  readonly next_escalation_at: number | null;
  readonly escalation_failure_count: number;
  readonly last_dispatch_error: string | null;
}

function getRun(db: Database.Database, runId: string): RunStateRow {
  return db
    .prepare(
      `SELECT next_escalation_at, escalation_failure_count, last_dispatch_error
         FROM habit_runs WHERE id = ?`,
    )
    .get(runId) as RunStateRow;
}

function countHabitCheckins(dispatch: ReturnType<typeof vi.fn>): number {
  return dispatch.mock.calls.filter((c) => c[0] === "habit-checkin").length;
}

describe("schedulerTick — escalation failure backoff (incident 2026-06-02)", () => {
  let tempDir: string;
  let db: Database.Database;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-esc-backoff-"));
    db = openDatabase(join(tempDir, "store.db"));
    await runMigrations(db, loadMigrations());
    seedHabits(db, SEED_CHANNELS);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
    // Silence the scheduler's stderr logging during these tests.
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((): boolean => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.useRealTimers();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a failed dispatch backs off next_escalation_at and increments the failure count", async () => {
    seedHabitRun(db, {
      runId: "run-fail",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS - 60 * 1000, // due
    });
    const dispatch = vi.fn(async (verb: string) => {
      if (verb === "habit-checkin") throw new Error("Credit balance is too low");
    });

    await schedulerTick({ db, dispatch });

    const run = getRun(db, "run-fail");
    expect(run.escalation_failure_count).toBe(1);
    // No longer immediately due — pushed into the future by the backoff.
    expect(run.next_escalation_at).toBe(NOW_MS + escalationBackoffMs(1));
    expect(run.next_escalation_at!).toBeGreaterThan(NOW_MS);
    expect(run.last_dispatch_error).toContain("Credit balance is too low");
  });

  it("repeated failures grow the backoff exponentially", async () => {
    seedHabitRun(db, {
      runId: "run-fail-again",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS - 60 * 1000,
      escalationFailureCount: 3,
    });
    const dispatch = vi.fn(async (verb: string) => {
      if (verb === "habit-checkin") throw new Error("boom");
    });

    await schedulerTick({ db, dispatch });

    const run = getRun(db, "run-fail-again");
    expect(run.escalation_failure_count).toBe(4);
    expect(run.next_escalation_at).toBe(NOW_MS + escalationBackoffMs(4));
    expect(escalationBackoffMs(4)).toBeGreaterThan(escalationBackoffMs(1));
  });

  it("a successful dispatch resets the failure count", async () => {
    seedHabitRun(db, {
      runId: "run-recover",
      habitId: "morning-row",
      nextEscalationAt: NOW_MS - 60 * 1000,
      escalationFailureCount: 2,
    });
    // Success: the mock resolves without throwing. The verb (not the
    // scheduler) owns next_escalation_at on success, so the scheduler must
    // only clear the failure counter here.
    const dispatch = vi.fn(async () => {});

    await schedulerTick({ db, dispatch });

    const run = getRun(db, "run-recover");
    expect(run.escalation_failure_count).toBe(0);
    expect(run.last_dispatch_error).toBeNull();
  });

  it("circuit breaker halts the tick after N consecutive failures", async () => {
    // Seed more due runs than the threshold; every dispatch fails.
    for (let i = 0; i < ESCALATION_CIRCUIT_BREAKER_THRESHOLD + 2; i++) {
      seedHabitRun(db, {
        runId: `run-${i}`,
        habitId: "morning-row",
        // Distinct fire_date per run to satisfy UNIQUE(habit_id, fire_date).
        fireDate: `2026-04-${String(i + 1).padStart(2, "0")}`,
        firedAt: NOW_MS - (100 - i) * 60 * 1000, // ascending fired_at order
        nextEscalationAt: NOW_MS - 60 * 1000,
      });
    }
    const dispatch = vi.fn(async (verb: string) => {
      if (verb === "habit-checkin") throw new Error("systemic outage");
    });

    await schedulerTick({ db, dispatch });

    // Only THRESHOLD dispatches attempted before the breaker trips; the rest
    // are deferred to the next tick (and have already backed off).
    expect(countHabitCheckins(dispatch)).toBe(ESCALATION_CIRCUIT_BREAKER_THRESHOLD);
  });
});
