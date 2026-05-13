// Task 1.1 / 1.2: Reconcile pending habit runs against external sensor signals.
//
// This orchestrator closes habit_runs that are still in a pending state when
// the underlying sensor data (Concept2, Garmin) shows up after the daemon
// has already prompted (or stopped prompting) the user. Without it, the
// daemon nags the user after they have already completed the activity.
//
// Phase 1 wiring is layered across follow-up tasks:
//   - 1.2: Concept2 sync + run completion logic (this task)
//   - 1.3: Garmin sync + run completion logic
//   - 1.4: idempotency (skip already-resolved runs, no duplicate posts)
//   - 1.5: cron wiring (`*/2 * * * *`) and production integration
//
// Production wiring (Task 1.5) is responsible for resolving `"wins"` (a
// channel-name keyword) and the per-habit `channel_id` (a Discord
// snowflake) when calling `postCompletion`. This file just emits the two
// channel ids verbatim — that asymmetry is intentional and matches the
// `postToChannel` pattern used elsewhere.

import type Database from "better-sqlite3";
import type { SessionStore } from "../daemon/session-store.js";
import type { Concept2Result } from "../lib/concept2-adapter.js";
import { findQualifyingSession } from "./verify-proof-internals.js";
import { ESCALATION_FOLLOW_UP_CONTENT } from "./habit-checkin.js";

// -----------------------------------------------------------------------------
// Public surface (pinned in Task 1.1).
// -----------------------------------------------------------------------------

export interface ReconcileResult {
  readonly attempted: number;
  readonly completed: number;
  readonly stillPending: number;
}

export interface ReconcileOptions {
  readonly sessionStore: SessionStore;
  readonly now: number;
  /**
   * Refresh the Concept2 cache for the run's date. The wrapper MUST cause
   * `sensor_signals` to be keyed by the run's local `fire_date` — the
   * reconciler later reads `sensor_signals` using that local-date key.
   *
   * The underlying adapter (`src/lib/concept2-adapter.ts:266 (toIsoDate)`)
   * keys by UTC date. The wrapper must therefore translate `opts.date` to
   * the local YYYY-MM-DD (see `localDateString` in this file) before
   * calling the adapter, or the late-evening east-of-UTC case will miss
   * freshly-synced data. See ADR 0001 for the local-time convention.
   */
  readonly concept2Sync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  /**
   * Refresh the Garmin cache for the run's date. Same TZ contract as
   * `concept2Sync`: the wrapper MUST cause `sensor_signals` to be keyed
   * by the run's local `fire_date`. If the underlying adapter keys by
   * UTC (cf. `src/lib/concept2-adapter.ts:266 (toIsoDate)`), translate
   * via `localDateString` before calling the adapter. See ADR 0001.
   */
  readonly garminSync: (opts: {
    habitId: string;
    runId: string;
    date: Date;
  }) => Promise<void>;
  readonly postCompletion: (opts: {
    channelId: string;
    runId: string;
    summary: string;
  }) => Promise<void>;
}

// -----------------------------------------------------------------------------
// Internal helpers.
// -----------------------------------------------------------------------------

// YYYY-MM-DD in process local time. Matches the daemon's `fire_date`
// writer (ADR 0001: cron expressions are interpreted in local time).
// Inlined here rather than imported from `discord-adapter.ts` because the
// helper is private to four other modules already (bootstrap.ts,
// discord-adapter.ts, evaluate-stage-b.ts, habit-checkin.ts); centralising
// would be a separate refactor. See task report for rationale.
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface PendingRunRow {
  readonly id: string;
  readonly habit_id: string;
  readonly fire_date: string;
  readonly status: string;
  readonly channel_id: string;
  readonly proof_type: string;
  readonly proof_config_json: string;
  // Phase 6.2: when non-null, the reconciler posts a brief follow-up to the
  // source channel after autonomous closure so the orphaned escalation gets
  // closure pointing at the #wins summary.
  readonly last_escalation_message_id: string | null;
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

interface WindDownProofConfig {
  readonly stage_b_threshold: string;
}

interface GarminSleepPayload {
  readonly sleep: {
    readonly sleep_onset_time: string | null;
  } | null;
}

/**
 * Loads runs that the reconciler may close out.
 *
 * Includes both `status='pending'` (Concept2 morning-row + wind-down
 * not-yet-typed) AND `status='partial'` (wind-down typed-msg-confirmed,
 * awaiting Garmin onset). Each per-proof-type branch is responsible for
 * filtering rows it does not own. See ADR Task 1.3.
 */
function loadPendingRuns(
  db: Database.Database,
  today: string,
): readonly PendingRunRow[] {
  return db
    .prepare(
      `SELECT r.id           AS id,
              r.habit_id     AS habit_id,
              r.fire_date    AS fire_date,
              r.status       AS status,
              h.channel_id   AS channel_id,
              h.proof_type   AS proof_type,
              h.proof_config_json AS proof_config_json,
              r.last_escalation_message_id AS last_escalation_message_id
         FROM habit_runs r
         JOIN habits h ON h.id = r.habit_id
        WHERE r.status IN ('pending','partial')
          AND r.fire_date = ?`,
    )
    .all(today) as readonly PendingRunRow[];
}

function loadCachedConcept2Results(
  db: Database.Database,
  fireDate: string,
): readonly Concept2Result[] {
  const row = db
    .prepare(
      `SELECT payload_json
         FROM sensor_signals
        WHERE source = 'concept2' AND payload_date = ?`,
    )
    .get(fireDate) as SensorPayloadRow | undefined;
  if (row === undefined) {
    return [];
  }
  const parsed = JSON.parse(row.payload_json) as Concept2Payload;
  return parsed.results;
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

function parseWindDownConfig(
  json: string,
  habitId: string,
): WindDownProofConfig {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const threshold = parsed.stage_b_threshold;
  if (typeof threshold !== "string") {
    throw new Error(
      `habit ${habitId} proof_config_json missing stage_b_threshold string`,
    );
  }
  return { stage_b_threshold: threshold };
}

/**
 * Extract HH:MM from an ISO-ish `sleep_onset_time` string
 * (e.g. "2026-05-12T22:30:00", with or without TZ suffix). Returns
 * undefined when the string doesn't match. Mirrors `extractHHMM` in
 * `evaluate-stage-b.ts:185-189` — inlined to keep the reconciler
 * self-contained (the duplication is one regex; centralisation would
 * be a separate refactor).
 */
function extractHHMM(onset: string): string | undefined {
  const m = onset.match(/T(\d{2}):(\d{2})/);
  if (m === null) return undefined;
  return `${m[1]}:${m[2]}`;
}

/**
 * Returns the cached Garmin sleep_onset_time for `fireDate` as HH:MM,
 * or `undefined` when the sensor_signals row is missing, has no sleep
 * payload, or the onset doesn't parse. Mirrors `loadGarminOnset` in
 * evaluate-stage-b.ts.
 */
function loadGarminOnsetHHMM(
  db: Database.Database,
  fireDate: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT payload_json
         FROM sensor_signals
        WHERE source = 'garmin' AND payload_date = ?
        LIMIT 1`,
    )
    .get(fireDate) as SensorPayloadRow | undefined;
  if (row === undefined) return undefined;

  const payload = JSON.parse(row.payload_json) as GarminSleepPayload;
  if (payload.sleep === null || payload.sleep === undefined) return undefined;
  if (payload.sleep.sleep_onset_time === null) return undefined;
  return extractHHMM(payload.sleep.sleep_onset_time);
}

export function formatWindDownSummary(onset: string, threshold: string): string {
  return `✓ Wind-down · asleep ${onset} (threshold ${threshold})`;
}

/**
 * Compose a `✓` ack line for #wins + source channel.
 *
 * Example: `✓ Morning row · 2026-05-13 09:35:00 · 10:03 · 2279m`.
 */
export function formatMorningRowSummary(session: Concept2Result): string {
  const totalSeconds = Math.floor(session.duration_seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `✓ Morning row · ${session.date} · ${mmss} · ${session.distance_meters}m`;
}

interface CompletionWriteContext {
  readonly db: Database.Database;
  readonly sessionStore: SessionStore;
  readonly now: number;
  readonly habitId: string;
  readonly runId: string;
  readonly proofPayload: unknown;
}

/**
 * Single transaction: flip habit_runs.status to 'completed' AND append the
 * audit-trail `habit_completed` session event. The session id is the
 * synthetic `"reconcile"` value — `SessionStore.append` will lazily
 * create the session row if it doesn't yet exist.
 */
function writeCompletion(ctx: CompletionWriteContext): void {
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE habit_runs
            SET status = 'completed',
                completed_at = ?,
                next_escalation_at = NULL,
                proof_payload_json = ?
          WHERE id = ?`,
      )
      .run(ctx.now, JSON.stringify({ proof: ctx.proofPayload }), ctx.runId);

    ctx.sessionStore.append(
      "reconcile",
      "habit_completed",
      {
        habitId: ctx.habitId,
        runId: ctx.runId,
        completedAt: ctx.now,
        proofPayload: ctx.proofPayload,
      },
      { trustLevel: "L1" },
    );
  });
  tx();
}

// -----------------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------------

export async function reconcilePendingRuns(
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const db = opts.sessionStore.db;
  const today = localDateString(new Date(opts.now));

  const pending = loadPendingRuns(db, today);

  let attempted = 0;
  let completed = 0;

  for (const row of pending) {
    // Two known proof types are reconcilable today; everything else
    // (e.g. strength `training_log_photo`) is skipped silently — those
    // remain a manual-proof path. `attempted` counts only rows the
    // reconciler took ownership of, so the cron operator's view of
    // "work attempted vs. closed" is honest.
    if (row.proof_type === "concept2_api+photo_fallback") {
      // Concept2 runs only exist in `status='pending'` (no partial
      // state for morning-row); skip partial rows defensively.
      if (row.status !== "pending") continue;

      attempted += 1;
      const didComplete = await reconcileConcept2Row(opts, row);
      if (didComplete) completed += 1;
    } else if (row.proof_type === "typed_msg+garmin_sleep") {
      // Wind-down accepts both `pending` (user has not typed
      // "shutting down") AND `partial` (typed-msg confirmed, awaiting
      // Garmin onset). Either way, an at-or-before-threshold Garmin
      // onset closes the run.
      if (row.status !== "pending" && row.status !== "partial") continue;

      attempted += 1;
      const didComplete = await reconcileWindDownRow(opts, row);
      if (didComplete) completed += 1;
    }
    // else: unknown proof_type — leave untouched, do not count.
  }

  return {
    attempted,
    completed,
    stillPending: attempted - completed,
  };
}

// -----------------------------------------------------------------------------
// Per-row branches.
//
// Each branch returns `true` when it moved the run to status='completed'
// this tick, `false` otherwise. The branch is responsible for posting
// acks (wrapped in independent try/catch — a flaky channel must not
// abort the batch or block the sibling post).
// -----------------------------------------------------------------------------

async function reconcileConcept2Row(
  opts: ReconcileOptions,
  row: PendingRunRow,
): Promise<boolean> {
  const db = opts.sessionStore.db;

  // Refresh the Concept2 cache. The injected sync function is async and
  // may throw; per design § 4 + Task 15, sync failures should surface
  // so the daemon's sensor-failure path can be wired in Task 1.4+.
  await opts.concept2Sync({
    habitId: row.habit_id,
    runId: row.id,
    date: new Date(opts.now),
  });

  const results = loadCachedConcept2Results(db, row.fire_date);
  const config = parseMorningRowConfig(row.proof_config_json, row.habit_id);
  const matched = findQualifyingSession(results, config.min_minutes);

  if (matched === undefined) return false;

  const proofPayload = {
    source: "concept2" as const,
    session: matched,
    autoDetected: true,
  };

  writeCompletion({
    db,
    sessionStore: opts.sessionStore,
    now: opts.now,
    habitId: row.habit_id,
    runId: row.id,
    proofPayload,
  });

  const summary = formatMorningRowSummary(matched);
  await postDualChannel(opts, row, summary);
  return true;
}

async function reconcileWindDownRow(
  opts: ReconcileOptions,
  row: PendingRunRow,
): Promise<boolean> {
  const db = opts.sessionStore.db;

  await opts.garminSync({
    habitId: row.habit_id,
    runId: row.id,
    date: new Date(opts.now),
  });

  const onset = loadGarminOnsetHHMM(db, row.fire_date);
  if (onset === undefined) return false;

  const config = parseWindDownConfig(row.proof_config_json, row.habit_id);
  // Fixed-width zero-padded HH:MM allows lexicographic comparison.
  // "22:30" <= "23:00" is identical to clock-time comparison.
  if (onset > config.stage_b_threshold) {
    // Onset after threshold — the miss-transition lives in
    // evaluateStageB, not here. Leave the row alone.
    return false;
  }

  const proofPayload = {
    source: "garmin" as const,
    sleep_onset: onset,
    autoDetected: true,
  };

  writeCompletion({
    db,
    sessionStore: opts.sessionStore,
    now: opts.now,
    habitId: row.habit_id,
    runId: row.id,
    proofPayload,
  });

  const summary = formatWindDownSummary(onset, config.stage_b_threshold);
  await postDualChannel(opts, row, summary);
  return true;
}

/**
 * Post a completion ack to the source channel AND #wins. Each post is
 * wrapped in its own try/catch — the DB write is already committed and
 * a flaky channel must not prevent the sibling post or abort the batch.
 * Pattern mirrors `verify-proof.ts:670-682` (Stage-A wind-down ack).
 *
 * Phase 6.2: when the run carries a `last_escalation_message_id`, a brief
 * follow-up is posted FIRST in the source channel so the orphaned
 * escalation gets closure pointing at the closure summary that follows.
 * The follow-up has its own try/catch and never blocks the closure posts.
 */
async function postDualChannel(
  opts: ReconcileOptions,
  row: PendingRunRow,
  summary: string,
): Promise<void> {
  if (row.last_escalation_message_id !== null) {
    try {
      await opts.postCompletion({
        channelId: row.channel_id,
        runId: row.id,
        summary: ESCALATION_FOLLOW_UP_CONTENT,
      });
    } catch (err: unknown) {
      console.error(
        `[reconcile-pending-runs] escalation follow-up post failed for run ${row.id}`,
        err,
      );
    }
  }
  try {
    await opts.postCompletion({
      channelId: row.channel_id,
      runId: row.id,
      summary,
    });
  } catch (err: unknown) {
    console.error(
      `[reconcile-pending-runs] source-channel ack post failed for run ${row.id}`,
      err,
    );
  }
  try {
    await opts.postCompletion({
      channelId: "wins",
      runId: row.id,
      summary,
    });
  } catch (err: unknown) {
    console.error(
      `[reconcile-pending-runs] wins ack post failed for run ${row.id}`,
      err,
    );
  }
}

// -----------------------------------------------------------------------------
// Cron registration.
// -----------------------------------------------------------------------------

/**
 * Idempotently register the reconcile-pending-runs cron in the `schedules`
 * table. Mirrors `registerRetryUnresolvedSensorsCron`: SELECT-first guard,
 * INSERT only when no row already exists for this verb. The schedules table
 * has no UNIQUE(verb) constraint (Phase B).
 *
 * Cron contract (Task 1.5):
 *   - cron_expr: `*\/2 * * * *` (every 2 minutes)
 *   - args_json: `{}` (the verb takes no per-row args; it scans all pending
 *     runs whose fire_date matches today)
 *   - missed_run_policy: skip
 *   - enabled: 1
 *   - dispatch_priority: 50 (lower than create-habit-run's 100 so the morning
 *     fire wins when both want to run on the same tick)
 */
export function registerReconcilePendingRunsCron(
  db: Database.Database,
): void {
  const existing = db
    .prepare(`SELECT id FROM schedules WHERE verb = ?`)
    .get("reconcile-pending-runs");
  if (existing !== undefined) {
    return;
  }

  db.prepare(
    `INSERT INTO schedules (
       cron_expr, verb, args_json, missed_run_policy, enabled, dispatch_priority
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("*/2 * * * *", "reconcile-pending-runs", "{}", "skip", 1, 50);
}
