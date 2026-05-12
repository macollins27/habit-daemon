// Task 19: tests for recordVisionRejection orchestration verb.
//
// recordVisionRejection() appends a 'proof_attempt_rejected' event to
// session_events and — once three such events accumulate for a single run —
// flips habit_runs.proof_rejection_callout_due from 0 to 1. The flag is read
// later by habit-checkin (Task 24+) to compose the callout text on the next
// scheduled L+1 dispatch; this verb does NOT compose the message, dispatch
// to Discord, or reset the flag. The verb also MUST NOT touch
// next_escalation_at — rejections do not move escalation.
//
// Test contract (architectural):
//   - This file intentionally does NOT import anything from
//     `src/lib/discord-adapter*`. Vision-verify and its rejection counter
//     are decoupled from Discord so the verb is testable in CLI, web-admin,
//     and future v2 contexts. Any future maintainer who adds a discord
//     import here has broken Task 19's decoupling contract — revert the
//     import and route Discord side-effects through habit-checkin.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 19
//   - src/daemon/session-store.ts (append() semantics, event_type CHECK)
//   - src/db/migrations/001_habits.sql (habit_runs.proof_rejection_callout_due)
//   - src/orchestrate/resolve-sensor-failure.ts (single-writer pattern)

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
import {
  recordVisionRejection,
  type VisionRejection,
} from "../../src/orchestrate/vision-rejection-counter.js";

interface HabitRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly status: string;
  readonly next_escalation_at: number | null;
  readonly proof_rejection_callout_due: number;
}

interface SessionEventRow {
  readonly id: number;
  readonly session_id: string;
  readonly seq: number;
  readonly event_json: string;
  readonly trust_level: string;
  readonly event_type: string | null;
}

interface CountRow {
  readonly n: number;
}

interface ParsedEvent {
  readonly runId: string;
  readonly subject: string;
  readonly reason?: string;
  readonly parsed?: unknown;
}

const DEFAULT_CHANNELS = {
  morningRow: "ch-row",
  strength: "ch-strength",
  windDown: "ch-wind-down",
} as const;

const RUN_ID = "run-test-0001";
const RUN_ID_B = "run-test-0002";
const HABIT_ID = "morning-row";
const HABIT_ID_B = "strength-mwf";
const FIRE_DATE = "2026-05-12";
const FIRE_DATE_B = "2026-05-13";
const SESSION_ID = "session-test-0001";
const FUTURE_TS = 9_999_999_999_999;

function seedHabitRun(
  db: Database.Database,
  opts: {
    runId?: string;
    habitId?: string;
    fireDate?: string;
    nextEscalationAt?: number | null;
    calloutDue?: number;
  } = {},
): void {
  const runId = opts.runId ?? RUN_ID;
  const habitId = opts.habitId ?? HABIT_ID;
  const fireDate = opts.fireDate ?? FIRE_DATE;
  const nextEscalationAt =
    opts.nextEscalationAt === undefined ? FUTURE_TS : opts.nextEscalationAt;
  const calloutDue = opts.calloutDue ?? 0;
  db.prepare(
    `INSERT INTO habit_runs (
       id, habit_id, fire_date, fired_at, current_level, next_escalation_at,
       status, completed_at, proof_payload_json, skip_reason,
       proof_rejection_callout_due
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    habitId,
    fireDate,
    Date.now(),
    1,
    nextEscalationAt,
    "pending",
    null,
    null,
    null,
    calloutDue,
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

function countEvents(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as CountRow
  ).n;
}

function countRejectionsForRun(db: Database.Database, runId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events
         WHERE event_type = 'proof_attempt_rejected'
           AND json_extract(event_json, '$.runId') = ?`,
      )
      .get(runId) as CountRow
  ).n;
}

const SAMPLE_REJECTION: VisionRejection = {
  subject: "pm5_screen",
  reason: "duration_below_threshold",
  parsed: { duration_minutes: 12, distance_m: 1800 },
};

describe("recordVisionRejection()", () => {
  let tempDir: string;
  let dbPath: string;
  let migrator: Database.Database;
  let sessionStore: SessionStore;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "habit-daemon-vision-rejection-"));
    dbPath = join(tempDir, "store.db");

    // Run migrations + seed on a short-lived connection, then close it so the
    // SessionStore's connection is the only writer. The verb requires both
    // the session_events INSERT and the habit_runs UPDATE on the SAME
    // connection (single-writer constraint, Task 15 pattern).
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

  it("first rejection: counts 1, flag stays 0, event written", () => {
    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    expect(result.rejectionCount).toBe(1);
    expect(result.calloutDueSet).toBe(false);
    expect(result.calloutAlreadyDue).toBe(false);

    const row = getRun(db, RUN_ID);
    expect(row?.proof_rejection_callout_due).toBe(0);

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("proof_attempt_rejected");
  });

  it("second rejection: counts 2, flag stays 0", () => {
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });
    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    expect(result.rejectionCount).toBe(2);
    expect(result.calloutDueSet).toBe(false);
    expect(result.calloutAlreadyDue).toBe(false);
    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(0);
  });

  it("third rejection: counts 3, calloutDueSet=true, flag flips to 1", () => {
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });
    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    expect(result.rejectionCount).toBe(3);
    expect(result.calloutDueSet).toBe(true);
    expect(result.calloutAlreadyDue).toBe(false);
    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(1);
  });

  it("fourth rejection: idempotent — flag stays 1, calloutAlreadyDue=true", () => {
    for (let i = 0; i < 3; i += 1) {
      recordVisionRejection({
        sessionStore,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        rejection: SAMPLE_REJECTION,
      });
    }
    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    expect(result.rejectionCount).toBe(4);
    expect(result.calloutDueSet).toBe(false);
    expect(result.calloutAlreadyDue).toBe(true);
    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(1);
  });

  it("pre-existing flag=1: first rejection reports calloutAlreadyDue=true, no flip", () => {
    // Reset and re-seed with the flag already set.
    db.prepare("DELETE FROM habit_runs WHERE id = ?").run(RUN_ID);
    seedHabitRun(db, { calloutDue: 1 });

    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    expect(result.rejectionCount).toBe(1);
    expect(result.calloutDueSet).toBe(false);
    expect(result.calloutAlreadyDue).toBe(true);
    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(1);
  });

  it("next_escalation_at is never modified across N rejections", () => {
    for (let i = 0; i < 5; i += 1) {
      recordVisionRejection({
        sessionStore,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        rejection: SAMPLE_REJECTION,
      });
      expect(getRun(db, RUN_ID)?.next_escalation_at).toBe(FUTURE_TS);
    }
  });

  it("event payload carries {runId, subject, reason, parsed}", () => {
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: {
        subject: "training_log",
        reason: "missing_field",
        parsed: { date: "2026-05-12", lifts: [] },
      },
    });

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    const parsed = JSON.parse(events[0].event_json) as ParsedEvent;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.subject).toBe("training_log");
    expect(parsed.reason).toBe("missing_field");
    expect(parsed.parsed).toEqual({ date: "2026-05-12", lifts: [] });
  });

  it("trust level is L1 (artifact-backed: image URL + parseable model output)", () => {
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: SAMPLE_REJECTION,
    });

    const events = getSessionEvents(db, SESSION_ID);
    expect(events.length).toBe(1);
    expect(events[0].trust_level).toBe("L1");
  });

  it("unknown runId throws atomically — no event written, no flag changes", () => {
    const eventsBefore = countEvents(db);

    expect(() =>
      recordVisionRejection({
        sessionStore,
        sessionId: SESSION_ID,
        runId: "run-does-not-exist",
        rejection: SAMPLE_REJECTION,
      }),
    ).toThrowError(/habit_run not found.*run-does-not-exist/);

    expect(countEvents(db)).toBe(eventsBefore);
    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(0);
  });

  it("multi-run isolation: rejections to run A do not affect run B's count or flag", () => {
    seedHabitRun(db, {
      runId: RUN_ID_B,
      habitId: HABIT_ID_B,
      fireDate: FIRE_DATE_B,
    });

    // 3 rejections to run A → flag flips for A only.
    for (let i = 0; i < 3; i += 1) {
      recordVisionRejection({
        sessionStore,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        rejection: SAMPLE_REJECTION,
      });
    }

    expect(getRun(db, RUN_ID)?.proof_rejection_callout_due).toBe(1);
    expect(getRun(db, RUN_ID_B)?.proof_rejection_callout_due).toBe(0);

    // One rejection to run B → counts as 1 (run-isolated count), flag stays 0.
    const result = recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID_B,
      rejection: SAMPLE_REJECTION,
    });
    expect(result.rejectionCount).toBe(1);
    expect(result.calloutDueSet).toBe(false);
    expect(getRun(db, RUN_ID_B)?.proof_rejection_callout_due).toBe(0);

    // Counter scoping verified via json_extract($.runId) on the table directly.
    expect(countRejectionsForRun(db, RUN_ID)).toBe(3);
    expect(countRejectionsForRun(db, RUN_ID_B)).toBe(1);
  });

  it("rejection without reason/parsed: optional fields tolerated", () => {
    recordVisionRejection({
      sessionStore,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      rejection: { subject: "pm5_screen" },
    });

    const events = getSessionEvents(db, SESSION_ID);
    const parsed = JSON.parse(events[0].event_json) as ParsedEvent;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.subject).toBe("pm5_screen");
    // Optional fields may be absent or undefined-omitted from the JSON.
  });
});
