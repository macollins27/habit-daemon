// Task 16: orchestration verb that re-attempts sensor pulls for habit_runs
// stuck in status='unresolved' (Task 15 set them there).
//
// Behavior per row:
//   1. If `now - fired_at >= 48 h` → terminal transition to
//      status='unresolved_no_data'. These rows are excluded from compliance
//      math (Phase B), so the daemon stops paying attention to them. No
//      sensor sync attempted.
//   2. Otherwise dispatch a sensor sync based on the habit's proof_type:
//        - 'concept2_api+photo_fallback' → concept2Sync(fire_date)
//        - 'typed_msg+garmin_sleep'      → garminSync(fire_date)
//        - 'training_log_photo'          → no sensor; skip (defensive).
//      The sync call is wrapped in try/catch. If it throws, we delegate to
//      resolveSensorFailure() to keep the row 'unresolved' and append a fresh
//      sensor_failure_logged event (Task 15 path; same code, no duplication).
//   3. If the sync succeeds, read the sensor_signals row for (source, date)
//      and evaluate the habit's proof_config inline (Phase A is small):
//        - morning-row: status='completed' if any results[] entry is a
//          'rower' session ≥ proof_config.min_minutes * 60 seconds.
//          Otherwise status='missed'. (Photo fallback is Task 34.)
//        - wind-down: status='completed' if sleep.sleep_onset_time's HH:MM
//          portion is ≤ proof_config.stage_b_threshold (e.g., '23:00').
//          Otherwise status='missed'.
//      A typed habit_completed / habit_missed event is appended at L1 trust
//      level (sensor-attested but not human-attested).
//
// Connection invariant (same as Task 15): the verb writes on
// `sessionStore.db` only. SQLite WAL permits one writer; mixing a separate
// connection would deadlock on SQLITE_BUSY. Callers MUST inject sensor sync
// adapters that, where they touch the DB, also write through this same
// handle (in production wire-up, garminSync/concept2Sync are thin wrappers
// over the existing adapters' syncDate() that pass sessionStore.db).
//
// `registerRetryUnresolvedSensorsCron()` inserts a `0 */6 * * *` schedule
// for this verb at dispatch_priority=50. It is idempotent — a SELECT-first
// guard skips the INSERT when a row with verb='retry-unresolved-sensors'
// already exists (the schedules table has no unique constraint on verb yet).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 16
//   - src/orchestrate/resolve-sensor-failure.ts (still-failing path delegate)
//   - src/db/migrations/001_habits.sql (habit_runs.status CHECK constraint)
//   - src/db/seed-habits.ts (proof_config shapes for the three habits)

import type Database from "better-sqlite3";
import type { SessionStore } from "../daemon/session-store.js";
import type { SessionEventType } from "../daemon/session-store.js";
import { resolveSensorFailure } from "./resolve-sensor-failure.js";

const FORTY_EIGHT_HOURS_MS = 48 * 3_600_000;

export interface RetryUnresolvedSensorsOptions {
  readonly sessionStore: SessionStore;
  readonly sessionId: string;
  readonly now: number;
  readonly garminSync: (date: string) => Promise<void>;
  readonly concept2Sync: (date: string) => Promise<void>;
}

export interface RetryResult {
  readonly attempted: number;
  readonly resolved: number;
  readonly stillUnresolved: number;
  readonly aged: number;
}

interface UnresolvedRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly fired_at: number;
}

interface HabitRow {
  readonly id: string;
  readonly proof_type: string;
  readonly proof_config_json: string;
}

interface SensorSignalRow {
  readonly payload_json: string;
}

interface MorningRowProofConfig {
  readonly min_minutes: number;
}

interface WindDownProofConfig {
  readonly stage_b_threshold: string;
}

interface Concept2Result {
  readonly type: string;
  readonly duration_seconds: number;
}

interface Concept2Payload {
  readonly results: ReadonlyArray<Concept2Result>;
}

interface GarminSleepPayload {
  readonly sleep: {
    readonly sleep_onset_time: string | null;
  } | null;
}

type ResolvedStatus = "completed" | "missed";

function isResolvedCompleted(
  proofType: string,
  proofConfigJson: string,
  payloadJson: string,
): boolean {
  if (proofType === "concept2_api+photo_fallback") {
    const cfg = JSON.parse(proofConfigJson) as MorningRowProofConfig;
    const payload = JSON.parse(payloadJson) as Concept2Payload;
    const minSeconds = cfg.min_minutes * 60;
    return payload.results.some(
      (r) => r.type === "rower" && r.duration_seconds >= minSeconds,
    );
  }
  if (proofType === "typed_msg+garmin_sleep") {
    const cfg = JSON.parse(proofConfigJson) as WindDownProofConfig;
    const payload = JSON.parse(payloadJson) as GarminSleepPayload;
    const onset = payload.sleep?.sleep_onset_time ?? null;
    if (onset === null) {
      return false;
    }
    const match = onset.match(/T(\d{2}):(\d{2})/);
    if (match === null) {
      return false;
    }
    const hhmm = `${match[1]}:${match[2]}`;
    // Lex comparison on zero-padded HH:MM is equivalent to time comparison.
    return hhmm <= cfg.stage_b_threshold;
  }
  // training_log_photo (and any unknown type) cannot be resolved by sensor
  // alone; defensive default → not completed.
  return false;
}

function sensorSourceFor(proofType: string): "garmin" | "concept2" | null {
  if (proofType === "concept2_api+photo_fallback") return "concept2";
  if (proofType === "typed_msg+garmin_sleep") return "garmin";
  return null;
}

function applyTerminalNoData(db: Database.Database, runId: string): void {
  db.prepare(
    `UPDATE habit_runs
       SET status = 'unresolved_no_data', next_escalation_at = NULL
     WHERE id = ?`,
  ).run(runId);
}

function applyResolved(
  sessionStore: SessionStore,
  sessionId: string,
  runId: string,
  newStatus: ResolvedStatus,
  now: number,
): void {
  const db = sessionStore.db;
  const eventType: SessionEventType =
    newStatus === "completed" ? "habit_completed" : "habit_missed";

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE habit_runs
         SET status = ?, completed_at = ?, next_escalation_at = NULL
       WHERE id = ?`,
    ).run(newStatus, now, runId);

    // L1: sensor-attested but not human-attested.
    sessionStore.append(sessionId, eventType, { runId, status: newStatus }, {
      trustLevel: "L1",
    });
  });

  tx();
}

export async function retryUnresolvedSensors(
  opts: RetryUnresolvedSensorsOptions,
): Promise<RetryResult> {
  const { sessionStore, sessionId, now, garminSync, concept2Sync } = opts;
  const db = sessionStore.db;

  const rows = db
    .prepare(
      `SELECT id, habit_id, fire_date, fired_at
         FROM habit_runs
        WHERE status = 'unresolved'
        ORDER BY fired_at ASC`,
    )
    .all() as readonly UnresolvedRunRow[];

  let attempted = 0;
  let resolved = 0;
  let stillUnresolved = 0;
  let aged = 0;

  for (const run of rows) {
    attempted += 1;

    if (now - run.fired_at >= FORTY_EIGHT_HOURS_MS) {
      applyTerminalNoData(db, run.id);
      aged += 1;
      continue;
    }

    const habit = db
      .prepare(
        `SELECT id, proof_type, proof_config_json FROM habits WHERE id = ?`,
      )
      .get(run.habit_id) as HabitRow | undefined;
    if (habit === undefined) {
      // Orphaned run: habit row missing. Leave it unresolved; another verb
      // can clean this up. Count it as still-unresolved so the summary
      // reflects no progress.
      stillUnresolved += 1;
      continue;
    }

    const source = sensorSourceFor(habit.proof_type);
    if (source === null) {
      // No sensor for this habit type (e.g., training_log_photo). It should
      // never have been parked in 'unresolved' by Task 15, but be defensive:
      // count as still-unresolved without retrying.
      stillUnresolved += 1;
      continue;
    }

    try {
      if (source === "garmin") {
        await garminSync(run.fire_date);
      } else {
        await concept2Sync(run.fire_date);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Same code path as Task 15's initial failure: append another
      // sensor_failure_logged event and keep status='unresolved'. The
      // habit_runs UPDATE inside resolveSensorFailure is a no-op-shape
      // (status already 'unresolved') but it still rolls back atomically
      // with the event append on failure.
      resolveSensorFailure({
        sessionStore,
        sessionId,
        runId: run.id,
        source,
        error,
      });
      stillUnresolved += 1;
      continue;
    }

    const signal = db
      .prepare(
        `SELECT payload_json FROM sensor_signals
          WHERE source = ? AND payload_date = ?`,
      )
      .get(source, run.fire_date) as SensorSignalRow | undefined;

    if (signal === undefined) {
      // The sync succeeded but no row landed for this date. Treat as
      // still-unresolved; we'll try again on the next cron tick.
      stillUnresolved += 1;
      continue;
    }

    const completed = isResolvedCompleted(
      habit.proof_type,
      habit.proof_config_json,
      signal.payload_json,
    );
    const newStatus: ResolvedStatus = completed ? "completed" : "missed";
    applyResolved(sessionStore, sessionId, run.id, newStatus, now);
    resolved += 1;
  }

  return { attempted, resolved, stillUnresolved, aged };
}

export function registerRetryUnresolvedSensorsCron(
  db: Database.Database,
): void {
  // schedules has no UNIQUE(verb) constraint yet (Phase B), so emulate
  // INSERT OR IGNORE with a SELECT-first guard.
  const existing = db
    .prepare(`SELECT id FROM schedules WHERE verb = ?`)
    .get("retry-unresolved-sensors");
  if (existing !== undefined) {
    return;
  }

  db.prepare(
    `INSERT INTO schedules (
       cron_expr, verb, args_json, missed_run_policy, enabled, dispatch_priority
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("0 */6 * * *", "retry-unresolved-sensors", "{}", "skip", 1, 50);
}
