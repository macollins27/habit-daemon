// Task 28: extracted L3 body_data anomaly detection.
//
// Two pure functions consumed by the WHY-well selector (Task 26) and the L3
// habit-checkin verb (Task 28). The body_data_well schema in
// docs/plans/2026-05-12-habit-daemon-design.md § 2 defines two `signal_mode`
// variants:
//
//   - "prior_night" (row + strength): a single sleep night dispositive — flag
//     when any relevant signal falls in the bottom 20% of the trailing 30-day
//     baseline.
//   - "trailing_week_trend" (wind-down): a one-week rolling average vs the
//     prior 23-day baseline — flag when the delta exceeds the per-signal
//     threshold (30 minutes ABSOLUTE for time-of-day signals, 10% RELATIVE
//     for numeric signals).
//
// Phase A keeps the heuristics simple and deterministic so we can drive the
// L3 body_data prompt without an ML loop. The thresholds match Task 26
// exactly — this module is a clean extraction of the private helpers that
// previously lived inside `why-well-selector.ts`.
//
// Both functions are I/O-free; the caller passes already-loaded Garmin rows
// and the relevant-signal list from `habit.why_stakes.body_data_well`.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 28
//   - docs/plans/2026-05-12-habit-daemon-design.md § 2 (body_data_well schema)
//   - src/lib/why-well-selector.ts (consumer)
//   - src/orchestrate/habit-checkin.ts (downstream consumer via the selector)

import type { SensorSignal } from "./why-well-selector.js";

// ------------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------------

export interface PriorNightAnomalyResult {
  readonly anomalous: boolean;
  readonly anomalousSignals: readonly string[];
}

export interface TrailingWeekAnomalyResult {
  readonly anomalous: boolean;
  readonly anomalousSignals: readonly string[];
}

// ------------------------------------------------------------------------
// Constants — must stay byte-for-byte aligned with Task 26 heuristics.
// ------------------------------------------------------------------------

const DEFAULT_BASELINE_WINDOW_DAYS = 30;
const PRIOR_NIGHT_PERCENTILE = 0.2;
const PRIOR_NIGHT_MIN_BASELINE = 5;
const TRAILING_WEEK_MIN_TOTAL_ROWS = 14;
const TRAILING_WEEK_RECENT_WINDOW = 7;

const TIME_OF_DAY_DELTA_MIN_THRESHOLD = 30;
const NUMERIC_DELTA_RATIO_THRESHOLD = 0.1; // 10%

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

// ------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------

/**
 * Detect a prior-night anomaly: returns `anomalous: true` when ANY of the
 * named `relevantSignals` on the row matching `priorDate` sits below the
 * 20th-percentile threshold of the trailing-30-day baseline (or whatever
 * `baselineWindowDays` overrides the default).
 *
 * Callers should pre-filter `garminSignals` to source === 'garmin'. The
 * function does NOT re-filter — it trusts the caller, mirroring the
 * Task 26 contract.
 *
 * Defensive behaviour:
 *   - Missing prior-night row → `{ anomalous: false, anomalousSignals: [] }`.
 *   - Baseline with < 5 usable values for a signal → that signal is skipped
 *     (the percentile estimate would be unreliable).
 *   - Malformed payload JSON or wrong-typed fields are ignored.
 */
export function detectPriorNightAnomaly(
  garminSignals: readonly SensorSignal[],
  relevantSignals: readonly string[],
  priorDate: string,
  baselineWindowDays: number = DEFAULT_BASELINE_WINDOW_DAYS,
): PriorNightAnomalyResult {
  // The `baselineWindowDays` argument is reserved for future tuning; Task 28
  // uses the full passed-in baseline (Task 26 filtered to 30 days at the
  // SQL layer). Referencing it here keeps the public contract stable.
  void baselineWindowDays;

  const priorSignal = garminSignals.find((s) => s.payload_date === priorDate);
  if (!priorSignal) return { anomalous: false, anomalousSignals: [] };

  const priorPayload = parsePayload(priorSignal);
  if (!priorPayload) return { anomalous: false, anomalousSignals: [] };

  // Trailing 30-day baseline = all Garmin signals strictly before
  // priorDate (exclusive), excluding the prior-night row itself.
  const baseline = garminSignals.filter(
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
    if (baselineVals.length < PRIOR_NIGHT_MIN_BASELINE) continue;

    baselineVals.sort((a, b) => a - b);
    // 20th-percentile threshold using nearest-rank (no interpolation).
    const idx = Math.max(
      0,
      Math.floor(PRIOR_NIGHT_PERCENTILE * baselineVals.length) - 1,
    );
    const threshold = baselineVals[idx];
    if (typeof threshold !== "number") continue;

    if (priorVal < threshold) {
      anomalies.push(sig);
    }
  }

  return { anomalous: anomalies.length > 0, anomalousSignals: anomalies };
}

/**
 * Detect a trailing-week anomaly: compares the 7 most-recent Garmin rows'
 * per-signal averages against the next 23 rows' per-signal averages. Returns
 * `anomalous: true` when any signal's delta exceeds the threshold (30
 * minutes ABSOLUTE for time-of-day signals, 10% RELATIVE for numeric).
 *
 * Defensive behaviour:
 *   - < 14 total Garmin rows → `{ anomalous: false, anomalousSignals: [] }`.
 *   - Baseline (rows 8..30) with fewer than 5 usable rows → not anomalous.
 *   - Per-signal: if either window has zero usable values, that signal is
 *     skipped.
 */
export function detectTrailingWeekAnomaly(
  garminSignals: readonly SensorSignal[],
  relevantSignals: readonly string[],
  baselineWindowDays: number = DEFAULT_BASELINE_WINDOW_DAYS,
): TrailingWeekAnomalyResult {
  void baselineWindowDays;

  const sorted = [...garminSignals].sort((a, b) =>
    b.payload_date.localeCompare(a.payload_date),
  ); // newest first

  if (sorted.length < TRAILING_WEEK_MIN_TOTAL_ROWS) {
    return { anomalous: false, anomalousSignals: [] };
  }

  const last7 = sorted.slice(0, TRAILING_WEEK_RECENT_WINDOW);
  const prior = sorted.slice(TRAILING_WEEK_RECENT_WINDOW, 30);
  if (prior.length < 5) return { anomalous: false, anomalousSignals: [] };

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

  return { anomalous: anomalies.length > 0, anomalousSignals: anomalies };
}
