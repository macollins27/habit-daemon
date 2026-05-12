// Task 26: L3 WHY-well selection orchestration.
//
// `selectWell` is a pure function that returns the WHY-well payload the L3
// habit-checkin template will weave into its prompt. It implements design § 3:
//
//   1. pattern_well — pattern_detector(28d).count >= 3
//      AND last_pattern_well_use_at < now() - 14 days
//   2. body_data_well — body_data_anomaly_detected()
//   3. stakes_well — rotation primary → secondary → tertiary, 7-day dedup
//
// The function is intentionally I/O-free: all context (habit row, run row,
// trailing miss_reasons, cached sensor_signals, last-use stamps) is loaded
// by the orchestration verb (Tasks 27/28/29) and passed in. Keeping it pure
// makes the priority chain exhaustively testable without DB fixtures.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 26
//   - docs/plans/2026-05-12-habit-daemon-design.md § 2 (why_stakes_json
//     schema) and § 3 (L3 WHY-well selection logic)

import type { HabitContext, RunContext } from "./prompt-builder.js";
import {
  detectPriorNightAnomaly,
  detectTrailingWeekAnomaly,
} from "./anomaly-detector.js";

// ------------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------------

/**
 * One row from `miss_reasons` (trailing 30-day window). Only the columns the
 * pattern detector actually reads are typed here — the verb may pull more
 * fields, but the selector ignores them.
 *
 * `inferred_specifics` is a colon-delimited slug like
 * `"late-gaming-friend:brian"`. The pattern detector groups by the prefix
 * before the first colon.
 */
export interface MissReason {
  readonly id: string;
  readonly habit_id: string;
  readonly run_id: string;
  readonly miss_date: string;
  readonly inferred_specifics: string | null;
  readonly classification: string | null;
  readonly created_at: number;
}

/**
 * One row from `sensor_signals`. `payload_json` is the raw JSON the adapter
 * wrote (e.g. `{"sleep": {...}}` for Garmin). The selector parses this
 * defensively — anything malformed is treated as "no signal".
 */
export interface SensorSignal {
  readonly id: string;
  readonly source: "garmin" | "concept2";
  readonly payload_date: string;
  readonly payload_json: string;
  readonly fetched_at: number;
}

export type StakeName = "primary" | "secondary" | "tertiary";

export interface WellSelectionContext {
  readonly habit: HabitContext;
  readonly run: RunContext;
  readonly now: number;
  readonly missReasons30d: readonly MissReason[];
  readonly sensorSignals: readonly SensorSignal[];
  readonly lastPatternWellUseMs: number | null;
  readonly lastStakesWellUse: {
    readonly stake: StakeName;
    readonly usedAtMs: number;
  } | null;
}

export interface PatternPayload {
  readonly well: "pattern";
  readonly slugPrefix: string;
  readonly count: number;
  readonly exemplarSpecifics: string;
  readonly framingTemplate: string;
}

export interface BodyDataPayload {
  readonly well: "body_data";
  readonly anomalousSignals: readonly string[];
  readonly framingTemplate: string;
}

export interface StakesPayload {
  readonly well: "stakes";
  readonly stake: StakeName;
  readonly text: string;
}

export type WellSelection = PatternPayload | BodyDataPayload | StakesPayload;

// ------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const PATTERN_LOOKBACK_MS = 28 * DAY_MS;
const PATTERN_COOLDOWN_MS = 14 * DAY_MS;
const PATTERN_THRESHOLD = 3;

const STAKES_COOLDOWN_MS = 7 * DAY_MS;
const ROTATION_ORDER: readonly StakeName[] = [
  "primary",
  "secondary",
  "tertiary",
];

// Body-data heuristics live in src/lib/anomaly-detector.ts (Task 28). The
// selector calls into that module via `detectPriorNightAnomaly` and
// `detectTrailingWeekAnomaly` — the thresholds and edge-case rules are
// codified there.

// ------------------------------------------------------------------------
// Type narrowing helpers
// ------------------------------------------------------------------------

function readObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const v = parent[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function readString(
  parent: Record<string, unknown>,
  key: string,
): string | null {
  const v = parent[key];
  return typeof v === "string" ? v : null;
}

function readStringArray(
  parent: Record<string, unknown>,
  key: string,
): readonly string[] {
  const v = parent[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

// ------------------------------------------------------------------------
// Pattern branch
// ------------------------------------------------------------------------

function groupBySlugPrefix(
  missReasons: readonly MissReason[],
): Map<string, MissReason[]> {
  const groups = new Map<string, MissReason[]>();
  for (const mr of missReasons) {
    if (!mr.inferred_specifics) continue;
    const prefix = mr.inferred_specifics.split(":")[0];
    if (!prefix) continue;
    const existing = groups.get(prefix);
    if (existing) {
      existing.push(mr);
    } else {
      groups.set(prefix, [mr]);
    }
  }
  return groups;
}

function tryPattern(ctx: WellSelectionContext): PatternPayload | null {
  // Cooldown gate first — cheap.
  if (
    ctx.lastPatternWellUseMs !== null &&
    ctx.now - ctx.lastPatternWellUseMs <= PATTERN_COOLDOWN_MS
  ) {
    return null;
  }

  const inWindow = ctx.missReasons30d.filter(
    (mr) => mr.created_at >= ctx.now - PATTERN_LOOKBACK_MS,
  );
  const groups = groupBySlugPrefix(inWindow);

  // Pick the largest group ≥ threshold.
  let bestPrefix: string | null = null;
  let bestGroup: MissReason[] | null = null;
  for (const [prefix, group] of groups) {
    if (group.length < PATTERN_THRESHOLD) continue;
    if (bestGroup === null || group.length > bestGroup.length) {
      bestPrefix = prefix;
      bestGroup = group;
    }
  }

  if (bestPrefix === null || bestGroup === null) return null;

  const patternWell = readObject(ctx.habit.why_stakes, "pattern_well");
  const framingTemplate =
    (patternWell && readString(patternWell, "framing_template")) ?? "";

  // Exemplar = first inferred_specifics in the group (chronologically first
  // in the source order; the verb passes rows in created_at order).
  const exemplar = bestGroup[0]?.inferred_specifics ?? bestPrefix;

  return {
    well: "pattern",
    slugPrefix: bestPrefix,
    count: bestGroup.length,
    exemplarSpecifics: exemplar,
    framingTemplate,
  };
}

// ------------------------------------------------------------------------
// Body-data branch
//
// The actual anomaly heuristics (prior-night bottom-20% and trailing-week
// trend) live in src/lib/anomaly-detector.ts. The selector handles habit-
// level routing — pulling the signal_mode from why_stakes, computing the
// prior-night date, and packaging the result into a `BodyDataPayload`.
// ------------------------------------------------------------------------

export function computePriorDate(fireDate: string): string | null {
  const fireDateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fireDate);
  if (!fireDateParts) return null;
  const fireDateMs = Date.UTC(
    Number(fireDateParts[1]),
    Number(fireDateParts[2]) - 1,
    Number(fireDateParts[3]),
  );
  const priorMs = fireDateMs - DAY_MS;
  return new Date(priorMs).toISOString().slice(0, 10);
}

function tryBodyData(ctx: WellSelectionContext): BodyDataPayload | null {
  const bodyDataWell = readObject(ctx.habit.why_stakes, "body_data_well");
  if (!bodyDataWell) return null;

  const mode = readString(bodyDataWell, "signal_mode");
  if (mode !== "prior_night" && mode !== "trailing_week_trend") return null;

  const relevantSignals = readStringArray(bodyDataWell, "relevant_signals");
  if (relevantSignals.length === 0) return null;

  const garminSignals = ctx.sensorSignals.filter((s) => s.source === "garmin");

  let anomalies: readonly string[];
  if (mode === "prior_night") {
    const priorDate = computePriorDate(ctx.run.fire_date);
    if (priorDate === null) return null;
    anomalies = detectPriorNightAnomaly(
      garminSignals,
      relevantSignals,
      priorDate,
    ).anomalousSignals;
  } else {
    anomalies = detectTrailingWeekAnomaly(garminSignals, relevantSignals)
      .anomalousSignals;
  }

  if (anomalies.length === 0) return null;

  const framingTemplate = readString(bodyDataWell, "framing_template") ?? "";
  return {
    well: "body_data",
    anomalousSignals: anomalies,
    framingTemplate,
  };
}

// ------------------------------------------------------------------------
// Stakes branch
// ------------------------------------------------------------------------

function nextStake(prev: StakeName): StakeName {
  const idx = ROTATION_ORDER.indexOf(prev);
  // idx is always >= 0 because StakeName is a closed union; the modulo
  // is just so the wrap is explicit.
  const next = ROTATION_ORDER[(idx + 1) % ROTATION_ORDER.length];
  return next ?? "primary";
}

function readStakeText(habit: HabitContext, stake: StakeName): string {
  const stakesWell = readObject(habit.why_stakes, "stakes_well");
  if (!stakesWell) return "";
  return readString(stakesWell, stake) ?? "";
}

function selectStakes(ctx: WellSelectionContext): StakesPayload {
  if (ctx.lastStakesWellUse === null) {
    return {
      well: "stakes",
      stake: "primary",
      text: readStakeText(ctx.habit, "primary"),
    };
  }

  const elapsed = ctx.now - ctx.lastStakesWellUse.usedAtMs;
  // Spec wording: "Used 7+ days ago with primary → returns secondary."
  // So the rotation boundary is `>= 7 days`. Within `< 7 days` we dedup.
  const stake =
    elapsed >= STAKES_COOLDOWN_MS
      ? nextStake(ctx.lastStakesWellUse.stake)
      : ctx.lastStakesWellUse.stake;

  return {
    well: "stakes",
    stake,
    text: readStakeText(ctx.habit, stake),
  };
}

// ------------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------------

/**
 * Pick the L3 WHY-well payload for a habit run. Priority chain:
 *   pattern > body_data > stakes.
 *
 * The caller (habit-checkin L3 verb) is responsible for loading the inputs
 * from SQLite and stamping the result into `last_pattern_well_use_at` /
 * `last_stakes_well_used` (those updates are side effects outside this
 * function).
 */
export function selectWell(ctx: WellSelectionContext): WellSelection {
  const pattern = tryPattern(ctx);
  if (pattern) return pattern;

  const bodyData = tryBodyData(ctx);
  if (bodyData) return bodyData;

  return selectStakes(ctx);
}
