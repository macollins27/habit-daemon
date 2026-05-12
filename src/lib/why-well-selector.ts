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

// Heuristics for the trailing_week_trend body-data check. These are
// pragmatic Phase A defaults documented in docs/plans/...phase-a... § Task 26.
const TIME_OF_DAY_DELTA_MIN_THRESHOLD = 30;
const NUMERIC_DELTA_RATIO_THRESHOLD = 0.1; // 10%

// Time-of-day signals are stored as "HH:MM" strings. Everything else is a
// numeric minutes/count/index. The signal-extractor maps each signal name
// to its numeric value (or null when absent / unparseable).
const TIME_OF_DAY_SIGNALS = new Set<string>(["sleep_onset_time"]);

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
// ------------------------------------------------------------------------

/**
 * Extract a numeric value for a body-data signal name out of a parsed Garmin
 * sensor payload. Time-of-day strings ("HH:MM") are converted to
 * minutes-from-midnight so deltas are comparable to numeric signals.
 *
 * Returns null when the field is missing, the wrong type, or unparseable.
 */
function extractSignalValue(
  payload: Record<string, unknown>,
  signalName: string,
): number | null {
  const sleep = readObject(payload, "sleep");
  if (!sleep) return null;
  const raw = sleep[signalName];

  if (TIME_OF_DAY_SIGNALS.has(signalName)) {
    if (typeof raw !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
    return h * 60 + mi;
  }

  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parsePayload(signal: SensorSignal): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(signal.payload_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function priorNightAnomalies(
  ctx: WellSelectionContext,
  relevantSignals: readonly string[],
): readonly string[] {
  // Prior night = the night before run.fire_date. We treat fire_date as
  // YYYY-MM-DD and subtract one day.
  const fireDateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ctx.run.fire_date);
  if (!fireDateParts) return [];
  const fireDateMs = Date.UTC(
    Number(fireDateParts[1]),
    Number(fireDateParts[2]) - 1,
    Number(fireDateParts[3]),
  );
  const priorMs = fireDateMs - DAY_MS;
  const priorDate = new Date(priorMs).toISOString().slice(0, 10);

  const garmin = ctx.sensorSignals.filter((s) => s.source === "garmin");
  const priorSignal = garmin.find((s) => s.payload_date === priorDate);
  if (!priorSignal) return [];

  const priorPayload = parsePayload(priorSignal);
  if (!priorPayload) return [];

  // Trailing 30-day baseline = the 30 Garmin signals before prior-night
  // (exclusive). Pull values per signal, sort, take the 20th percentile.
  const baseline = garmin.filter(
    (s) => s.payload_date !== priorDate && s.payload_date < priorDate,
  );

  const anomalies: string[] = [];
  for (const sig of relevantSignals) {
    const priorVal = extractSignalValue(priorPayload, sig);
    if (priorVal === null) continue;

    const baselineVals: number[] = [];
    for (const b of baseline) {
      const p = parsePayload(b);
      if (!p) continue;
      const v = extractSignalValue(p, sig);
      if (v !== null) baselineVals.push(v);
    }
    if (baselineVals.length < 5) continue; // Insufficient baseline.

    baselineVals.sort((a, b) => a - b);
    // 20th-percentile threshold using nearest-rank (no interpolation).
    const idx = Math.max(0, Math.floor(0.2 * baselineVals.length) - 1);
    const threshold = baselineVals[idx];
    if (typeof threshold !== "number") continue;

    if (priorVal < threshold) {
      anomalies.push(sig);
    }
  }
  return anomalies;
}

function trailingWeekAnomalies(
  ctx: WellSelectionContext,
  relevantSignals: readonly string[],
): readonly string[] {
  // 7-day rolling vs prior 30-day baseline. We treat "last 7 days" as the
  // 7 most-recent Garmin signals and "30-day baseline" as the 23 signals
  // BEFORE that — design wording is ambiguous but consistent with the
  // "(avg of last 7d) vs (avg of trailing 30d, excluding last 7d)" spec
  // in task 26.
  const garmin = [...ctx.sensorSignals]
    .filter((s) => s.source === "garmin")
    .sort((a, b) => b.payload_date.localeCompare(a.payload_date)); // newest first

  if (garmin.length < 14) return []; // need both windows populated

  const last7 = garmin.slice(0, 7);
  const prior = garmin.slice(7, 30);
  if (prior.length < 5) return [];

  const anomalies: string[] = [];
  for (const sig of relevantSignals) {
    const collect = (sigs: readonly SensorSignal[]): number[] => {
      const out: number[] = [];
      for (const s of sigs) {
        const p = parsePayload(s);
        if (!p) continue;
        const v = extractSignalValue(p, sig);
        if (v !== null) out.push(v);
      }
      return out;
    };
    const recent = collect(last7);
    const baseline = collect(prior);
    if (recent.length === 0 || baseline.length === 0) continue;

    const avg = (xs: readonly number[]): number =>
      xs.reduce((a, b) => a + b, 0) / xs.length;
    const recentAvg = avg(recent);
    const baselineAvg = avg(baseline);
    const delta = Math.abs(recentAvg - baselineAvg);

    if (TIME_OF_DAY_SIGNALS.has(sig)) {
      if (delta > TIME_OF_DAY_DELTA_MIN_THRESHOLD) anomalies.push(sig);
    } else {
      const denom = Math.abs(baselineAvg);
      if (denom === 0) {
        if (delta > 0) anomalies.push(sig);
      } else if (delta / denom > NUMERIC_DELTA_RATIO_THRESHOLD) {
        anomalies.push(sig);
      }
    }
  }
  return anomalies;
}

function tryBodyData(ctx: WellSelectionContext): BodyDataPayload | null {
  const bodyDataWell = readObject(ctx.habit.why_stakes, "body_data_well");
  if (!bodyDataWell) return null;

  const mode = readString(bodyDataWell, "signal_mode");
  if (mode !== "prior_night" && mode !== "trailing_week_trend") return null;

  const relevantSignals = readStringArray(bodyDataWell, "relevant_signals");
  if (relevantSignals.length === 0) return null;

  const anomalies =
    mode === "prior_night"
      ? priorNightAnomalies(ctx, relevantSignals)
      : trailingWeekAnomalies(ctx, relevantSignals);

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
