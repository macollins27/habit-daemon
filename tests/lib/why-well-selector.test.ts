// Task 26: tests for selectWell — the L3 WHY-well selection orchestration.
//
// selectWell is a pure function: it takes habit + run context, the trailing
// 30-day miss_reasons, the cached sensor_signals, and the last-pattern /
// last-stakes usage stamps, and returns a typed WellSelection that the L3
// habit-checkin verb will weave into its prompt.
//
// Priority chain (per design doc § 3 — "L3 WHY-well selection logic"):
//   1. pattern_well — if pattern_detector(28d).count >= 3
//      AND last_pattern_well_use_at < now() - 14 days
//   2. body_data_well — if body_data_anomaly_detected()
//   3. stakes_well — rotation primary → secondary → tertiary, 7-day dedup
//
// These tests cover each branch in isolation, the cooldown/dedup boundaries,
// the rotation semantics, and the priority interleaving (pattern wins over
// body_data which wins over stakes).
//
// References:
//   - docs/plans/2026-05-12-phase-a-implementation.md § Task 26
//   - docs/plans/2026-05-12-habit-daemon-design.md § 3 (L3 WHY-well selection)
//   - src/lib/why-well-selector.ts

import { describe, it, expect } from "vitest";
import {
  selectWell,
  type MissReason,
  type SensorSignal,
  type WellSelectionContext,
  type WellSelection,
} from "../../src/lib/why-well-selector.js";
import type { HabitContext, RunContext } from "../../src/lib/prompt-builder.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Anchor "now" at a fixed local timestamp so tests are deterministic across
// machines. 2026-05-12 12:00:00 UTC is well inside Phase A.
const NOW = Date.parse("2026-05-12T12:00:00Z");

// ------------------------------------------------------------------------
// Fixture builders
// ------------------------------------------------------------------------

function strengthHabit(): HabitContext {
  return {
    id: "strength-mwf",
    name: "Strength M/W/F",
    domain: "strength",
    cron_expr: "20 18 * * 1,3,5",
    proof_type: "training_log_photo",
    proof_config: {
      min_log_entries: 3,
      vision_subject: "training_log",
    },
    why_stakes: {
      stakes_well: {
        primary: "STAKES_PRIMARY_TEXT",
        secondary: "STAKES_SECONDARY_TEXT",
        tertiary: "STAKES_TERTIARY_TEXT",
      },
      body_data_well: {
        signal_mode: "prior_night",
        relevant_signals: [
          "total_sleep_minutes",
          "rem_minutes",
          "deep_sleep_minutes",
          "hrv",
        ],
        anomaly_check: "any signal in bottom 20% of trailing 30-day baseline",
        framing_template: "BODY_DATA_FRAMING_TEMPLATE",
      },
      pattern_well: {
        lookback_days: 28,
        trigger_threshold: 3,
        framing_template: "PATTERN_FRAMING_TEMPLATE",
      },
    },
  };
}

function windDownHabit(): HabitContext {
  return {
    id: "wind-down",
    name: "Wind-down",
    domain: "sleep",
    cron_expr: "0 22 * * 0-4",
    proof_type: "discord_shutting_down",
    proof_config: {},
    why_stakes: {
      stakes_well: {
        primary: "WIND_PRIMARY",
        secondary: "WIND_SECONDARY",
        tertiary: "WIND_TERTIARY",
      },
      body_data_well: {
        signal_mode: "trailing_week_trend",
        relevant_signals: ["sleep_onset_time", "total_sleep_minutes", "hrv"],
        anomaly_check: "7d avg differs from 30d baseline by threshold",
        framing_template: "WIND_BODY_FRAMING",
      },
      pattern_well: {
        lookback_days: 28,
        trigger_threshold: 3,
        framing_template: "WIND_PATTERN_FRAMING",
      },
    },
  };
}

function run(fireDate = "2026-05-12"): RunContext {
  return {
    id: "run-test-0001",
    fire_date: fireDate,
    current_level: 3,
    status: "pending",
    fired_at: NOW,
    proof_rejection_callout_due: 0,
  };
}

function missReason(opts: {
  id?: string;
  slug: string;
  ageDays: number;
}): MissReason {
  return {
    id: opts.id ?? `mr-${opts.slug}-${opts.ageDays}`,
    habit_id: "strength-mwf",
    run_id: "run-old",
    miss_date: "2026-04-30",
    inferred_specifics: opts.slug,
    classification: null,
    created_at: NOW - opts.ageDays * DAY_MS,
  };
}

function garminSignal(opts: {
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

function isoDateMinusDays(days: number): string {
  const d = new Date(NOW - days * DAY_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function baseCtx(
  overrides: Partial<WellSelectionContext> = {},
): WellSelectionContext {
  return {
    habit: strengthHabit(),
    run: run(),
    now: NOW,
    missReasons30d: [],
    sensorSignals: [],
    lastPatternWellUseMs: null,
    lastStakesWellUse: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------------
// Pattern branch
// ------------------------------------------------------------------------

describe("selectWell — pattern branch", () => {
  it("returns pattern when 3+ same-slug misses exist and pattern has never been used", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:brian", ageDays: 2 }),
        missReason({ slug: "late-gaming-friend:carl", ageDays: 5 }),
        missReason({ slug: "late-gaming-friend:dave", ageDays: 9 }),
      ],
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("pattern");
    if (result.well === "pattern") {
      expect(result.slugPrefix).toBe("late-gaming-friend");
      expect(result.count).toBe(3);
      expect(result.framingTemplate).toBe("PATTERN_FRAMING_TEMPLATE");
      expect(result.exemplarSpecifics).toContain("late-gaming-friend");
    }
  });

  it("returns pattern when last pattern use was 15 days ago (cooldown expired)", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 4 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 7 }),
      ],
      lastPatternWellUseMs: NOW - 15 * DAY_MS,
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("pattern");
  });

  it("does NOT return pattern when last pattern use was 13 days ago (cooldown active)", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 4 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 7 }),
      ],
      lastPatternWellUseMs: NOW - 13 * DAY_MS,
      lastStakesWellUse: null,
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("pattern");
    // Falls through to stakes (no body_data anomaly, no prior stakes use)
    expect(result.well).toBe("stakes");
  });

  it("does NOT return pattern when only 2 same-slug misses are present", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 4 }),
      ],
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("pattern");
  });

  it("does NOT return pattern when 3 entries exist but no single slug has count >= 3", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "work-emergency:zoom", ageDays: 4 }),
        missReason({ slug: "travel:redeye", ageDays: 7 }),
      ],
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("pattern");
  });

  it("excludes miss_reasons older than the 28-day lookback window", () => {
    const ctx = baseCtx({
      missReasons30d: [
        // Two within window, one outside → only 2 in-window → threshold not met.
        missReason({ slug: "late-gaming-friend:a", ageDays: 2 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 10 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 29 }),
      ],
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("pattern");
  });

  it("picks the largest slug group when multiple groups meet the threshold", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "small:a", ageDays: 1 }),
        missReason({ slug: "small:b", ageDays: 2 }),
        missReason({ slug: "small:c", ageDays: 3 }),
        missReason({ slug: "big:a", ageDays: 4 }),
        missReason({ slug: "big:b", ageDays: 5 }),
        missReason({ slug: "big:c", ageDays: 6 }),
        missReason({ slug: "big:d", ageDays: 7 }),
      ],
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("pattern");
    if (result.well === "pattern") {
      expect(result.slugPrefix).toBe("big");
      expect(result.count).toBe(4);
    }
  });
});

// ------------------------------------------------------------------------
// Body-data branch (prior_night mode)
// ------------------------------------------------------------------------

describe("selectWell — body_data branch (prior_night)", () => {
  // fire_date = "2026-05-12" → "prior night" = "2026-05-11" = isoDateMinusDays(1).
  // Baseline therefore needs to start at isoDateMinusDays(2) so prior-night
  // and baseline do not collide on the same payload_date.
  it("returns body_data when prior-night hrv is in the bottom 20% of trailing 30d", () => {
    // Baseline of 30 normal nights, oldest is 31 days ago, newest is 2 days ago.
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const priorNight = garminSignal({
      date: isoDateMinusDays(1),
      ageDays: 1,
      // Anomalously low hrv compared to baseline.
      sleep: {
        sleep_onset_time: "23:00",
        total_sleep_minutes: 420,
        rem_minutes: 90,
        deep_sleep_minutes: 75,
        hrv: 25,
      },
    });
    const ctx = baseCtx({
      sensorSignals: [priorNight, ...baseline],
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("body_data");
    if (result.well === "body_data") {
      expect(result.anomalousSignals).toContain("hrv");
      expect(result.framingTemplate).toBe("BODY_DATA_FRAMING_TEMPLATE");
    }
  });

  it("does NOT return body_data when prior-night signals are within normal range", () => {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const priorNight = garminSignal({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: {
        sleep_onset_time: "23:00",
        total_sleep_minutes: 425,
        rem_minutes: 92,
        deep_sleep_minutes: 78,
        hrv: 68,
      },
    });
    const ctx = baseCtx({
      sensorSignals: [priorNight, ...baseline],
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("body_data");
    expect(result.well).toBe("stakes");
  });

  it("does NOT return body_data when no prior-night signal is present", () => {
    // Baseline only — no signal at the prior-night date.
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const ctx = baseCtx({
      sensorSignals: baseline,
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("body_data");
  });
});

// ------------------------------------------------------------------------
// Body-data branch (trailing_week_trend mode)
// ------------------------------------------------------------------------

describe("selectWell — body_data branch (trailing_week_trend)", () => {
  it("returns body_data when last 7d hrv avg differs from prior 30d baseline > 10%", () => {
    // 30-day baseline avg hrv = 65. Last 7 days drop to 50 → ~23% delta.
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 50,
          },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const ctx = baseCtx({
      habit: windDownHabit(),
      sensorSignals: signals,
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("body_data");
    if (result.well === "body_data") {
      expect(result.anomalousSignals).toContain("hrv");
    }
  });

  it("does NOT return body_data when 7d vs 30d delta is small (< 10%)", () => {
    const signals: SensorSignal[] = [];
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 64,
          },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const ctx = baseCtx({
      habit: windDownHabit(),
      sensorSignals: signals,
    });
    const result = selectWell(ctx);
    expect(result.well).not.toBe("body_data");
  });

  it("returns body_data when 7d sleep_onset_time slips > 30 min vs baseline", () => {
    const signals: SensorSignal[] = [];
    // Last 7 nights: onset 23:45 (1425 min). Prior 23 nights: onset 23:00 (1380 min). Delta = 45 min.
    for (let i = 1; i <= 7; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:45",
            total_sleep_minutes: 380,
            rem_minutes: 80,
            deep_sleep_minutes: 70,
            hrv: 65,
          },
        }),
      );
    }
    for (let i = 8; i <= 30; i++) {
      signals.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const ctx = baseCtx({
      habit: windDownHabit(),
      sensorSignals: signals,
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("body_data");
    if (result.well === "body_data") {
      expect(result.anomalousSignals).toContain("sleep_onset_time");
    }
  });
});

// ------------------------------------------------------------------------
// Stakes branch
// ------------------------------------------------------------------------

describe("selectWell — stakes branch", () => {
  it("returns primary when stakes have never been used", () => {
    const ctx = baseCtx();
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("primary");
      expect(result.text).toBe("STAKES_PRIMARY_TEXT");
    }
  });

  it("rotates primary → secondary after 7+ days", () => {
    const ctx = baseCtx({
      lastStakesWellUse: {
        stake: "primary",
        usedAtMs: NOW - 7 * DAY_MS,
      },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("secondary");
      expect(result.text).toBe("STAKES_SECONDARY_TEXT");
    }
  });

  it("rotates secondary → tertiary after 7+ days", () => {
    const ctx = baseCtx({
      lastStakesWellUse: {
        stake: "secondary",
        usedAtMs: NOW - 7 * DAY_MS,
      },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("tertiary");
      expect(result.text).toBe("STAKES_TERTIARY_TEXT");
    }
  });

  it("wraps tertiary → primary after 7+ days", () => {
    const ctx = baseCtx({
      lastStakesWellUse: {
        stake: "tertiary",
        usedAtMs: NOW - 7 * DAY_MS,
      },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("primary");
      expect(result.text).toBe("STAKES_PRIMARY_TEXT");
    }
  });

  it("dedups same-day re-use (returns the same stake)", () => {
    const ctx = baseCtx({
      lastStakesWellUse: {
        stake: "primary",
        usedAtMs: NOW,
      },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("primary");
    }
  });

  it("dedups within the 7-day window (6 days ago → same stake)", () => {
    const ctx = baseCtx({
      lastStakesWellUse: {
        stake: "secondary",
        usedAtMs: NOW - 6 * DAY_MS,
      },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("secondary");
    }
  });
});

// ------------------------------------------------------------------------
// Priority chain
// ------------------------------------------------------------------------

describe("selectWell — priority chain", () => {
  function priorNightAnomalyFixture(): readonly SensorSignal[] {
    const baseline: SensorSignal[] = [];
    for (let i = 2; i <= 31; i++) {
      baseline.push(
        garminSignal({
          date: isoDateMinusDays(i),
          ageDays: i,
          sleep: {
            sleep_onset_time: "23:00",
            total_sleep_minutes: 420,
            rem_minutes: 90,
            deep_sleep_minutes: 75,
            hrv: 65,
          },
        }),
      );
    }
    const priorNight = garminSignal({
      date: isoDateMinusDays(1),
      ageDays: 1,
      sleep: {
        sleep_onset_time: "23:00",
        total_sleep_minutes: 420,
        rem_minutes: 90,
        deep_sleep_minutes: 75,
        hrv: 25,
      },
    });
    return [priorNight, ...baseline];
  }

  it("pattern wins over body_data when both match", () => {
    const ctx = baseCtx({
      missReasons30d: [
        missReason({ slug: "late-gaming-friend:a", ageDays: 1 }),
        missReason({ slug: "late-gaming-friend:b", ageDays: 4 }),
        missReason({ slug: "late-gaming-friend:c", ageDays: 7 }),
      ],
      sensorSignals: priorNightAnomalyFixture(),
    });
    const result: WellSelection = selectWell(ctx);
    expect(result.well).toBe("pattern");
  });

  it("body_data wins over stakes when pattern is absent and anomaly present", () => {
    const ctx = baseCtx({
      sensorSignals: priorNightAnomalyFixture(),
      lastStakesWellUse: { stake: "primary", usedAtMs: NOW - 10 * DAY_MS },
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("body_data");
  });

  it("stakes is the default when neither pattern nor body_data matches", () => {
    const ctx = baseCtx({
      missReasons30d: [],
      sensorSignals: [],
    });
    const result = selectWell(ctx);
    expect(result.well).toBe("stakes");
    if (result.well === "stakes") {
      expect(result.stake).toBe("primary");
    }
  });
});
