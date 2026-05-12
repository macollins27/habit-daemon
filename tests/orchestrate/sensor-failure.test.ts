// Task 15: tests for resolveSensorFailure orchestration verb.
//
// resolveSensorFailure() transitions a habit_run to status='unresolved' and
// appends a 'sensor_failure_logged' event to the session_events table, both
// in a single atomic SQLite transaction. Because SQLite (in WAL mode) only
// permits one writer at a time, the verb's transaction must run on the same
// connection that SessionStore.append() uses internally. Tests therefore
// run migrations + seed via a short-lived `migrator` connection (closed
// before SessionStore opens), then perform all habit_runs reads/writes
// through `sessionStore.db` — the canonical handle the verb is given.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 15
//   - src/daemon/session-store.ts (append() semantics, event_type CHECK)
//   - src/db/migrations/001_habits.sql (habit_runs status CHECK)

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
import { resolveSensorFailure } from "../../src/orchestrate/resolve-sensor-failure.js";

interface HabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly status: string;
  readonly next_escalation_at: number | null;
}

interface SessionEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly trust_level: string;
  readonly event_type: string | null;
}

interface SessionRow {
  readonly session_id: string;
}

interface CountRow {
  readonly n: number;
}

interface ParsedEvent {
  readonly runId: string;
  readonly source: string;
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}

const DEFAULT_CHANNELS = {
  morningRow: "ch-row",
  strength: "ch-strength",
  windDown: "ch-wind-down",
} as const;

const RUN_ID = "run-test-0001";
const HABIT_ID = "morning-row";
const FIRE_DATE = "2026-05-12";
const SESSION_ID = "session-test-0001";
const FUTURE_TS = 9_999_999_999_999;

function seedHabitRun(
  db: Database.Database,
  opts: { runId?: string; status?: string; nextEscalationAt?: number | null } = {},
): void {
  const runId = opts.runId ?? RUN_ID;
  const status = opts.status ?? "pending";
  const nextEscalationAt =
    opts.nextEscalationAt === undefined ? FUTURE_TS : opts.nextEscalationAt;
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    HABIT_ID,
    FIRE_DATE,
    Date.now(),
    1,
    nextEscalationAt,
    status,
    null,
    null,
    null,
    0,
  );
}

function getRun(db: Database.Database, runId: string): HabitRunRow | undefined {
  return db
    .prepare("SELECT * FROM habit_runs WHERE id = ?")
    .get(runId) as HabitRunRow | undefined;
}

function getSessionEvents(
  db: Database.Database,
  sessionId: string,
): readonly SessionEventRow[] {
  return db
    .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId) as readonly SessionEventRow[];
}

function getSession(
  db: Database.Database,
  sessionId: string,
): SessionRow | undefined {
  return db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;
}

function countEvents(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as CountRow
  ).n;
}

describe("resolveSensorFailure()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-sensor-failure-"));
    dbPath = join(tempDir, "store.db");

    // Run migrations + seed on a short-lived connection, then close it so the
    // SessionStore's connection is the only writer. The verb requires both
    // the habit_runs UPDATE and the session_events INSERT on the SAME
    // connection (single SQLite transaction across two writers is impossible
    // with WAL — SQLITE_BUSY otherwise). Tests therefore share
    // `sessionStore.db` as the canonical handle for habit_runs reads/writes.
    migrator = openDatabase(dbPath);
    await runMigrations(migrator, loadMigrations());
    seedHabits(migrator, DEFAULT_CHANNELS);
    migrator.close();

    sessionStore = new SessionStore({ dbPath });
    db = sessionStore.db;
    seedHabitRun(db);
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("transitions habit_runs.status to 'unresolved' on garmin failure", () => {
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "garmin",
      error: new GarminAuthExpired("token expired"),
    });

    const row = getRun(db, RUN_ID);
    expect(row).toBeDefined();
    expect(row?.status).toBe("unresolved");
  });

  it("halts next_escalation_at by setting it to NULL", () => {
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "garmin",
      error: new GarminAuthExpired("token expired"),
    });

    const row = getRun(db, RUN_ID);
    expect(row?.next_escalation_at).toBeNull();
  });

  it("appends a session_events row with event_type='sensor_failure_logged' and trust_level='L0'", () => {
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "garmin",
      error: new GarminAuthExpired("token expired"),
    });

    // SessionStore.append() creates the session row on first write.
    expect(getSession(db, SESSION_ID)).toBeDefined();

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("sensor_failure_logged");
    expect(events[0].trust_level).toBe("L0");
  });

  it("payload carries runId, source, and {name,message} of the error", () => {
    const err = new GarminAuthExpired("token expired");
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "garmin",
      error: err,
    });

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    const parsed = JSON.parse(events[0].event_json) as ParsedEvent;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.source).toBe("garmin");
    expect(parsed.error.name).toBe("GarminAuthExpired");
    expect(parsed.error.message).toBe("token expired");
  });

  it("records source='concept2' when called with a Concept2 failure", () => {
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "concept2",
      error: new Error("refresh exhausted"),
    });

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    const parsed = JSON.parse(events[0].event_json) as ParsedEvent;
    expect(parsed.source).toBe("concept2");
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("refresh exhausted");
  });

  it("throws a descriptive error for an unknown runId and writes nothing", () => {
    const eventsBefore = countEvents(db);

    expect(() =>
      resolveSensorFailure({
        db,
        sessionStore,
        sessionId: SESSION_ID,
        runId: "run-does-not-exist",
        source: "garmin",
        error: new GarminAuthExpired("token expired"),
      }),
    ).toThrowError(/habit_run not found.*run-does-not-exist/);

    // No event written — atomicity preserved across the whole verb.
    expect(countEvents(db)).toBe(eventsBefore);
    // Existing run untouched.
    const row = getRun(db, RUN_ID);
    expect(row?.status).toBe("pending");
    expect(row?.next_escalation_at).toBe(FUTURE_TS);
    // Session row not created since SessionStore was never called.
    expect(getSession(db, SESSION_ID)).toBeUndefined();
  });

  it("writes a second event when called twice for the same run; status stays 'unresolved'", () => {
    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "garmin",
      error: new GarminAuthExpired("first failure"),
    });

    resolveSensorFailure({
      db,
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      source: "concept2",
      error: new Error("second failure"),
    });

    const row = getRun(db, RUN_ID);
    expect(row?.status).toBe("unresolved");
    expect(row?.next_escalation_at).toBeNull();

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(2);
    const first = JSON.parse(events[0].event_json) as ParsedEvent;
    const second = JSON.parse(events[1].event_json) as ParsedEvent;
    expect(first.source).toBe("garmin");
    expect(first.error.message).toBe("first failure");
    expect(second.source).toBe("concept2");
    expect(second.error.message).toBe("second failure");
  });

  it("rolls back the habit_runs update if the session event append fails", () => {
    // Force SessionStore.append to throw by stubbing it to a function that
    // raises after the habit_runs UPDATE has already happened inside the
    // verb's transaction. Because both writes share a single SQLite
    // transaction, the UPDATE must roll back.
    const original = sessionStore.append.bind(sessionStore);
    sessionStore.append = (() => {
      throw new Error("synthetic append failure");
    }) as typeof sessionStore.append;

    try {
      expect(() =>
        resolveSensorFailure({
          db,
          sessionStore,
          sessionId: SESSION_ID,
          runId: RUN_ID,
          source: "garmin",
          error: new GarminAuthExpired("token expired"),
        }),
      ).toThrowError(/synthetic append failure/);

      const row = getRun(db, RUN_ID);
      expect(row?.status).toBe("pending");
      expect(row?.next_escalation_at).toBe(FUTURE_TS);
    } finally {
      sessionStore.append = original;
    }
  });
});
