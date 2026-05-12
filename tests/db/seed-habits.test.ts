import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { loadMigrations } from "../../src/db/load-migrations.js";
import { seedHabits } from "../../src/db/seed-habits.js";

interface HabitRow {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly cron_expr: string;
  readonly why_stakes_json: string;
  readonly proof_type: string;
  readonly proof_config_json: string;
  readonly channel_id: string;
  readonly active: number;
  readonly created_at: number;
}

interface CountRow {
  readonly n: number;
}

interface StakesWell {
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
}

interface BodyDataWell {
  readonly signal_mode: string;
  readonly relevant_signals: ReadonlyArray<string>;
  readonly anomaly_check: string;
  readonly framing_template: string;
}

interface PatternWell {
  readonly lookback_days: number;
  readonly trigger_threshold: number;
  readonly framing_template: string;
}

interface WhyStakesJson {
  readonly stakes_well: StakesWell;
  readonly body_data_well: BodyDataWell;
  readonly pattern_well: PatternWell;
}

function getHabit(db: Database.Database, id: string): HabitRow | undefined {
  return db
    .prepare("SELECT * FROM habits WHERE id = ?")
    .get(id) as HabitRow | undefined;
}

function countHabits(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM habits")
    .get() as CountRow;
  return row.n;
}

const DEFAULT_CHANNELS = {
  morningRow: "ch-row",
  strength: "ch-strength",
  windDown: "ch-wind-down",
} as const;

describe("seedHabits()", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(db, loadMigrations());
  });

  afterEach(() => {
    db.close();
  });

  it("inserts exactly three habit rows with stable ids", () => {
    seedHabits(db, DEFAULT_CHANNELS);

    expect(countHabits(db)).toBe(3);
    expect(getHabit(db, "morning-row")).toBeDefined();
    expect(getHabit(db, "strength-mwf")).toBeDefined();
    expect(getHabit(db, "wind-down")).toBeDefined();
  });

  it("seeds morning-row with the design-locked scalar fields", () => {
    seedHabits(db, DEFAULT_CHANNELS);
    const row = getHabit(db, "morning-row");
    if (!row) throw new Error("morning-row not seeded");

    expect(row.id).toBe("morning-row");
    expect(row.domain).toBe("row");
    expect(row.cron_expr).toBe("5 9 * * *");
    expect(row.proof_type).toBe("concept2_api+photo_fallback");
    expect(row.channel_id).toBe("ch-row");
    expect(row.active).toBe(1);
    expect(typeof row.name).toBe("string");
    expect(row.name.length).toBeGreaterThan(0);

    const proofConfig = JSON.parse(row.proof_config_json) as Record<
      string,
      unknown
    >;
    expect(proofConfig).toEqual({
      min_minutes: 10,
      lookup_window_hours: 2,
      fallback_required_at_level: 3,
    });
  });

  it("seeds strength-mwf with the design-locked scalar fields", () => {
    seedHabits(db, DEFAULT_CHANNELS);
    const row = getHabit(db, "strength-mwf");
    if (!row) throw new Error("strength-mwf not seeded");

    expect(row.id).toBe("strength-mwf");
    expect(row.domain).toBe("strength");
    expect(row.cron_expr).toBe("20 18 * * 1,3,5");
    expect(row.proof_type).toBe("training_log_photo");
    expect(row.channel_id).toBe("ch-strength");
    expect(row.active).toBe(1);

    const proofConfig = JSON.parse(row.proof_config_json) as Record<
      string,
      unknown
    >;
    expect(proofConfig).toEqual({
      min_log_entries: 3,
      vision_subject: "training_log",
    });
  });

  it("seeds wind-down with the design-locked scalar fields", () => {
    seedHabits(db, DEFAULT_CHANNELS);
    const row = getHabit(db, "wind-down");
    if (!row) throw new Error("wind-down not seeded");

    expect(row.id).toBe("wind-down");
    expect(row.domain).toBe("wind-down");
    expect(row.cron_expr).toBe("0 22 * * 0-4");
    expect(row.proof_type).toBe("typed_msg+garmin_sleep");
    expect(row.channel_id).toBe("ch-wind-down");
    expect(row.active).toBe(1);

    const proofConfig = JSON.parse(row.proof_config_json) as Record<
      string,
      unknown
    >;
    expect(proofConfig).toEqual({
      stage_a_phrase: "shutting down",
      stage_a_window_min: 15,
      stage_b_threshold: "23:00",
    });
  });

  it("writes why_stakes_json with the locked stakes_well content (all 3 habits identical)", () => {
    seedHabits(db, DEFAULT_CHANNELS);

    for (const id of ["morning-row", "strength-mwf", "wind-down"]) {
      const row = getHabit(db, id);
      if (!row) throw new Error(`${id} not seeded`);

      const parsed = JSON.parse(row.why_stakes_json) as WhyStakesJson;

      expect(parsed.stakes_well.primary).toBe(
        "12 months post T9-T12 compression fracture, recovery stalled"
      );
      expect(parsed.stakes_well.secondary).toBe(
        "Family livelihood depends on Linkware shipping — body has to last the build"
      );
      expect(parsed.stakes_well.tertiary).toBe(
        "Detrained athlete (former top-3 triathlon) trying to restore baseline"
      );
    }
  });

  it("writes why_stakes_json with the locked body_data_well content and per-habit signal_mode", () => {
    seedHabits(db, DEFAULT_CHANNELS);

    const expectedSignals = [
      "sleep_onset_time",
      "rem_minutes",
      "deep_sleep_minutes",
      "hrv",
    ];
    const expectedAnomalyCheck =
      "any signal in bottom 20% of trailing 30-day baseline";
    const expectedTemplate =
      "You slept {total_sleep_minutes}, REM {rem_minutes} (bottom {percentile}%). {habit_name} is the parasympathetic primer for tonight's sleep, not just today.";

    const cases: ReadonlyArray<{ id: string; signalMode: string }> = [
      { id: "morning-row", signalMode: "prior_night" },
      { id: "strength-mwf", signalMode: "prior_night" },
      { id: "wind-down", signalMode: "trailing_week_trend" },
    ];

    for (const { id, signalMode } of cases) {
      const row = getHabit(db, id);
      if (!row) throw new Error(`${id} not seeded`);

      const parsed = JSON.parse(row.why_stakes_json) as WhyStakesJson;
      expect(parsed.body_data_well.signal_mode).toBe(signalMode);
      expect(parsed.body_data_well.relevant_signals).toEqual(expectedSignals);
      expect(parsed.body_data_well.anomaly_check).toBe(expectedAnomalyCheck);
      expect(parsed.body_data_well.framing_template).toBe(expectedTemplate);
    }
  });

  it("writes why_stakes_json with the locked pattern_well content (all 3 habits identical)", () => {
    seedHabits(db, DEFAULT_CHANNELS);

    const expectedTemplate =
      "{count}{ordinal} {weekday} in {timeframe}. There's something about {weekday}. We figure it out now or it becomes the pattern.";

    for (const id of ["morning-row", "strength-mwf", "wind-down"]) {
      const row = getHabit(db, id);
      if (!row) throw new Error(`${id} not seeded`);

      const parsed = JSON.parse(row.why_stakes_json) as WhyStakesJson;
      expect(parsed.pattern_well.lookback_days).toBe(28);
      expect(parsed.pattern_well.trigger_threshold).toBe(3);
      expect(parsed.pattern_well.framing_template).toBe(expectedTemplate);
    }
  });

  it("produces why_stakes_json that parses with all three top-level keys", () => {
    seedHabits(db, DEFAULT_CHANNELS);

    for (const id of ["morning-row", "strength-mwf", "wind-down"]) {
      const row = getHabit(db, id);
      if (!row) throw new Error(`${id} not seeded`);

      const parsed = JSON.parse(row.why_stakes_json) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual([
        "body_data_well",
        "pattern_well",
        "stakes_well",
      ]);
    }
  });

  it("is idempotent on re-run — row count stays at 3, no throw", () => {
    seedHabits(db, DEFAULT_CHANNELS);
    expect(countHabits(db)).toBe(3);

    expect(() => {
      seedHabits(db, DEFAULT_CHANNELS);
    }).not.toThrow();

    expect(countHabits(db)).toBe(3);
  });

  it("uses INSERT OR REPLACE: re-running with different channel_ids updates rows in place", () => {
    seedHabits(db, DEFAULT_CHANNELS);
    expect(getHabit(db, "morning-row")?.channel_id).toBe("ch-row");
    expect(getHabit(db, "strength-mwf")?.channel_id).toBe("ch-strength");
    expect(getHabit(db, "wind-down")?.channel_id).toBe("ch-wind-down");

    seedHabits(db, {
      morningRow: "ch-99",
      strength: "ch-98",
      windDown: "ch-97",
    });

    expect(countHabits(db)).toBe(3);
    expect(getHabit(db, "morning-row")?.channel_id).toBe("ch-99");
    expect(getHabit(db, "strength-mwf")?.channel_id).toBe("ch-98");
    expect(getHabit(db, "wind-down")?.channel_id).toBe("ch-97");
  });

  it("writes created_at as a millisecond epoch integer", () => {
    const before = Date.now();
    seedHabits(db, DEFAULT_CHANNELS);
    const after = Date.now();

    for (const id of ["morning-row", "strength-mwf", "wind-down"]) {
      const row = getHabit(db, id);
      if (!row) throw new Error(`${id} not seeded`);
      expect(Number.isInteger(row.created_at)).toBe(true);
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
    }
  });
});
