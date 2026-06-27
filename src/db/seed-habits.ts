/**
 * Seed the three Phase A habits with their locked `why_stakes_json` content.
 *
 * Source of truth: docs/plans/2026-05-12-habit-daemon-design.md § 2. The
 * `stakes_well`, `body_data_well`, and `pattern_well` strings are reproduced
 * verbatim from the design — they are intentionally personal founder context
 * (T9-T12 compression fracture recovery, Linkware build, detrained-athlete
 * baseline) and must not be paraphrased or "improved" without first amending
 * the design doc.
 *
 * Channel ids are passed in by the caller. Tests pass placeholders; production
 * wiring (later task) will read them from `DISCORD_CHANNEL_*` env vars and
 * inject them here. The seed function never touches `process.env` directly.
 *
 * Idempotent: re-running calls `INSERT OR REPLACE` keyed on `habits.id`, so
 * the seed is safe to run on every daemon startup. Re-running with different
 * channel ids updates the rows in place.
 *
 * Forward issue (Phase B): `body_data_well.framing_template` is shared across
 * all three habits but only matches the `prior_night` signal_mode semantically
 * (it interpolates `{total_sleep_minutes}`, a last-night concept). For
 * `wind-down` the signal_mode is `trailing_week_trend` and the template is
 * technically off. The design doc does not yet specify a separate
 * trailing-week template; Phase B will customize the template per
 * signal_mode when body_data_well actually fires for wind-down. For Phase A
 * we use the design's template verbatim for all three habits.
 */

import type Database from "better-sqlite3";

export interface HabitChannelIds {
  readonly morningRow: string;
  readonly strength: string;
  readonly windDown: string;
}

interface StakesWell {
  readonly primary: string;
  readonly secondary: string;
  readonly tertiary: string;
}

type SignalMode = "prior_night" | "trailing_week_trend";

interface BodyDataWell {
  readonly signal_mode: SignalMode;
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

interface MorningRowProofConfig {
  readonly min_minutes: number;
  readonly lookup_window_hours: number;
  readonly fallback_required_at_level: number;
}

interface StrengthProofConfig {
  readonly min_log_entries: number;
  readonly vision_subject: string;
}

interface WindDownProofConfig {
  readonly stage_a_phrase: string;
  readonly stage_a_window_min: number;
  readonly stage_b_threshold: string;
}

type ProofConfig =
  | MorningRowProofConfig
  | StrengthProofConfig
  | WindDownProofConfig;

interface HabitSeed {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly cronExpr: string;
  readonly whyStakes: WhyStakesJson;
  readonly proofType: string;
  readonly proofConfig: ProofConfig;
  readonly channelId: string;
}

// Verbatim from design § 2. Identical across all three habits.
const STAKES_WELL: StakesWell = {
  primary:
    "12 months post T9-T12 compression fracture, recovery stalled",
  secondary:
    "Family livelihood depends on Linkware shipping — body has to last the build",
  tertiary:
    "Detrained athlete (former top-3 triathlon) trying to restore baseline",
};

// Verbatim from design § 2. signal_mode varies per habit; everything else
// is identical across all three.
const BODY_DATA_RELEVANT_SIGNALS: ReadonlyArray<string> = [
  "sleep_onset_time",
  "rem_minutes",
  "deep_sleep_minutes",
  "hrv",
];

const BODY_DATA_ANOMALY_CHECK =
  "any signal in bottom 20% of trailing 30-day baseline";

const BODY_DATA_FRAMING_TEMPLATE =
  "You slept {total_sleep_minutes}, REM {rem_minutes} (bottom {percentile}%). {habit_name} is the parasympathetic primer for tonight's sleep, not just today.";

// Verbatim from design § 2. Identical across all three habits.
const PATTERN_WELL: PatternWell = {
  lookback_days: 28,
  trigger_threshold: 3,
  framing_template:
    "{count}{ordinal} {weekday} in {timeframe}. There's something about {weekday}. We figure it out now or it becomes the pattern.",
};

function buildWhyStakes(signalMode: SignalMode): WhyStakesJson {
  return {
    stakes_well: STAKES_WELL,
    body_data_well: {
      signal_mode: signalMode,
      relevant_signals: BODY_DATA_RELEVANT_SIGNALS,
      anomaly_check: BODY_DATA_ANOMALY_CHECK,
      framing_template: BODY_DATA_FRAMING_TEMPLATE,
    },
    pattern_well: PATTERN_WELL,
  };
}

function buildSeeds(channelIds: HabitChannelIds): ReadonlyArray<HabitSeed> {
  return [
    {
      id: "morning-row",
      name: "Morning row",
      domain: "row",
      cronExpr: "5 9 * * *",
      whyStakes: buildWhyStakes("prior_night"),
      proofType: "concept2_api+photo_fallback",
      proofConfig: {
        min_minutes: 10,
        lookup_window_hours: 2,
        fallback_required_at_level: 3,
      },
      channelId: channelIds.morningRow,
    },
    {
      id: "strength-mwf",
      name: "Strength M/W/F",
      domain: "strength",
      cronExpr: "20 18 * * 1,3,5",
      whyStakes: buildWhyStakes("prior_night"),
      proofType: "training_log_photo",
      proofConfig: {
        min_log_entries: 3,
        vision_subject: "training_log",
      },
      channelId: channelIds.strength,
    },
    {
      id: "wind-down",
      name: "Wind-down",
      domain: "wind-down",
      cronExpr: "0 22 * * 0-4",
      whyStakes: buildWhyStakes("trailing_week_trend"),
      proofType: "typed_msg+garmin_sleep",
      proofConfig: {
        stage_a_phrase: "shutting down",
        stage_a_window_min: 15,
        stage_b_threshold: "23:00",
      },
      channelId: channelIds.windDown,
    },
  ];
}

/**
 * Insert (or replace) the three locked Phase A habit rows.
 *
 * Wraps the three upserts in a single transaction so partial seed state is
 * impossible if any single row's INSERT fails.
 */
export function seedHabits(
  db: Database.Database,
  channelIds: HabitChannelIds
): void {
  const seeds = buildSeeds(channelIds);

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO habits (
      id, name, domain, cron_expr, why_stakes_json,
      proof_type, proof_config_json, channel_id, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const seedTx = db.transaction((rows: ReadonlyArray<HabitSeed>) => {
    const createdAt = Date.now();
    for (const seed of rows) {
      upsert.run(
        seed.id,
        seed.name,
        seed.domain,
        seed.cronExpr,
        JSON.stringify(seed.whyStakes),
        seed.proofType,
        JSON.stringify(seed.proofConfig),
        seed.channelId,
        1,
        createdAt
      );
    }
  });

  seedTx(seeds);
}

/**
 * Seed (or replace) the daily-alignment habit row. Kept SEPARATE from
 * `seedHabits` and called by bootstrap ONLY when SMS is enabled, so a default
 * deployment that hasn't opted into the text-escalation feature gets exactly
 * the original three habits and no behaviour change.
 *
 * Unlike the sensor habits, alignment uses neither why-wells (its escalation
 * copy is fixed, not Claude-generated) nor a proof_config (its proof is judged
 * by `verifyAlignment`), so both JSON columns are empty objects. `domain` is
 * "alignment" — the sentinel the dispatch switch uses to route escalations to
 * `runAlignmentCheckin` and that is absent from `DOMAIN_TO_CHANNEL`, so it
 * delivers via the raw `channel_id` snowflake.
 *
 * Idempotent: INSERT OR REPLACE keyed on the fixed id "daily-alignment".
 */
export function seedAlignmentHabit(
  db: Database.Database,
  opts: { readonly channelId: string; readonly cronExpr: string },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO habits (
      id, name, domain, cron_expr, why_stakes_json,
      proof_type, proof_config_json, channel_id, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "daily-alignment",
    "Daily alignment",
    "alignment",
    opts.cronExpr,
    "{}",
    "alignment_text",
    "{}",
    opts.channelId,
    1,
    Date.now(),
  );
}
