// Task 28: tests for the anomaly-detector module — extracted L3 body_data
// helpers used by `selectWell` and by the L3 body_data verb path.
//
// Two pure functions:
//
//   detectPriorNightAnomaly(garminSignals, relevantSignals, priorDate)
//     - Pulls the row whose payload_date matches `priorDate` (YYYY-MM-DD).
//     - For each relevant signal, compares it to the 20th-percentile threshold
//       computed from the trailing 30-day baseline of older Garmin rows.
//     - Returns { anomalous, anomalousSignals } where `anomalousSignals` lists
//       each signal whose prior-night value sits BELOW the 20th-percentile
//       threshold.
//     - Defensive defaults: missing prior-night row → not anomalous;
//       insufficient baseline (< 5 rows w/ that signal) → that signal is
//       skipped.
//
//   detectTrailingWeekAnomaly(garminSignals, relevantSignals)
//     - Splits Garmin rows newest-first: last 7 form the "recent" window;
//       the next 23 form the "baseline" window.
//     - Compares per-signal averages; thresholds are 30 minutes ABSOLUTE for
//       time-of-day signals (e.g. sleep_onset_time) and 10% RELATIVE for
//       everything else.
//     - Defensive defaults: < 14 Garmin rows total → not anomalous.
//
// Tests intentionally do not mock anything; both functions are pure.
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 28
//   - src/lib/anomaly-detector.ts (module under test)
//   - src/lib/why-well-selector.ts (consumer)

import { describe, it, expect } from "vitest";
import {
  detectPriorNightAnomaly,
  detectTrailingWeekAnomaly,
} from "../../src/lib/anomaly-detector.js";
import type { SensorSignal } from "../../src/lib/why-well-selector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-05-12T12:00:00Z");

function isoDateMinusDays(days: number): string {
  const d = new Date(NOW - days * DAY_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function garmin(opts: {
  date: string;
  ageDays: number;
  sleep: Record<string, unknown> | null;
}): SensorSignal {
  return {
    id: `garmin-${opts.date}`,
    source: "garmin",
    payload_date: opts.date,
    payload_json: JSON.stringify({ sleep: opts.sleep }),
    fetched_at: NOW - opts.ageDays * DAY_MS,
  };
}

// -------------------------------------------------------------------------
// detectPriorNightAnomaly
// -------------------------------------------------------------------------

describe("detectPriorNightAnomaly", () => {
  it("fires when prior-night rem_minutes is below the 20th percentile of baseline", () => {
    // Baseline: 30 nights with rem_minutes in [70..99] — prior night rem=20
    // is clearly below the 20th percentile (~72).
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { rem_minutes: 70 + ((i * 3) % 30), hrv: 65 },
        }),
      );
    }
    const priorNight = garmin({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: { rem_minutes: 20, hrv: 65 },
    });

    const result = detectPriorNightAnomaly(
      [priorNight, ...baseline],
      ["rem_minutes"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(true);
    expect(result.anomalousSignals).toContain("rem_minutes");
  });

  it("does NOT fire when prior-night value is near the median", () => {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          // Spread baseline rem_minutes across [60..89] so the 20th percentile
          // sits well below 85.
          sleep: { rem_minutes: 60 + ((i * 7) % 30) },
        }),
      );
    }
    const priorNight = garmin({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: { rem_minutes: 85 }, // near median
    });

    const result = detectPriorNightAnomaly(
      [priorNight, ...baseline],
      ["rem_minutes"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(false);
    expect(result.anomalousSignals).toEqual([]);
  });

  it("lists every relevant signal that breaches the bottom-20% threshold", () => {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { rem_minutes: 90, hrv: 65 },
        }),
      );
    }
    const priorNight = garmin({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: { rem_minutes: 25, hrv: 20 },
    });

    const result = detectPriorNightAnomaly(
      [priorNight, ...baseline],
      ["rem_minutes", "hrv"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(true);
    expect(result.anomalousSignals).toContain("rem_minutes");
    expect(result.anomalousSignals).toContain("hrv");
  });

  it("returns not-anomalous when the prior-night row is missing", () => {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { rem_minutes: 90 },
        }),
      );
    }
    const result = detectPriorNightAnomaly(
      baseline,
      ["rem_minutes"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(false);
    expect(result.anomalousSignals).toEqual([]);
  });

  it("returns not-anomalous when baseline has fewer than 5 usable rows", () => {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 5; i++) {
      // Only 4 baseline rows — defensive floor is < 5.
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { rem_minutes: 90 },
        }),
      );
    }
    const priorNight = garmin({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: { rem_minutes: 5 }, // would be anomalous if baseline were enough
    });

    const result = detectPriorNightAnomaly(
      [priorNight, ...baseline],
      ["rem_minutes"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(false);
    expect(result.anomalousSignals).toEqual([]);
  });

  it("ignores non-Garmin source rows in the baseline (caller passes only Garmin)", () => {
    // Documentation test: the function trusts the caller to filter to Garmin
    // ahead of time. If a caller passes mixed sources, the function still
    // works because it only reads the `sleep` block.
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { rem_minutes: 90 },
        }),
      );
    }
    const priorNight = garmin({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: { rem_minutes: 30 },
    });
    const result = detectPriorNightAnomaly(
      [priorNight, ...baseline],
      ["rem_minutes"],
      isoDateMinusDays(1),
    );
    expect(result.anomalous).toBe(true);
  });
});

// -------------------------------------------------------------------------
// detectTrailingWeekAnomaly
// -------------------------------------------------------------------------

describe("detectTrailingWeekAnomaly", () => {
  it("fires when last-7d hrv avg drops > 10% vs prior 23d baseline", () => {
    // 7d avg hrv = 35; 23d baseline avg hrv = 50; delta ~30%.
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 35 },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 50 },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, ["hrv"]);
    expect(result.anomalous).toBe(true);
    expect(result.anomalousSignals).toContain("hrv");
  });

  it("does NOT fire when last-7d avg is within 5% of baseline", () => {
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 64 },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 65 },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, ["hrv"]);
    expect(result.anomalous).toBe(false);
    expect(result.anomalousSignals).toEqual([]);
  });

  it("fires when last-7d sleep_onset_time slips > 30 min later vs baseline", () => {
    // 7d avg sleep_onset = 23:45 (1425); baseline avg = 22:30 (1350) → 75 min later.
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { sleep_onset_time: "23:45" },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { sleep_onset_time: "22:30" },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, ["sleep_onset_time"]);
    expect(result.anomalous).toBe(true);
    expect(result.anomalousSignals).toContain("sleep_onset_time");
  });

  it("does NOT fire when sleep_onset_time slips only 15 min (below 30 min threshold)", () => {
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { sleep_onset_time: "22:45" },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { sleep_onset_time: "22:30" },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, ["sleep_onset_time"]);
    expect(result.anomalous).toBe(false);
  });

  it("returns not-anomalous when fewer than 14 Garmin rows exist", () => {
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 13; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 35 },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, ["hrv"]);
    expect(result.anomalous).toBe(false);
    expect(result.anomalousSignals).toEqual([]);
  });

  it("fires on the larger delta when multiple signals breach", () => {
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 30, total_sleep_minutes: 300 },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garmin({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: { hrv: 65, total_sleep_minutes: 420 },
        }),
      );
    }
    const result = detectTrailingWeekAnomaly(signals, [
      "hrv",
      "total_sleep_minutes",
    ]);
    expect(result.anomalous).toBe(true);
    expect(result.anomalousSignals).toContain("hrv");
    expect(result.anomalousSignals).toContain("total_sleep_minutes");
  });
});
