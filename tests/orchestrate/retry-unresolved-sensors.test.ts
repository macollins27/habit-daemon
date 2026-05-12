// Task 16: tests for retryUnresolvedSensors orchestration verb + cron.
//
// retryUnresolvedSensors() queries habit_runs WHERE status='unresolved' and,
// per row, either re-attempts the sensor pull (via injected adapter mocks),
// resolves the run to completed/missed per the habit's proof_config, or —
// if the run is older than 48 h since fired_at — transitions terminally to
// 'unresolved_no_data' (excluded from compliance math).
//
// Like resolveSensorFailure (Task 15), the verb operates on `sessionStore.db`
// for all writes so the habit_runs UPDATEs and session_events INSERTs share a
// single SQLite connection. Tests therefore run migrations + seed via a
// short-lived `migrator` connection that closes BEFORE SessionStore opens,
// and use sessionStore.db as the canonical handle for habit_runs reads.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 16
//   - src/orchestrate/resolve-sensor-failure.ts (still-failing path delegates)
//   - src/lib/garmin-adapter.ts (GarminAuthExpired class)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";
import { SessionStore } from "../../src/daemon/session-store.js";
import { GarminAuthExpired } from "../../src/lib/garmin-adapter.js";
import {
  retryUnresolvedSensors,
  registerRetryUnresolvedSensorsCron,
} from "../../src/orchestrate/retry-unresolved-sensors.js";

interface HabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly fired_at: number;
  readonly status: string;
  readonly next_escalation_at: number | null;
  readonly completed_at: number | null;
}

interface SessionEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly trust_level: string;
  readonly event_type: string | null;
}

interface ScheduleRow {
  readonly id: number;
  readonly cron_expr: string;
  readonly verb: string;
  readonly args_json: string;
  readonly missed_run_policy: string;
  readonly enabled: number;
  readonly dispatch_priority: number;
}

interface CountRow {
  readonly n: number;
}

const DEFAULT_CHANNELS = {
  morningRow: "ch-row",
  strength: "ch-strength",
  windDown: "ch-wind-down",
} as const;

const SESSION_ID = "session-retry-0001";
const FIRE_DATE = "2026-05-12";
const NOW_MS = 1_747_059_000_000; // arbitrary fixed "now" for tests
const HOUR_MS = 3_600_000;

interface SeedRunOpts {
  readonly runId: string;
  readonly habitId: string;
  readonly status?: string;
  readonly fireDate?: string;
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
    opts.fireDate ?? FIRE_DATE,
    opts.firedAt ?? NOW_MS - HOUR_MS,
    1,
    null,
    opts.status ?? "unresolved",
    null,
    null,
    null,
    0,
  );
}

function writeConcept2Signal(
  db: Database.Database,
  date: string,
  durationSeconds: number,
): void {
  const payload = {
    results: [
      {
        id: 1,
        date,
        type: "rower",
        duration_seconds: durationSeconds,
        distance_meters: 2000,
      },
    ],
  };
  db.prepare(
    `INSERT OR REPLACE INTO sensor_signals (
       id, source, payload_date, payload_json, fetched_at
     ) VALUES (?, 'concept2', ?, ?, ?)`,
  ).run(`concept2-${date}`, date, JSON.stringify(payload), NOW_MS);
}

function writeGarminSignal(
  db: Database.Database,
  date: string,
  onsetTime: string | null,
): void {
  const sleep =
    onsetTime === null
      ? null
      : {
          sleep_onset_time: onsetTime,
          total_sleep_minutes: 420,
          rem_minutes: 90,
          deep_sleep_minutes: 60,
          hrv: 55,
        };
  const payload = { sleep };
  db.prepare(
    `INSERT OR REPLACE INTO sensor_signals (
       id, source, payload_date, payload_json, fetched_at
     ) VALUES (?, 'garmin', ?, ?, ?)`,
  ).run(`garmin-${date}`, date, JSON.stringify(payload), NOW_MS);
}

function getRun(db: Database.Database, runId: string): HabitRunRow | undefined {
  return db
    .prepare("SELECT * FROM habit_runs WHERE id = ?")
    .get(runId) as HabitRunRow | undefined;
}

function getEvents(
  db: Database.Database,
  sessionId: string,
): readonly SessionEventRow[] {
  return db
    .prepare(
      "SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionId) as readonly SessionEventRow[];
}

function countSchedules(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as CountRow
  ).n;
}

describe("retryUnresolvedSensors()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-retry-unresolved-"));
    dbPath = join(tempDir, "store.db");

    migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, DEFAULT_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a Concept2 morning-row to 'completed' when retry yields a qualifying session", async () => {
    seedHabitRun(db, { runId: "run-c2-ok", habitId: "morning-row" });

    const concept2Sync = async (date: string): Promise<void> => {
      // Mock the adapter: it would normally fetch + write to sensor_signals.
      // We do the write directly so the verb can read the payload it expects.
      writeConcept2Signal(db, date, 12 * 60); // 12-min row, qualifies.
    };
    const garminSync = async (): Promise<void> => {
      throw new Error("garmin sync should not be called for morning-row");
    };

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result).toEqual({
      attempted: 1,
      resolved: 1,
      stillUnresolved: 0,
      aged: 0,
    });
    const row = getRun(db, "run-c2-ok");
    expect(row?.status).toBe("completed");
    expect(row?.completed_at).not.toBeNull();

    const events = getEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_completed");
    expect(events[0].trust_level).toBe("L1");
  });

  it("resolves a Concept2 morning-row to 'missed' when retry yields no qualifying session", async () => {
    seedHabitRun(db, { runId: "run-c2-miss", habitId: "morning-row" });

    const concept2Sync = async (date: string): Promise<void> => {
      writeConcept2Signal(db, date, 5 * 60); // 5-min row, below 10-min threshold.
    };
    const garminSync = async (): Promise<void> => {
      throw new Error("garmin sync should not be called for morning-row");
    };

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result.resolved).toBe(1);
    const row = getRun(db, "run-c2-miss");
    expect(row?.status).toBe("missed");

    const events = getEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("habit_missed");
    expect(events[0].trust_level).toBe("L1");
  });

  it("resolves a Garmin wind-down to 'completed' when sleep onset is at or before threshold", async () => {
    seedHabitRun(db, { runId: "run-gar-ok", habitId: "wind-down" });

    const garminSync = async (date: string): Promise<void> => {
      writeGarminSignal(db, date, `${date}T22:30:00`); // 22:30 ≤ 23:00.
    };
    const concept2Sync = async (): Promise<void> => {
      throw new Error("concept2 sync should not be called for wind-down");
    };

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result.resolved).toBe(1);
    const row = getRun(db, "run-gar-ok");
    expect(row?.status).toBe("completed");

    const events = getEvents(db, SESSION_ID);
    expect(events[0].event_type).toBe("habit_completed");
  });

  it("resolves a Garmin wind-down to 'missed' when sleep onset is after threshold", async () => {
    seedHabitRun(db, { runId: "run-gar-miss", habitId: "wind-down" });

    const garminSync = async (date: string): Promise<void> => {
      writeGarminSignal(db, date, `${date}T23:45:00`); // 23:45 > 23:00.
    };
    const concept2Sync = async (): Promise<void> => {};

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result.resolved).toBe(1);
    const row = getRun(db, "run-gar-miss");
    expect(row?.status).toBe("missed");

    const events = getEvents(db, SESSION_ID);
    expect(events[0].event_type).toBe("habit_missed");
  });

  it("transitions to 'unresolved_no_data' when fired_at is older than 48 h and skips sensor sync", async () => {
    seedHabitRun(db, {
      runId: "run-aged",
      habitId: "morning-row",
      firedAt: NOW_MS - 49 * HOUR_MS,
    });

    let garminCalled = false;
    let concept2Called = false;
    const garminSync = async (): Promise<void> => {
      garminCalled = true;
    };
    const concept2Sync = async (): Promise<void> => {
      concept2Called = true;
    };

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result).toEqual({
      attempted: 1,
      resolved: 0,
      stillUnresolved: 0,
      aged: 1,
    });
    expect(garminCalled).toBe(false);
    expect(concept2Called).toBe(false);

    const row = getRun(db, "run-aged");
    expect(row?.status).toBe("unresolved_no_data");
    expect(row?.next_escalation_at).toBeNull();
  });

  it("stays 'unresolved' and writes a fresh sensor_failure_logged event when sync still fails", async () => {
    seedHabitRun(db, { runId: "run-fail", habitId: "wind-down" });

    const garminSync = async (): Promise<void> => {
      throw new GarminAuthExpired("token still expired");
    };
    const concept2Sync = async (): Promise<void> => {};

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result).toEqual({
      attempted: 1,
      resolved: 0,
      stillUnresolved: 1,
      aged: 0,
    });
    const row = getRun(db, "run-fail");
    expect(row?.status).toBe("unresolved");
    expect(row?.next_escalation_at).toBeNull();

    const events = getEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("sensor_failure_logged");
    expect(events[0].trust_level).toBe("L0");
  });

  it("processes a mixed batch with correct summary counts", async () => {
    seedHabitRun(db, {
      runId: "run-mix-resolve",
      habitId: "morning-row",
      firedAt: NOW_MS - HOUR_MS,
    });
    seedHabitRun(db, {
      runId: "run-mix-fail",
      habitId: "wind-down",
      firedAt: NOW_MS - 2 * HOUR_MS,
    });
    seedHabitRun(db, {
      runId: "run-mix-aged",
      habitId: "morning-row",
      fireDate: "2026-05-10",
      firedAt: NOW_MS - 49 * HOUR_MS,
    });

    const concept2Sync = async (date: string): Promise<void> => {
      writeConcept2Signal(db, date, 12 * 60);
    };
    const garminSync = async (): Promise<void> => {
      throw new GarminAuthExpired("still expired");
    };

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync,
      concept2Sync,
    });

    expect(result).toEqual({
      attempted: 3,
      resolved: 1,
      stillUnresolved: 1,
      aged: 1,
    });
    expect(getRun(db, "run-mix-resolve")?.status).toBe("completed");
    expect(getRun(db, "run-mix-fail")?.status).toBe("unresolved");
    expect(getRun(db, "run-mix-aged")?.status).toBe("unresolved_no_data");
  });

  it("ignores runs that are not in 'unresolved' status", async () => {
    seedHabitRun(db, {
      runId: "run-pending",
      habitId: "morning-row",
      status: "pending",
    });
    seedHabitRun(db, {
      runId: "run-completed",
      habitId: "morning-row",
      fireDate: "2026-05-11",
      status: "completed",
    });

    const result = await retryUnresolvedSensors({
      sessionStore,
      sessionId: SESSION_ID,
      now: NOW_MS,
      garminSync: async () => {
        throw new Error("should not be called");
      },
      concept2Sync: async () => {
        throw new Error("should not be called");
      },
    });

    expect(result).toEqual({
      attempted: 0,
      resolved: 0,
      stillUnresolved: 0,
      aged: 0,
    });
    expect(getRun(db, "run-pending")?.status).toBe("pending");
    expect(getRun(db, "run-completed")?.status).toBe("completed");
  });
});

describe("registerRetryUnresolvedSensorsCron()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-retry-cron-"));
    dbPath = join(tempDir, "store.db");
    migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
  });

  afterEach(() => {
    migrator.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("inserts one schedules row for the retry verb on a 6-h cron", () => {
    registerRetryUnresolvedSensorsCron(migrator);

    const rows = migrator
      .prepare("SELECT * FROM schedules WHERE verb = ?")
      .all("retry-unresolved-sensors") as readonly ScheduleRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].cron_expr).toBe("0 */6 * * *");
    expect(rows[0].args_json).toBe("{}");
    expect(rows[0].missed_run_policy).toBe("skip");
    expect(rows[0].enabled).toBe(1);
    expect(rows[0].dispatch_priority).toBe(50);
  });

  it("is idempotent: a second call does not insert a duplicate row", () => {
    registerRetryUnresolvedSensorsCron(migrator);
    registerRetryUnresolvedSensorsCron(migrator);

    expect(countSchedules(migrator)).toBe(1);
  });
});
