// Task 2.1: checkProvable — read-only proof-cache check.
//
// Answers "given a habit + fire_date, is there already cached sensor data
// that proves this habit was done?" in a single pure call. No DB writes,
// no side effects, no posting. Used by Task 2.2 to short-circuit
// habit-checkin escalation when the proof is already on file.
//
// Phase 2 scope is intentionally narrow:
//   - `concept2_api+photo_fallback` reads `sensor_signals` and runs the
//     min-minutes filter via the existing `findQualifyingSession` helper.
//   - All other proof_types (training_log_photo, typed_msg+garmin_sleep)
//     return `{ provable: false }`. The Garmin/wind-down branch is listed
//     in the plan as future work — do NOT pre-implement it here.
//
// The function is synchronous. Both DB reads (`habits`, `sensor_signals`)
// are direct better-sqlite3 calls; no async surface is needed.

import type Database from "better-sqlite3";
import type { Concept2Result } from "../lib/concept2-adapter.js";
import { findQualifyingSession } from "./verify-proof-internals.js";

// -----------------------------------------------------------------------------
// Public surface.
// -----------------------------------------------------------------------------

export interface ProvableCheckOptions {
  readonly db: Database.Database;
  readonly habitId: string;
  /** YYYY-MM-DD, local-date convention per ADR 0001. */
  readonly fireDate: string;
}

export interface ProvableResult {
  readonly provable: boolean;
  readonly source?: "concept2" | "garmin";
  readonly payload?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Internal row shapes.
// -----------------------------------------------------------------------------

interface HabitRow {
  readonly proof_type: string;
  readonly proof_config_json: string;
}

interface SensorPayloadRow {
  readonly payload_json: string;
}

interface Concept2Payload {
  readonly results: readonly Concept2Result[];
}

interface MorningRowProofConfig {
  readonly min_minutes: number;
}

// -----------------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------------

export function checkProvable(opts: ProvableCheckOptions): ProvableResult {
  const habit = opts.db
    .prepare(
      `SELECT proof_type, proof_config_json
         FROM habits
        WHERE id = ?`,
    )
    .get(opts.habitId) as HabitRow | undefined;

  if (habit === undefined) {
    return { provable: false };
  }

  if (habit.proof_type === "concept2_api+photo_fallback") {
    return checkConcept2(opts, habit);
  }

  // Other proof types (training_log_photo, typed_msg+garmin_sleep) fall
  // through. Garmin/wind-down is intentionally deferred per plan §2.1.
  return { provable: false };
}

// -----------------------------------------------------------------------------
// Concept2 branch.
// -----------------------------------------------------------------------------

function checkConcept2(
  opts: ProvableCheckOptions,
  habit: HabitRow,
): ProvableResult {
  const row = opts.db
    .prepare(
      `SELECT payload_json
         FROM sensor_signals
        WHERE source = 'concept2' AND payload_date = ?`,
    )
    .get(opts.fireDate) as SensorPayloadRow | undefined;

  if (row === undefined) {
    return { provable: false };
  }

  const parsed = JSON.parse(row.payload_json) as Concept2Payload;
  const config = parseMorningRowConfig(
    habit.proof_config_json,
    opts.habitId,
  );

  const matched = findQualifyingSession(parsed.results, config.min_minutes);
  if (matched === undefined) {
    return { provable: false };
  }

  // `Concept2Result` is a `Readonly<{...}>` shape with all primitive
  // fields — assignment to `Record<string, unknown>` is structurally
  // safe. Cast via `unknown` to satisfy TS without widening the helper's
  // typed return.
  return {
    provable: true,
    source: "concept2",
    payload: matched as unknown as Record<string, unknown>,
  };
}

function parseMorningRowConfig(
  json: string,
  habitId: string,
): MorningRowProofConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const minMinutes = parsed.min_minutes;
  if (typeof minMinutes !== "number") {
    throw new Error(
      `habit ${habitId} proof_config_json missing numeric min_minutes`,
    );
  }
  return { min_minutes: minMinutes };
}
